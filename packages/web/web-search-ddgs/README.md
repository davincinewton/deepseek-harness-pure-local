# @deepseek-ai/dsh-web-search-ddgs

English | [中文](README.zh.md)

A [DuckDuckGo](https://duckduckgo.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It queries DuckDuckGo's HTML endpoint **in-process** through the maintained [`ddg-search`](https://www.npmjs.com/package/ddg-search) library and maps the returned `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, does not own the `ctx.web` key, and does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

Unlike the credential-backed search providers, this one needs **no API key**: it runs in-process with no external interpreter or committed runner to resolve, so its `available()` is always `true`. That is why it is the shipped default `searchProvider` — `web_search` works out of the box on a deployment with no key, where a keyless DeepSeek route would fail the call as `WEB_PROVIDER_CREDENTIAL_MISSING`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `defaultMaxResults` | `5` | Default result count when a request carries no `maxResults`. A positive integer. A per-request `maxResults` always wins. |

```yaml
- id: web-search-ddgs
  name: '@deepseek-ai/dsh-web-search-ddgs'
  config:
    defaultMaxResults: 10
```

The base bundle pins `searchProvider: duckduckgo` and sets `defaultMaxResults: 10`; the DeepSeek route stays registered for a deployment that sets a key and opts in via `searchProvider: deepseek-official`. Pinning selects one provider, so no `WEB_PROVIDER_AMBIGUOUS` is raised.

## Mapping

`ddg-search` returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `description`. Empty `title`/`description` strings are dropped so the seam never carries a blank field; a result with no title and no snippet still returns as `url`-only. `publishedAt` is absent — `ddg-search` provides no publication date.

A request's `maxResults` wins over the configured `defaultMaxResults` and is passed to `ddg-search`; the seam re-enforces the bound on the way back. A genuine zero-match is a valid, non-error result: it returns `{ sources: [] }`. Provider failures (anti-bot detection, HTTP, network) surface as `WebError` `WEB_PROVIDER_ERROR`; a pre-aborted or in-flight-aborted request surfaces as `WEB_ABORTED`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, and snippets under the consumer's error wrapper, or its exact `DuckDuckGo search aborted` and `DuckDuckGo search failed: <error>` failures. `ddg-search` produces no generated answer, so none enters context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Throttling masquerades as empty** — DuckDuckGo has no official API and rate-limits rapid repeated requests from one IP. `ddg-search` returns an empty result for both a genuine zero-match and a throttled request, so a throttled search reports "no results" rather than a failure. The provider deliberately does not distinguish the two: a second empty is still returned as `{ sources: [] }` (honest), not converted into an error.
- **No `publishedAt`** — `ddg-search` carries no publication date, so sources never have one.
- **Region and recency are fixed** — the provider sends `region: ''` and `time: ''`; regional and recency controls wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Unofficial endpoint, no SLA** — DuckDuckGo's HTML endpoint is unofficial and can change or block scrapers freely; a free provider with no availability guarantee.
