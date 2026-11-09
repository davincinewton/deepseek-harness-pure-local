---
name: headless-multi-engine-search
description: "Use when a search task needs broader or less biased coverage than a single engine — e.g. \"search with multiple engines\", \"cross-check these results\" — or when one engine is blocked or its ranking suspect and the mcp-chrome bridge is not available. Runs the same query through DuckDuckGo, Bing, and Baidu on the built-in managed headless browser (browser_* tools; no MCP bridge), merges the three lists with cross-engine dedup and corroboration (each item records which engines returned it), resolves a chosen set into clean real URLs with captured full text, and emits a web-search-chrome-url-compatible JSON manifest plus an engines field per item."
---

# Headless Multi-Engine Search → Corroborated URL Manifest

Run the **same query through 3 search engines** (DuckDuckGo, Bing, Baidu) on the built-in managed headless browser (the `browser_*` tools), merge the three lists with **cross-engine dedup and corroboration**, resolve a **chosen set** into **clean, real URLs** with captured full text, and emit a **structured JSON manifest** in the `web-search-chrome-url` shape plus an `engines` field per item.

## Why this skill exists

Single-engine results are biased by that engine's index and ranking model. Cross-engine agreement is a cheap relevance signal: a result returned by 2–3 independent engines is more likely genuinely on-topic than one from a single engine.

`headless-web-search` searches **DuckDuckGo first** (Bing/Baidu are fallbacks there). This skill makes all three first-class, and each engine is **degradable**: an engine blocked for the headless browser is recorded as unavailable while the rest still run — from a given network DuckDuckGo, Bing, or Baidu may answer while another blocks. Two of the three engines need **no clicks to reach a clean URL** (DuckDuckGo's decoded `uddg`, Baidu's `link?url=` token followed by navigation); only Bing rows cost a click. The user's real Chrome is not involved: results are anonymous and not personalized; state that in any downstream methodology.

## Preconditions

- The `browser_*` tools must be available (same list as `headless-web-search`). If they are not, report the capability unavailable and offer `web_search` as a degraded alternative (single engine, snippets only).
- Reuse `headless-web-search` for the shared primitives (navigation statuses, wall detection, per-engine extraction, Bing click resolution, return-by-re-navigation). Load it if unsure.
- If a `browser_act` call is denied by the approval gate, stop click-resolving, emit the manifest with everything captured so far, and record the remaining Bing items as `unresolved` with the note `"approval denied"`. DuckDuckGo and Baidu items are unaffected — they resolve by navigation. Never retry a denied call.

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions.
- **One managed page, reused**: it navigates DuckDuckGo → Bing → Baidu in sequence; `browser_close` once at the end.
- **One page per engine** (cap 8 items each, ~24 raw items before merge) to bound the call budget; the single-engine skill uses two DuckDuckGo pages because it is single-engine.
- **Never emit or pass a raw `href` token**: Bing `/ck/a` and Baidu `link?url=` tokens go into no output; only resolved final URLs (or DuckDuckGo's decoded `uddg` URL) do.
- **An engine wall degrades, never halts**: 403 / navigation error / Baidu security-verification page / rows whose fields are all empty → record the engine in `unavailableEngines` and continue. Never retry a blocked engine. If all three are unavailable, stop and run `web_search` as the degraded alternative, saying so.
- **Resolve in ascending `index`** and **verify the row list after every return** (re-extract; count and first title must match) — re-navigate to the engine's search URL if it changed.

## Step 1 — Search all 3 engines (1 page each)

On the one managed page, in this order. Each navigation returns `{url, title, statusCode}` — apply the wall rules before extracting. All extractions use `limit: 8`, `maxFieldChars: 200`.

1. **DuckDuckGo**: `https://html.duckduckgo.com/html/?q=<url-encoded query>` — extract with `browser_extract_list`: selector `#links .result`, fields `title` → selector `.result__a`, `url` → selector `.result__a` attribute `href`, `snippet` → selector `.result__snippet`. URL-decode the `uddg` parameter in each `url` to get the clean real URL, and **discard rows whose decoded URL points at `duckduckgo.com/y.js`** (sponsored redirects).
2. **Bing**: `https://www.bing.com/search?q=<url-encoded query>&setlang=en` — extract with selector `li.b_algo`, fields `title` → selector `h2`, `snippet` → selector `p`. Rows with empty fields everywhere = results-less shell → unavailable. Bing links are `/ck/a` tokens: no clean URL comes from the results page.
3. **Baidu**: `https://www.baidu.com/s?wd=<url-encoded query>&rn=10` — extract with selector `div.c-container`, fields `title` → selector `h3`, `url` → selector `h3 a` attribute `href`, `snippet` → selector `[class*=abstract]` (snippet/source class names rotate; on 0 rows take one `browser_snapshot` and adapt once). A security-verification redirect or still-0 rows → unavailable. Each `url` is a `link?url=` redirect token: never emit it; Step 3.2 navigates to it. Expect Chinese-language results even for English queries — keep them as real coverage and say so downstream.

Per-engine record: `{ engine, count, items: [{ title, source?, date?, snippet, url?, token?, pos }] }` — `pos` is the 0-based position within that engine's rows (the `index` to click in Step 3), `url` is the clean URL for DuckDuckGo items, `token` the navigation-resolvable token for Baidu items; Bing items carry neither until Step 3 resolves them.

## Step 2 — Merge with corroboration

Deduplicate across engines by **normalized title** (lowercase, strip punctuation and repeated whitespace) and, when both items carry a URL, by URL host + path. Keep the first occurrence's field values (prefer the one with richer snippet/date), and set `engines` to every engine that returned the item, in engine order. Order the merged list by **engine count (desc), then first-seen position**; ties break by engine order (DuckDuckGo > Bing > Baidu). Assign each item a stable 0-based `index`. If Bing was blocked, `unavailableEngines` includes `bing`, etc.

## Step 3 — Resolve and capture the chosen set (ascending index)

Choose the items the task needs (top N or per-angle picks; prefer 2–3-engine corroborated items). For each:

1. **DuckDuckGo items**: `browser_navigate` to the decoded URL — no click needed.
2. **Baidu items**: `browser_navigate` to the recorded `link?url=` token; the returned status `url` is the clean real URL. A verification/error page means the token died — re-extract that engine's results for a fresh token once, else `unresolved`, note `"redirect blocked"`.
3. **Bing items**: `browser_act` click, `index` = the item's `pos` within Bing's rows, target `#b_results h2 a`. The returned status carries the resolved `url` and page `title`; verify the title plausibly matches the result. If `url` is still on the Bing domain, `browser_wait` (no selector) once and re-read.
4. **Capture full text** on the landed page: `browser_extract` (no selector, `maxChars: 20000`). Paywall/bot-wall boilerplate or 401/403 → `unresolved` with a note.
5. **Date probe**: `browser_extract_list` with selector `head, article, main, body`, fields `published` → selector `meta[property="article:published_time"]` attribute `content`, `date` → selector `meta[name="date"]` attribute `content`, `when` → selector `time[datetime]` attribute `datetime` (field selectors resolve inside their row: the `head` row supplies `meta` values, the `article`/`main`/`body` rows supply visible `time` elements). First non-empty value → `published`; none → `published: null`.
6. **Return to the engine**: re-`browser_navigate` to that engine's search URL (navigating engines in engine order groups the returns). DuckDuckGo and Bing need no session tokens; Baidu mints fresh `link?url=` tokens per load, so always re-extract instead of reusing tokens. Re-extract, verify count + first title, then the next item.

## Step 4 — Emit the manifest

A **JSON object** — the handoff artifact (superset of `headless-web-search`'s array):

```json
{
  "query": "…",
  "engines": ["duckduckgo", "bing", "baidu"],
  "unavailableEngines": [],
  "items": [
    {
      "index": 0,
      "title": "…",
      "source": "Reuters",
      "date": "2026-09-01",
      "published": "2026-09-01",
      "snippet": "…(≤200 chars)…",
      "type": "article",
      "url": "https://www.reuters.com/…",
      "captureMethod": "innerText",
      "fullText": "…",
      "engines": ["duckduckgo", "baidu"]
    }
  ],
  "unresolved": [ { "index": 7, "title": "…", "engines": ["bing"], "note": "paywall" } ]
}
```

- `captureMethod` is always `innerText`. `type`: `article` / `video` / `qa` / `social` / `hub`.
- The primary `items` array holds only resolved items with a real `url`; failures go to `unresolved` with a `note`.
- Render a short markdown table (title → linked url, engines, date) for readability; the **JSON is the contract**. No `href` tokens anywhere.
- Methodology: record which engines answered and that Baidu contributes Chinese-language coverage.

## Step 5 — Clean up

`browser_close` to release the managed page.

## Failure modes

| Symptom | Action |
|---|---|
| No `browser_*` tools in catalog | Capability unavailable; offer `web_search` (single engine, snippets only) |
| DuckDuckGo 403 or navigation error | `unavailableEngines += duckduckgo`; continue with Bing/Baidu |
| Decoded `uddg` points at `duckduckgo.com/y.js` | Sponsored redirect — discard the row, do not resolve it |
| Bing rows with empty fields | Results-less shell — `unavailableEngines += bing` |
| Baidu security-verification page or 0 rows after one adaptation | `unavailableEngines += baidu` |
| All three engines unavailable | Stop; `web_search` as degraded alternative; say so |
| Status `url` still engine-token after Bing click | `browser_wait` once; still a token → `unresolved`, note `"redirect not completed"` |
| Baidu `link?url=` token dies on navigation | Re-extract for a fresh token once; else `unresolved`, note `"redirect blocked"` |
| Row list changed after return | Re-navigate to that engine's search URL, re-align, continue |
| 0 rows on an engine's results page | One `browser_snapshot`, adapt selectors once; still 0 → engine unavailable |
| `browser_act` denied by approval gate | Stop click-resolving (Bing items only); emit what is captured; rest `unresolved`, note `"approval denied"`; DuckDuckGo/Baidu items unaffected |
