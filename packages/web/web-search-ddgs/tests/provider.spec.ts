import { beforeEach, describe, expect, it, vi } from 'vitest'
import { search } from 'ddg-search'
import type { SearchResponse } from 'ddg-search'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
} from '../src/provider.ts'

// Drive the ddg-search boundary deterministically: search() resolves with the next scripted
// response, so the provider's mapping and error translation are tested without a live DuckDuckGo.
vi.mock('ddg-search', () => ({ search: vi.fn() }))

const searchMock = vi.mocked(search)

function response(results: SearchResponse['results']): SearchResponse {
  return { results, spelling: null, zeroClick: null, pagesScraped: 1, query: 'q' }
}

describe('DuckDuckGoSearchProvider registration + availability', () => {
  it('registers under the stable "duckduckgo" id', () => {
    expect(new DuckDuckGoSearchProvider({}).id).toBe(DUCKDUCKGO_PROVIDER_ID)
  })

  it('is always available — it runs in-process with no external interpreter to resolve', () => {
    expect(new DuckDuckGoSearchProvider({}).available()).toBe(true)
  })
})

describe('DuckDuckGoSearchProvider search() result mapping', () => {
  beforeEach(() => {
    searchMock.mockReset()
  })

  it('maps ddg-search results to seam sources (url, title, snippet) and reports no truncation', async () => {
    searchMock.mockResolvedValue(response([
      { url: 'https://a.test', title: 'A', description: 'alpha', displayUrl: 'a.test' },
      { url: 'https://b.test', title: 'B', description: 'beta', displayUrl: 'b.test' },
    ]))
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).resolves.toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'alpha' },
        { url: 'https://b.test', title: 'B', snippet: 'beta' },
      ],
      truncated: false,
    })
  })

  it('omits empty title and snippet so the seam never carries a blank field', async () => {
    searchMock.mockResolvedValue(response([
      { url: 'https://a.test', title: '', description: '', displayUrl: 'a.test' },
      { url: 'https://c.test', title: 'C', description: '', displayUrl: 'c.test' },
    ]))
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).resolves.toEqual({
      sources: [
        { url: 'https://a.test' },
        { url: 'https://c.test', title: 'C' },
      ],
      truncated: false,
    })
  })

  it('returns an empty result for a genuine zero-match — a second zero-match is still honest', async () => {
    searchMock.mockResolvedValue(response([]))
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
    await expect(provider.search({ query: 'q2' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('passes the resolved maxResults (per-request, then configured, then default) to ddg-search', async () => {
    searchMock.mockResolvedValue(response([]))
    const provider = new DuckDuckGoSearchProvider({ defaultMaxResults: 7 })
    await provider.search({ query: 'q' })
    expect(searchMock.mock.calls[0]![1]!.maxResults).toBe(7)
    await provider.search({ query: 'q', maxResults: 3 })
    expect(searchMock.mock.calls[1]![1]!.maxResults).toBe(3)
    expect(new DuckDuckGoSearchProvider({}).id).toBe(DUCKDUCKGO_PROVIDER_ID)
    const defaultProvider = new DuckDuckGoSearchProvider({})
    searchMock.mockResolvedValue(response([]))
    await defaultProvider.search({ query: 'q' })
    expect(searchMock.mock.calls[2]![1]!.maxResults).toBe(5)
  })
})

describe('DuckDuckGoSearchProvider search() error paths', () => {
  beforeEach(() => {
    searchMock.mockReset()
  })

  it('surfaces a ddg-search failure (bot detection, HTTP, network) as WEB_PROVIDER_ERROR', async () => {
    searchMock.mockRejectedValue(new Error('Anti-bot detection triggered on first request. Try again later.'))
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('Anti-bot detection triggered'),
    })
  })

  it('carries the underlying failure as the cause', async () => {
    const cause = new Error('HTTP 503 Service Unavailable')
    searchMock.mockRejectedValue(cause)
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).rejects.toSatisfy((error: unknown) =>
      error instanceof WebError && (error as { cause?: unknown }).cause === cause)
  })

  it('stringifies a non-Error rejection into the provider error message', async () => {
    searchMock.mockRejectedValue('boom')
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DuckDuckGo search failed: boom',
    })
  })

  it('surfaces a pre-aborted request as WEB_ABORTED without calling ddg-search', async () => {
    const provider = new DuckDuckGoSearchProvider({})
    const controller = new AbortController()
    controller.abort()
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('surfaces an abort fired during the search as WEB_ABORTED, not a provider error', async () => {
    searchMock.mockImplementation((async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      throw new Error('AbortError')
    }) as typeof search)
    const provider = new DuckDuckGoSearchProvider({})
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('rethrows a WebError thrown by ddg-search instead of re-wrapping it', async () => {
    const webError = new WebError('already wrapped', 'WEB_PROVIDER_ERROR')
    searchMock.mockRejectedValue(webError)
    const provider = new DuckDuckGoSearchProvider({})
    await expect(provider.search({ query: 'q' })).rejects.toBe(webError)
  })
})
