/**
 * Model-facing browser tools (`browser_navigate`, `browser_snapshot`,
 * `browser_act`, `browser_extract`, `browser_screenshot`, `browser_close`) over
 * `ctx.browser`. This package owns schemas, validation, prompt guidance,
 * budgets, approval gating, and presentation, never a browser driver.
 * Enablement controls tool registration; an enabled tool remains visible when
 * its provider is unavailable and fails with a structured error at execution
 * time. `browser_screenshot` registers only while an attachments store is
 * mounted (image blocks need durable references); `browser_act` asks the
 * approval seam before touching the page while `actRequiresApproval` is set.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-browser'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  applyBrowserActTool,
  applyBrowserCloseTool,
  applyBrowserExtractTool,
  applyBrowserNavigateTool,
  applyBrowserScreenshotTool,
  applyBrowserSnapshotTool,
} from './tools.ts'
import type { BrowserToolOptions } from './tools.ts'

export {
  applyBrowserActTool,
  applyBrowserCloseTool,
  applyBrowserExtractTool,
  applyBrowserNavigateTool,
  applyBrowserScreenshotTool,
  applyBrowserSnapshotTool,
  derivePageKey,
} from './tools.ts'
export type { BrowserToolOptions } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** Services required by the browser tool suite. */
export const inject = ['tools', 'browser', 'systemPrompt']

/** Default cooperative tool-call timeout budgets (ms), per tool family. */
export const DEFAULT_BROWSER_TOOL_TIMEOUTS = {
  navigateMs: 60_000,
  actMs: 20_000,
  readMs: 20_000,
  screenshotMs: 30_000,
} as const

/** Plugin config: which browser tools to register, the act approval gate, budgets, and model budgets. */
export interface Config {
  /** Register `browser_navigate`. Defaults to true. */
  navigate?: boolean
  /** Register `browser_snapshot`. Defaults to true. */
  snapshot?: boolean
  /** Register `browser_act`. Defaults to true. */
  act?: boolean
  /** Register `browser_extract`. Defaults to true. */
  extract?: boolean
  /** Register `browser_screenshot` (requires a mounted attachments store). Defaults to true. */
  screenshot?: boolean
  /** Register `browser_close`. Defaults to true. */
  close?: boolean
  /** Ask the approval seam before every `browser_act`. Defaults to true. */
  actRequiresApproval?: boolean
  /** Cooperative timeout budget (ms) for `browser_navigate`. Defaults to 60000. */
  navigateTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `browser_act`. Defaults to 20000. */
  actTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `browser_snapshot`/`browser_extract`/`browser_close`. Defaults to 20000. */
  readTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `browser_screenshot`. Defaults to 30000. */
  screenshotTimeoutMs?: number
  /** Cap on snapshot visible text. Defaults to 20000. */
  snapshotMaxTextChars?: number
  /** Cap on snapshot interactive elements. Defaults to 120. */
  snapshotMaxElements?: number
  /** Default and hard cap on `browser_extract` characters. Defaults to 100000. */
  extractMaxChars?: number
}

export const Config: z<Config> = z.object({
  navigate: z.boolean().default(true),
  snapshot: z.boolean().default(true),
  act: z.boolean().default(true),
  extract: z.boolean().default(true),
  screenshot: z.boolean().default(true),
  close: z.boolean().default(true),
  actRequiresApproval: z.boolean().default(true),
  navigateTimeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUTS.navigateMs),
  actTimeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUTS.actMs),
  readTimeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUTS.readMs),
  screenshotTimeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUTS.screenshotMs),
  snapshotMaxTextChars: z.number().default(20_000),
  snapshotMaxElements: z.number().default(120),
  extractMaxChars: z.number().default(100_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A time or budget cap must be a positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-browser: ${name} must be a positive integer`)
  }
}

/**
 * Register the enabled browser tools. Each tool's cooperative timeout budget is
 * attached as `ToolDefinition.timeoutMs` for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce. The tools' disposers
 * are fiber-scoped (the effect-based registries clean up on dispose), so no
 * manual teardown is needed.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('navigateTimeoutMs', resolved.navigateTimeoutMs)
  assertPositiveInteger('actTimeoutMs', resolved.actTimeoutMs)
  assertPositiveInteger('readTimeoutMs', resolved.readTimeoutMs)
  assertPositiveInteger('screenshotTimeoutMs', resolved.screenshotTimeoutMs)
  assertPositiveInteger('snapshotMaxTextChars', resolved.snapshotMaxTextChars)
  assertPositiveInteger('snapshotMaxElements', resolved.snapshotMaxElements)
  assertPositiveInteger('extractMaxChars', resolved.extractMaxChars)
  const options: BrowserToolOptions = {
    actRequiresApproval: resolved.actRequiresApproval,
    navigateTimeoutMs: resolved.navigateTimeoutMs,
    actTimeoutMs: resolved.actTimeoutMs,
    readTimeoutMs: resolved.readTimeoutMs,
    screenshotTimeoutMs: resolved.screenshotTimeoutMs,
    snapshotMaxTextChars: resolved.snapshotMaxTextChars,
    snapshotMaxElements: resolved.snapshotMaxElements,
    extractMaxChars: resolved.extractMaxChars,
  }

  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 115,
    text: 'Use the browser_* tools to drive one managed headless browser page for this session: browser_navigate opens an HTTP(S) URL, browser_snapshot returns the page text plus interactive elements (address elements back as ::-p-aria(<exact name>)), browser_act clicks/fills/presses/selects one element, browser_extract reads page or element text, browser_screenshot captures the page as an image, and browser_close releases the page.',
  })

  if (resolved.navigate) applyBrowserNavigateTool(ctx, options)
  if (resolved.snapshot) applyBrowserSnapshotTool(ctx, options)
  if (resolved.act) {
    // With `actRequiresApproval` set, the strict sequence runs through the
    // approval seam; a composition without the seam fails every gated call
    // loudly at execution time rather than silently dropping the tool (the
    // web tools' visible-but-unavailable posture).
    applyBrowserActTool(ctx, options, resolved.actRequiresApproval
      ? async (exec: ToolExecution, reason: string) => {
        const approval = ctx.get('approval')
        if (approval === undefined) {
          throw new Error('browser_act requires approval (actRequiresApproval), but no approval service is mounted; mount the approval seam or set actRequiresApproval: false')
        }
        if (exec.agent === undefined) {
          throw new Error('browser_act requires approval, but the call carries no agent to ask through')
        }
        return approval.request({
          agent: exec.agent,
          toolName: 'browser_act',
          callId: exec.callId,
          reason,
          signal: exec.signal,
        })
      }
      : undefined)
  }
  if (resolved.extract) applyBrowserExtractTool(ctx, options)
  if (resolved.screenshot) {
    // Image blocks reference durable attachments; without a store the tool
    // cannot honor its output contract, so it is not registered at all
    // (mirrors the read_image attachments gate).
    ctx.inject(['attachments'], (scope: Context) => {
      applyBrowserScreenshotTool(scope, options)
    })
  }
  if (resolved.close) applyBrowserCloseTool(ctx, options)
}
