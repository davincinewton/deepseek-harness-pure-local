/**
 * Delegation policy through child session events appended before publication:
 * the parent's sandbox override plus the pinned `approval/policy: never`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const OUTSIDE_REFUSAL = 'it is outside the workspace and permitted roots'
const contexts: Context[] = []
let workspace: string

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inherit-')))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

async function setupWalled(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  return { ctx, parent }
}

function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'spawn',
      label: 'child task',
    }),
  }
}

function toolResultTexts(agent: Agent): string[] {
  return agent.session.events
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content
      .flatMap(block => block.content)
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(''))
}

describe('in-process policy inheritance', () => {
  it('records the parent sandbox override and the inherited approval override before publishing a spawn child', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(homedir(), `dsh-inherit-${process.pid}-spawn-blocked.txt`)
    setSandboxMode(parent.session, 'workspace-write')
    setApprovalPolicy(parent.session, 'ask')
    const parentLogLength = parent.session.events.length
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      const result = await run.result
      const child = run.localAgent as Agent

      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(toolResultTexts(child).join('\n')).toContain(OUTSIDE_REFUSAL)
      expect(result.stopReason).toBe('completed')
      expect(child.session.events.slice(0, 2)).toMatchObject([
        { type: 'sandbox/mode', seq: 0, data: { mode: 'workspace-write', source: 'delegation' } },
        { type: 'approval/policy', seq: 1, data: { policy: 'ask', source: 'delegation' } },
      ])
      expect(child.session.firstLiveSeq).toBe(0)
      expect(child.session.header.seedLength).toBeUndefined()
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('workspace-write')
      expect(ctx.approval.overrideOf(child.session)).toBe('ask')
      const request = child.session.events.find(
        (event): event is SessionEvent<'request/header'> => event.type === 'request/header',
      )
      const runtimeContext = child.session.events.find(
        (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
          && event.data.source.kind === 'plugin'
          && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt',
      )
      if (request === undefined || runtimeContext === undefined) throw new Error('child request lacks its runtime policy context')
      expect(runtimeContext.seq).toBeLessThan(request.seq)
      const contextText = runtimeContext.data.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      expect(contextText).toContain('Current DSH file policy: workspace-write')
      expect(contextText).toContain('Approval policy: ask.')
      // The statement rides runtime context; the system prompt stays uniform.
      expect(contextText).toContain('You are a delegated subagent')
      expect(request.data.header.system).not.toContain('Approval policy: ask.')
      expect(request.data.header.system).not.toContain('You are a delegated subagent')
      expect(parent.session.events).toHaveLength(parentLogLength)
    } finally {
      await run.dispose()
    }
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(homedir(), `dsh-inherit-${process.pid}-fork-blocked.txt`)
    setSandboxMode(parent.session, 'workspace-write')
    const seed = [...parent.session.events]
    setSandboxMode(parent.session, 'workspace-write')
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), { seed })
    try {
      await run.result
      const child = run.localAgent as Agent

      expect(child.session.header.seedLength).toBe(1)
      expect(child.session.firstLiveSeq).toBe(seed.length)
      // seq 1 is the constructor's end-seed marker.
      expect(child.session.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
        { seq: 0, data: { mode: 'workspace-write' } },
        { seq: 2, data: { mode: 'workspace-write', source: 'delegation' } },
      ])
      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('workspace-write')

      setSandboxMode(child.session, 'danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    } finally {
      await run.dispose()
    }
  })

  it('captures policy at delegation before asynchronous child creation', async () => {
    const script: Script = [textResponse('child done')]
    const { ctx, parent } = await setupWalled(script)
    setSandboxMode(parent.session, 'workspace-write')

    const starting = startInProcessRun(spawnRequest(parent), {})
    setSandboxMode(parent.session, 'danger-full-access')
    const run = await starting
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('workspace-write')
    } finally {
      await run.dispose()
    }
  })

  it('seeds neither knob for an unswitched parent — the child resolves the same defaults', async () => {
    const script: Script = []
    const { parent } = await setupWalled(script)
    const allowed = join(workspace, 'default-allowed.txt')
    script.push(
      toolCallResponse('write', 'write', { file_path: allowed, content: 'fine' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(await readFile(allowed, 'utf8')).toBe('fine')
      expect(child.session.events.some(event => event.type === 'sandbox/mode')).toBe(false)
      expect(child.session.events.some(event => event.type === 'approval/policy')).toBe(false)
      expect(child.session.firstLiveSeq).toBe(0)
    } finally {
      await run.dispose()
    }
  })

  it('routes a child outside-workspace prompt to the session answerer and honors the one-shot grant', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    // The parent runs the approval default (ask) without an override; the
    // child resolves the same default, so its prompt reaches this answerer.
    const granted: unknown[] = []
    ctx.on('approval/request', (req) => {
      granted.push(req.toolName)
      return Promise.resolve('allowed-once' as const)
    }, { prepend: true })
    const target = join(homedir(), `dsh-inherit-${process.pid}-ask-granted.txt`)
    rmSync(target, { force: true })
    script.push(
      toolCallResponse('write', 'write', { file_path: target, content: 'granted' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(granted).toEqual(['write'])
      expect(await readFile(target, 'utf8')).toBe('granted')
      const asked = child.session.events.find(e => e.type === 'approval/asked')
      const decided = child.session.events.find(e => e.type === 'approval/decided')
      expect(asked).toBeDefined()
      expect(decided?.data).toMatchObject({ outcome: 'allowed-once' })
    } finally {
      rmSync(target, { force: true })
      await run.dispose()
    }
  })

  it('refuses a child outside-workspace write deterministically when the parent pinned never', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    // A granting answerer proves the inherited pin resolves before it runs.
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const blocked = join(homedir(), `dsh-inherit-${process.pid}-escalation-blocked.txt`)
    rmSync(blocked, { force: true })
    setSandboxMode(parent.session, 'workspace-write')
    setApprovalPolicy(parent.session, 'never')
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent as Agent

      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(consulted).toBe(false)
      expect(toolResultTexts(child).join('\n')).toContain(OUTSIDE_REFUSAL)
      const asked = child.session.events.find(
        (event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked',
      )
      const decided = child.session.events.find(
        (event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided',
      )
      expect(asked?.data.toolName).toBe('write')
      expect(decided?.data).toMatchObject({ id: asked?.data.id, outcome: 'rejected' })
    } finally {
      rmSync(blocked, { force: true })
      await run.dispose()
    }
  })
})
