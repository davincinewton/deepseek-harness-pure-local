/**
 * The built-in read-only bash command set and matcher for the no-backend
 * fallback. When no kernel sandbox backend is present, a command whose EVERY
 * subcommand is read-only runs WITHOUT a prompt (it is safe unconfined);
 * anything else is gated by the approval channel. Conservative by design —
 * when in doubt a command is NOT read-only, so it prompts (or fails closed
 * under a non-interactive policy).
 *
 * This is a permission concern (what is safe to run unconfined), housed here
 * with the sandbox vocabulary because it decides the no-backend fallback's free
 * set. The full rule engine (allow/ask/deny, `Tool(specifier)`, wrappers,
 * redirects) is a later phase; this module is the read-only subset only.
 *
 * @module dsh-sandbox/read-only
 */

/**
 * Programs that are read-only for ANY arguments: they carry no write or exec
 * capability at all, so no flag can make them unsafe. A command whose program
 * is here (and that is not a compound with a non-read-only subcommand) is
 * read-only.
 */
const ALWAYS_READ_ONLY = new Set([
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'wc', 'which', 'diff', 'stat',
  'du', 'df', 'ps', 'env', 'printenv', 'date', 'whoami', 'hostname', 'uname',
  'id', 'true', 'false', 'test', '[', 'printf', 'type', 'alias', 'basename',
  'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum', 'cksum', 'cut',
  'column', 'nl', 'od', 'xxd', 'tac', 'rev', 'tr', 'seq', 'expr', 'less',
  'more', 'strings',
])

/**
 * `git` subcommands that are read-only (no mutating form). A `git` invocation
 * is read-only exactly when its first non-option argument is one of these AND
 * it carries no mutating flag.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'rev-parse',
  'ls-files', 'describe', 'shortlog', 'blame', 'cat-file', 'reflog', 'config',
  'stash',
])

/**
 * `git` flags that mutate in the context of the read-only subcommands above
 * (branch/tag delete/rename, config set/unset, force). Global read-only options
 * (`-c name=value`, `-a`/`--all` on log/diff) are deliberately NOT here.
 */
const GIT_MUTATING_FLAGS = new Set([
  '-d', '-D', '--delete', '-m', '--move', '--force', '-f',
  '--unset', '--add', '--edit', '-e',
])

/**
 * Whether one whitespace-split token is a shell option (starts with `-`).
 * Used to skip options when locating a command's subcommand word.
 */
function isOption(token: string): boolean {
  return token.startsWith('-') && token.length > 1
}

/**
 * Whether one simple (non-compound) command is read-only. Splits the command
 * into tokens, locates the program (skipping a leading env assignment like
 * `FOO=bar`), and checks it against the read-only sets. A command with a
 * redirect target other than `/dev/null` is NOT read-only here (redirect
 * checking is a later phase; being conservative, any `>`/`>>` disqualifies).
 * @param command - one simple command (no compound operators).
 * @returns true when the command is read-only.
 */
export function isReadOnlySimpleCommand(command: string): boolean {
  // Any output redirect to a real file makes this non-read-only (conservative:
  // redirect-target checking against file rules is a later phase).
  if (/[<>]/u.test(command)) return false

  const tokens = command.trim().split(/\s+/u).filter(token => token.length > 0)
  // Skip leading `VAR=value` env assignments.
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] as string)) index += 1
  const program = tokens[index]
  if (program === undefined) return false

  const bare = program.split('/').pop() as string
  if (bare === 'git') return isReadOnlyGit(tokens.slice(index + 1))
  return ALWAYS_READ_ONLY.has(bare)
}

/** Whether a `git` invocation (tokens after `git`) is read-only. */
function isReadOnlyGit(args: readonly string[]): boolean {
  // A mutating flag ANYWHERE disqualifies (conservative: over-reject is safe).
  for (const arg of args) {
    if (GIT_MUTATING_FLAGS.has(arg)) return false
  }
  // The subcommand is the first non-option token.
  let subcommand: string | undefined
  for (const arg of args) {
    if (isOption(arg)) continue
    subcommand = arg
    break
  }
  if (subcommand === undefined) return false
  if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false
  // `git config` and `git stash` have read-only and mutating forms distinguished
  // by their second word / flag; require the read-only form explicitly.
  if (subcommand === 'config') return args.includes('--get') || args.includes('--list') || args.includes('-l')
  if (subcommand === 'stash') return args[args.indexOf('stash') + 1] === 'list'
  return true
}

/**
 * Whether a full (possibly compound) bash command is read-only: EVERY
 * subcommand separated by `&&`, `||`, `;`, `|`, `|&`, `&`, or a newline must
 * be read-only. An empty/blank command is not read-only.
 * @param command - the full command text as the model wrote it.
 * @returns true when every subcommand is read-only.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  // Split on compound operators (right-to-left, multi-char first) and newlines.
  const subcommands = trimmed
    .split(/\n/u)
    .flatMap(line => line.split(/&&|\|\||;|\||&/u))
    .map(part => part.trim())
    .filter(part => part.length > 0)
  if (subcommands.length === 0) return false
  return subcommands.every(part => isReadOnlySimpleCommand(part))
}
