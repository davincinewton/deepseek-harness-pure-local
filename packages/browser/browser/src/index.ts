/**
 * Service Definition for the browser-automation capability seam (`ctx.browser`):
 * the provider registry and provider-selecting page operations. Duplicate ids are
 * rejected. At execution time, a configured provider must exist and be usable;
 * without one, exactly one usable provider is required, so selection never
 * depends on registration order. The seam enforces snapshot and extract caps on
 * provider results so a provider cannot overflow the Consumer's model budget.
 * @module @deepseek-ai/dsh-browser
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BrowserActRequest,
  BrowserActResult,
  BrowserExtractRequest,
  BrowserExtractResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSnapshotLimits,
  BrowserSnapshotResult,
} from './types.ts'
import { BrowserError, BrowserPageKey } from './types.ts'

export {
  BrowserError,
  BrowserPageKey,
} from './types.ts'
export type {
  BrowserActionKind,
  BrowserActRequest,
  BrowserActResult,
  BrowserExtractRequest,
  BrowserExtractResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserPageStatus,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSnapshotElement,
  BrowserSnapshotLimits,
  BrowserSnapshotResult,
  BrowserWaitUntil,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/**
 * Config for the browser seam. `provider` pins which provider wins; it is
 * optional (a single registered usable provider auto-selects). Operational
 * overrides such as environment variables must feed this same field rather than
 * introduce a hidden priority chain.
 */
export interface BrowserRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The browser automation service. Registered as `ctx.browser` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `BROWSER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `BROWSER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `BROWSER_PROVIDER_UNAVAILABLE`.
 */
export class BrowserRuntime extends Service {
  /**
   * Provider selection config. An operational env override feeds the SAME
   * field: `$DSH_BROWSER_PROVIDER` is equivalent to `provider` and is NOT a
   * hidden priority chain.
   */
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.providerId = config.provider ?? process.env.DSH_BROWSER_PROVIDER
  }

  /**
   * Register a page-operation provider. Throws {@link BrowserError}
   * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'browser.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Navigate the key's page through the selected provider. Resolves the
   * provider at call time with the selection rules above; throws
   * {@link BrowserError} when the capability cannot run.
   * @param pageKey - the Consumer-derived page owner.
   * @param request - the navigation target and settle condition.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the post-navigation page status.
   */
  async navigate(pageKey: BrowserPageKey, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return this.resolve().navigate(pageKey, request, signal)
  }

  /**
   * Snapshot the key's page through the selected provider. The seam enforces
   * `limits` on the provider result: text is cut to `maxTextChars`, elements to
   * `maxElements`, and `truncated` reflects either cut.
   * @param pageKey - the page owner.
   * @param limits - the Consumer's model budget for this snapshot.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the bounded page state.
   */
  async snapshot(pageKey: BrowserPageKey, limits: BrowserSnapshotLimits, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const result = await this.resolve().snapshot(pageKey, limits, signal)
    return capSnapshot(result, limits)
  }

  /**
   * Perform one page mutation through the selected provider.
   * @param pageKey - the page owner.
   * @param request - the action, target selector, and optional value.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the post-action page status.
   */
  async act(pageKey: BrowserPageKey, request: BrowserActRequest, signal?: AbortSignal): Promise<BrowserActResult> {
    return this.resolve().act(pageKey, request, signal)
  }

  /**
   * Read text (or one attribute) out of the key's page. The seam enforces
   * `request.maxChars` on the result.
   * @param pageKey - the page owner.
   * @param request - the optional selector/attribute plus the character bound.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the read text, capped to `request.maxChars`.
   */
  async extract(pageKey: BrowserPageKey, request: BrowserExtractRequest, signal?: AbortSignal): Promise<BrowserExtractResult> {
    const result = await this.resolve().extract(pageKey, request, signal)
    return capExtract(result, request.maxChars)
  }

  /**
   * Capture the key's page as PNG through the selected provider.
   * @param pageKey - the page owner.
   * @param request - whether to capture beyond the viewport.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the PNG bytes and dimensions.
   */
  async screenshot(pageKey: BrowserPageKey, request: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult> {
    return this.resolve().screenshot(pageKey, request, signal)
  }

  /**
   * Release the key's page. With no usable provider nothing can be open, so the
   * call resolves as a no-op instead of failing teardown.
   * @param pageKey - the page owner.
   * @returns resolves once the provider (if any) released the page.
   */
  async close(pageKey: BrowserPageKey): Promise<void> {
    const usable = this.usableProviders()
    const [provider] = usable
    if (provider === undefined) return
    await provider.close(pageKey)
  }

  /** Resolve the selected provider or throw the matching {@link BrowserError}. */
  private resolve(): BrowserProvider {
    const usable = this.usableProviders()
    if (this.providerId !== undefined) {
      const provider = this.providers.get(this.providerId)
      if (!provider) {
        throw new BrowserError(`configured browser provider "${this.providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new BrowserError(`configured browser provider "${this.providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      return provider
    }
    const [single] = usable
    if (single === undefined) {
      throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
    }
    return single
  }

  private usableProviders(): BrowserProvider[] {
    return [...this.providers.values()].filter(provider => provider.available())
  }
}

/** Enforce the snapshot caps: trim text and elements, and flag either cut. */
function capSnapshot(result: BrowserSnapshotResult, limits: BrowserSnapshotLimits): BrowserSnapshotResult {
  const textCut = result.text.length > limits.maxTextChars
  const elementsCut = result.elements.length > limits.maxElements
  if (!textCut && !elementsCut) return result
  return {
    ...result,
    text: textCut ? result.text.slice(0, limits.maxTextChars) : result.text,
    elements: elementsCut ? result.elements.slice(0, limits.maxElements) : result.elements,
    truncated: true,
  }
}

/** Enforce `maxChars` on an extract result: trim text and flag it. */
function capExtract(result: BrowserExtractResult, maxChars: number): BrowserExtractResult {
  if (result.text.length <= maxChars) return result
  return { ...result, text: result.text.slice(0, maxChars), truncated: true }
}

export default BrowserRuntime
