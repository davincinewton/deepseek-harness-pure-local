/**
 * The permission rule engine: declarative allow/ask/deny rules and the matchers
 * that decide, for one tool call, whether it runs free, prompts, or is denied.
 * Pure app logic — no kernel, no model. This is the core of the rule-based auth
 * (the no-backend fallback's gate and the eventual auto mode).
 *
 * Rule text is `Tool` or `Tool(specifier)`; tool names compare case-insensitively
 * (`Bash` and `bash` name the same tool). Precedence is deny → ask → allow in
 * that effect order regardless of rule-list order; first match in an effect wins.
 * A bash specifier is a command pattern (`*` matches any text incl. spaces, and
 * a trailing ` *` also matches the bare prefix); an fs specifier is a path
 * pattern. The matcher is conservative: when in doubt a call is NOT allow-matched,
 * so it falls to the prompt (or fail-closed under a non-interactive policy).
 * Bypass resistance is a property of the DENY rules (and the optional kernel
 * sandbox), not the allow matcher.
 *
 * @module dsh-sandbox/rules
 */

import { isReadOnlyBashCommand } from './read-only.ts'

/** The effect a rule has on a matching call. */
export type PermissionEffect = 'allow' | 'ask' | 'deny'

/** One parsed permission rule: an effect on a tool, optionally scoped to a specifier. */
export interface PermissionRule {
  effect: PermissionEffect
  /** The tool name the rule applies to (e.g. `Bash`, `Write`, `mcp__server__tool`). */
  tool: string
  /** The specifier (command pattern / path pattern) when the rule is scoped. */
  specifier?: string
}

/** A set of raw rule texts by effect, as written in config/settings. */
export interface PermissionRules {
  allow?: readonly string[]
  ask?: readonly string[]
  deny?: readonly string[]
}

/**
 * Parse one rule text (`Tool` or `Tool(specifier)`) into a {@link PermissionRule}.
 * A bare tool name has no specifier (it matches every use of the tool). The
 * tool name may contain `_` (MCP tools); the specifier is the text between the
 * first `(` and the last `)`.
 * @param effect - the rule's effect.
 * @param text - the rule as written (e.g. `Bash(npm run *)`, `Read(./.env)`).
 * @returns the parsed rule.
 * @throws when the text is not `Tool` or `Tool(specifier)`.
 */
export function parsePermissionRule(effect: PermissionEffect, text: string): PermissionRule {
  const trimmed = text.trim()
  const match = /^([A-Za-z0-9_*]+)(?:\((.*)\))?$/u.exec(trimmed)
  if (match === null || match[1] === undefined) {
    throw new Error(`invalid permission rule: expected Tool or Tool(specifier), got ${JSON.stringify(text)}`)
  }
  const tool = match[1]
  const specifier = match[2]
  return { effect, tool, ...(specifier !== undefined && specifier.length > 0 ? { specifier } : {}) }
}

/**
 * Parse every rule text in a {@link PermissionRules} set into {@link PermissionRule}s.
 * @param rules - the three effect lists as written in configuration.
 * @returns the parsed rules, in deny/ask/allow order per list.
 * @throws when any text is not `Tool` or `Tool(specifier)`.
 */
export function parseRules(rules: PermissionRules): PermissionRule[] {
  const out: PermissionRule[] = []
  for (const text of rules.deny ?? []) out.push(parsePermissionRule('deny', text))
  for (const text of rules.ask ?? []) out.push(parsePermissionRule('ask', text))
  for (const text of rules.allow ?? []) out.push(parsePermissionRule('allow', text))
  return out
}

/** Escape every RegExp metacharacter in a literal chunk. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Translate a `*`/`**` glob into a RegExp source string (`*` stops at `/`, `**` does not). */
function globToRegexSource(pattern: string): string {
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const rest = pattern.slice(index)
    if (rest.startsWith('**')) {
      index += 2
      if (pattern.startsWith('/', index)) {
        // `a/**/b` matches `a/b` and `a/x/b`: zero or more WHOLE segments.
        out += '(?:.*/)?'
        index += 1
      } else {
        out += '.*'
      }
    } else if (rest.startsWith('*')) {
      out += '[^/]*'
      index += 1
    } else {
      const stop = rest.indexOf('*')
      const literal = stop === -1 ? rest : rest.slice(0, stop)
      out += escapeRegex(literal)
      index += literal.length
    }
  }
  return out
}

/** Leading wrappers a bash command may be wrapped in without changing its identity. */
const BASH_WRAPPERS = new Set(['timeout', 'nice', 'nohup', 'time', 'stdbuf', 'command', 'builtin', 'env', 'xargs'])

/** Leading `VAR=value` env assignment token. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/u
/** A `timeout` duration operand (a number with an optional unit suffix). */
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/u

/**
 * Strip leading wrappers and `VAR=value` assignments from a simple command's
 * tokens, returning the tokens from the real program onward. Each wrapper's own
 * option tokens (and `timeout`'s duration operand) are dropped with it.
 * @param tokens - the whitespace-split tokens of one simple command.
 * @returns the tokens from the program onward.
 */
function stripWrappers(tokens: readonly string[]): string[] {
  const rest = [...tokens]
  for (;;) {
    while (rest.length > 0 && ENV_ASSIGN.test(rest[0] as string)) rest.shift()
    const head = rest[0]
    if (head === undefined) return []
    const bare = head.split('/').pop() as string
    if (!BASH_WRAPPERS.has(bare)) return rest
    rest.shift()
    while (rest.length > 0 && (rest[0] as string).startsWith('-')) rest.shift()
    if (bare === 'timeout' && rest.length > 0 && TIMEOUT_DURATION.test(rest[0] as string)) rest.shift()
  }
}

/** Whether a pattern (with `*` wildcards) matches a string; a `*`-free pattern is exact. */
function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'u').test(value)
}

/**
 * Normalize fd duplications so operator splitting and redirect scanning only
 * see file-targeted operators: `2>&1` (duplicate to a numeric fd) has no file
 * target and is dropped; `&>file` (both streams to a file) becomes `>file`.
 * @param command - the raw command text.
 * @returns the command with fd duplication operators removed.
 */
function normalizeRedirects(command: string): string {
  return command
    .replace(/\d*>&(?=\d)/gu, '')
    .replace(/&>/gu, '>')
}

/** Split a full command into its simple subcommands (compound operators + newlines). */
function splitSubcommands(command: string): string[] {
  return normalizeRedirects(command)
    .split(/\n/u)
    .flatMap(line => line.split(/&&|\|\||;|\||&/u))
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/** A write redirect (`> f`, `2>> f`) whose target is not `/dev/null` or an fd duplication. */
function hasUnsafeRedirect(simple: string): boolean {
  for (const match of simple.matchAll(/\d?>{1,2}\s*(\S+)/gu)) {
    // The pattern's `(\S+)` capture is mandatory, so group 1 is always present.
    const target = match[1] as string
    if (target.startsWith('&') || target === '/dev/null') continue
    return true
  }
  return false
}

/**
 * Whether one simple command matches a bash command pattern. The comparison uses
 * the wrapper-stripped command: whole-command wildcard match, program-only match,
 * or (for a trailing ` *` pattern) the bare prefix without arguments.
 * @param pattern - the rule's command pattern.
 * @param simple - one simple (non-compound) command.
 * @returns true when the stripped command matches the pattern.
 */
function simpleMatchesPattern(pattern: string, simple: string): boolean {
  const stripped = stripWrappers(simple.trim().split(/\s+/u).filter(token => token.length > 0))
  const [program] = stripped
  if (program === undefined) return false
  const strippedCommand = stripped.join(' ')
  if (wildcardMatch(pattern, strippedCommand)) return true
  if (wildcardMatch(pattern, program)) return true
  // `Bash(ls *)` also matches bare `ls`: the trailing argument wildcard is optional.
  if (pattern.endsWith(' *') && strippedCommand === pattern.slice(0, -2)) return true
  return false
}

/**
 * Whether a bash rule matches a full (possibly compound) command.
 * - No specifier: matches every bash call.
 * - `allow`: EVERY subcommand must match the pattern (write redirects never
 *   allow-match) or be read-only; one non-matching part disqualifies the allow.
 * - `ask`/`deny`: ANY subcommand matching the pattern triggers the rule
 *   (matched past wrappers/assignments, including inside the compound).
 * @param rule - the parsed bash rule.
 * @param command - the full command text.
 * @returns true when the rule matches.
 */
export function matchBashRule(rule: PermissionRule, command: string): boolean {
  if (rule.specifier === undefined) return true
  const subcommands = splitSubcommands(command)
  if (subcommands.length === 0) return false
  if (rule.effect === 'allow') {
    return subcommands.every(part =>
      (simpleMatchesPattern(rule.specifier as string, part) && !hasUnsafeRedirect(part))
      || isReadOnlyBashCommand(part))
  }
  return subcommands.some(part => simpleMatchesPattern(rule.specifier as string, part))
}

/**
 * Whether an fs rule matches a resolved (canonical) path. A rule with no
 * specifier matches every use of the tool. The pattern may be absolute (compared
 * to the whole canonical path) or relative/short (matched against any trailing
 * segment sequence of it); `*` stops at `/` and `**` does not.
 * @param rule - the parsed fs rule.
 * @param path - the canonical absolute path of the target.
 * @returns true when the rule matches.
 */
export function matchFsRule(rule: PermissionRule, path: string): boolean {
  if (rule.specifier === undefined) return true
  const pattern = rule.specifier.replace(/^\.\//u, '')
  if (pattern.includes('*')) {
    const source = globToRegexSource(pattern)
    // Absolute or `**`-leading patterns anchor at the root; a relative/basename
    // pattern matches any trailing segment sequence of the path.
    const anchored = pattern.startsWith('/') || pattern.startsWith('**')
    const regex = new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`, 'u')
    return regex.test(path)
  }
  // Short patterns (`.env`) name a path or a file name against the path tail.
  return path === pattern || path.endsWith(`/${pattern}`)
}

/** The tool call the decision subject of a rule lookup is expressed from. */
export interface PermissionSubject {
  /** The command text for bash tools. */
  command?: string
  /** The (canonical) target path for filesystem tools. */
  file_path?: string
}

/** Options narrowing one {@link decide} lookup. */
export interface PermissionDecisionOptions {
  /**
   * A session grant covers this call (see `dsh-sandbox-policy/grants`): the
   * call runs free without a prompt, unless a deny rule blocks it. Deny rules
   * always outrank a grant — they are the operator's bypass-proof stop — and a
   * grant also outranks ask rules, which exist only to force the prompt.
   */
  granted?: boolean
}

/**
 * The decision for one tool call under a rule set: effects are tried in
 * deny → ask → allow order regardless of list order; first match wins. A call
 * with no matching rule is `ask` (it prompts), EXCEPT a read-only bash call,
 * which is `allow` (the no-backend fallback's free set). A grant-covered call
 * is `allow` unless a deny rule blocks it, skipping every ask rule.
 * @param rules - the parsed rules.
 * @param tool - the tool name (compared case-insensitively).
 * @param subject - the call's subject (`command` for bash, `file_path` for fs tools).
 * @param options - the grant coverage narrowing the decision.
 * @returns the decision.
 */
export function decide(
  rules: readonly PermissionRule[],
  tool: string,
  subject: PermissionSubject,
  options: PermissionDecisionOptions = {},
): 'allow' | 'ask' | 'deny' {
  const subjectText = tool.toLowerCase() === 'bash' ? subject.command : subject.file_path
  if (subjectText === undefined) return 'ask'
  const scoped = rules.filter(rule => rule.tool.toLowerCase() === tool.toLowerCase())
  const matches = (rule: PermissionRule): boolean =>
    tool.toLowerCase() === 'bash' ? matchBashRule(rule, subjectText) : matchFsRule(rule, subjectText)
  if (scoped.some(rule => rule.effect === 'deny' && matches(rule))) return 'deny'
  if (options.granted === true) return 'allow'
  if (scoped.some(rule => rule.effect === 'ask' && matches(rule))) return 'ask'
  if (scoped.some(rule => rule.effect === 'allow' && matches(rule))) return 'allow'
  // No rule matched: a read-only bash call runs free; everything else prompts.
  if (tool.toLowerCase() === 'bash' && isReadOnlyBashCommand(subjectText)) return 'allow'
  return 'ask'
}

/**
 * Convenience: parse a raw rule set and decide. See {@link decide} and
 * {@link parseRules}.
 * @param raw - the raw rule texts by effect.
 * @param tool - the tool name.
 * @param subject - the call's subject.
 * @returns the decision.
 */
export function decideRaw(raw: PermissionRules, tool: string, subject: PermissionSubject): 'allow' | 'ask' | 'deny' {
  return decide(parseRules(raw), tool, subject)
}
