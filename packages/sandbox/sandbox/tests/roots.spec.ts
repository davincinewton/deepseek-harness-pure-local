/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('danger-full-access fences nothing at all (the allow-list is not consulted)', () => {
    expect(writableRoots({ mode: 'danger-full-access', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('appends the extraWritable allow-set, canonicalized and deduplicated against the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-extra-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, extraWritable: [extra, extra, ws] })
    expect(roots).toContain(realpathSync.native(extra))
    expect(roots.filter(root => root === realpathSync.native(extra))).toHaveLength(1)
    expect(roots.filter(root => root === realpathSync.native(ws))).toHaveLength(1)
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(realpathSync.native(ws))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(roots).size).toBe(roots.length)
  })
})
