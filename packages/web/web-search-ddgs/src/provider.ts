/**
 * `DuckDuckGoSearchProvider`: a `WebSearchProvider` that queries DuckDuckGo's HTML endpoint
 * in-process through the maintained `ddg-search` library. This provider owns only the mapping
 * from `ddg-search`'s results to the seam's source shape and the translation of its failures
 * (anti-bot detection, HTTP, network) into `WebError`s. A genuine zero-match is a valid,
 * non-error result: `ddg-search` returns an empty result list for it, which this provider
 * returns as `{ sources: [] }` for the model to act on.
 * @module @deepseek-ai/dsh-web-search-ddgs/provider
 */

import { search } from 'ddg-search'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under (`searchProvider: duckduckgo`). */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Default result count when a request carries no `maxResults`. */
export const DUCKDUCKGO_DEFAULT_MAX_RESULTS = 5

/** Resolved provider options. */
export interface DuckDuckGoSearchProviderOptions {
  /** Default result count when a request carries no `maxResults`. */
  defaultMaxResults?: number
}

/**
 * Map one `ddg-search` result to the seam's citeable source. `title` and `snippet` are optional
 * on the seam; empty strings are dropped so the seam never carries a blank field.
 */
function toSource(result: { url: string; title: string; description: string }): WebSearchSource {
  return {
    url: result.url,
    ...(result.title.length > 0 ? { title: result.title } : {}),
    ...(result.description.length > 0 ? { snippet: result.description } : {}),
  }
}

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  constructor(private readonly options: DuckDuckGoSearchProviderOptions) {}

  /**
   * The provider is always locally usable: it runs in-process with no external interpreter or
   * committed runner to resolve. Connectivity to DuckDuckGo is only known at search time.
   */
  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // An explicit per-request bound wins over the configured default; both resolve here and the
    // seam re-enforces the bound on the way back regardless.
    const maxResults = request.maxResults ?? this.options.defaultMaxResults ?? DUCKDUCKGO_DEFAULT_MAX_RESULTS
    try {
      // A pre-aborted signal throws the native abort error here; the catch normalizes it to the
      // seam's WEB_ABORTED, the same as an abort that fires while the search is in flight.
      signal?.throwIfAborted()
      const response = await search(request.query, {
        maxPages: 1,
        maxResults,
        region: '',
        time: '',
        ...(signal !== undefined ? { signal } : {}),
      })
      return { sources: response.results.map(toSource), truncated: false }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED')
      if (error instanceof WebError) throw error
      throw new WebError(`DuckDuckGo search failed: ${String((error as Error)?.message ?? error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
