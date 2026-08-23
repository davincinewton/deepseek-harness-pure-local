import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { SearchResponse } from 'ddg-search'
import * as ddgsPlugin from '@deepseek-ai/dsh-web-search-ddgs'
import { DUCKDUCKGO_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-ddgs'

// The provider calls ddg-search's network-bound search(); mock it so this composition test is
// deterministic and needs no live DuckDuckGo. The seam and plugin wiring under test are real.
vi.mock('ddg-search', () => ({ search: vi.fn() }))
const { search } = await import('ddg-search')
const searchMock = vi.mocked(search)

function response(results: SearchResponse['results']): SearchResponse {
  return { results, spelling: null, zeroClick: null, pagesScraped: 1, query: 'q' }
}

describe('web-search-ddgs plugin registration (real composition)', () => {
  beforeEach(() => {
    searchMock.mockReset()
  })

  it('registers the provider into ctx.web and serves a search (HMR-safe)', async () => {
    searchMock.mockResolvedValue(response([
      { url: 'https://a.test', title: 'A', description: 'alpha', displayUrl: 'a.test' },
    ]))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgsPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'alpha' }],
      truncated: false,
    })
    // Disposing the plugin fiber removes the provider from the seam (HMR safety).
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('threads the configured defaultMaxResults through to ddg-search', async () => {
    searchMock.mockResolvedValue(response([]))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgsPlugin, { defaultMaxResults: 9 })
    await ctx.web.search({ query: 'q' })
    expect(searchMock.mock.calls[0]![1]!.maxResults).toBe(9)
    await fiber.dispose()
  })

  it('surfaces a ddg-search failure as a provider error through the seam', async () => {
    searchMock.mockRejectedValue(new Error('Anti-bot detection triggered on first request. Try again later.'))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgsPlugin, {})
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ddgsPlugin).toBe(false)
  })
})
