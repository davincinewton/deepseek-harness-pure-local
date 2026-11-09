---
name: headless-web-search
description: "Use when search results from the managed headless browser must be handed off to a downstream deep-fetch workflow that runs in a SEPARATE session (or after the browser page is closed), or when the user asks for a browser search that does not touch their own Chrome. Runs a DuckDuckGo search (two pages) on the built-in managed headless browser (browser_* tools; no MCP bridge) — degrading to Bing, then Baidu, when an engine blocks the headless browser — resolves every row to a clean real URL (no click needed on the default engines), captures each chosen page's full text while it is on screen, and emits a web-search-chrome-url-compatible JSON manifest of {title, source, date, snippet, url, fullText, published, type} plus an unresolved list with notes."
---

# Headless Web Search → Resolved URL Manifest

Search the web through the built-in managed headless browser (the `browser_*` tools) and emit a **structured JSON manifest**: clean real URLs, each page's captured full text, and the article's own published date — the handoff artifact a separate-session fetch workflow consumes **without the browser page and without opaque redirect tokens**. No MCP bridge and no user browser: the engine sees an anonymous plain-Chrome browser, so results are not personalized; state that in any downstream methodology.

## Why this skill exists

DuckDuckGo (the default engine) embeds the real URL in every result link (`uddg=` parameter — decode it, no navigation needed) and Baidu's `link?url=` tokens resolve by a plain navigation, so clean URLs come **free from the search page itself**: the whole default path runs with read-only tools and no approval-gated calls. The manifest is therefore the only output; there is no separate link-list mode. Bing — the middle fallback — is the one engine whose `/ck/a` links resolve only by clicking its rows, so click resolution survives as a Bing-only step.

## Preconditions

- The `browser_navigate`, `browser_act`, `browser_wait`, `browser_extract_list`, `browser_extract`, and `browser_close` tools must be in this session's catalog. If they are not, this skill cannot run: its output requires URL decoding/capture on live pages. Report the capability as unavailable and offer `web_search` as a degraded alternative (snippets only, no resolved URLs or full text). Do not loop.
- The first browser call can take a while: it launches Chrome Headless Shell, and on a fresh install downloads it first. Wait it out once.
- `browser_act` is needed only when the search ran on **Bing**. If a `browser_act` call is denied by the session's approval gate, stop click-resolving, emit the manifest with everything captured so far, and record the remaining Bing items under `unresolved` with the note `"approval denied"`. Never retry a denied call. DuckDuckGo and Baidu items are unaffected — they resolve by navigation.
- For a search in the user's own logged-in Chrome (personalized results), use `web-search-chrome` / `web-search-chrome-url` instead — they need the mcp-chrome bridge.

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions.
- **One managed page for the whole run**: every call reuses it; `browser_close` when done.
- **Never emit or pass a raw `href` token**: Bing `/ck/a` and Baidu `link?url=` tokens go into no output; only resolved final URLs (or DuckDuckGo's decoded `uddg` URL) do.
- **Wall detection**: an HTTP 403, a navigation error, or rows whose fields are all empty means that engine refused this browser — degrade per Fallback engines. Never retry a blocked engine.
- **Two pages on DuckDuckGo, one page on a fallback engine**; cap 8 rows per page and 200 characters per field (the extraction call enforces both).

## Step 1 — Search DuckDuckGo (two pages)

1. Page 1: `browser_navigate` to `https://html.duckduckgo.com/html/?q=<url-encoded query>`. A 403 status means DuckDuckGo is unavailable — go to the fallback chain.
2. Extract with `browser_extract_list` (`limit: 8`, `maxFieldChars: 200`): selector `#links .result`, fields `title` → selector `.result__a`, `url` → selector `.result__a` attribute `href`, `snippet` → selector `.result__snippet`.
3. Each `url` value is `…/l/?uddg=<percent-encoded>`: URL-decode the `uddg` parameter value to get the clean real URL. **Discard ad rows**: a decoded URL pointing at `duckduckgo.com/y.js` is a sponsored redirect, not a result.
4. Page 2: `browser_navigate` to `https://html.duckduckgo.com/html/?q=<url-encoded query>&s=10&dc=11&v=l` and extract the same way. A refused page 2 still yields page 1 — present it and note the missing page.
5. Merge the two pages, deduplicate by title (keep the page-1 occurrence), preserve order, and assign a stable 0-based `index` to each surviving item.

## Fallback engines (only when DuckDuckGo is unavailable; try in order)

The first engine that answers is the search. Record which engine answered for the manifest's methodology.

1. **Bing**: `https://www.bing.com/search?q=<url-encoded query>&setlang=en` — rows present but every field empty means a results-less shell was served: unavailable. Extract with selector `li.b_algo`, fields `title` → selector `h2`, `snippet` → selector `p`. Bing links are `/ck/a` tokens: no clean URL comes from the results page, so each item resolves only by the click step (Step 3.2).
2. **Baidu**: `https://www.baidu.com/s?wd=<url-encoded query>&rn=10` — a redirect to a Baidu security-verification page, or 0 rows after one selector adaptation, means unavailable. Extract with selector `div.c-container`, fields `title` → selector `h3`, `url` → selector `h3 a` attribute `href`, `snippet` → selector `[class*=abstract]` (Baidu's snippet/source class names rotate; on 0 rows take one `browser_snapshot` and adapt once). Each `url` is an `http://www.baidu.com/link?url=…` redirect token: never emit it — Step 3.1 navigates to it and records the final URL. Expect a language mix: Baidu returns Chinese-language results even for English queries; keep them (they are real coverage) but say so downstream.

If all three engines are unavailable, report that every engine blocked the headless browser, run `web_search` as the degraded alternative, and say so.

## Step 2 — Choose the resolution set

Pick the items the downstream workflow needs (top N, per-segment picks; the task decides). DuckDuckGo items already hold their clean URL; Bing and Baidu items carry their token into Step 3.

## Step 3 — Resolve and capture, one item at a time (ascending index)

1. **DuckDuckGo items**: `browser_navigate` to the decoded URL. **Baidu items**: `browser_navigate` to the recorded `link?url=` token — the returned status is the landed page and its `url` is the clean real URL (the redirect was followed natively); a verification/error page instead means the token died — re-extract the results page for a fresh token once, else mark `unresolved`, note `"redirect blocked"`.
2. **Bing items**: `browser_act` with `action: click`, `index` = the item's 0-based position **within the current page's rows** (re-extract first to confirm alignment), target `#b_results h2 a`. The returned status is the landed page: its `url` is the clean real URL. If the status `url` is still on the Bing domain (slow redirect), `browser_wait` (no selector) once and re-read; still a token → `unresolved`, note `"redirect not completed"`.
3. For every landed page: verify the page `title` plausibly matches the result title; a mismatch means the wrong target landed — discard and say so.
4. **Capture full text** with `browser_extract` (no selector, `maxChars: 20000`): the rendered page's text. If the body is dominated by cookie/subscribe/paywall boilerplate or the status said 401/403, the item is paywalled/blocked — mark `unresolved` with a note and move on.
5. **Probe the article's own date** with `browser_extract_list`: selector `head, article, main, body`, fields `published` → selector `meta[property="article:published_time"]` attribute `content`, `date` → selector `meta[name="date"]` attribute `content`, `when` → selector `time[datetime]` attribute `datetime` (field selectors are resolved inside their row, so the `head` row supplies the `meta` values and the `article`/`main`/`body` rows supply visible `time` elements). First non-empty value wins → `published`; none → `published: null`.
6. **Return to results**: `browser_navigate` back to the recorded search URL (the DuckDuckGo page-1/2 URL, the Bing search URL, or the Baidu URL), re-extract, and verify the list still matches (row count + first title **of the post-decode, post-ad-filter list** — ad slots shuffle between loads) before the next item. DuckDuckGo and Bing need no session tokens; Baidu mints fresh `link?url=` tokens per load, so always re-extract instead of reusing tokens.

## Step 4 — Emit the manifest

Output the resolved set as a **JSON array** — the handoff artifact a separate-session fetch workflow parses:

```json
[
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
    "fullText": "…(captured article body; may be long)…"
  }
]
```

- `captureMethod` is always `innerText` (the rendered DOM's text).
- `fullText` is the captured body; long is fine — the downstream workflow reads it instead of re-navigating. Cap at ~20 000 characters when needed and note the cap; never drop the field.
- `published` (the article's own date) is preferred over the search-result `date` for time-window checks; keep both.
- `type`: `article` / `video` / `qa` / `social` / `hub`.
- Include **only** resolved items with a real `url` in the primary array; list failures (paywall, interstitial, redirect-not-completed, approval denied) in a separate `unresolved` array with a `note`.
- Also render a short markdown table (title → linked url, source, date) for readability. The **JSON is the contract**.
- Do not include `href` tokens anywhere in the output.

## Step 5 — Clean up

`browser_close` to release the managed page.

## Failure modes

| Symptom | Action |
|---|---|
| No `browser_*` tools in catalog | Capability unavailable; offer `web_search` (snippets only) |
| First browser call very slow | Chrome Headless Shell download/launch — wait it out once |
| DuckDuckGo 403 or navigation error | Engine unavailable — Bing, then Baidu; never retry DuckDuckGo |
| Decoded `uddg` points at `duckduckgo.com/y.js` | Sponsored redirect — discard the row, do not resolve it |
| Bing rows with empty fields | Results-less shell — engine unavailable, go to Baidu |
| Bing status `url` still engine-token after click | `browser_wait` once; still a token → `unresolved`, note `"redirect not completed"` |
| Baidu lands on security verification, or 0 rows | One `browser_snapshot` + selector adaptation; still failing → engine unavailable |
| Baidu `link?url=` token dies on navigation | Re-extract for a fresh token once; else `unresolved`, note `"redirect blocked"` |
| Consent/interstitial instead of the article | `unresolved`, note `"interstitial"`; do not solve it |
| Row list changed after return | Re-navigate to the search URL, re-extract, re-align indices, continue |
| 0 rows on a results page (first engine) | One `browser_snapshot`, adapt selectors once, else degrade engine |
| `browser_act` denied by approval gate (Bing only) | Stop click-resolving; emit what is captured; remaining Bing items `unresolved`, note `"approval denied"`; DuckDuckGo/Baidu items unaffected |
| All three engines unavailable | Stop; `web_search` as degraded alternative; say so |
| Extraction reports `truncated` | Raise `limit`/`maxFieldChars` once if more is genuinely needed |
