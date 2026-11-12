/**
 * Path-containment mechanics for the sandbox: whether a canonical path sits
 * under a writable root. Canonical spellings take the fast lexical path;
 * filesystem identity supplies the conservative fallback for alias-equivalent
 * roots such as Windows 8.3 names and casing. The in-process filesystem fence
 * and the tool layer's pre-emptive prompt gate share this one test, so a
 * prompt never fires for an access the fence would have allowed.
 *
 * The Windows convention (case-insensitive lexical comparison, `\`
 * separators, win32 directory walks) is selected by one call-time read of
 * `process.platform`, so the win32 branch executes under host-convention
 * tests that spoof the platform; on a real host this matches `node:path`'s
 * own platform selection.
 *
 * @module dsh-sandbox/containment
 */

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

const MISSING_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return MISSING_CODES.has(code)
}

/** The path module of the platform whose filesystem semantics govern containment. */
function hostPath(): typeof posix {
  return process.platform === 'win32' ? win32 : posix
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase()
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive)
  const comparableRoot = comparablePath(root, caseSensitive)
  if (comparableTarget === comparableRoot) return true
  const separator = hostPath().sep
  const prefix = comparableRoot.endsWith(separator) ? comparableRoot : comparableRoot + separator
  return comparableTarget.startsWith(prefix)
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    /* v8 ignore else -- a non-missing stat failure requires a host permission or I/O fault after resolve reached this ancestor. */
    if (isMissing(error)) return undefined
    /* v8 ignore next -- requires a host permission or I/O fault after resolve already reached this ancestor. */
    throw error
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Determine whether a canonical target is a writable root or lies beneath it.
 * The lexical fast path handles normal canonical spellings. When spellings
 * differ, walk the target's existing ancestors and compare filesystem identity
 * with the root; this recognizes Windows long-name/8.3 aliases and casing
 * without weakening containment to a textual approximation.
 * @param path - canonical target key, which may end in a missing suffix.
 * @param root - canonical writable root.
 * @param caseSensitive - whether lexical comparison preserves case; defaults
 *   to the host filesystem convention used by supported platforms.
 * @returns whether the target is the root or a descendant of it.
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true

  const rootInfo = await statIfPresent(root)
  if (!rootInfo) return false

  const host = hostPath()
  let ancestor = path
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = host.dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}
