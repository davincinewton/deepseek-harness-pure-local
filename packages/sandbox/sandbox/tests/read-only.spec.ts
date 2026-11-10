/**
 * Tests for the built-in read-only bash matcher (the no-backend fallback's free
 * set). Conservative by design: when in doubt a command is NOT read-only, so it
 * prompts. These pin the read-only / non-read-only boundary for the common
 * shapes the model produces.
 */

import { describe, expect, it } from 'vitest'
import { isReadOnlyBashCommand, isReadOnlySimpleCommand } from '@deepseek-ai/dsh-sandbox'

describe('isReadOnlySimpleCommand', () => {
  it('accepts unambiguous read-only programs', () => {
    for (const command of ['ls', 'ls -la', 'cat README.md', 'echo hi', 'pwd', 'head -n 5 a.txt',
      'tail -f log', 'wc -l a b', 'which node', 'diff a b', 'stat x', 'du -sh .', 'df -h',
      'ps aux', 'env', 'date', 'whoami', 'uname -a', 'true', 'false', 'printf %s x',
      'basename /a/b c', 'dirname /a/b', 'realpath /a', 'readlink /a', 'md5sum f',
      'cut -d, -f1 f', 'od -c f', 'seq 1 10', 'expr 1 + 1']) {
      expect(isReadOnlySimpleCommand(command), command).toBe(true)
    }
  })

  it('rejects write/exec-capable programs', () => {
    for (const command of ['rm -rf /', 'npm install', 'git push origin main', 'find . -delete',
      'find . -exec rm {} ;', 'sed -i s/a/b/ f', 'sort -o out in', 'mkdir x', 'touch f',
      'cp a b', 'mv a b', 'chmod 777 f', 'curl https://x', 'docker ps', 'tee out', 'bash -c x']) {
      expect(isReadOnlySimpleCommand(command), command).toBe(false)
    }
  })

  it('treats any redirect as non-read-only (conservative; redirect checks are a later phase)', () => {
    expect(isReadOnlySimpleCommand('ls > out.txt')).toBe(false)
    expect(isReadOnlySimpleCommand('ls 2>/dev/null')).toBe(false)
    expect(isReadOnlySimpleCommand('cat a < b')).toBe(false)
  })

  it('skips a leading env assignment before the program', () => {
    expect(isReadOnlySimpleCommand('FOO=bar ls')).toBe(true)
    expect(isReadOnlySimpleCommand('FOO=bar rm -rf x')).toBe(false)
  })

  it('resolves a path-qualified program to its basename', () => {
    expect(isReadOnlySimpleCommand('/bin/ls -la')).toBe(true)
    expect(isReadOnlySimpleCommand('/usr/bin/rm -rf x')).toBe(false)
  })

  it('rejects a blank command', () => {
    expect(isReadOnlySimpleCommand('')).toBe(false)
    expect(isReadOnlySimpleCommand('   ')).toBe(false)
    // Assignments but no program at all.
    expect(isReadOnlySimpleCommand('FOO=bar')).toBe(false)
  })
})

describe('git read-only forms', () => {
  it('accepts read-only subcommands', () => {
    for (const command of ['git status', 'git log --oneline', 'git diff', 'git show HEAD',
      'git branch', 'git remote -v', 'git rev-parse HEAD', 'git ls-files', 'git describe',
      'git blame f', 'git reflog', 'git config --list', 'git stash list']) {
      expect(isReadOnlySimpleCommand(command), command).toBe(true)
    }
  })

  it('rejects mutating subcommands and flags', () => {
    for (const command of ['git push', 'git commit -m x', 'git checkout b', 'git merge main',
      'git rebase', 'git branch -d b', 'git tag -d t', 'git config user.name x',
      'git stash push', 'git pull', 'git reset --hard']) {
      expect(isReadOnlySimpleCommand(command), command).toBe(false)
    }
  })

  it('skips global options before the subcommand', () => {
    expect(isReadOnlySimpleCommand('git --no-pager log')).toBe(true)
    // Only options, no subcommand; and a bare `-` names no subcommand either.
    expect(isReadOnlySimpleCommand('git --no-pager')).toBe(false)
    expect(isReadOnlySimpleCommand('git - log')).toBe(false)
  })
})

describe('isReadOnlyBashCommand (compound)', () => {
  it('requires EVERY subcommand to be read-only', () => {
    expect(isReadOnlyBashCommand('ls && cat a')).toBe(true)
    expect(isReadOnlyBashCommand('ls; pwd')).toBe(true)
    expect(isReadOnlyBashCommand('cat a | wc -l')).toBe(true)
    expect(isReadOnlyBashCommand('ls && rm -rf x')).toBe(false)
    expect(isReadOnlyBashCommand('npm test || git push')).toBe(false)
    expect(isReadOnlyBashCommand('ls\nrm x')).toBe(false)
  })

  it('rejects a compound with a non-read-only subcommand anywhere', () => {
    expect(isReadOnlyBashCommand('true && false && rm x')).toBe(false)
    expect(isReadOnlyBashCommand('echo a && echo b && find . -delete')).toBe(false)
  })

  it('rejects a blank command', () => {
    expect(isReadOnlyBashCommand('')).toBe(false)
    // Operators but no subcommand.
    expect(isReadOnlyBashCommand('&&')).toBe(false)
  })
})
