/**
 * Tests for the sticky-session-grant kit: the `sandbox/grant` write path, the
 * log fold (reset by the next `sandbox/mode` switch), and the coverage rule
 * (mode match, bash and filesystem scopes kept disjoint).
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  effectiveGrants, grantCovers, grantSandbox, setSandboxMode,
} from '@deepseek-ai/dsh-sandbox-policy'

function session(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 0,
  })
}

describe('effectiveGrants', () => {
  it('is empty without grant events', () => {
    const created = session('s0')
    expect(effectiveGrants(created.events)).toEqual([])
  })

  it('collects grants in log order, rootless and rooted alike', () => {
    const created = session('s1')
    grantSandbox(created, { mode: 'workspace-write' })
    grantSandbox(created, { mode: 'workspace-write', root: '/repo' })
    expect(effectiveGrants(created.events)).toEqual([
      { mode: 'workspace-write' },
      { mode: 'workspace-write', root: '/repo' },
    ])
  })

  it('drops every earlier grant at the next sandbox/mode switch', () => {
    const created = session('s2')
    grantSandbox(created, { mode: 'workspace-write' })
    setSandboxMode(created, 'read-only')
    expect(effectiveGrants(created.events)).toEqual([])
    grantSandbox(created, { mode: 'read-only' })
    expect(effectiveGrants(created.events)).toEqual([{ mode: 'read-only' }])
  })
})

describe('grantSandbox', () => {
  it('appends exactly one sandbox/grant event', () => {
    const created = session('s3')
    grantSandbox(created, { mode: 'workspace-write' })
    const appends = created.events.filter((event: SessionEvent) => event.type === 'sandbox/grant')
    expect(appends).toHaveLength(1)
    expect(appends[0]?.data).toEqual({ mode: 'workspace-write' })
  })

  it('carries the covered root when one is given', () => {
    const created = session('s4')
    grantSandbox(created, { mode: 'read-only', root: '/repo/a.ts' })
    expect(effectiveGrants(created.events)).toEqual([{ mode: 'read-only', root: '/repo/a.ts' }])
  })
})

describe('grantCovers', () => {
  const rootless = [{ mode: 'workspace-write' as const }]
  const rooted = [{ mode: 'workspace-write' as const, root: '/repo' }]

  it('a rootless grant covers bash under its mode only', () => {
    expect(grantCovers(rootless, 'workspace-write')).toBe(true)
    expect(grantCovers(rootless, 'read-only')).toBe(false)
    expect(grantCovers(rootless, 'workspace-write', '/repo/a.ts')).toBe(false)
  })

  it('a rooted grant covers filesystem paths at or below its root only', () => {
    expect(grantCovers(rooted, 'workspace-write', '/repo')).toBe(true)
    expect(grantCovers(rooted, 'workspace-write', '/repo/a.ts')).toBe(true)
    expect(grantCovers(rooted, 'workspace-write', '/repo-elsewhere/a.ts')).toBe(false)
    expect(grantCovers(rooted, 'workspace-write', '/other/a.ts')).toBe(false)
    expect(grantCovers(rooted, 'workspace-write')).toBe(false)
    expect(grantCovers(rooted, 'read-only', '/repo/a.ts')).toBe(false)
  })

  it('no grants cover nothing', () => {
    expect(grantCovers([], 'workspace-write')).toBe(false)
    expect(grantCovers([], 'workspace-write', '/repo/a.ts')).toBe(false)
  })
})
