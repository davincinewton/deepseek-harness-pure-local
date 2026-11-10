/**
 * Permission-rule gating for the `write`/`edit` tools against the real local
 * backend: a deny rule blocks the mutation before anything touches disk, an
 * ask rule prompts through `ctx.approval` (fail-closed without a channel), and
 * the default (no rules) keeps the standing fence behavior unchanged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

/** An approval-capable fake agent: an open turn the approval audit pair can append to. */
function fakeAgent() {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [{ type: 'turn/start' }]
  const id = SessionId('rules-session')
  return {
    id,
    session: {
      id,
      header: { version: 0, id, createdAt: 0 },
      events,
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        return event
      },
    },
  }
}

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>> | undefined

async function setup(withApproval: boolean, rules: { allow?: string[]; ask?: string[]; deny?: string[] } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-rules-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  if (withApproval) await ctx.plugin(ApprovalService)
  fiber = await ctx.plugin(ToolFs, { rules })
}

afterEach(async () => {
  await fiber?.dispose()
  fiber = undefined
  await rm(dir, { recursive: true, force: true })
})

let callCounter = 0
function call(name: string, args: unknown, withAgent = true) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`rules-call-${++callCounter}`),
    name,
    arguments: args,
    ...withAgent ? { agent: fakeAgent() as never } : {},
  })
}

/** Execute against a stable agent so a recorded grant is visible to later calls. */
function callWith(agent: ReturnType<typeof fakeAgent>, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`rules-call-${++callCounter}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('fs permission rules', () => {
  it('without rules the write path is unchanged', async () => {
    await setup(false)
    const result = await call('write', { file_path: 'plain.txt', content: 'ok' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'plain.txt'), 'utf8')).toBe('ok')
  })

  it('a deny rule blocks the write before anything touches disk', async () => {
    await setup(false, { deny: ['Write(.env)'] })
    const result = await call('write', { file_path: '.env', content: 'SECRET=1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('denied by a permission rule')
    await expect(readFile(join(dir, '.env'), 'utf8')).rejects.toThrow()
  })

  it('a deny rule blocks edit too', async () => {
    await setup(false, { deny: ['Edit(*/secret.txt)'] })
    const result = await call('edit', { file_path: 'a/secret.txt', old_string: 'x', new_string: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('denied by a permission rule')
  })

  it('an unmatched rule leaves the mutation free', async () => {
    await setup(false, { deny: ['Write(.env)'] })
    const result = await call('write', { file_path: 'safe.txt', content: 'ok' })
    expect(result.isError).toBe(false)
  })

  it('an ask rule prompts and proceeds once approved', async () => {
    await setup(true, { ask: ['Write(private-ask.txt)'] })
    const prompted = vi.fn()
    ctx.on('approval/request', () => { prompted(); return Promise.resolve<ApprovalOutcome>('allowed-once') })
    const result = await call('write', { file_path: 'private-ask.txt', content: 'v' })
    expect(prompted).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'private-ask.txt'), 'utf8')).toBe('v')
  })

  it('an ask rule rejects when the user denies', async () => {
    await setup(true, { ask: ['Write(private-ask.txt)'] })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
    const result = await call('write', { file_path: 'private-ask.txt', content: 'v' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('was not approved (outcome: rejected)')
  })

  it('an ask rule fails closed without an approval channel', async () => {
    await setup(false, { ask: ['Write(private-ask.txt)'] })
    const result = await call('write', { file_path: 'private-ask.txt', content: 'v' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel is available')
  })

  it('an ask rule fails closed with no agent to route through', async () => {
    await setup(true, { ask: ['Write(private-ask.txt)'] })
    const result = await call('write', { file_path: 'private-ask.txt', content: 'v' }, false)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel is available')
  })

  it('a malformed rule text fails the composition at load', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-rules-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await expect(ctx.plugin(ToolFs, { rules: { deny: ['Write(unclosed'] } })).rejects.toThrow(/invalid permission rule/)
  })

  it('"allow for session" records one grant covering that path and skips later prompts', async () => {
    await setup(true, { ask: ['Write(*)'] })
    const asked = vi.fn()
    ctx.on('approval/request', (req) => {
      expect(req.allowSession).toBe(true)
      asked()
      return Promise.resolve<ApprovalOutcome>('allowed-for-session')
    })
    const agent = fakeAgent()
    expect((await callWith(agent, 'write', { file_path: 'gated.txt', content: 'v' })).isError).toBe(false)
    const grants = agent.session.events.filter(event => event.type === 'sandbox/grant')
    expect(grants).toHaveLength(1)
    expect(grants[0]?.data).toEqual({ mode: 'danger-full-access', root: join(dir, 'gated.txt') })
    // The granted path is free; a sibling path still prompts.
    expect((await callWith(agent, 'write', { file_path: 'gated.txt', content: 'v2' })).isError).toBe(false)
    expect(asked).toHaveBeenCalledTimes(1)
    expect((await callWith(agent, 'write', { file_path: 'sibling.txt', content: 's' })).isError).toBe(false)
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('a sandbox/mode switch revokes the fs grant', async () => {
    await setup(true, { ask: ['Write(*)'] })
    const asked = vi.fn()
    ctx.on('approval/request', () => { asked(); return Promise.resolve<ApprovalOutcome>('rejected') })
    const agent = fakeAgent()
    agent.session.append('sandbox/grant', { mode: 'danger-full-access', root: join(dir, 'gated.txt') })
    expect((await callWith(agent, 'write', { file_path: 'gated.txt', content: 'v' })).isError).toBe(false)
    expect(asked).not.toHaveBeenCalled()
    agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    expect((await callWith(agent, 'write', { file_path: 'gated.txt', content: 'v' })).isError).toBe(true)
    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('a deny rule blocks a path even when a grant covers it', async () => {
    await setup(true, { deny: ['Write(gated.txt)'] })
    const agent = fakeAgent()
    agent.session.append('sandbox/grant', { mode: 'danger-full-access', root: join(dir, 'gated.txt') })
    const result = await callWith(agent, 'write', { file_path: 'gated.txt', content: 'v' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('denied by a permission rule')
  })
})
