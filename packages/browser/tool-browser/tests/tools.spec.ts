import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Service } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserError } from '@deepseek-ai/dsh-browser'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'

const testToolSignal = new AbortController().signal

/** Scripted approval seam: fixed outcome, records every request. */
class ApprovalFake extends Service {
  outcome = 'allowed-once'
  readonly calls: { toolName: string; reason?: string }[] = []
  constructor(ctx: Context) {
    super(ctx, 'approval')
  }
  request(req: { toolName: string; reason?: string }): Promise<string> {
    this.calls.push(req)
    return Promise.resolve(this.outcome)
  }
}

/** Scripted attachments seam returning a fixed image ref. */
class AttachmentsFake extends Service {
  readonly imageLimits = { maxImageBytes: 1000, maxMessageImageBytes: 1000, maxImagesPerMessage: 4, mediaTypes: ['image/png'] }
  saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
    attachmentId: 'att-1',
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 100,
    height: 50,
  }))
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
}

/** Scripted llm seam for the screenshot route gate. */
class LlmFake extends Service {
  modalities: readonly string[] | undefined = ['text', 'image']
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  resolveModelInfo(): Promise<{ inputModalities?: readonly string[] }> {
    return Promise.resolve({ ...(this.modalities === undefined ? {} : { inputModalities: this.modalities }) })
  }
}

const visionAgent = {
  session: { id: 'sess-1', requestHeader: () => ({ config: { provider: 'deepseek', model: 'vision-test' } }) },
  options: {},
} as never

const plainAgent = {
  session: { id: 'sess-2', requestHeader: () => undefined },
  options: { provider: 'deepseek', model: 'vision-test' },
} as never

function fakeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    id: 'stub',
    available: () => true,
    navigate: (_key, request) => Promise.resolve({ url: request.url, title: 'T', statusCode: 200 }),
    snapshot: () => Promise.resolve({ url: 'https://x.test', title: 'T', statusCode: 200, text: 'visible text', elements: [{ role: 'link', name: 'Home' }], truncated: false }),
    act: (_key, request) => Promise.resolve({ url: `acted:${request.action}:${request.target}`, title: 'T', statusCode: null }),
    extract: (_key, request) => Promise.resolve({ url: 'https://x.test', text: 'x'.repeat(Math.min(request.maxChars, 50)), truncated: false }),
    extractList: (_key, request) => Promise.resolve({
      url: 'https://x.test',
      rows: Array.from({ length: Math.min(request.limit, 3) }, (_element, index) => ({ title: `R${index}`, href: `https://x.test/${index}` })),
      count: Math.min(request.limit, 3),
      truncated: false,
    }),
    wait: (_key, request) => Promise.resolve({ url: `waited:${request.selector ?? 'idle'}`, title: 'T', statusCode: 200 }),
    screenshot: () => Promise.resolve({ url: 'https://x.test', data: new Uint8Array(10), mediaType: 'image/png', bytes: 10, width: 100, height: 50 }),
    close: () => Promise.resolve(),
    ...overrides,
  }
}

interface MountOptions {
  config?: ToolBrowser.Config
  provider?: BrowserProvider | null
  approval?: boolean
  attachments?: boolean
  llm?: boolean
}

/** Mount real registry/seams plus fakes, and return a tool executor. */
async function mountTools(opts: MountOptions = {}): Promise<{
  ctx: Context
  approval: ApprovalFake | undefined
  call: (name: string, args: unknown, agent?: never) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime, {})
  let approval: ApprovalFake | undefined
  if (opts.approval ?? true) {
    await ctx.plugin(ApprovalFake)
    approval = ctx.get('approval') as unknown as ApprovalFake
  }
  if (opts.attachments ?? true) await ctx.plugin(AttachmentsFake)
  if (opts.llm ?? true) await ctx.plugin(LlmFake)
  if (opts.provider !== null) ctx.browser.registerProvider(opts.provider ?? fakeProvider())
  await ctx.plugin(ToolBrowser, opts.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown, agent?: never) => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++counter}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
  return { ctx, approval, call }
}

const textOf = (result: ToolExecutionResult): string =>
  result.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('\n')

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('tool-browser registration', () => {
  it('registers all eight tools by default', async () => {
    const { ctx } = await mountTools()
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_act', 'browser_extract', 'browser_extract_list', 'browser_wait', 'browser_screenshot', 'browser_close']) {
      expect(ctx.tools.get(name), name).toBeDefined()
    }
  })

  it('omits tools disabled by config and screenshot without an attachments store', async () => {
    const { ctx } = await mountTools({ config: { act: false, extract: false, extractList: false, wait: false }, attachments: false })
    expect(ctx.tools.get('browser_act')).toBeUndefined()
    expect(ctx.tools.get('browser_extract')).toBeUndefined()
    expect(ctx.tools.get('browser_extract_list')).toBeUndefined()
    expect(ctx.tools.get('browser_wait')).toBeUndefined()
    expect(ctx.tools.get('browser_screenshot')).toBeUndefined()
    expect(ctx.tools.get('browser_navigate')).toBeDefined()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolBrowser).toBe(false)
  })

  it('refuses a waitToolTimeoutMs not exceeding waitTimeoutMs at mount', async () => {
    await expect(mountTools({ config: { waitTimeoutMs: 1000, waitToolTimeoutMs: 900 } }))
      .rejects.toThrow('waitToolTimeoutMs must exceed waitTimeoutMs')
  })
})

describe('browser_navigate / browser_close', () => {
  it('navigates the session page and renders status', async () => {
    const { call } = await mountTools()
    const result = await call('browser_navigate', { url: 'https://example.com' }, visionAgent)
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Navigated: https://example.com (HTTP 200)')
  })

  it('rejects an empty url', async () => {
    const { call } = await mountTools()
    expect((await call('browser_navigate', { url: '  ' })).isError).toBe(true)
  })

  it('fails with BROWSER_PROVIDER_UNAVAILABLE when no provider is usable', async () => {
    const unavailable = fakeProvider({ available: () => false })
    const { call } = await mountTools({ provider: unavailable })
    const result = await call('browser_navigate', { url: 'https://x.test' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no usable browser provider is registered')
  })

  it('keys the page by calling session id', async () => {
    const closedKeys: string[] = []
    const { call } = await mountTools({ provider: fakeProvider({ close: (key) => { closedKeys.push(key); return Promise.resolve() } }) })
    const result = await call('browser_close', {}, visionAgent)
    expect(result.isError).toBeFalsy()
    expect(closedKeys).toEqual(['sess-1'])
  })
})

describe('browser_snapshot / browser_extract', () => {
  it('renders elements and text with the exact addressing hint', async () => {
    const { call } = await mountTools()
    const result = await call('browser_snapshot', {})
    expect(textOf(result)).toContain('[link] Home')
    expect(textOf(result)).toContain('visible text')
  })

  it('caps extract chars to the configured deployment limit', async () => {
    let seen = 0
    const { call } = await mountTools({
      config: { extractMaxChars: 10 },
      provider: fakeProvider({ extract: (_k, request) => { seen = request.maxChars; return Promise.resolve({ url: 'https://x.test', text: 'ok', truncated: false }) } }),
    })
    await call('browser_extract', { maxChars: 999999 })
    expect(seen).toBe(10)
  })

  it('refuses attribute without a selector and a non-positive maxChars', async () => {
    const { call } = await mountTools()
    expect((await call('browser_extract', { attribute: 'href' })).isError).toBe(true)
    expect((await call('browser_extract', { maxChars: 0 })).isError).toBe(true)
  })
})

describe('browser_extract_list', () => {
  it('projects rows onto named fields and renders one line per row', async () => {
    const { call } = await mountTools()
    const result = await call('browser_extract_list', {
      selector: '#rso > div',
      fields: { title: { selector: 'a h3' }, href: { selector: 'a', attribute: 'href' } },
    })
    expect(result.isError).toBeFalsy()
    const text = textOf(result)
    expect(text).toContain('Rows from https://x.test (3)')
    expect(text).toContain('title=R0 | href=https://x.test/0')
  })

  it('applies the configured default and hard row caps', async () => {
    const seen: number[] = []
    const { call } = await mountTools({
      config: { extractListDefaultLimit: 4, extractListMaxLimit: 6 },
      provider: fakeProvider({ extractList: (_k, request) => {
        seen.push(request.limit)
        return Promise.resolve({ url: 'https://x.test', rows: [], count: 0, truncated: false })
      } }),
    })
    await call('browser_extract_list', { selector: 'li', fields: { title: {} } })
    await call('browser_extract_list', { selector: 'li', fields: { title: {} }, limit: 99 })
    expect(seen).toEqual([4, 6])
  })

  it('refuses a non-positive limit or maxFieldChars', async () => {
    const { call } = await mountTools()
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: {} }, limit: 0 })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: {} }, maxFieldChars: 0 })).isError).toBe(true)
  })

  it('refuses malformed field maps before touching the page', async () => {
    const { call } = await mountTools()
    expect((await call('browser_extract_list', { selector: 'li', fields: { href: { attribute: 'href' } } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: {} })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: 'plain string' } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: ['h3'] } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: null } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: { selector: 12 } } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: 'li', fields: { title: { selector: 'h3', attribute: 7 } } })).isError).toBe(true)
    expect((await call('browser_extract_list', { selector: '  ', fields: { title: {} } })).isError).toBe(true)
  })

  it('flags truncated rows and empty results in the render', async () => {
    const { call } = await mountTools({
      provider: fakeProvider({ extractList: (_k, request) => request.selector === 'empty'
        ? Promise.resolve({ url: 'https://x.test', rows: [], count: 0, truncated: false })
        : Promise.resolve({ url: 'https://x.test', rows: [{ title: 'A' }], count: 1, truncated: true }) }),
    })
    expect(textOf(await call('browser_extract_list', { selector: 'li', fields: { title: {} } }))).toContain('(truncated')
    expect(textOf(await call('browser_extract_list', { selector: 'empty', fields: { title: {} } }))).toContain('(no rows matched)')
  })
})

describe('browser_wait', () => {
  it('waits for a selector and renders the settled status', async () => {
    const { call } = await mountTools()
    const result = await call('browser_wait', { selector: '#rso h3' })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Waited: waited:#rso h3 (HTTP 200)')
  })

  it('caps the wait budget to the configured deployment limit', async () => {
    const seen: number[] = []
    const { call } = await mountTools({
      config: { waitTimeoutMs: 900, waitToolTimeoutMs: 1200 },
      provider: fakeProvider({ wait: (_k, request) => {
        seen.push(request.timeoutMs)
        return Promise.resolve({ url: 'u', title: 't', statusCode: null })
      } }),
    })
    await call('browser_wait', { timeoutMs: 5000 })
    await call('browser_wait', {})
    expect(seen).toEqual([900, 900])
  })

  it('refuses a non-positive timeoutMs', async () => {
    const { call } = await mountTools()
    expect((await call('browser_wait', { timeoutMs: 0 })).isError).toBe(true)
  })
})

describe('browser_act approval gate', () => {
  it('asks the approval seam and runs only on allowed-once', async () => {
    const { approval, call } = await mountTools()
    const result = await call('browser_act', { action: 'click', target: '::-p-aria(Search)' }, visionAgent)
    expect(approval!.calls).toHaveLength(1)
    expect(approval!.calls[0]).toMatchObject({ toolName: 'browser_act' })
    expect(approval!.calls[0]!.reason).toContain('click')
    expect(textOf(result)).toContain('acted:click')
  })

  it('refuses a rejected outcome without touching the page', async () => {
    let touched = false
    const { ctx, approval, call } = await mountTools({
      provider: fakeProvider({ act: () => { touched = true; return Promise.resolve({ url: '', title: '', statusCode: null }) } }),
    })
    approval!.outcome = 'rejected'
    const result = await call('browser_act', { action: 'click', target: 'a' }, visionAgent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not approved (outcome: rejected)')
    expect(touched).toBe(false)
    expect(ctx.get('approval')).toBeDefined()
  })

  it('skips the gate when actRequiresApproval is false', async () => {
    const { approval, call } = await mountTools({ approval: false, config: { actRequiresApproval: false } })
    const result = await call('browser_act', { action: 'click', target: 'a' }, visionAgent)
    expect(approval).toBeUndefined()
    expect(result.isError).toBeFalsy()
  })

  it('fails loud when the gate is on but no approval service is mounted', async () => {
    const { call } = await mountTools({ approval: false })
    const result = await call('browser_act', { action: 'click', target: 'a' }, visionAgent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no approval service is mounted')
  })

  it('passes an indexed target through the gate reason and the provider request', async () => {
    const { approval, call } = await mountTools({
      provider: fakeProvider({ act: (_k, request) => Promise.resolve({ url: `acted:${request.action}:${request.index ?? 'none'}`, title: 'T', statusCode: null }) }),
    })
    const result = await call('browser_act', { action: 'click', target: 'li.r', index: 2 }, visionAgent)
    expect(textOf(result)).toContain('acted:click:2')
    expect(approval!.calls[0]!.reason).toContain('"li.r" #2')
  })

  it('rejects a negative or fractional index before the approval gate', async () => {
    const { approval, call } = await mountTools()
    expect((await call('browser_act', { action: 'click', target: 'a', index: -1 }, visionAgent)).isError).toBe(true)
    expect((await call('browser_act', { action: 'click', target: 'a', index: 1.5 }, visionAgent)).isError).toBe(true)
    expect(approval!.calls).toHaveLength(0)
  })
})

describe('browser_screenshot', () => {
  it('persists the PNG and returns a text envelope plus an image block', async () => {
    const { ctx, call } = await mountTools()
    const result = await call('browser_screenshot', { fullPage: true }, visionAgent)
    expect(result.isError).toBeFalsy()
    expect(result.content[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-1', width: 100, height: 50 } })
    const attachments = ctx.get('attachments') as unknown as AttachmentsFake
    expect(attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png' }))
  })

  it('refuses a page screenshot above the attachment byte cap', async () => {
    const { call } = await mountTools({ provider: fakeProvider({ screenshot: () => Promise.resolve({ url: 'https://x.test', data: new Uint8Array(5000), mediaType: 'image/png', bytes: 5000, width: 1, height: 1 }) }) })
    const result = await call('browser_screenshot', {}, visionAgent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('above the 1000-byte image limit')
  })

  it('refuses a non-vision model route before capturing', async () => {
    const { ctx, call } = await mountTools()
    ;(ctx.get('llm') as unknown as LlmFake).modalities = ['text']
    const result = await call('browser_screenshot', {}, visionAgent)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('does not declare image input')
  })

  it('resolves the route from agent options when the request header is absent', async () => {
    const { call } = await mountTools()
    const result = await call('browser_screenshot', {}, plainAgent)
    expect(result.isError).toBeFalsy()
  })

  it('fails when the route cannot be resolved at all', async () => {
    const { call } = await mountTools()
    const result = await call('browser_screenshot', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('model route could not be resolved')
  })
})

describe('presentation', () => {
  it('renders pending calls as titled generic cards', async () => {
    const { ctx } = await mountTools()
    const tool = ctx.tools.get('browser_navigate')!
    expect(tool.presentCall!({ url: 'https://x.test' })).toMatchObject({ card: 'generic', title: 'Browse https://x.test', kind: 'fetch' })
    const act = ctx.tools.get('browser_act')!
    expect(act.presentCall!({ action: 'click', target: 'a' })).toMatchObject({ card: 'generic', title: 'Browse click a', kind: 'execute' })
    const list = ctx.tools.get('browser_extract_list')!
    expect(list.presentCall!({ selector: '#rso', fields: {} })).toMatchObject({ card: 'generic', title: 'Extract list #rso', kind: 'read', rawInput: '#rso' })
    expect(list.isConcurrencySafe!({ selector: '#rso', fields: { title: {} } })).toBe(false)
    const wait = ctx.tools.get('browser_wait')!
    expect(wait.presentCall!({})).toMatchObject({ title: 'Wait for navigation' })
    expect(wait.presentCall!({ selector: '#x' })).toMatchObject({ title: 'Wait for #x', rawInput: '#x' })
    expect(wait.isConcurrencySafe!({})).toBe(false)
  })

  it('carries a BrowserError code through failed results', async () => {
    const { call } = await mountTools({ provider: fakeProvider({ navigate: () => Promise.reject(new BrowserError('boom', 'BROWSER_BLOCKED_URL')) }) })
    const result = await call('browser_navigate', { url: 'https://127.0.0.1' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('boom')
  })
})
