/**
 * The Puppeteer-backed `BrowserProvider`: owns the Chrome Headless Shell
 * executable (cache lookup or first-run provisioning), the single browser
 * process, one managed page per {@link BrowserPageKey}, and an ephemeral
 * profile directory. All of it is released when the registering fiber disposes:
 * pages close, the browser quits, the child process is killed, and a
 * provider-created profile directory is removed.
 * @module @deepseek-ai/dsh-browser-puppeteer/provider
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import type { Browser as PuppeteerBrowser, ElementHandle, HTTPResponse, KeyInput, Page } from 'puppeteer-core'
import { TimeoutError } from 'puppeteer-core'
import { BrowserError } from '@deepseek-ai/dsh-browser'
import type {
  BrowserActionKind,
  BrowserActRequest,
  BrowserActResult,
  BrowserExtractListRequest,
  BrowserExtractListResult,
  BrowserExtractRequest,
  BrowserExtractResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserPageKey,
  BrowserPageStatus,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSnapshotLimits,
  BrowserSnapshotResult,
  BrowserWaitRequest,
  BrowserWaitResult,
} from '@deepseek-ai/dsh-browser'
import { assertNavigationTargetAllowed, validateNavigateUrl } from './policy.ts'
import type { NavigationPolicyOptions } from './policy.ts'
import { DEFAULT_CACHE_DIR, provisionExecutable } from './provision.ts'
import type { ProvisionLog } from './provision.ts'

/** Registry id of this provider kind. */
export const PUPPETEER_PROVIDER_ID = 'puppeteer'

/**
 * Fixed launch posture, prepended to `chromeArgs`: drop the
 * `navigator.webdriver` automation flag that search engines and news sites
 * read before anything else (measured: with it set, Google answers the SERP
 * with a 429 `/sorry` wall even under a plain-Chrome user agent). Not a
 * tunable — every launch of the managed browser presents as a plain browser.
 */
const BASE_CHROME_ARGS = ['--disable-blink-features=AutomationControlled']

/** Tunables the provider was constructed with (all resolved from plugin config). */
export interface PuppeteerProviderOptions {
  /** Empty = resolve from cache or provision. */
  readonly executablePath: string
  /** Empty = `@puppeteer/browsers` default cache (`~/.cache/puppeteer`). */
  readonly cacheDir: string
  /** Empty = newest cached / current stable build. */
  readonly buildId: string
  /** `auto` provisions on demand; `off` only uses an already-present executable. */
  readonly provision: 'auto' | 'off'
  /** Empty = an ephemeral per-process profile directory, removed on dispose. */
  readonly userDataDir: string
  readonly chromeArgs: readonly string[]
  /** Page user-agent override; empty = the browser's own headless user agent. */
  readonly userAgent: string
  /** Page viewport width in CSS pixels. */
  readonly viewportWidth: number
  /** Page viewport height in CSS pixels. */
  readonly viewportHeight: number
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  /** Post-click wait for a follow-up navigation to settle (bounded, best-effort). */
  readonly actionSettleMs: number
  readonly maxUrlLength: number
  /** Hard bound on snapshot text returned across the CDP boundary. */
  readonly maxEvaluateTextChars: number
  readonly policy: NavigationPolicyOptions
  /** Progress/warning sink for provisioning and launch decisions. */
  readonly log?: ProvisionLog
}

/** Data one snapshot evaluate returns; the provider maps it into the seam shape. */
interface RawSnapshot {
  text: string
  elements: { role: string; name?: string; type?: string }[]
}

/**
 * Page-side snapshot body, kept as a string literal rather than a function:
 * `page.evaluate` serializes functions with `toString()` and runs them in the
 * page context, so any Node-side transpile helper would be undefined there —
 * the source launch transpiles with esbuild `keepNames`, which injects
 * `__name()` calls around named functions. Transpilers never rewrite string
 * literals, so the compiled {@link SNAPSHOT_PAGE_FUNCTION} is immune to
 * whatever produced the module. It is compiled rather than passed as a string
 * because Puppeteer evaluates a string page function as a bare expression and
 * passes no arguments.
 */
const SNAPSHOT_PAGE_SOURCE = `
  const text = document.body.innerText
  const selector = 'a[href], button, input, select, textarea, summary, [role], [contenteditable="true"]'
  const elements = []
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= maxElements) break
    if (el.getClientRects().length === 0) continue
    const role = el.getAttribute('role') ?? roleOf(el)
    if (role === undefined) continue
    const name = nameOf(el)
    const type = typeOf(el)
    elements.push({ role, ...(name === undefined ? {} : { name }), ...(type === undefined ? {} : { type }) })
  }
  function roleOf(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = el.type
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    return undefined
  }
  function typeOf(el) {
    return el.tagName.toLowerCase() === 'input' ? el.type : undefined
  }
  function nameOf(el) {
    const direct = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title')
    if (direct !== null && direct.trim().length > 0) return collapse(direct)
    if (el.tagName.toLowerCase() === 'input') {
      if (el.type === 'submit' || el.type === 'button') return el.value.length > 0 ? collapse(el.value) : undefined
      return undefined
    }
    const text = el.innerText
    return text.trim().length > 0 ? collapse(text) : undefined
  }
  function collapse(value) {
    const trimmed = value.replace(/\\s+/g, ' ').trim()
    return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed
  }
  return { text: text.slice(0, maxText), elements }
`

/** The page-side snapshot function's signature, as called by the provider. */
type SnapshotPageFunction = (maxText: number, maxElements: number) => RawSnapshot

/** Compiled once; see {@link SNAPSHOT_PAGE_SOURCE} for why the body is a string. */
// oxlint-disable-next-line typescript/no-implied-eval -- a string-compiled body is the only transpile-immune page function
const SNAPSHOT_PAGE_FUNCTION = new Function(
  'maxText',
  'maxElements',
  SNAPSHOT_PAGE_SOURCE,
) as SnapshotPageFunction

/** Data one extract-list evaluate returns; the provider maps it into the seam shape. */
interface RawExtractList {
  rows: Record<string, string>[]
  total: number
}

/**
 * Page-side extract-list body, kept as a string literal for the same transpile
 * immunity as {@link SNAPSHOT_PAGE_SOURCE}. Every row matching `selector` is
 * projected onto `fields`: a field reads the text of its descendant match (or
 * of the row), or one attribute of it; a missing target omits the field.
 */
const EXTRACT_LIST_PAGE_SOURCE = `
  const rows = []
  const all = document.querySelectorAll(selector)
  for (const el of all) {
    if (rows.length >= limit) break
    const row = {}
    for (const name of Object.keys(fields)) {
      const field = fields[name]
      const target = field.selector === undefined ? el : el.querySelector(field.selector)
      if (target === null) continue
      let value
      if (field.attribute !== undefined) value = target.getAttribute(field.attribute) ?? ''
      else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) value = target.value
      else value = target.innerText
      const collapsed = value.replace(/\\s+/g, ' ').trim()
      row[name] = collapsed.length > maxFieldChars ? collapsed.slice(0, maxFieldChars) : collapsed
    }
    rows.push(row)
  }
  return { rows, total: all.length }
`

/** The page-side extract-list function's signature, as called by the provider. */
type ExtractListPageFunction = (
  selector: string,
  fields: Record<string, { selector?: string; attribute?: string }>,
  limit: number,
  maxFieldChars: number,
) => RawExtractList

/** Compiled once; see {@link SNAPSHOT_PAGE_SOURCE} for why the body is a string. */
// oxlint-disable-next-line typescript/no-implied-eval -- a string-compiled body is the only transpile-immune page function
const EXTRACT_LIST_PAGE_FUNCTION = new Function(
  'selector',
  'fields',
  'limit',
  'maxFieldChars',
  EXTRACT_LIST_PAGE_SOURCE,
) as ExtractListPageFunction

/** Page-side predicate: at least `index + 1` visible matches of `selector` exist. */
const HAS_VISIBLE_MATCH_SOURCE = `
  return [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length > 0).length > index
`

/** Compiled once; see {@link SNAPSHOT_PAGE_SOURCE} for why the body is a string. */
// oxlint-disable-next-line typescript/no-implied-eval -- a string-compiled body is the only transpile-immune page function
const HAS_VISIBLE_MATCH_FUNCTION = new Function(
  'selector',
  'index',
  HAS_VISIBLE_MATCH_SOURCE,
) as (selector: string, index: number) => boolean

/**
 * The Puppeteer page-operation provider. Registered by the
 * `@deepseek-ai/dsh-browser-puppeteer` plugin; usable directly by tests.
 */
export class PuppeteerBrowserProvider implements BrowserProvider {
  readonly id = PUPPETEER_PROVIDER_ID

  readonly #options: PuppeteerProviderOptions
  #executable: Promise<string> | undefined
  /** `off` mode with no found executable turns false after prewarm completes. */
  #usable = true
  #browser: Promise<PuppeteerBrowser> | undefined
  #profileDir: string | undefined
  readonly #pages = new Map<BrowserPageKey, Page>()
  readonly #lastStatus = new WeakMap<Page, number>()

  /**
   * @param options - resolved provider configuration.
   */
  constructor(options: PuppeteerProviderOptions) {
    this.#options = options
  }

  /**
   * Start executable discovery/provisioning without waiting on it, so boot
   * never blocks on a first-run download. Rejections are memoized into the
   * operations that need the executable; `off` mode marks the provider
   * unusable when no executable exists. Every failure is reported through
   * `log` at boot, so the terminal already says the browser is unusable
   * instead of waiting for the first operation to surface it.
   */
  prewarm(): void {
    void this.#ensureExecutable().catch((error: unknown) => {
      this.#options.log?.(`browser: not available — ${error instanceof BrowserError ? error.message : String(error)}`)
      if (this.#options.provision === 'off') this.#usable = false
    })
  }

  available(): boolean {
    return this.#usable
  }

  /**
   * Release every page, quit the browser, force-kill an unresponsive child
   * process, and remove a provider-created profile directory. Idempotent.
   * @returns resolves once teardown settled.
   */
  async dispose(): Promise<void> {
    const browser = await this.#browser?.catch(() => undefined)
    this.#browser = undefined
    for (const page of this.#pages.values()) {
      await page.close().catch(() => {})
    }
    this.#pages.clear()
    if (browser !== undefined) {
      await browser.close().catch(() => {})
      browser.process()?.kill('SIGKILL')
    }
    if (this.#profileDir !== undefined) {
      const dir = this.#profileDir
      this.#profileDir = undefined
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async navigate(pageKey: BrowserPageKey, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    const url = validateNavigateUrl(request.url, this.#options.maxUrlLength)
    await assertNavigationTargetAllowed(url, this.#options.policy)
    let page: Page
    try {
      page = await this.#page(pageKey, signal)
    } catch (error: unknown) {
      throw pageError(error)
    }
    const waitUntil = request.waitUntil ?? 'load'
    let response: HTTPResponse | null
    try {
      response = await withCancellation(
        page.goto(url.href, { waitUntil, timeout: this.#options.navigationTimeoutMs }),
        signal,
      )
    } catch (error: unknown) {
      throw navigationError(error)
    }
    if (response !== null) this.#lastStatus.set(page, response.status())
    return this.#status(page)
  }

  async snapshot(pageKey: BrowserPageKey, limits: BrowserSnapshotLimits, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const page = await this.#requirePage(pageKey)
    const status = await this.#status(page)
    let raw: RawSnapshot
    try {
      raw = await withCancellation(
        page.evaluate(
          SNAPSHOT_PAGE_FUNCTION,
          this.#options.maxEvaluateTextChars,
          limits.maxElements,
        ),
        signal,
      )
    } catch (error: unknown) {
      throw readError(error)
    }
    return {
      ...status,
      // The provider applies its own hard transport cap first; the seam caps
      // again against the Consumer budget and flags either cut.
      text: raw.text.slice(0, limits.maxTextChars),
      elements: raw.elements,
      truncated: raw.text.length >= this.#options.maxEvaluateTextChars,
    }
  }

  async act(pageKey: BrowserPageKey, request: BrowserActRequest, signal?: AbortSignal): Promise<BrowserActResult> {
    const { action, target, value, index } = request
    if ((action === 'fill' || action === 'press' || action === 'select') && (value === undefined || value.length === 0)) {
      throw new BrowserError(`browser_act "${action}" requires a non-empty value`, 'BROWSER_ACTION_FAILED')
    }
    if (action === 'click' && value !== undefined) {
      throw new BrowserError('browser_act "click" takes no value', 'BROWSER_ACTION_FAILED')
    }
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
      throw new BrowserError('browser_act index must be a non-negative integer', 'BROWSER_ACTION_FAILED')
    }
    // The guards above make the empty default unreachable for value-taking actions.
    const actionValue = value ?? ''
    const page = await this.#requirePage(pageKey)
    const timeout = this.#options.actionTimeoutMs
    try {
      if (index === undefined) {
        if (action === 'click' || action === 'fill') {
          // The Locator API is Puppeteer's native interaction surface: it waits
          // for a visible, stable element and rejects with TimeoutError when
          // none appears — the exact semantics this tool reports to the model.
          const locator = page.locator(target).setTimeout(timeout)
          if (action === 'click') {
            await withCancellation(locator.click(), signal)
            await this.#settle(page)
          } else {
            await withCancellation(locator.fill(actionValue), signal)
          }
        } else {
          const handle = await withCancellation(
            page.waitForSelector(target, { visible: true, timeout }),
            signal,
          )
          if (handle === null) {
            throw new BrowserError(`no visible element matched "${target}" within ${timeout}ms`, 'BROWSER_TARGET_NOT_FOUND')
          }
          await this.#performOnHandle(page, handle, action, actionValue, signal)
        }
      } else {
        // Indexed addressing: the Nth visible match, mirroring querySelectorAll()[N].
        const handle = await this.#nthVisibleHandle(page, target, index, timeout, signal)
        try {
          await this.#performOnHandle(page, handle, action, actionValue, signal)
        } finally {
          await handle.dispose().catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (error instanceof BrowserError) throw error
      if (error instanceof TimeoutError) {
        throw new BrowserError(`no visible element matched "${target}" within ${timeout}ms`, 'BROWSER_TARGET_NOT_FOUND', { cause: error })
      }
      throw new BrowserError(`browser_act "${action}" on "${target}" failed`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    return this.#status(page)
  }

  /** Perform one resolved action, then settle any navigation it started. */
  async #performOnHandle(page: Page, handle: ElementHandle, action: BrowserActionKind, value: string, signal?: AbortSignal): Promise<void> {
    if (action === 'click') {
      await withCancellation(handle.click(), signal)
      await this.#settle(page)
      return
    }
    if (action === 'fill') {
      // Triple-click selects existing text so the fill replaces it, like Locator.fill.
      await withCancellation(handle.click({ count: 3 }), signal)
      await withCancellation(page.keyboard.type(value), signal)
      return
    }
    if (action === 'press') {
      await withCancellation(handle.press(value as KeyInput), signal)
      await this.#settle(page)
      return
    }
    await withCancellation(handle.select(value), signal)
  }

  /** Give a follow-up navigation a bounded moment; a page that never navigates waits out the window. */
  async #settle(page: Page): Promise<void> {
    await page.waitForNetworkIdle({ idleTime: 100, timeout: this.#options.actionSettleMs }).catch(() => {})
  }

  /** The Nth visible match of `selector`, waiting up to `timeout` for it to appear. */
  async #nthVisibleHandle(page: Page, selector: string, index: number, timeout: number, signal?: AbortSignal): Promise<ElementHandle> {
    try {
      await withCancellation(
        page.waitForFunction(HAS_VISIBLE_MATCH_FUNCTION, { timeout }, selector, index),
        signal,
      )
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        throw new BrowserError(`no visible element matched "${selector}" at index ${index} within ${timeout}ms`, 'BROWSER_TARGET_NOT_FOUND', { cause: error })
      }
      throw error
    }
    const handles = await page.$$(selector)
    const visible: ElementHandle[] = []
    for (const handle of handles) {
      const box = await handle.boundingBox()
      if (box === null) await handle.dispose().catch(() => {})
      else visible.push(handle)
    }
    const chosen = visible[index]
    for (const [position, handle] of visible.entries()) {
      if (position !== index) await handle.dispose().catch(() => {})
    }
    if (chosen === undefined) {
      throw new BrowserError(`no visible element matched "${selector}" at index ${index}`, 'BROWSER_TARGET_NOT_FOUND')
    }
    return chosen
  }

  async extract(pageKey: BrowserPageKey, request: BrowserExtractRequest, signal?: AbortSignal): Promise<BrowserExtractResult> {
    const page = await this.#requirePage(pageKey)
    if (request.selector === undefined) {
      let text: string
      try {
        text = await withCancellation(
          page.evaluate(() => document.body.innerText),
          signal,
        )
      } catch (error: unknown) {
        throw readError(error)
      }
      return { url: page.url(), text, truncated: false }
    }
    let handle: ElementHandle | null
    try {
      handle = await withCancellation(
        page.waitForSelector(request.selector, { timeout: this.#options.actionTimeoutMs }),
        signal,
      )
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        throw new BrowserError(`no element matched "${request.selector}"`, 'BROWSER_TARGET_NOT_FOUND', { cause: error })
      }
      throw readError(error)
    }
    if (handle === null) {
      throw new BrowserError(`no element matched "${request.selector}"`, 'BROWSER_TARGET_NOT_FOUND')
    }
    const attribute = request.attribute
    let text: string
    try {
      text = await withCancellation(
        handle.evaluate((el, attr) => {
          if (attr !== null) return el.getAttribute(attr) ?? ''
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
          return (el as HTMLElement).innerText
        }, attribute ?? null),
        signal,
      )
    } catch (error: unknown) {
      throw readError(error)
    }
    return { url: page.url(), text, truncated: false }
  }

  async extractList(pageKey: BrowserPageKey, request: BrowserExtractListRequest, signal?: AbortSignal): Promise<BrowserExtractListResult> {
    const page = await this.#requirePage(pageKey)
    let raw: RawExtractList
    try {
      raw = await withCancellation(
        page.evaluate(EXTRACT_LIST_PAGE_FUNCTION, request.selector, request.fields, request.limit, request.maxFieldChars),
        signal,
      )
    } catch (error: unknown) {
      throw readError(error)
    }
    return {
      url: page.url(),
      rows: raw.rows,
      count: raw.rows.length,
      truncated: raw.total > raw.rows.length,
    }
  }

  async wait(pageKey: BrowserPageKey, request: BrowserWaitRequest, signal?: AbortSignal): Promise<BrowserWaitResult> {
    const page = await this.#requirePage(pageKey)
    const timeout = request.timeoutMs
    try {
      if (request.selector !== undefined) {
        const handle = await withCancellation(
          page.waitForSelector(request.selector, { visible: true, timeout }),
          signal,
        )
        if (handle === null) {
          throw new BrowserError(`no visible element matched "${request.selector}" within ${timeout}ms`, 'BROWSER_TIMEOUT')
        }
      } else {
        // A navigation may have completed before the wait started, so network
        // quiescence is the settle signal rather than a navigation event; a
        // page that never quiesces simply waits out the window.
        await withCancellation(page.waitForNetworkIdle({ idleTime: 200, timeout }), signal).catch(() => {})
      }
    } catch (error: unknown) {
      if (error instanceof BrowserError) throw error
      if (error instanceof TimeoutError) {
        throw new BrowserError(`no visible element matched "${request.selector}" within ${timeout}ms`, 'BROWSER_TIMEOUT', { cause: error })
      }
      throw readError(error)
    }
    return this.#status(page)
  }

  async screenshot(pageKey: BrowserPageKey, request: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult> {
    const page = await this.#requirePage(pageKey)
    const data = await withCancellation(
      page.screenshot({ fullPage: request.fullPage ?? false, type: 'png' }),
      signal,
    )
    const dimensions = pngDimensions(data)
    return {
      url: page.url(),
      data,
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: dimensions[0],
      height: dimensions[1],
    }
  }

  async close(pageKey: BrowserPageKey): Promise<void> {
    const page = this.#pages.get(pageKey)
    this.#pages.delete(pageKey)
    if (page !== undefined) await page.close().catch(() => {})
  }

  /** Resolve the executable, provisioning it once when configured to. */
  #ensureExecutable(): Promise<string> {
    if (this.#options.executablePath.length > 0) return Promise.resolve(this.#options.executablePath)
    this.#executable ??= provisionExecutable({
      provision: this.#options.provision,
      ...(this.#options.cacheDir.length > 0 ? { cacheDir: this.#options.cacheDir } : { cacheDir: DEFAULT_CACHE_DIR }),
      ...(this.#options.buildId.length > 0 ? { buildId: this.#options.buildId } : {}),
      ...this.#options.log === undefined ? {} : { log: this.#options.log },
    }).catch((error: unknown) => {
      // Unwrap a prewarm-caused rejection so callers see the BrowserError, and
      // memoize a fresh promise for a later retry attempt.
      this.#executable = undefined
      throw error instanceof BrowserError
        ? error
        : new BrowserError('browser executable provisioning failed', 'BROWSER_PROVISION_FAILED', { cause: error })
    })
    return this.#executable
  }

  async #browserPromise(): Promise<PuppeteerBrowser> {
    this.#browser ??= (async () => {
      const executablePath = await this.#ensureExecutable()
      const userDataDir = this.#options.userDataDir.length > 0
        ? this.#options.userDataDir
        : await mkdtemp(join(tmpdir(), 'dsh-browser-profile-'))
      if (this.#options.userDataDir.length === 0) this.#profileDir = userDataDir
      return await this.#launch(executablePath, userDataDir)
    })().catch((error: unknown) => {
      this.#browser = undefined
      throw error instanceof BrowserError
        ? error
        : new BrowserError('browser launch failed', 'BROWSER_PROVIDER_ERROR', { cause: error })
    })
    return this.#browser
  }

  /**
   * Launch Chrome Headless Shell. Hosts with unprivileged user namespaces
   * disabled (AppArmor-restricted Ubuntu 23.10+, many containers) abort with
   * "No usable sandbox!"; on that exact failure the launch retries once with
   * `--no-sandbox` and warns, because a usable capability with a warned
   * weaker sandbox beats a dead one. Every other launch failure propagates
   * unchanged, and an explicit `--no-sandbox` in `chromeArgs` suppresses the
   * retry path (the operator already chose it).
   */
  async #launch(executablePath: string, userDataDir: string): Promise<PuppeteerBrowser> {
    const launch = (args: string[]): Promise<PuppeteerBrowser> => puppeteer.launch({
      executablePath,
      // The provisioned binary IS headless (Chrome Headless Shell);
      // 'shell' launches it without a --headless flag.
      headless: 'shell',
      userDataDir,
      args,
      protocolTimeout: this.#options.navigationTimeoutMs,
    })
    try {
      return await launch([...BASE_CHROME_ARGS, ...this.#options.chromeArgs])
    } catch (error: unknown) {
      if (!isSandboxUnavailable(error) || this.#options.chromeArgs.includes('--no-sandbox')) throw error
      this.#options.log?.('browser: this host denies Chrome its sandbox ("No usable sandbox"); retrying with --no-sandbox — page content runs WITHOUT Chrome\'s sandbox; enabling unprivileged user namespaces restores it')
      return launch([...BASE_CHROME_ARGS, ...this.#options.chromeArgs, '--no-sandbox', '--disable-setuid-sandbox'])
    }
  }

  async #page(pageKey: BrowserPageKey, signal?: AbortSignal): Promise<Page> {
    const existing = this.#pages.get(pageKey)
    if (existing !== undefined && !existing.isClosed()) return existing
    const browser = await this.#browserPromise()
    const page = await withCancellation(browser.newPage(), signal)
    page.setDefaultTimeout(this.#options.actionTimeoutMs)
    if (this.#options.userAgent.length > 0) await page.setUserAgent({ userAgent: this.#options.userAgent })
    await page.setViewport({ width: this.#options.viewportWidth, height: this.#options.viewportHeight })
    page.on('response', (response: HTTPResponse) => {
      if (response.frame() === page.mainFrame()) this.#lastStatus.set(page, response.status())
    })
    this.#pages.set(pageKey, page)
    return page
  }

  /** Operations other than navigate require an already-created page. */
  #requirePage(pageKey: BrowserPageKey): Promise<Page> {
    const page = this.#pages.get(pageKey)
    if (page === undefined || page.isClosed()) {
      return Promise.reject(new BrowserError(`no page is open for this caller; call browser_navigate first (page key "${pageKey}")`, 'BROWSER_NO_PAGE'))
    }
    return Promise.resolve(page)
  }

  async #status(page: Page): Promise<BrowserPageStatus> {
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      statusCode: this.#lastStatus.get(page) ?? null,
    }
  }
}

/** Reject with `BROWSER_CANCELLED` as soon as `signal` aborts. */
function withCancellation<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new BrowserError('browser operation cancelled', 'BROWSER_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new BrowserError('browser operation cancelled', 'BROWSER_CANCELLED')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

/** True when the launch error is the host denying Chrome's sandbox. */
function isSandboxUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No usable sandbox')
}

/** Map a navigation failure onto the shared taxonomy. */
function navigationError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  if (error instanceof TimeoutError) {
    return new BrowserError('navigation timed out', 'BROWSER_TIMEOUT', { cause: error })
  }
  return new BrowserError('navigation failed', 'BROWSER_PROVIDER_ERROR', { cause: error })
}

/** Map a page-open failure (new page, dead browser connection) onto the shared taxonomy. */
function pageError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  return new BrowserError('browser page could not be opened', 'BROWSER_PROVIDER_ERROR', { cause: error })
}

/**
 * Map a page-read failure onto the shared taxonomy. A navigation or closure
 * interrupting the read gets its own routable code so the model retries the
 * read instead of re-navigating.
 */
function readError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  if (error instanceof TimeoutError) {
    return new BrowserError('browser read timed out', 'BROWSER_TIMEOUT', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/Execution context was destroyed|Target closed|Connection closed|Inspected target navigated/i.test(message)) {
    return new BrowserError('the page navigated or closed during the read; retry the operation', 'BROWSER_PAGE_CHANGED', { cause: error })
  }
  return new BrowserError('browser read failed', 'BROWSER_PROVIDER_ERROR', { cause: error })
}

/** Read width/height from a PNG's IHDR chunk. */
function pngDimensions(data: Uint8Array): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.byteLength < 24 || view.getUint32(0) !== 0x8950_4e47 || view.getUint32(4) !== 0x0d0a_1a0a) {
    throw new BrowserError('screenshot did not return PNG data', 'BROWSER_PROVIDER_ERROR')
  }
  return [view.getUint32(16), view.getUint32(20)]
}
