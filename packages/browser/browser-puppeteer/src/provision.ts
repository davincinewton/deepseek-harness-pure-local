/**
 * Chrome Headless Shell provisioning: locate an installed binary in the
 * `@puppeteer/browsers` cache, or download it on first use. This is the step the
 * `puppeteer` npm package would hide in a `postinstall` script; the harness
 * denies unreviewed lifecycle scripts, so provisioning is an explicit,
 * idempotent runtime action the provider plugin owns (decided in the browser
 * seam Agent Note: the binary never rides the shipped artifact closure).
 * @module @deepseek-ai/dsh-browser-puppeteer/provision
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers'
import { BrowserError } from '@deepseek-ai/dsh-browser'

/** Default browser cache root, matching the documented `~/.cache/puppeteer` location. */
export const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'puppeteer')

/** Where the provider's progress callback reports during provisioning. */
export type ProvisionLog = (message: string) => void

/**
 * Find an installed Chrome Headless Shell executable. Without `buildId` the
 * newest installed build wins; with one, only that build matches. Returns
 * `undefined` when nothing usable is cached (missing cache directory
 * included). `@puppeteer/browsers` lists build directories without checking
 * the binary, so an entry whose executable file is absent — e.g. the empty
 * directory an interrupted download leaves behind — is ignored rather than
 * reported as a cache hit.
 *
 * @param cacheDir - the `@puppeteer/browsers` cache root.
 * @param buildId - optional exact build to match.
 * @returns the executable path, or `undefined` when absent.
 */
export async function findInstalledExecutable(cacheDir: string, buildId?: string): Promise<string | undefined> {
  let installed
  try {
    installed = await getInstalledBrowsers({ cacheDir })
  } catch {
    return undefined
  }
  const shells = installed.filter(entry =>
    entry.browser === Browser.CHROMEHEADLESSSHELL && existsSync(entry.executablePath))
  const matching = buildId === undefined ? shells : shells.filter(entry => entry.buildId === buildId)
  const [newest] = [...matching].sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))
  return newest?.executablePath
}

/**
 * Ensure a Chrome Headless Shell executable exists and return its path.
 * Resolution order: an explicitly configured `buildId` cache hit → newest
 * cached build (no `buildId`) → network install of the requested (or current
 * stable) build. Provisioning failures throw {@link BrowserError}
 * `BROWSER_PROVISION_FAILED` with the network/platform cause chained; nothing
 * is silently skipped.
 *
 * @param options - cache directory, optional pinned build id, progress sink.
 * @returns the executable path of a present build.
 */
export async function provisionExecutable(options: {
  readonly cacheDir: string
  readonly buildId?: string
  /** `off` never downloads: a cache miss is a loud failure. */
  readonly provision?: 'auto' | 'off'
  readonly log?: ProvisionLog
}): Promise<string> {
  const { cacheDir, buildId, log } = options
  const platform = detectBrowserPlatform()
  if (platform === undefined) {
    throw new BrowserError('no supported browser platform detected for Chrome Headless Shell provisioning', 'BROWSER_PROVISION_FAILED')
  }
  const found = await findInstalledExecutable(cacheDir, buildId)
  if (found !== undefined) return found
  if (options.provision === 'off') {
    throw new BrowserError(
      'Chrome Headless Shell is not present and provisioning is disabled (provision: "off"); install it, point executablePath at it, or set provision: "auto"',
      'BROWSER_PROVISION_FAILED',
    )
  }
  if (buildId !== undefined) {
    log?.(`browser: build ${buildId} not cached; downloading Chrome Headless Shell`)
  } else {
    log?.('browser: resolving the current stable Chrome Headless Shell build (first run downloads ~100 MB)')
  }
  let resolvedBuildId: string
  try {
    resolvedBuildId = buildId ?? await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, 'stable')
  } catch (error: unknown) {
    throw new BrowserError('browser: could not resolve a Chrome Headless Shell build (offline? pin buildId in config)', 'BROWSER_PROVISION_FAILED', { cause: error })
  }
  try {
    const installed = await install({
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId: resolvedBuildId,
      cacheDir,
      downloadProgressCallback: (downloaded, total) => {
        if (total > 0 && downloaded === total) log?.(`browser: downloaded Chrome Headless Shell ${resolvedBuildId} (${total} bytes)`)
      },
    })
    return installed.executablePath
  } catch (error: unknown) {
    throw new BrowserError(`browser: Chrome Headless Shell ${resolvedBuildId} download failed (offline? pin a cached buildId or set executablePath)`, 'BROWSER_PROVISION_FAILED', { cause: error })
  }
}
