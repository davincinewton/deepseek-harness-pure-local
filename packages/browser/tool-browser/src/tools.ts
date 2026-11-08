/**
 * The six model-facing browser tools over `ctx.browser`: one managed page per
 * calling session, addressed as a sequence of `navigate → snapshot → act →
 * extract/screenshot` steps. Page state persists between calls; `browser_close`
 * releases it. This module owns schemas, validation, budgets, approval gating,
 * and presentation; the seam and provider own retrieval and execution.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolCallKind, ToolExecution } from '@deepseek-ai/dsh-tools'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BrowserPageKey } from '@deepseek-ai/dsh-browser'
import type { BrowserActRequest, BrowserNavigateRequest, BrowserPageStatus, BrowserScreenshotRequest, BrowserSnapshotElement, BrowserSnapshotLimits } from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Resolved Consumer budgets and gates (from plugin config). */
export interface BrowserToolOptions {
  readonly actRequiresApproval: boolean
  readonly navigateTimeoutMs: number
  readonly actTimeoutMs: number
  readonly readTimeoutMs: number
  readonly screenshotTimeoutMs: number
  readonly snapshotMaxTextChars: number
  readonly snapshotMaxElements: number
  readonly extractMaxChars: number
}

/**
 * The canonical page-status output fields shared by navigate and act.
 * `statusCode` is omitted when the state has no fresh main-document response
 * (client-side navigation, post-act settle).
 */
const pageStatusProperties = {
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
  statusCode: { type: 'integer' },
} as const

/** The canonical output value of navigate/act results. */
interface PageStatusValue {
  url: string
  title: string
  statusCode?: number
}

/** A page snapshot's canonical value. */
interface SnapshotValue extends PageStatusValue {
  text: string
  elements: { role: string; name?: string; type?: string }[]
  truncated: boolean
}

/** A screenshot's canonical value: the durable attachment plus its envelope. */
interface ScreenshotValue {
  url: string
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** Project a seam page status onto the canonical omit-null shape. */
function statusValue(status: BrowserPageStatus): PageStatusValue {
  return {
    url: status.url,
    title: status.title,
    ...(status.statusCode === null ? {} : { statusCode: status.statusCode }),
  }
}

/**
 * Derive the calling caller's page key. Sessions own one page each; a direct
 * caller without an agent (tests, service-level calls) shares the `default` key.
 * @param exec - the tool execution context.
 * @returns the branded page key for this caller.
 */
export function derivePageKey(exec: ToolExecution) {
  return BrowserPageKey(exec.agent?.session.id ?? 'default')
}

/**
 * Refuse a screenshot when the calling model route cannot carry image input,
 * mirroring the `read_image` route gate: an image block for a non-vision model
 * would fail the NEXT request rather than this call.
 * @param ctx - the plugin context used to resolve the optional `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 */
async function assertImageCapableModel(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot capture a screenshot: the current model route could not be resolved')
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`cannot capture a screenshot: model "${model}" does not declare image input; switch to an image-capable model to capture screenshots`)
  }
}

/** Re-brand a canonical screenshot value into the `ImageBlock` attachment ref. */
function imageRefFromValue(value: ScreenshotValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType as ImageAttachmentRef['mediaType'],
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    name: 'browser-screenshot.png',
  }
}

/** Shared renderer for navigate/act page-status results. */
function renderStatus(label: string, value: PageStatusValue): { type: 'text'; text: string }[] {
  const status = value.statusCode === undefined ? '' : ` (HTTP ${value.statusCode})`
  return [{ type: 'text', text: `${label}: ${value.url}${status}\nTitle: ${value.title}` }]
}

/** Pending-card presenter for the page tools (generic card, distinct kinds). */
function statusCall(title: string, kind: ToolCallKind, rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/**
 * Register `browser_navigate`: open (or redirect) the caller's managed page.
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 */
export function applyBrowserNavigateTool(ctx: Context, options: BrowserToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the managed browser page to an HTTP(S) URL and return its final URL, title, and HTTP status. The page persists across browser_* calls; a second call navigates the same page.',
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to open.' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle2'], description: 'Settle condition. Defaults to "load"; use "networkidle2" for script-heavy pages.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: pageStatusProperties },
      render: (_args, value) => renderStatus('Navigated', value),
    },
    timeoutMs: options.navigateTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.url.trim().length === 0) throw new Error('url must be a non-empty string')
      const request: BrowserNavigateRequest = { url: args.url, ...(args.waitUntil === undefined ? {} : { waitUntil: args.waitUntil }) }
      const result = await ctx.browser.navigate(derivePageKey(exec), request, exec.signal)
      return statusValue(result)
    },
    presentCall: args => statusCall(`Browse ${args.url}`, 'fetch', args.url),
  }))
}

/**
 * Register `browser_snapshot`: the bounded page state the model plans against
 * — visible text plus addressable interactive elements (address elements back
 * with `::-p-aria(<name>)`).
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 */
export function applyBrowserSnapshotTool(ctx: Context, options: BrowserToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return the managed page\'s visible text and its interactive elements (role + accessible name). Address an element later as ::-p-aria(<exact name>) or a CSS selector.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...pageStatusProperties,
          text: { type: 'string', required: true },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                name: { type: 'string' },
                type: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [...renderStatus('Snapshot', value), { type: 'text', text: renderSnapshotText(value) }],
    },
    timeoutMs: options.readTimeoutMs,
    // A snapshot reads but never mutates; overlapping snapshots of one page are
    // still ordered by the registry's exclusive scheduling of sibling writes.
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const limits: BrowserSnapshotLimits = { maxTextChars: options.snapshotMaxTextChars, maxElements: options.snapshotMaxElements }
      const result = await ctx.browser.snapshot(derivePageKey(exec), limits, exec.signal)
      return {
        ...statusValue(result),
        text: result.text,
        elements: result.elements.map((element: BrowserSnapshotElement) => ({
          role: element.role,
          ...(element.name === undefined ? {} : { name: element.name }),
          ...(element.type === undefined ? {} : { type: element.type }),
        })),
        truncated: result.truncated,
      }
    },
    presentCall: () => statusCall('Page snapshot', 'read'),
  }))
}

/** Render one snapshot's element list beside its text. */
function renderSnapshotText(value: SnapshotValue): string {
  const elements = value.elements
    .map(element => [`[${element.role}${element.type === undefined ? '' : ':' + element.type}]`, element.name ?? '(unlabeled)'].join(' '))
  const footer = value.truncated ? '\n(truncated — extract a specific element or selector for more)' : ''
  return `Elements:\n${elements.length > 0 ? elements.join('\n') : '(none interactive found)'}\n\nText:\n${value.text}${footer}`
}

/**
 * Register `browser_act`: click/fill/press/select one element of the managed
 * page. When `actRequiresApproval` is configured, the call asks the approval
 * seam first and runs only on an `'allowed-once'` outcome.
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 * @param requestApproval - the approval request path (the `approval` service),
 *   supplied by the composing plugin only when gating is configured.
 */
export function applyBrowserActTool(
  ctx: Context,
  options: BrowserToolOptions,
  requestApproval: ((exec: ToolExecution, reason: string) => Promise<string>) | undefined,
): void {
  ctx.tools.register(defineTool({
    name: 'browser_act',
    description: 'Interact with the managed page: click, fill (type into), press a key on, or select an option of one element. Target it with ::-p-aria(<exact snapshot name>), ::-p-text(<text>), or a CSS selector.',
    parameters: {
      action: { type: 'string', required: true, enum: ['click', 'fill', 'press', 'select'], description: 'The interaction to perform.' },
      target: { type: 'string', required: true, description: 'Element address: ::-p-aria(<name>), ::-p-text(<text>), or a CSS selector.' },
      value: { type: 'string', description: 'Text for "fill", key name for "press", option value for "select". Not used by "click".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: pageStatusProperties },
      render: (_args, value) => renderStatus('Acted', value),
    },
    timeoutMs: options.actTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.target.trim().length === 0) throw new Error('target must be a non-empty string')
      if (requestApproval !== undefined) {
        const valuePart = args.value === undefined ? '' : ` value "${args.value}"`
        const outcome = await requestApproval(exec, `browser_act: ${args.action} "${args.target}"${valuePart}`)
        if (outcome !== 'allowed-once') {
          throw new Error(`browser_act was not approved (outcome: ${outcome}); the page was not modified`)
        }
      }
      const request: BrowserActRequest = {
        action: args.action,
        target: args.target,
        ...(args.value === undefined ? {} : { value: args.value }),
      }
      const result = await ctx.browser.act(derivePageKey(exec), request, exec.signal)
      return statusValue(result)
    },
    presentCall: args => statusCall(`Browse ${args.action} ${args.target}`, 'execute', args.target),
  }))
}

/**
 * Register `browser_extract`: the page's (or one element's) text, or one
 * attribute value.
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 */
export function applyBrowserExtractTool(ctx: Context, options: BrowserToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'browser_extract',
    description: 'Read text from the managed page: the whole body by default, one element with a selector, or one attribute value of that element.',
    parameters: {
      selector: { type: 'string', description: 'Element address (CSS or ::-p-aria()/::-p-text()). Omit for the whole page body.' },
      attribute: { type: 'string', description: 'Attribute name to read instead of text (e.g. "href", "src"). Requires selector.' },
      maxChars: { type: 'integer', description: 'Upper bound on returned characters. Defaults to (and is capped by) the deployment limit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.text}${value.truncated ? '\n\n(text truncated)' : ''}` }],
    },
    timeoutMs: options.readTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.attribute !== undefined && args.selector === undefined) throw new Error('attribute requires a selector')
      const requested = args.maxChars ?? options.extractMaxChars
      if (!Number.isInteger(requested) || requested < 1) throw new Error('maxChars must be a positive integer')
      const maxChars = Math.min(requested, options.extractMaxChars)
      return ctx.browser.extract(derivePageKey(exec), {
        maxChars,
        ...(args.selector === undefined ? {} : { selector: args.selector }),
        ...(args.attribute === undefined ? {} : { attribute: args.attribute }),
      }, exec.signal)
    },
    presentCall: args => statusCall(`Extract ${args.selector ?? 'page text'}`, 'read', args.selector),
  }))
}

/**
 * Register `browser_screenshot` (attachments must be mounted). The PNG is
 * persisted through the attachments seam before the result is returned, so the
 * image block references a durable object exactly like `read_image`.
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 */
export function applyBrowserScreenshotTool(ctx: Context, options: BrowserToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the managed page as a PNG image so you can see it (layout, charts, anything text misses).',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page. Defaults to false (viewport only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Screenshot of ${value.url} (${value.width}x${value.height} PNG, ${value.bytes} bytes)` },
        { type: 'image', attachment: imageRefFromValue(value) },
      ],
    },
    timeoutMs: options.screenshotTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await assertImageCapableModel(ctx, exec)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('cannot capture a screenshot: no attachment service is mounted')
      const request: BrowserScreenshotRequest = { ...(args.fullPage === undefined ? {} : { fullPage: args.fullPage }) }
      const shot = await ctx.browser.screenshot(derivePageKey(exec), request, exec.signal)
      const cap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      if (shot.bytes > cap) {
        throw new Error(`screenshot is ${shot.bytes} bytes, above the ${cap}-byte image limit; retry without fullPage or extract text instead`)
      }
      const ref = await attachments.saveImage({ data: shot.data, mediaType: shot.mediaType, name: 'browser-screenshot.png' })
      return {
        url: shot.url,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      }
    },
    presentCall: () => statusCall('Page screenshot', 'read'),
  }))
}

/**
 * Register `browser_close`: release the caller's managed page (the browser
 * process stays warm for a later navigation).
 * @param ctx - context whose tools registry receives the tool.
 * @param options - resolved Consumer budgets.
 */
export function applyBrowserCloseTool(ctx: Context, options: BrowserToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the managed browser page for this session. A later browser_navigate opens a fresh one.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Browser page closed.' }],
    },
    timeoutMs: options.readTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      await ctx.browser.close(derivePageKey(exec))
      return { closed: true }
    },
    presentCall: () => statusCall('Close browser page', 'execute'),
  }))
}
