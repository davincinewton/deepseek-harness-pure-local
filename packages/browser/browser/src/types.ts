/**
 * Vocabulary for the browser-automation capability seam (`ctx.browser`). One
 * provider kind covers the whole page-operation set (navigate, snapshot, act,
 * extract, screenshot, close) because a page is one stateful resource: splitting
 * the kinds across providers would let two backends own one page.
 * @module @deepseek-ai/dsh-browser/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Navigation settle condition. `load` waits for the load event,
 * `domcontentloaded` for parsed DOM, and `networkidle2` for near-quiet network
 * activity (the practical choice for script-heavy pages).
 */
export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle2'

/**
 * The opaque owner of one managed page. The Consumer derives it from the
 * calling session so concurrent sessions never share a page; providers treat it
 * purely as a map key and never parse it.
 */
export type BrowserPageKey = Branded<'dsh-browser/page'>

/**
 * Mint a {@link BrowserPageKey} from a Consumer-derived string (typically the
 * calling session id). The Consumer owns the derivation; the seam never parses
 * the value.
 * @param value - the Consumer-derived key material.
 * @returns the branded key.
 */
export function BrowserPageKey(value: string): BrowserPageKey {
  return value as BrowserPageKey
}

/** One navigation request. The provider validates the URL against its policy. */
export interface BrowserNavigateRequest {
  readonly url: string
  /** Settle condition; the provider applies its own default when omitted. */
  readonly waitUntil?: BrowserWaitUntil
}

/** Observable state of the managed page after an operation completes. */
export interface BrowserPageStatus {
  /** The page's current URL (after redirects). */
  readonly url: string
  /** The document title at settle time. */
  readonly title: string
  /** HTTP status of the last main-document response, or `null` for client-side states with no new response. */
  readonly statusCode: number | null
}

/** Result of one navigation: the post-navigation page status. */
export type BrowserNavigateResult = BrowserPageStatus

/**
 * One addressable interactive element from a snapshot. `role`/`name` are the
 * accessible identity the model addresses back through `::-p-aria(name)` (or a
 * CSS selector); inventing a name the page does not expose would make that
 * address fail, so `name` is the accessible name verbatim or omitted.
 */
export interface BrowserSnapshotElement {
  readonly role: string
  readonly name?: string
  /** Element type when it refines the role for addressing (e.g. `textbox`, `checkbox`). */
  readonly type?: string
}

/**
 * Bounded page state for model consumption: visible text plus the addressable
 * interactive elements. The seam enforces the request's caps on the provider
 * result exactly like `dsh-web` caps search sources.
 */
export interface BrowserSnapshotResult extends BrowserPageStatus {
  /** Visible text of the document body, capped to `maxTextChars`. */
  readonly text: string
  /** Interactive elements in document order, capped to `maxElements`. */
  readonly elements: readonly BrowserSnapshotElement[]
  /** True when the seam trimmed `text` or `elements` to the requested caps. */
  readonly truncated: boolean
}

/** Caps a snapshot request carries; the seam enforces them on the result. */
export interface BrowserSnapshotLimits {
  readonly maxTextChars: number
  readonly maxElements: number
}

/** The supported page mutations. Each maps to one addressable target. */
export type BrowserActionKind = 'click' | 'fill' | 'press' | 'select'

/**
 * One page mutation. `target` is a Puppeteer selector expression the provider
 * resolves (CSS, `::-p-aria(Name)`, or `::-p-text(text)`); `value` is the text
 * for `fill`, the key for `press`, and the option for `select`.
 */
export interface BrowserActRequest {
  readonly action: BrowserActionKind
  readonly target: string
  readonly value?: string
}

/** Result of one action: the post-action page status. */
export type BrowserActResult = BrowserPageStatus

/**
 * One read request. Without `selector` the whole body text is returned; with a
 * selector and an `attribute`, the element's attribute value is returned
 * instead of its text.
 */
export interface BrowserExtractRequest {
  readonly selector?: string
  /** Attribute name; meaningful only with `selector`. */
  readonly attribute?: string
  /** Upper bound on returned characters; the seam truncates to it. */
  readonly maxChars: number
}

/** One read outcome. A successful read of a missing target is an error, not empty text. */
export interface BrowserExtractResult {
  readonly url: string
  readonly text: string
  /** True when the seam cut `text` to `maxChars`. */
  readonly truncated: boolean
}

/** One screenshot request. `fullPage` captures beyond the viewport. */
export interface BrowserScreenshotRequest {
  readonly fullPage?: boolean
}

/**
 * PNG screenshot bytes plus dimensions. Transport of the binary is in-process
 * only: the Consumer persists the bytes through the attachments seam before
 * returning, and the session log carries the attachment reference.
 */
export interface BrowserScreenshotResult {
  /** The captured page's URL, for the result envelope. */
  readonly url: string
  readonly data: Uint8Array
  readonly mediaType: 'image/png'
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/**
 * A page-operation backend. Registered with `ctx.browser.registerProvider`.
 * `id` is a stable string, unique within the seam. Lifecycle (browser process,
 * profile directory, page map) belongs entirely to the provider and must be
 * released when its registration fiber disposes.
 */
export interface BrowserProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls or launch anything. */
  available(): boolean
  /** Navigate the key's page, creating it on first use; honor `signal` for cancellation. */
  navigate(pageKey: BrowserPageKey, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserNavigateResult>
  /** Snapshot the key's page under the request caps. */
  snapshot(pageKey: BrowserPageKey, limits: BrowserSnapshotLimits, signal?: AbortSignal): Promise<BrowserSnapshotResult>
  /** Resolve `target` and perform one mutation on the key's page. */
  act(pageKey: BrowserPageKey, request: BrowserActRequest, signal?: AbortSignal): Promise<BrowserActResult>
  /** Read text (or one attribute) out of the key's page. */
  extract(pageKey: BrowserPageKey, request: BrowserExtractRequest, signal?: AbortSignal): Promise<BrowserExtractResult>
  /** Capture the key's page as PNG. */
  screenshot(pageKey: BrowserPageKey, request: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>
  /** Release the key's page. Unknown keys are a no-op so teardown is idempotent. */
  close(pageKey: BrowserPageKey): Promise<void>
}

/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes cover
 * unavailable, missing, unusable, ambiguous, or duplicate providers and
 * provider failure; the Puppeteer provider additionally distinguishes invalid
 * or blocked URLs, missing pages, action and target failures, timeouts,
 * cancellation, and provisioning failures.
 */
export class BrowserError extends HarnessError {}
