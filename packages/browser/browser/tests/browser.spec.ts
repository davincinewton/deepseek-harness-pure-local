import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, {
  BrowserError,
  BrowserPageKey,
} from '@deepseek-ai/dsh-browser'
import type {
  BrowserProvider,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
} from '@deepseek-ai/dsh-browser'

const pageKey = BrowserPageKey('session-1')

/** A scripted provider for contract tests; unused methods reject clearly. */
function makeProvider(id: string, available: boolean, overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    id,
    available: () => available,
    navigate: () => Promise.resolve({ url: `https://x.test/${id}`, title: id, statusCode: 200 }),
    snapshot: () => Promise.resolve({ url: 'https://x.test', title: id, statusCode: 200, text: 'full page text', elements: [], truncated: false }),
    act: () => Promise.resolve({ url: 'https://x.test', title: id, statusCode: null }),
    extract: () => Promise.resolve({ url: 'https://x.test', text: 'extracted', truncated: false }),
    screenshot: () => Promise.resolve({ url: 'https://x.test', data: new Uint8Array(), mediaType: 'image/png', bytes: 0, width: 1, height: 1 }),
    close: () => Promise.resolve(),
    ...overrides,
  }
}

/** Mount a BrowserRuntime on a fresh root context with the given config. */
async function mountBrowser(
  config: ConstructorParameters<typeof BrowserRuntime>[1] = {},
): Promise<{ ctx: Context; browser: BrowserRuntime }> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  return { ctx, browser: ctx.browser }
}

describe('BrowserRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { browser } = await mountBrowser()
    const dispose = browser.registerProvider(makeProvider('stub', true))
    await expect(browser.navigate(pageKey, { url: 'https://x.test' })).resolves.toMatchObject({ title: 'stub' })
    dispose()
    await expect(browser.navigate(pageKey, { url: 'https://x.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws BROWSER_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('stub', true))
    expect(() => browser.registerProvider(makeProvider('stub', true)))
      .toThrow(expect.objectContaining({ code: 'BROWSER_DUPLICATE_PROVIDER' }))
  })

  it('selects the configured provider and reports missing/unavailable ids distinctly', async () => {
    const { browser } = await mountBrowser({ provider: 'chosen' })
    browser.registerProvider(makeProvider('other', true))
    await expect(browser.navigate(pageKey, { url: 'https://x.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_MISSING' }))
    browser.registerProvider(makeProvider('chosen', false))
    await expect(browser.navigate(pageKey, { url: 'https://x.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('raises BROWSER_PROVIDER_AMBIGUOUS with several usable providers', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('a', true))
    browser.registerProvider(makeProvider('b', true))
    await expect(browser.navigate(pageKey, { url: 'https://x.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_AMBIGUOUS' }))
  })
})

describe('BrowserRuntime caps', () => {
  it('caps snapshot text and elements and flags truncation', async () => {
    const { browser } = await mountBrowser()
    const elements = Array.from({ length: 5 }, (_, index) => ({ role: `r${index}` }))
    browser.registerProvider(makeProvider('stub', true, {
      snapshot: (): Promise<BrowserSnapshotResult> =>
        Promise.resolve({ url: 'https://x.test', title: 't', statusCode: 200, text: 'abcdefghij', elements, truncated: false }),
    }))
    const result = await browser.snapshot(pageKey, { maxTextChars: 4, maxElements: 2 })
    expect(result.text).toBe('abcd')
    expect(result.elements).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('keeps an under-cap snapshot unflagged', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('stub', true))
    const result = await browser.snapshot(pageKey, { maxTextChars: 100, maxElements: 10 })
    expect(result.truncated).toBe(false)
  })

  it('caps extract text to the requested maxChars', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('stub', true, {
      extract: () => Promise.resolve({ url: 'https://x.test', text: '0123456789', truncated: false }),
    }))
    const result = await browser.extract(pageKey, { maxChars: 3 })
    expect(result).toEqual({ url: 'https://x.test', text: '012', truncated: true })
  })

  it('preserves a provider-flagged truncation the caps did not touch', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('stub', true, {
      snapshot: (): Promise<BrowserSnapshotResult> =>
        Promise.resolve({ url: 'https://x.test', title: 't', statusCode: 200, text: 'short', elements: [], truncated: true }),
    }))
    const result = await browser.snapshot(pageKey, { maxTextChars: 100, maxElements: 10 })
    expect(result.truncated).toBe(true)
  })
})

describe('BrowserRuntime delegation', () => {
  it('forwards act/screenshot and delegates close to the usable provider', async () => {
    const { browser } = await mountBrowser()
    const closed: string[] = []
    browser.registerProvider(makeProvider('stub', true, {
      act: (_key, request) => Promise.resolve({ url: `acted:${request.action}`, title: 't', statusCode: null }),
      screenshot: (): Promise<BrowserScreenshotResult> =>
        Promise.resolve({ url: 'https://x.test', data: new Uint8Array([1]), mediaType: 'image/png', bytes: 1, width: 2, height: 3 }),
      close: (key) => { closed.push(key); return Promise.resolve() },
    }))
    await expect(browser.act(pageKey, { action: 'click', target: 'a' })).resolves.toMatchObject({ url: 'acted:click' })
    await expect(browser.screenshot(pageKey, {})).resolves.toMatchObject({ width: 2, height: 3 })
    await browser.close(pageKey)
    expect(closed).toEqual(['session-1'])
  })

  it('treats close as a no-op when nothing usable is registered', async () => {
    const { browser } = await mountBrowser()
    await expect(browser.close(pageKey)).resolves.toBeUndefined()
  })

  it('propagates an unavailable provider error through every operation', async () => {
    const { browser } = await mountBrowser()
    browser.registerProvider(makeProvider('stub', false))
    await expect(browser.snapshot(pageKey, { maxTextChars: 10, maxElements: 1 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
    await expect(browser.extract(pageKey, { maxChars: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
    await expect(browser.act(pageKey, { action: 'click', target: 'a' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
    await expect(browser.screenshot(pageKey, {}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })
})

describe('BrowserPageKey', () => {
  it('mints branded keys that compare as their source strings', () => {
    expect(String(BrowserPageKey('abc'))).toBe('abc')
    expect(new BrowserError('x', 'Y').code).toBe('Y')
  })
})
