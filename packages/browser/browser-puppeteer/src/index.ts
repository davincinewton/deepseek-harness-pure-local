/**
 * `@deepseek-ai/dsh-browser-puppeteer`: registers a `BrowserProvider` backed by
 * `puppeteer-core` and Chrome Headless Shell with `ctx.browser`. A
 * function/namespace plugin (NOT a default-export service): it registers INTO
 * the seam's provider registry, like the web fetch provider does. First use
 * provisions the headless browser binary when `provision: 'auto'`; boot only
 * kicks the idempotent check off in the background.
 *
 * @module @deepseek-ai/dsh-browser-puppeteer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-browser'
import { PuppeteerBrowserProvider } from './provider.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export {
  PUPPETEER_PROVIDER_ID,
  PuppeteerBrowserProvider,
} from './provider.ts'
export type { PuppeteerProviderOptions } from './provider.ts'
export { DEFAULT_CACHE_DIR, findInstalledExecutable, provisionExecutable } from './provision.ts'
export { assertNavigationTargetAllowed, isBlockedAddress, validateNavigateUrl } from './policy.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-puppeteer'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/**
 * Plugin config. `provision: 'auto'` (default) locates a cached Chrome Headless
 * Shell or downloads it on first use; `'off'` requires `executablePath` or an
 * already-cached build and fails loud otherwise. Navigation targets default to
 * public http(s) addresses: loopback needs `allowLoopback`, and hosts whose DNS
 * resolves to private/reserved addresses need `allowHosts`.
 */
export interface Config {
  /** `auto` provisions Chrome Headless Shell on demand; `off` never downloads. Validated to exactly one of the two at load. */
  provision?: string
  /** Exact Chrome Headless Shell build id to use/install. Empty = newest cached / current stable. */
  buildId?: string
  /** Browser cache root. Empty = `~/.cache/puppeteer`. */
  cacheDir?: string
  /** Explicit Chrome Headless Shell executable. Empty = resolve from cache/provision. */
  executablePath?: string
  /** Chrome profile directory. Empty = an ephemeral per-process one, removed on dispose. */
  userDataDir?: string
  /** Extra Chrome launch arguments (e.g. `--no-sandbox` in containers without user namespaces). */
  chromeArgs?: string[]
  /** Navigation budget in milliseconds. */
  navigationTimeoutMs?: number
  /** Element wait / action budget in milliseconds. */
  actionTimeoutMs?: number
  /** Post-click wait for a follow-up navigation to settle. */
  actionSettleMs?: number
  /** Maximum accepted request URL length. */
  maxUrlLength?: number
  /** Hard bound on snapshot text returned by one page evaluation. */
  maxEvaluateTextChars?: number
  /** Allow loopback navigation targets. */
  allowLoopback?: boolean
  /** Hostnames allowed regardless of address class (exact, case-insensitive). */
  allowHosts?: string[]
}

export const Config: z<Config> = z.object({
  provision: z.string().default('auto'),
  buildId: z.string().default(''),
  cacheDir: z.string().default(''),
  executablePath: z.string().default(''),
  userDataDir: z.string().default(''),
  chromeArgs: z.array(z.string()).default([]),
  navigationTimeoutMs: z.number().default(45_000),
  actionTimeoutMs: z.number().default(15_000),
  actionSettleMs: z.number().default(2_000),
  maxUrlLength: z.number().default(2048),
  maxEvaluateTextChars: z.number().default(500_000),
  allowLoopback: z.boolean().default(false),
  allowHosts: z.array(z.string()).default([]),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A time/size budget must be a positive finite number within Node's timer range. */
function assertPositiveBudget(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`browser-puppeteer: ${name} must be a positive finite number no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** A size/length cap must be a positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`browser-puppeteer: ${name} must be a positive integer`)
  }
}

/**
 * Register the Puppeteer browser provider with `ctx.browser`. Provisioning is
 * kicked off (not awaited) so a first-run download never blocks boot; the
 * tools fail with a structured `BROWSER_PROVISION_FAILED` while the browser is
 * unusable. The provider's teardown is fiber-scoped: disposing the plugin
 * closes pages, quits Chrome, and removes the ephemeral profile.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveBudget('navigationTimeoutMs', resolved.navigationTimeoutMs)
  assertPositiveBudget('actionTimeoutMs', resolved.actionTimeoutMs)
  assertPositiveBudget('actionSettleMs', resolved.actionSettleMs)
  assertPositiveInteger('maxUrlLength', resolved.maxUrlLength)
  assertPositiveInteger('maxEvaluateTextChars', resolved.maxEvaluateTextChars)
  if (resolved.provision !== 'auto' && resolved.provision !== 'off') {
    throw new Error(`browser-puppeteer: provision must be 'auto' or 'off'; got ${JSON.stringify(resolved.provision)}`)
  }
  const provider = new PuppeteerBrowserProvider({
    executablePath: resolved.executablePath,
    cacheDir: resolved.cacheDir,
    buildId: resolved.buildId,
    provision: resolved.provision,
    userDataDir: resolved.userDataDir,
    chromeArgs: resolved.chromeArgs,
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    actionTimeoutMs: resolved.actionTimeoutMs,
    actionSettleMs: resolved.actionSettleMs,
    maxUrlLength: resolved.maxUrlLength,
    maxEvaluateTextChars: resolved.maxEvaluateTextChars,
    policy: {
      allowLoopback: resolved.allowLoopback,
      allowHosts: resolved.allowHosts,
    },
    log: (message) => { ctx.logger.info(message) },
  })
  ctx.browser.registerProvider(provider)
  provider.prewarm()
  ctx.effect(function* () {
    yield () => provider.dispose()
  }, 'browser-puppeteer teardown')
}
