/**
 * `@deepseek-ai/dsh-web-search-ddgs`: registers a DuckDuckGo-backed `WebSearchProvider` with
 * `ctx.web`. A function/namespace plugin (NOT a default-export service): a search provider does
 * not own the `ctx.web` key — it registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * The provider queries DuckDuckGo's HTML endpoint in-process through the `ddg-search` library —
 * no external interpreter or committed runner to resolve, so there is no interpreter config.
 * @module @deepseek-ai/dsh-web-search-ddgs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_MAX_RESULTS,
  DuckDuckGoSearchProvider,
} from './provider.ts'

export {
  DUCKDUCKGO_DEFAULT_MAX_RESULTS,
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
} from './provider.ts'
export type { DuckDuckGoSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-ddgs'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` applies the result-count default). */
export interface Config {
  /** Default result count when a request carries no `maxResults`. */
  defaultMaxResults?: number
}

export const Config: z<Config> = z.object({
  defaultMaxResults: z.number().step(1).min(1),
})

/** Register the DuckDuckGo search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider({
    defaultMaxResults: config.defaultMaxResults ?? DUCKDUCKGO_DEFAULT_MAX_RESULTS,
  }))
}
