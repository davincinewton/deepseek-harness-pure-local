/**
 * Tests for the sandbox-policy home: the deployment default (mode +
 * workspaceRoot) the service exposes, and the per-session `sandbox/mode`
 * override kit (fold + write path) every enforcing capability reads.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mounted(config: { mode?: 'workspace-write' | 'danger-full-access'; workspaceRoot?: string; extraWritable?: string[] } = {}) {
  const ctx = new Context()
  await ctx.plugin(SandboxPolicyService, config)
  return ctx
}

function session(id: string, cwd?: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 0,
    ...cwd === undefined ? {} : { cwd },
  })
}

function agentFor(activeSession: Session): Agent {
  return { session: activeSession } as unknown as Agent
}

async function policyContext(ctx: Context, activeSession: Session): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent: agentFor(activeSession) }))
    .contexts.find(context => context.name === 'sandbox:policy')?.text
}

describe('SandboxPolicyService', () => {
  it('defaults to workspace-write (Mode A) under the process cwd', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve(process.cwd()))
  })

  it('carries a configured mode and resolves the workspace root absolute', async () => {
    const ctx = await mounted({ mode: 'danger-full-access', workspaceRoot: '/ws/../ws/./sub' })
    expect(ctx.sandboxPolicy.defaultMode).toBe('danger-full-access')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve('/ws/../ws/./sub'))
  })

  describe('the extraWritable allow-set (D1)', () => {
    // Mirrors the service's resolveWorkspaceRoot: resolve(canonicalPath(..)).
    const expectRoot = (svc: { extraWritable: readonly string[] }, rel: string) =>
      expect(svc.extraWritable).toContain(resolve(canonicalPath(join(homedir(), rel))))

    it('defaults to the task-infrastructure table (package caches, tool data dirs)', async () => {
      const ctx = await mounted()
      if (process.platform === 'win32') {
        expect(ctx.sandboxPolicy.extraWritable).toContain(resolve(canonicalPath(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))))
      } else {
        expectRoot(ctx.sandboxPolicy, '.cache')
      }
      expectRoot(ctx.sandboxPolicy, '.npm')
      expect(ctx.sandboxPolicy.extraWritable.every(root => isAbsolute(root))).toBe(true)
    })

    it('config replaces the default table wholesale and expands ~', async () => {
      const ctx = await mounted({ extraWritable: ['~/custom-cache'] })
      expect(ctx.sandboxPolicy.extraWritable).toHaveLength(1)
      expectRoot(ctx.sandboxPolicy, 'custom-cache')
    })

    it('an explicit empty list omits the field from resolved policies', async () => {
      const ctx = await mounted({ extraWritable: [] })
      expect(ctx.sandboxPolicy.extraWritable).toEqual([])
      expect(ctx.sandboxPolicy.resolve()).not.toHaveProperty('extraWritable')
    })

    // The allow-set must reach backends grantable: the Landlock launcher
    // opens every rule path and fails closed on a missing one (the host bug
    // this pins: a default table entry like ~/.cargo on a host without Rust
    // made every confined command refuse to start).
    it('resolve() grants only the allow-set roots that exist on this host', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-policy-extra-'))
      try {
        const present = join(root, 'cache')
        const absent = join(root, 'cargo')
        mkdirSync(present)
        const ctx = await mounted({ extraWritable: [absent, present] })
        // The configured table is reported intact; only the resolved policy is filtered.
        expect(ctx.sandboxPolicy.extraWritable).toEqual([resolve(canonicalPath(absent)), resolve(canonicalPath(present))])
        expect(ctx.sandboxPolicy.resolve().extraWritable).toEqual([resolve(canonicalPath(present))])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('resolve() omits the field when every allow-set root is absent', async () => {
      const root = join(mkdtempSync(join(tmpdir(), 'dsh-policy-extra-gone-')), 'missing')
      const ctx = await mounted({ extraWritable: [root] })
      expect(ctx.sandboxPolicy.extraWritable).toHaveLength(1)
      expect(ctx.sandboxPolicy.resolve()).not.toHaveProperty('extraWritable')
    })
  })

  it('resolves the deployment policy for an agentless call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-agentless-'))
    try {
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', extraWritable: [root] })
      expect(ctx.sandboxPolicy.resolve()).toEqual({
        mode: 'workspace-write',
        workspaceRoot: resolve('/fallback'),
        extraWritable: [resolve(canonicalPath(root))],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves each session mode and cwd together without changing the fallback', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'dsh-policy-session-extra-'))
    try {
      const expectedExtra = [resolve(canonicalPath(extra))]
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', extraWritable: [extra] })
      const first = session('sess-first', '/projects/first')
      const second = session('sess-second', '/projects/second')
      setSandboxMode(second, 'danger-full-access')

      expect(ctx.sandboxPolicy.resolve({ session: first })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: resolve('/projects/first'),
        extraWritable: expectedExtra,
        sessionId: 'sess-first',
      })
      expect(ctx.sandboxPolicy.resolve({ session: second })).toEqual({
        mode: 'danger-full-access',
        workspaceRoot: resolve('/projects/second'),
        extraWritable: expectedExtra,
        sessionId: 'sess-second',
      })
      expect(ctx.sandboxPolicy.overrideOf(first)).toBeUndefined()
      expect(ctx.sandboxPolicy.overrideOf(second)).toBe('danger-full-access')
      expect(ctx.sandboxPolicy.resolve()).toEqual({
        mode: 'workspace-write',
        workspaceRoot: resolve('/fallback'),
        extraWritable: expectedExtra,
      })
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('resolves a symlink-sensitive session cwd with POSIX component semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-cwd-'))
    try {
      const lexical = join(root, 'lexical')
      const physical = join(root, 'physical')
      const child = join(physical, 'child')
      mkdirSync(lexical)
      mkdirSync(child, { recursive: true })
      const link = join(lexical, 'link')
      symlinkSync(child, link, 'dir')
      const cwd = `${link}${sep}..`
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', extraWritable: [] })

      expect(ctx.sandboxPolicy.resolve({ session: session('sess-symlink-parent', cwd) })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: realpathSync.native(physical),
        sessionId: 'sess-symlink-parent',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets an approved mode outrank the session mode while retaining its root', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback', extraWritable: [] })
    const active = session('sess-approved', '/projects/approved')
    setSandboxMode(active, 'workspace-write')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access',
      workspaceRoot: resolve('/projects/approved'),
      sessionId: 'sess-approved',
    })
  })

  it('uses the configured root when a session has no cwd', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-no-cwd') }).workspaceRoot).toBe(resolve('/fallback'))
  })

  it('rejects a mode outside the closed vocabulary at load', async () => {
    const ctx = new Context()
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { mode: 'yolo' as never })).rejects.toThrow()
  })

  it('disposes the service and context contribution from a child fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin(SandboxPolicyService, {})
    expect(ctx.sandboxPolicy).toBeDefined()
    expect(await policyContext(ctx, session('sess-hmr'))).toContain('workspace-write')
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')).toBeUndefined()
  })
})

describe('sandbox:policy request context', () => {
  async function promptMounted(config: { mode?: 'workspace-write' | 'danger-full-access'; workspaceRoot?: string } = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SandboxPolicyService, config)
    return ctx
  }

  it.each(['workspace-write', 'danger-full-access'] as const)('renders the exact %s policy without a capability inventory', async (mode) => {
    const ctx = await promptMounted({ mode, workspaceRoot: '/fallback' })
    const workspaceRoot = resolve('/projects/current')
    const expected = {
      'workspace-write': `Current DSH file policy: workspace-write. File operations enforced by the DSH file sandbox may modify the session workspace ${JSON.stringify(workspaceRoot)}, the platform temp areas, and the configured task-infrastructure roots without asking; anything outside them prompts the user (allow once, or full access for the session). Confined commands are kernel-confined to the same write set.`,
      'danger-full-access': 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
    } as const

    expect(await policyContext(ctx, session(`sess-${mode}`, '/projects/../projects/current'))).toBe(expected[mode])
  })

  it('keeps the complete rendered prompt byte-stable across TMPDIR changes', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write' })
    const active = session('sess-tmpdir-stability', '/projects/current')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = '/tmp/first-host-temp'
      const firstAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      const firstPrompt = renderPrompt(firstAssembly)
      const firstContext = renderContextSnapshot(firstAssembly)
      process.env.TMPDIR = '/tmp/second-host-temp'
      const secondAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      expect(renderPrompt(secondAssembly)).toBe(firstPrompt)
      expect(renderContextSnapshot(secondAssembly)).toBe(firstContext)
      expect(firstContext).not.toContain('host-temp')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('reflects the latest durable switch on the next assembly and stays byte-stable otherwise', async () => {
    const ctx = await promptMounted()
    const active = session('sess-switch', '/projects/current')
    const first = await policyContext(ctx, active)
    expect(await policyContext(ctx, active)).toBe(first)

    setSandboxMode(active, 'danger-full-access')
    const danger = await policyContext(ctx, active)
    expect(danger).toBe('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.')
    expect(await policyContext(ctx, active)).toBe(danger)

    setSandboxMode(active, 'workspace-write')
    expect(await policyContext(ctx, active)).toBe(`Current DSH file policy: workspace-write. File operations enforced by the DSH file sandbox may modify the session workspace ${JSON.stringify(resolve('/projects/current'))}, the platform temp areas, and the configured task-infrastructure roots without asking; anything outside them prompts the user (allow once, or full access for the session). Confined commands are kernel-confined to the same write set.`)
  })

  it('reconstructs resumed policy from the session log and omits diagnostics without an agent', async () => {
    const active = session('sess-resume', '/projects/current')
    setSandboxMode(active, 'workspace-write')
    const resumed = Session.create(active.id, active.events, active.header)
    const ctx = await promptMounted({ mode: 'danger-full-access' })

    expect(await policyContext(ctx, resumed)).toContain('workspace-write')
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')?.text).toBe('')
  })
})

describe('the sandbox/mode session kit', () => {
  it('SANDBOX_MODES lists every mode for advertisement and validation', () => {
    expect(SANDBOX_MODES).toEqual(['workspace-write', 'danger-full-access'])
  })

  it('effectiveSandboxMode folds to the last switch, or undefined without one', () => {
    const session = Session.create(SessionId('sess-fold'))
    expect(effectiveSandboxMode(session.events)).toBeUndefined()
    setSandboxMode(session, 'danger-full-access')
    setSandboxMode(session, 'workspace-write')
    expect(effectiveSandboxMode(session.events)).toBe('workspace-write')
  })

  it('setSandboxMode appends exactly one sandbox/mode event per switch', () => {
    const session = Session.create(SessionId('sess-write'))
    setSandboxMode(session, 'danger-full-access')
    const modeEvents = session.events.filter(e => e.type === 'sandbox/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ mode: 'danger-full-access' })
  })
})
