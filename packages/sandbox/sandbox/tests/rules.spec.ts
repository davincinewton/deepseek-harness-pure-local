/**
 * Tests for the permission rule engine: rule parsing, the bash/fs matchers
 * (wildcards, compound split, wrapper strip, read-only fold), and the
 * deny→ask→allow decision. Pinned against the Claude-Code-style match/no-match
 * shapes so the allow matcher's conservatism and the deny matcher's breadth are
 * both locked in.
 */

import { describe, expect, it } from 'vitest'
import {
  decide,
  decideRaw,
  matchBashRule,
  matchFsRule,
  parsePermissionRule,
  parseRules,
  type PermissionRule,
} from '@deepseek-ai/dsh-sandbox'

const rule = (effect: 'allow' | 'ask' | 'deny', tool: string, specifier?: string): PermissionRule =>
  ({ effect, tool, ...(specifier !== undefined ? { specifier } : {}) })

describe('parsePermissionRule', () => {
  it('parses a bare tool and a Tool(specifier)', () => {
    expect(parsePermissionRule('allow', 'Bash')).toEqual({ effect: 'allow', tool: 'Bash' })
    expect(parsePermissionRule('deny', 'Bash(npm run *)')).toEqual({ effect: 'deny', tool: 'Bash', specifier: 'npm run *' })
    expect(parsePermissionRule('ask', 'mcp__server__tool(x)')).toEqual({ effect: 'ask', tool: 'mcp__server__tool', specifier: 'x' })
  })

  it('rejects malformed rule text', () => {
    expect(() => parsePermissionRule('allow', '')).toThrow(/invalid permission rule/)
    expect(() => parsePermissionRule('allow', 'no tool name (x)')).toThrow(/invalid permission rule/)
  })
})

describe('matchBashRule', () => {
  it('a bare tool rule matches every call', () => {
    expect(matchBashRule(rule('deny', 'bash'), 'anything at all')).toBe(true)
  })

  it('wildcards: `ls *` needs the space, `ls*` does not', () => {
    const spaced = rule('allow', 'bash', 'ls *')
    expect(matchBashRule(spaced, 'ls')).toBe(true)
    expect(matchBashRule(spaced, 'ls -la')).toBe(true)
    expect(matchBashRule(spaced, 'lsof -i')).toBe(false)
    const unspaced = rule('allow', 'bash', 'ls*')
    expect(matchBashRule(unspaced, 'lsof -i')).toBe(true)
  })

  it('matches a program+args pattern', () => {
    expect(matchBashRule(rule('allow', 'bash', 'git commit *'), 'git commit -m x')).toBe(true)
    expect(matchBashRule(rule('allow', 'bash', 'npm run *'), 'npm run build')).toBe(true)
    expect(matchBashRule(rule('allow', 'bash', 'npm run *'), 'npm install')).toBe(false)
    // A program-only pattern matches when the whole command carries arguments.
    expect(matchBashRule(rule('deny', 'bash', 'git'), 'git status')).toBe(true)
  })

  it('an allow rule requires EVERY compound part to match or be read-only', () => {
    const r = rule('allow', 'bash', 'npm run *')
    expect(matchBashRule(r, 'npm run build && npm run test')).toBe(true)
    expect(matchBashRule(r, 'npm run build && rm -rf x')).toBe(false)
    // A read-only part is acceptable inside an allow compound.
    expect(matchBashRule(r, 'npm run build && ls')).toBe(true)
  })

  it('a deny/ask rule is triggered by ANY matching compound part', () => {
    const r = rule('deny', 'bash', 'rm *')
    expect(matchBashRule(r, 'ls && rm -rf x')).toBe(true)
    expect(matchBashRule(r, 'echo hi && rm x')).toBe(true)
    expect(matchBashRule(r, 'ls && cat a')).toBe(false)
  })

  it('matches past leading wrappers and env assignments', () => {
    const r = rule('allow', 'bash', 'npm test')
    expect(matchBashRule(r, 'timeout 5 npm test')).toBe(true)
    expect(matchBashRule(r, 'FOO=bar npm test')).toBe(true)
    expect(matchBashRule(r, 'nohup npm test')).toBe(true)
    expect(matchBashRule(r, 'env -i npm test')).toBe(true)
    expect(matchBashRule(r, 'timeout npm test')).toBe(true)
    expect(matchBashRule(r, '/usr/bin/nohup npm test')).toBe(true)
  })

  it('matches nothing in degenerate commands', () => {
    const r = rule('deny', 'bash', 'x')
    // Only operators, and a lone wrapper leave no program to match.
    expect(matchBashRule(r, '&&')).toBe(false)
    expect(matchBashRule(rule('allow', 'bash', 'x'), '&&')).toBe(false)
    expect(matchBashRule(r, 'nohup')).toBe(false)
  })

  it('an allow rule never matches a write redirect; deny rules still do', () => {
    const allow = rule('allow', 'bash', 'echo *')
    expect(matchBashRule(allow, 'echo hi')).toBe(true)
    expect(matchBashRule(allow, 'echo hi > out.txt')).toBe(false)
    // /dev/null and fd duplication are not filesystem writes.
    expect(matchBashRule(allow, 'echo hi > /dev/null 2>&1')).toBe(true)
    const deny = rule('deny', 'bash', 'echo *')
    expect(matchBashRule(deny, 'echo hi > out.txt')).toBe(true)
  })
})

describe('matchFsRule', () => {
  it('a bare tool rule matches every path', () => {
    expect(matchFsRule(rule('deny', 'write'), '/any/path')).toBe(true)
  })

  it('matches an exact path and a basename', () => {
    expect(matchFsRule(rule('deny', 'write', '.env'), '/repo/.env')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', '.env'), '/repo/other/.env')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', '.env'), '/repo/.env.bak')).toBe(false)
  })

  it('matches a glob pattern against the path tail', () => {
    expect(matchFsRule(rule('allow', 'write', 'src/**'), '/repo/src/a/b.ts')).toBe(true)
    expect(matchFsRule(rule('allow', 'write', 'src/*.ts'), '/repo/src/a.ts')).toBe(true)
    expect(matchFsRule(rule('allow', 'write', 'src/*.ts'), '/repo/src/a/b.ts')).toBe(false)
    expect(matchFsRule(rule('allow', 'write', 'src/**'), '/repo/lib/a.ts')).toBe(false)
  })

  it('treats a `/**/` segment as an optional separator', () => {
    expect(matchFsRule(rule('deny', 'write', 'src/**/secret'), '/repo/src/secret')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', 'src/**/secret'), '/repo/src/a/secret')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', 'src/**/secret'), '/repo/src/xsecret')).toBe(false)
  })

  it('anchors absolute and `**`-leading patterns at the root', () => {
    expect(matchFsRule(rule('deny', 'write', '/etc/**'), '/etc/passwd')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', '/etc/**'), '/opt/etc/passwd')).toBe(false)
    expect(matchFsRule(rule('deny', 'write', '**/id_rsa'), '/home/user/.ssh/id_rsa')).toBe(true)
    expect(matchFsRule(rule('deny', 'write', './.env'), '/repo/.env')).toBe(true)
  })
})

describe('decide (deny > ask > allow, first match wins)', () => {
  it('deny outranks allow and ask', () => {
    const rules = [
      rule('allow', 'bash', 'npm *'),
      rule('deny', 'bash', 'npm run deploy *'),
    ]
    expect(decide(rules, 'bash', { command: 'npm run build' })).toBe('allow')
    expect(decide(rules, 'bash', { command: 'npm run deploy prod' })).toBe('deny')
  })

  it('ask outranks allow', () => {
    const rules = [rule('allow', 'bash', 'git *'), rule('ask', 'bash', 'git push *')]
    expect(decide(rules, 'bash', { command: 'git status' })).toBe('allow')
    expect(decide(rules, 'bash', { command: 'git push origin' })).toBe('ask')
  })

  it('a read-only bash call with no matching rule is allow; a novel one is ask', () => {
    expect(decide([], 'bash', { command: 'ls -la' })).toBe('allow')
    expect(decide([], 'bash', { command: 'npm install' })).toBe('ask')
  })

  it('a tool with no rules and a non-bash subject is ask', () => {
    expect(decide([], 'write', { file_path: '/x' })).toBe('ask')
    expect(decide([rule('allow', 'write', 'src/**')], 'write', { file_path: '/repo/src/a.ts' })).toBe('allow')
  })

  it('asks when the subject field for the tool is absent', () => {
    expect(decide([], 'bash', {})).toBe('ask')
    expect(decide([], 'write', {})).toBe('ask')
  })

  it('decideRaw parses and decides in one step', () => {
    expect(decideRaw({ allow: ['Bash(npm run *)'], deny: ['Bash(rm *)'] }, 'bash', { command: 'npm run build' })).toBe('allow')
    expect(decideRaw({ allow: ['Bash(npm run *)'], deny: ['Bash(rm *)'] }, 'bash', { command: 'rm -rf x' })).toBe('deny')
  })
})

describe('decide with a session grant', () => {
  it('a grant frees a novel command without a prompt', () => {
    expect(decide([], 'bash', { command: 'npm install' }, { granted: true })).toBe('allow')
  })

  it('a grant outranks an ask rule', () => {
    expect(decide([rule('ask', 'bash', 'ls *')], 'bash', { command: 'ls -la' }, { granted: true })).toBe('allow')
  })

  it('a deny rule still outranks a grant', () => {
    expect(decide([rule('deny', 'bash', 'rm *')], 'bash', { command: 'rm -rf x' }, { granted: true })).toBe('deny')
  })

  it('a filesystem call granted on its path is allow regardless of rules', () => {
    expect(decide([rule('ask', 'write', '.env')], 'write', { file_path: '/repo/.env' }, { granted: true })).toBe('allow')
    expect(decide([rule('deny', 'write', '.env')], 'write', { file_path: '/repo/.env' }, { granted: true })).toBe('deny')
  })
})

describe('parseRules ordering', () => {
  it('emits deny, then ask, then allow (precedence order)', () => {
    const rules = parseRules({ allow: ['Bash(a)'], ask: ['Bash(b)'], deny: ['Bash(c)'] })
    expect(rules.map(r => r.effect)).toEqual(['deny', 'ask', 'allow'])
  })

  it('parses partial sets, omitting absent groups', () => {
    expect(parseRules({})).toEqual([])
    expect(parseRules({ allow: ['Bash(a)'] }).map(r => r.effect)).toEqual(['allow'])
    expect(parseRules({ deny: ['Bash(c)'] }).map(r => r.effect)).toEqual(['deny'])
  })
})
