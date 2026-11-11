---
name: headless-multi-engine-search
description: "Use when a search task needs broader or less biased coverage than a single engine — e.g. \"search with multiple engines\", \"cross-check these results\" — or when one engine is blocked or its ranking suspect and the mcp-chrome bridge is not available. Runs the same query through DuckDuckGo and Brave on the built-in managed headless browser (browser_* tools; no MCP bridge), merges the two lists with cross-engine dedup and corroboration (each item records which engines returned it), resolves a chosen set into clean real URLs with captured full text, and emits a web-search-chrome-url-compatible JSON manifest plus an engines field per item."
---

# Headless Multi-Engine Search → Corroborated URL Manifest

Run the **same query through 2 search engines** (DuckDuckGo, Brave) on the built-in managed headless browser (the `browser_*` tools), merge the two lists with **cross-engine dedup and corroboration**, resolve a **chosen set** into **clean, real URLs** with captured full text, and emit a **structured JSON manifest** in the `web-search-chrome-url` shape plus an `engines` field per item.

## Why this skill exists

Single-engine results are biased by that engine's index and ranking model. Cross-engine agreement is a cheap relevance signal: a result returned by both independent engines is more likely genuinely on-topic than one from a single engine. DuckDuckGo and Brave run **separate crawls and indexes**, so agreement here is cross-index, not a mirror echo.

`headless-web-search` searches **DuckDuckGo first** (Bing/Brave are fallbacks there). This skill makes both of its two engines first-class, and each is **degradable**: an engine blocked for the headless browser is recorded as unavailable while the other still runs — from a given network DuckDuckGo or Brave may answer while the other blocks. Both engines carry the clean URL in every row (DuckDuckGo's decoded `uddg`, Brave's direct `href`), so the whole run is **read-only**: no clicks, no redirect tokens, no approval-gated calls. The user's real Chrome is not involved: results are anonymous and not personalized; state that in any downstream methodology.

## Preconditions

- The `browser_*` tools must be available (same list as `headless-web-search`). If they are not, report the capability unavailable and offer `web_search` as a degraded alternative (single engine, snippets only).
- Reuse `headless-web-search` for the shared primitives (navigation statuses, wall detection, DuckDuckGo/Brave extraction, return-by-re-navigation). Load it if unsure.

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions — `browser_act` is never needed.
- **One managed page, reused**: it navigates DuckDuckGo → Brave in sequence; `browser_close` once at the end.
- **One page per engine** (cap 8 items each, ~16 raw items before merge) to bound the call budget; the single-engine skill uses two DuckDuckGo pages because it is single-engine.
- **Clean URLs only**: DuckDuckGo rows decode their `uddg` parameter and Brave rows carry the direct `href`; nothing else is ever emitted or navigated.
- **An engine wall degrades, never halts**: 403 / navigation error / bot-challenge (CAPTCHA) page / rows whose fields are all empty → record the engine in `unavailableEngines` and continue. Never retry a blocked engine. If both engines are unavailable, stop and run `web_search` as the degraded alternative, saying so.
- **Resolve in ascending `index`** and **verify the row list after every return** (re-extract; count and first title must match) — re-navigate to the engine's search URL if it changed.

## Step 1 — Search both engines (1 page each)

On the one managed page, in this order. Each navigation returns `{url, title, statusCode}` — apply the wall rules before extracting. All extractions use `limit: 8`, `maxFieldChars: 200`.

1. **DuckDuckGo**: `https://html.duckduckgo.com/html/?q=<url-encoded query>` — extract with `browser_extract_list`: selector `#links .result`, fields `title` → selector `.result__a`, `url` → selector `.result__a` attribute `href`, `snippet` → selector `.result__snippet`. URL-decode the `uddg` parameter in each `url` to get the clean real URL, and **discard rows whose decoded URL points at `duckduckgo.com/y.js`** (sponsored redirects).
2. **Brave**: `https://search.brave.com/search?q=<url-encoded query>` — navigate with `waitUntil: networkidle2` (Brave renders its result column shortly after load; extracting at `load` can see 0 rows; `browser_wait` without a selector is the alternative). Extract with `browser_extract_list`: selector `div:has(> a[href^="https"]:not([href*="brave.com"]))`, fields `title` → selector `a[href^="https"]`, `url` → selector `a[href^="https"]` attribute `href`. Each `url` is the article's **direct URL — no token, no click**. A bot-challenge page, or still-0 rows after one `browser_snapshot` adaptation → unavailable. The selector can yield duplicate rows for one URL — the Step 2 URL dedup folds them into one item.

Per-engine record: `{ engine, count, items: [{ title, source?, date?, snippet, url, pos }] }` — `pos` is the 0-based position within that engine's rows (merge order), `url` the clean real URL.

## Step 2 — Merge with corroboration

Deduplicate across engines by **normalized title** (lowercase, strip punctuation and repeated whitespace) and, when both items carry a URL, by URL host + path. Keep the first occurrence's field values (prefer the one with richer snippet/date), and set `engines` to every engine that returned the item, in engine order. Order the merged list by **engine count (desc), then first-seen position**; ties break by engine order (DuckDuckGo > Brave). Assign each item a stable 0-based `index`. A blocked engine lands in `unavailableEngines`.

## Step 3 — Resolve and capture the chosen set (ascending index)

Choose the items the task needs (top N or per-angle picks; prefer two-engine corroborated items). For each:

1. **Any item**: `browser_navigate` to the recorded clean URL — both engines' rows already hold it, so there is no click or token step.
2. **Capture full text** on the landed page: `browser_extract` (no selector, `maxChars: 20000`). Paywall/bot-wall boilerplate or 401/403 → `unresolved` with a note.
3. **Date probe**: `browser_extract_list` with selector `head, article, main, body`, fields `published` → selector `meta[property="article:published_time"]` attribute `content`, `date` → selector `meta[name="date"]` attribute `content`, `when` → selector `time[datetime]` attribute `datetime` (field selectors resolve inside their row: the `head` row supplies `meta` values, the `article`/`main`/`body` rows supply visible `time` elements). First non-empty value → `published`; none → `published: null`.
4. **Return to the engine**: re-`browser_navigate` to that engine's search URL (navigating engines in engine order groups the returns). Neither engine needs session tokens; Brave appends its own `conversation=` parameter to the address bar after load, so always re-navigate to the ORIGINAL search URL you recorded. Re-extract, verify count + first title, then the next item.

## Step 4 — Emit the manifest

A **JSON object** — the handoff artifact (superset of `headless-web-search`'s array):

```json
{
  "query": "…",
  "engines": ["duckduckgo", "brave"],
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
      "engines": ["duckduckgo", "brave"]
    }
  ],
  "unresolved": [ { "index": 7, "title": "…", "engines": ["duckduckgo"], "note": "paywall" } ]
}
```

- `captureMethod` is always `innerText`. `type`: `article` / `video` / `qa` / `social` / `hub`.
- The primary `items` array holds only resolved items with a real `url`; failures go to `unresolved` with a `note`.
- Render a short markdown table (title → linked url, engines, date) for readability; the **JSON is the contract**.
- Methodology: record which engines answered and that the two engines searched independent indexes, so a two-engine match spans both.

## Step 5 — Clean up

`browser_close` to release the managed page.

## Failure modes

| Symptom | Action |
|---|---|
| No `browser_*` tools in catalog | Capability unavailable; offer `web_search` (single engine, snippets only) |
| DuckDuckGo 403 or navigation error | `unavailableEngines += duckduckgo`; continue with Brave |
| Decoded `uddg` points at `duckduckgo.com/y.js` | Sponsored redirect — discard the row, do not resolve it |
| Brave shows 0 rows right after navigation | Results render after load — navigate with `networkidle2` or `browser_wait` (no selector) first; still 0 rows after one selector adaptation → `unavailableEngines += brave` |
| Brave bot-challenge page (rare) | `unavailableEngines += brave` |
| Both engines unavailable | Stop; `web_search` as degraded alternative; say so |
| Duplicate rows for one Brave URL | Expected — Step 2 URL dedup folds them |
| Row list changed after return | Re-navigate to that engine's search URL, re-align, continue |
| 0 rows on an engine's results page | One `browser_snapshot`, adapt selectors once; still 0 → engine unavailable |
