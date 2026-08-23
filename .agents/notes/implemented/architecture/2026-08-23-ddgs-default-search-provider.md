# Agent Note: DuckDuckGo is the keyless default search provider, in-process over `ddg-search`

Status: implemented

English | [中文](2026-08-23-ddgs-default-search-provider.zh.md)

## Problem

The shipped default `searchProvider` was `deepseek-official`, a credential-backed route: on a deployment with no `DEEPSEEK_API_KEY`, `web_search` fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`, so the model's web-search tool is dead out of the box. Every other registered search provider (Exa, Perplexity, DeepSeek) also needs a key, so a fresh deployment had no working search path at all.

## Decision

**DuckDuckGo is the shipped default `searchProvider`, backed by the in-process `ddg-search` library.** `@deepseek-ai/dsh-web-search-ddgs` registers a `WebSearchProvider` (id `duckduckgo`) that queries DuckDuckGo's HTML endpoint in-process through the maintained [`ddg-search`](https://www.npmjs.com/package/ddg-search) JS/TS scraper — no external interpreter, no committed Python runner, and no hand-rolled fetch scraper. Its `available()` is always `true` because there is nothing to resolve; connectivity is only known at search time. The base bundle pins `searchProvider: duckduckgo` and sets `defaultMaxResults: 10`; the DeepSeek route stays registered for a deployment that sets a key and opts in via `searchProvider: deepseek-official`. Pinning one id means selection never becomes `WEB_PROVIDER_AMBIGUOUS`.

**A genuine zero-match and a throttled request both return `{ sources: [] }` — the provider does not detect throttling.** DuckDuckGo rate-limits rapid repeated requests, and `ddg-search` reports both a real zero-match and a throttled request as an empty result list. Rather than heuristically convert a second empty into an error — which would turn legitimate no-results queries into false failures — the provider returns the empty result honestly. The tradeoff is that a throttled search reports "no results" instead of a visible error; the limitation is recorded in the package README.

## Alternatives considered

- **A Python subprocess runner over the `ddgs` library** — honors the upstream repo directly but drags a Python runtime and `pip install` into a Node harness, adds interpreter detection (`python3`/`py -3`), and spawns a subprocess per search. Rejected: the in-process `ddg-search` library gives the same DuckDuckGo retrieval with none of that infrastructure.
- **A hand-rolled fetch scraper over DuckDuckGo's HTML endpoint** — zero external deps, but hand-maintains the scraping that `ddg-search` already maintains. Rejected: prefer the maintained dependency over hand-rolling owned code and tests.
- **Keep `deepseek-official` as the default and leave keyless search dead** — preserves the current behavior but leaves `web_search` non-functional on any deployment without a key, which is the common case for a first run.

## Consequences

A fresh deployment has a working `web_search` with zero credentials: the default route needs no key and no extra runtime. A deployment that sets a DeepSeek key and pins `searchProvider: deepseek-official` gets the structured DeepSeek search instead; the two routes are mutually exclusive via the pin.

`ddg-search`'s `postinstall` runs a local build step, so the package is allow-listed in `pnpm-workspace.yaml` `allowBuilds`. The provider is a function/namespace plugin (`inject: ['web']`) with a package-owned invariant companion that declares no runtime invariant — it exposes no event sequence or mutable data relation beyond the seam's contracts.

The throttling-vs-empty tradeoff is a standing limitation, not a bug: it is documented in the package README's known-limitations section and is what makes the keyless default safe to ship.

## Testing

`packages/web/web-search-ddgs/tests/provider.spec.ts` pins the result mapping (url/title/snippet, blank-field omission, honest empty for a second zero-match), the `maxResults` resolution order (per-request, configured, default), and the error translation (provider failure → `WEB_PROVIDER_ERROR` with cause; pre-aborted and in-flight abort → `WEB_ABORTED`). `tests/plugin.spec.ts` is the REAL-composition test: it boots the real `WebRuntime` + plugin through a `Context`, serves a search, and proves HMR-safety by disposing the fiber and observing `WEB_PROVIDER_CONFIGURED_MISSING`.
