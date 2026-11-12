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
import { canonicalPath, isWithinWritable, writableRoots } from '@deepseek-ai/dsh-sandbox'

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

describe('isWithinWritable', () => {
  it('danger-full-access prompts for nothing', async () => {
    expect(await isWithinWritable({ mode: 'danger-full-access', workspaceRoot: '/does/not/exist' }, '/elsewhere/file.ts')).toBe(true)
  })

  it('workspace-write contains the canonical workspace root, its descendants, and the platform temp areas', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-within-'))
    const policy = { mode: 'workspace-write', workspaceRoot: ws } as const
    expect(await isWithinWritable(policy, ws)).toBe(true)
    expect(await isWithinWritable(policy, join(ws, 'src', 'main.ts'))).toBe(true)
    expect(await isWithinWritable(policy, join(canonicalPath(tmpdir()), 'scratch.txt'))).toBe(true)
  })

  it('workspace-write prompts for a same-prefix sibling and unrelated paths', async () => {
    // A missing root outside the temp areas: a workspace created under /tmp
    // would make its siblings contained anyway, by the /tmp writable root.
    const root = join('/dsh-roots-spec', `ws-${process.pid}-${Date.now()}`)
    const policy = { mode: 'workspace-write', workspaceRoot: root } as const
    expect(await isWithinWritable(policy, `${root}/src/main.ts`)).toBe(true)
    expect(await isWithinWritable(policy, `${root}-sibling/main.ts`)).toBe(false)
    expect(await isWithinWritable(policy, '/etc/ssl/site-ca.pem')).toBe(false)
  })

  // The reported bug: on Windows both the canonicalized workspace root and the
  // resolved target key are backslash-spelled, and a prompt gate that appends
  // `/` matched none of them — every in-workspace access prompted. Spoofing
  // `process.platform` exercises that branch on a POSIX host: no fixture path
  // exists here, so containment falls to the lexical fast path, exactly as the
  // canonical-spelling fast path serves a real win32 host.
  it('workspace-write contains backslash-spelled descendants of a Windows-spelled root', async () => {
    const hostPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const ws = 'G:\\work\\quant\\astock-ai-trader'
      const policy = { mode: 'workspace-write', workspaceRoot: ws } as const
      expect(await isWithinWritable(policy, `${ws}\\data_loader\\download_akshare_stock_data.py`)).toBe(true)
      expect(await isWithinWritable(policy, 'g:\\WORK\\quant\\astock-ai-trader\\x.py')).toBe(true)
      expect(await isWithinWritable(policy, 'G:\\work\\quant\\astock-ai-trader-old\\x.py')).toBe(false)
      expect(await isWithinWritable(policy, 'C:\\work\\quant\\astock-ai-trader\\x.py')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true })
    }
  })
})
