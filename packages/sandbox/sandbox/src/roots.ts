/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The Landlock dialect keeps its own grant spellings (launcher-owned
 * flags) — the honest per-runner differences recorded in the sandbox RFC —
 * with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list: the policy's workspace root, the host
 * `/tmp`, and the per-user platform temp dir (`os.tmpdir()` — the real temp
 * area for mkstemp-family tools; omitting it would deny what the mode
 * promises). D1 allow-set extensions (package caches, tool data dirs) join
 * this list from configuration; each entry is a documented hole.
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty under `danger-full-access`
 *   (nothing is fenced there at all).
 */
/**
 * Whether one canonicalized path sits under a writable root of `policy` —
 * the containment the tool layer prompts on BEFORE the fence (the prompt
 * decision must not wait for a denial). Case-insensitive on win32 like the
 * fence's containment; the fence remains the enforcement, this is the
 * prompt trigger.
 * @param policy - the resolved file-effect policy.
 * @param path - the canonicalized target path to test.
 * @returns true when the path is contained (no prompt needed).
 */
export function isWithinWritable(policy: SandboxExecutionPolicy, path: string): boolean {
  if (policy.mode !== 'workspace-write') return true
  const fold = process.platform === 'win32' ? path.toLowerCase() : path
  return writableRoots(policy).some((root) => {
    const base = process.platform === 'win32' ? root.toLowerCase() : root
    const prefix = base.endsWith('/') || base.endsWith(String.fromCharCode(92)) ? base : `${base}/`
    return fold === base || fold.startsWith(prefix)
  })
}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([
    policy.workspaceRoot, '/tmp', tmpdir(),
    ...(policy.extraWritable ?? []),
  ].map(canonicalPath))]
}
