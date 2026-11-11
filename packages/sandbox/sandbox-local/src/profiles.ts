/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the operator-runner profile arguments for one confined policy.
 * The argv dialect is bwrap-compatible (`--ro-bind`, `--tmpfs`, `--bind`) —
 * the flag language operator-supplied runners are expected to understand;
 * DSH itself ships no built-in runner in this dialect.
 * @param policy - file-effect policy to express as runner mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function runnerCommandProfileArgs(policy: SandboxPolicy): string[] {
  // confine() receives a confined policy, whose only mode is workspace-write.
  return [
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent',
    '--tmpfs', '/tmp',
    '--bind', policy.workspaceRoot, policy.workspaceRoot,
  ]
}

/**
 * Build the Landlock launcher grants for one confined policy: everything
 * readable; read-write the launcher-dialect roots (`/dev/null`, host `/tmp`,
 * the workspace root — the Landlock spelling of the writable-root meaning,
 * parity with {@link writableRoots} pinned by test).
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null', '/tmp', policy.workspaceRoot]
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
