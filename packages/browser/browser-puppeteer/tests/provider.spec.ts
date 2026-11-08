import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserPageKey } from '@deepseek-ai/dsh-browser'

// puppeteer-core is replaced by a scripted fake: the provider logic under test
// (lifecycle, policy wiring, error taxonomy, teardown) is real, the browser is
// not. The real-binary path lives in the opt-in e2e file.
const { launchMock, page, browser, locatorChain } = vi.hoisted(() => {
  const page = {
    url: () => 'https://page.test/final',
    title: async () => 'Fake Title',
    goto: vi.fn(async (_url: string, _opts?: unknown): Promise<{ status: () => number } | null> => ({ status: () => 200 })),
    evaluate: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ text: 'body text', elements: [] })),
    waitForSelector: vi.fn(async (_selector: string, _opts?: unknown): Promise<unknown> => null),
    waitForNetworkIdle: vi.fn(async () => {}),
    screenshot: vi.fn(async (_opts?: unknown): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(4)),
    close: vi.fn(async () => {}),
    isClosed: () => false,
    on: vi.fn(),
    setDefaultTimeout: vi.fn(),
    mainFrame: () => ({ id: 1 }),
    locator: vi.fn((): typeof locatorChain => locatorChain),
  }
  const locatorChain: { setTimeout: (ms: number) => unknown; click: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } = {
    setTimeout: () => locatorChain,
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
  }
  const processHandle = { kill: vi.fn() }
  const browser = {
    newPage: async () => page,
    close: vi.fn(async () => {}),
    process: () => processHandle,
  }
  const launchMock = vi.fn(async (_options: unknown) => browser)
  return { launchMock, page, browser, locatorChain }
})

vi.mock('puppeteer-core', () => ({
  default: { launch: launchMock },
  TimeoutError: class TimeoutError extends Error {},
}))

const browsersMock = {
  Browser: { CHROMEHEADLESSSHELL: 'chrome-headless-shell' },
  detectBrowserPlatform: vi.fn((): string | undefined => 'linux'),
  getInstalledBrowsers: vi.fn(async (_opts?: unknown): Promise<{ browser: string; buildId: string; executablePath: string }[]> => []),
  resolveBuildId: vi.fn(async () => '145.0.7632.77'),
  install: vi.fn(async (_opts?: { downloadProgressCallback?: (downloaded: number, total: number) => void }): Promise<{ executablePath: string }> => ({ executablePath: '/fake/chrome-headless-shell' })),
}

vi.mock('@puppeteer/browsers', () => browsersMock)

const { TimeoutError } = await import('puppeteer-core')
const plugin = await import('@deepseek-ai/dsh-browser-puppeteer')
const { PuppeteerBrowserProvider } = plugin

const pageKey = BrowserPageKey('session-1')

type PuppeteerProvider = InstanceType<typeof PuppeteerBrowserProvider>

/** Options for a directly-constructed provider; quiet by default. */
function providerOptions(overrides: Partial<import('@deepseek-ai/dsh-browser-puppeteer').PuppeteerProviderOptions> = {}): import('@deepseek-ai/dsh-browser-puppeteer').PuppeteerProviderOptions {
  return {
    executablePath: '/fake/chrome-headless-shell',
    cacheDir: '',
    buildId: '',
    provision: 'off',
    userDataDir: '',
    chromeArgs: [],
    navigationTimeoutMs: 1000,
    actionTimeoutMs: 500,
    actionSettleMs: 1,
    maxUrlLength: 2048,
    maxEvaluateTextChars: 100_000,
    policy: { allowLoopback: false, allowHosts: [] },
    ...overrides,
  }
}

/** A minimal PNG buffer with the given IHDR dimensions (only the header is parsed). */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x8950_4e47)
  view.setUint32(4, 0x0d0a_1a0a)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

beforeEach(() => {
  launchMock.mockClear()
  browser.close.mockClear()
  browser.process().kill.mockClear()
  page.goto.mockClear().mockResolvedValue({ status: () => 200 })
  page.close.mockClear()
  locatorChain.click.mockReset().mockResolvedValue(undefined)
  locatorChain.fill.mockReset().mockResolvedValue(undefined)
  page.screenshot.mockClear()
  page.waitForNetworkIdle.mockClear()
  page.on.mockClear()
  page.waitForSelector.mockReset()
  page.evaluate.mockReset().mockResolvedValue({ text: 'body text', elements: [] })
  for (const fn of Object.values(browsersMock)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset(): void }).mockReset()
  }
  browsersMock.detectBrowserPlatform.mockReturnValue('linux')
  browsersMock.getInstalledBrowsers.mockResolvedValue([])
  browsersMock.resolveBuildId.mockResolvedValue('145.0.7632.77')
  browsersMock.install.mockResolvedValue({ executablePath: '/fake/chrome-headless-shell' })
})

/** A provider with one page already opened by a successful navigation. */
async function opened(): Promise<PuppeteerProvider> {
  const provider = new PuppeteerBrowserProvider(providerOptions())
  await provider.navigate(pageKey, { url: 'https://example.com' })
  return provider
}

describe('PuppeteerBrowserProvider navigation', () => {
  it('navigates and reports status/title, launching lazily with a private profile', async () => {
    const provider = new PuppeteerBrowserProvider(providerOptions())
    const result = await provider.navigate(pageKey, { url: 'https://example.com' })
    expect(result).toEqual({ url: 'https://page.test/final', title: 'Fake Title', statusCode: 200 })
    expect(launchMock).toHaveBeenCalledTimes(1)
    const launchOptions = launchMock.mock.calls[0]![0] as { executablePath: string; headless: string; userDataDir: string }
    expect(launchOptions.executablePath).toBe('/fake/chrome-headless-shell')
    expect(launchOptions.headless).toBe('shell')
    expect(launchOptions.userDataDir).toContain('dsh-browser-profile-')
    await provider.dispose()
  })

  it('refuses blocked targets before touching the browser', async () => {
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await expect(provider.navigate(pageKey, { url: 'http://127.0.0.1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_BLOCKED_URL' }))
    expect(launchMock).not.toHaveBeenCalled()
    await provider.dispose()
  })

  it('maps goto TimeoutError to BROWSER_TIMEOUT', async () => {
    page.goto.mockRejectedValueOnce(new TimeoutError('Navigation timeout of 1000 ms exceeded'))
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await expect(provider.navigate(pageKey, { url: 'https://slow.test' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TIMEOUT' }))
    await provider.dispose()
  })

  it('rejects operations on an unopened page with BROWSER_NO_PAGE', async () => {
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await expect(provider.snapshot(pageKey, { maxTextChars: 10, maxElements: 1 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NO_PAGE' }))
    await expect(provider.extract(pageKey, { maxChars: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NO_PAGE' }))
    await provider.dispose()
  })
})

describe('PuppeteerBrowserProvider actions', () => {
  it('validates action/value pairing before resolving the target', async () => {
    const provider = await opened()
    await expect(provider.act(pageKey, { action: 'fill', target: 'input' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ACTION_FAILED' }))
    await expect(provider.act(pageKey, { action: 'click', target: 'a', value: 'x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ACTION_FAILED' }))
    await provider.dispose()
  })

  it('reports an unresolved locator as BROWSER_TARGET_NOT_FOUND', async () => {
    locatorChain.click.mockRejectedValueOnce(new TimeoutError('Waiting for locator failed'))
    const provider = await opened()
    await expect(provider.act(pageKey, { action: 'click', target: '::-p-aria(Missing)' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_NOT_FOUND' }))
    await provider.dispose()
  })

  it('clicks through the Locator API, settles a follow-up navigation, and returns the page status', async () => {
    const provider = await opened()
    const result = await provider.act(pageKey, { action: 'click', target: 'a[href]' })
    expect(page.locator).toHaveBeenCalledWith('a[href]')
    expect(locatorChain.click).toHaveBeenCalled()
    expect(page.waitForNetworkIdle).toHaveBeenCalled()
    expect(result).toEqual({ url: 'https://page.test/final', title: 'Fake Title', statusCode: 200 })
    await provider.dispose()
  })

  it('fills through the Locator API', async () => {
    const provider = await opened()
    await provider.act(pageKey, { action: 'fill', target: '::-p-aria(Search box)', value: 'text' })
    expect(locatorChain.fill).toHaveBeenCalledWith('text')
    await provider.dispose()
  })

  it('drives press and select through a resolved handle', async () => {
    const press = vi.fn(async () => {})
    const select = vi.fn(async () => ['v'])
    page.waitForSelector.mockResolvedValueOnce({ press }).mockResolvedValueOnce({ select })
    const provider = await opened()
    await provider.act(pageKey, { action: 'press', target: 'input', value: 'Enter' })
    expect(press).toHaveBeenCalledWith('Enter')
    await provider.act(pageKey, { action: 'select', target: 'select', value: 'v' })
    expect(select).toHaveBeenCalledWith('v')
    await provider.dispose()
  })

  it('wraps element action failures as BROWSER_ACTION_FAILED', async () => {
    locatorChain.fill.mockRejectedValueOnce(new Error('detached'))
    const provider = await opened()
    await expect(provider.act(pageKey, { action: 'fill', target: 'input', value: 'v' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ACTION_FAILED' }))
    await provider.dispose()
  })
})

describe('PuppeteerBrowserProvider reads', () => {
  it('reads body text and element attributes through evaluate', async () => {
    page.evaluate.mockResolvedValue('hello body')
    const provider = await opened()
    await expect(provider.extract(pageKey, { maxChars: 100 })).resolves.toEqual({
      url: 'https://page.test/final', text: 'hello body', truncated: false,
    })
    const handle = { evaluate: vi.fn(async () => 'https://link.test/target') }
    page.waitForSelector.mockResolvedValueOnce(handle)
    await expect(provider.extract(pageKey, { selector: 'a', attribute: 'href', maxChars: 100 }))
      .resolves.toMatchObject({ text: 'https://link.test/target' })
    await provider.dispose()
  })

  it('surfaces snapshot element data and flags provider-cap truncation', async () => {
    page.evaluate.mockResolvedValueOnce({ text: 'abc', elements: [{ role: 'link', name: 'Home' }] })
    const provider = await opened()
    const result = await provider.snapshot(pageKey, { maxTextChars: 100, maxElements: 10 })
    expect(result.elements).toEqual([{ role: 'link', name: 'Home' }])
    expect(result.truncated).toBe(false)
    await provider.dispose()
  })

  it('parses screenshot dimensions from the PNG header', async () => {
    page.screenshot.mockResolvedValueOnce(png(1280, 1024))
    const provider = await opened()
    const shot = await provider.screenshot(pageKey, { fullPage: true })
    expect(shot).toMatchObject({ url: 'https://page.test/final', mediaType: 'image/png', width: 1280, height: 1024, bytes: 32 })
    expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true, type: 'png' })
    await provider.dispose()
  })

  it('rejects non-PNG screenshot payloads', async () => {
    page.screenshot.mockResolvedValueOnce(
      new Uint8Array(Array.from({ length: 25 }, (_element, index) => index + 1)),
    )
    const provider = await opened()
    await expect(provider.screenshot(pageKey, {}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_ERROR' }))
    await provider.dispose()
  })
})

describe('PuppeteerBrowserProvider lifecycle', () => {
  it('close is idempotent for unknown keys and quits the page otherwise', async () => {
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await provider.close(pageKey)
    await provider.navigate(pageKey, { url: 'https://example.com' })
    await provider.close(pageKey)
    expect(page.close).toHaveBeenCalledTimes(1)
    await provider.close(pageKey)
    expect(page.close).toHaveBeenCalledTimes(1)
    await provider.dispose()
  })

  it('dispose quits the browser, kills the child process, and removes the ephemeral profile', async () => {
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await provider.navigate(pageKey, { url: 'https://example.com' })
    const launchOptions = launchMock.mock.calls.at(-1)![0] as { userDataDir: string }
    const profileDir = launchOptions.userDataDir
    expect(existsSync(profileDir)).toBe(true)
    await provider.dispose()
    expect(browser.close).toHaveBeenCalled()
    expect(browser.process().kill).toHaveBeenCalledWith('SIGKILL')
    expect(existsSync(profileDir)).toBe(false)
  })

  it('keeps a configured userDataDir after dispose', async () => {
    const kept = await mkdtemp(join(tmpdir(), 'dsh-browser-kept-'))
    const provider = new PuppeteerBrowserProvider(providerOptions({ userDataDir: kept }))
    await provider.navigate(pageKey, { url: 'https://example.com' })
    await provider.dispose()
    expect(existsSync(kept)).toBe(true)
    await rm(kept, { recursive: true, force: true })
  })

  it('retries a sandbox-denied launch once with --no-sandbox and warns', async () => {
    const logs: string[] = []
    launchMock
      .mockRejectedValueOnce(new Error('Failed to launch the browser process: Code: null\nstderr:\nFATAL:...zygote_host_impl_linux.cc No usable sandbox!\n'))
      .mockImplementationOnce(async () => browser)
    const provider = new PuppeteerBrowserProvider(providerOptions({ log: message => logs.push(message) }))
    await expect(provider.navigate(pageKey, { url: 'https://example.com' })).resolves.toMatchObject({ statusCode: 200 })
    expect(launchMock).toHaveBeenCalledTimes(2)
    const retryArgs = (launchMock.mock.calls[1]![0] as { args: string[] }).args
    expect(retryArgs).toContain('--no-sandbox')
    expect(retryArgs).toContain('--disable-setuid-sandbox')
    expect(logs.join('\n')).toContain('WITHOUT Chrome')
    await provider.dispose()
  })

  it('does not retry when the operator already set --no-sandbox, and rethrows other launch failures', async () => {
    launchMock.mockRejectedValueOnce(new Error('No usable sandbox!'))
    const provider = new PuppeteerBrowserProvider(providerOptions({ chromeArgs: ['--no-sandbox'] }))
    await expect(provider.navigate(pageKey, { url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_ERROR' }))
    expect(launchMock).toHaveBeenCalledTimes(1)
    await provider.dispose()

    launchMock.mockRejectedValueOnce(new Error('executable does not exist'))
    const other = new PuppeteerBrowserProvider(providerOptions())
    await expect(other.navigate(pageKey, { url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_ERROR' }))
    expect(launchMock).toHaveBeenCalledTimes(2)
    await other.dispose()
  })

  it('cancels an in-flight operation when the caller signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new PuppeteerBrowserProvider(providerOptions())
    await expect(provider.navigate(pageKey, { url: 'https://example.com' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CANCELLED' }))
    await provider.dispose()
  })
})

describe('provisioning', () => {
  /** A real cache root with the given executable files created inside it. */
  async function cacheWith(files: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-cache-'))
    for (const file of files) await writeFile(join(dir, file), '#!/bin/sh\n', { mode: 0o755 })
    return dir
  }

  it('uses a cached build when present', async () => {
    const cache = await cacheWith(['144', '145'])
    browsersMock.getInstalledBrowsers.mockResolvedValue([
      { browser: 'chrome-headless-shell', buildId: '144.0.1', executablePath: join(cache, '144') },
      { browser: 'chrome-headless-shell', buildId: '145.0.2', executablePath: join(cache, '145') },
    ])
    expect(await plugin.findInstalledExecutable(cache)).toBe(join(cache, '145'))
    expect(await plugin.provisionExecutable({ cacheDir: cache })).toBe(join(cache, '145'))
    expect(browsersMock.install).not.toHaveBeenCalled()
    await rm(cache, { recursive: true, force: true })
  })

  it('honors an exact buildId filter', async () => {
    const cache = await cacheWith(['144'])
    browsersMock.getInstalledBrowsers.mockResolvedValue([
      { browser: 'chrome-headless-shell', buildId: '144.0.1', executablePath: join(cache, '144') },
    ])
    expect(await plugin.findInstalledExecutable(cache, '145.0.2')).toBeUndefined()
    expect(await plugin.findInstalledExecutable(cache, '144.0.1')).toBe(join(cache, '144'))
    await rm(cache, { recursive: true, force: true })
  })

  it('treats a build directory whose executable is missing as a cache miss and downloads', async () => {
    // An interrupted download leaves the build directory behind with no binary;
    // the stale directory must not suppress the first-run download.
    const cache = await mkdtemp(join(tmpdir(), 'dsh-browser-cache-'))
    browsersMock.getInstalledBrowsers.mockResolvedValue([
      { browser: 'chrome-headless-shell', buildId: '145.0.2', executablePath: join(cache, '145') },
    ])
    expect(await plugin.findInstalledExecutable(cache)).toBeUndefined()
    const logs: string[] = []
    const path = await plugin.provisionExecutable({ cacheDir: cache, log: message => logs.push(message) })
    expect(path).toBe('/fake/chrome-headless-shell')
    expect(browsersMock.install).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('100 MB')
    await rm(cache, { recursive: true, force: true })
  })

  it('downloads when nothing is cached and reports the progress line', async () => {
    const logs: string[] = []
    const path = await plugin.provisionExecutable({ cacheDir: '/cache', log: message => logs.push(message) })
    expect(path).toBe('/fake/chrome-headless-shell')
    expect(browsersMock.resolveBuildId).toHaveBeenCalled()
    expect(browsersMock.install).toHaveBeenCalledWith(expect.objectContaining({ browser: 'chrome-headless-shell', cacheDir: '/cache' }))
    expect(logs.join('\n')).toContain('100 MB')
  })

  it('treats a cache listing that fails to read as empty', async () => {
    browsersMock.getInstalledBrowsers.mockRejectedValueOnce(new Error('EACCES'))
    expect(await plugin.findInstalledExecutable('/cache')).toBeUndefined()
  })

  it('reports the completed download through the progress callback', async () => {
    type InstallOptions = { downloadProgressCallback?: (downloaded: number, total: number) => void }
    browsersMock.install.mockImplementationOnce(async (options?: InstallOptions) => {
      options?.downloadProgressCallback?.(0, 100)
      options?.downloadProgressCallback?.(100, 100)
      return { executablePath: '/fake/chrome-headless-shell' }
    })
    const logs: string[] = []
    await plugin.provisionExecutable({ cacheDir: '/cache', log: message => logs.push(message) })
    expect(logs.join('\n')).toContain('downloaded Chrome Headless Shell 145.0.7632.77 (100 bytes)')
  })

  it('fails loud on an unsupported platform, an unresolvable build, or a download error', async () => {
    browsersMock.detectBrowserPlatform.mockReturnValueOnce(undefined)
    await expect(plugin.provisionExecutable({ cacheDir: '/cache' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVISION_FAILED' }))
    browsersMock.resolveBuildId.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(plugin.provisionExecutable({ cacheDir: '/cache' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVISION_FAILED' }))
    browsersMock.install.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(plugin.provisionExecutable({ cacheDir: '/cache', buildId: '145.0.7632.77' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVISION_FAILED' }))
  })

  it('treats "off" mode with no cached build as unusable (loud, structured)', async () => {
    browsersMock.getInstalledBrowsers.mockResolvedValue([])
    const provider = new PuppeteerBrowserProvider(providerOptions({ executablePath: '', provision: 'off' }))
    provider.prewarm()
    await vi.waitFor(() =>{  expect(provider.available()).toBe(false) })
    await expect(provider.navigate(pageKey, { url: 'https://example.com' })).rejects.toBeInstanceOf(Error)
    expect(browsersMock.install).not.toHaveBeenCalled()
    await provider.dispose()
  })
})

describe('plugin registration (real seam)', () => {
  it('registers into ctx.browser, serves a navigate, and unregisters + tears down on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime, {})
    const fiber = await ctx.plugin(plugin, { executablePath: '/fake/chrome-headless-shell', provision: 'off' })
    await expect(ctx.browser.navigate(pageKey, { url: 'https://example.com' })).resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
    await expect(ctx.browser.navigate(pageKey, { url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
    expect(browser.close).toHaveBeenCalled()
  })

  it('rejects an invalid provision value at config validation', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime, {})
    await expect(ctx.plugin(plugin, { provision: 'sometimes' }))
      .rejects.toThrow(/provision must be 'auto' or 'off'/)
  })

  it('rejects non-positive budgets at config validation', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime, {})
    await expect(ctx.plugin(plugin, { navigationTimeoutMs: 0 }))
      .rejects.toThrow(/navigationTimeoutMs/)
  })
})
