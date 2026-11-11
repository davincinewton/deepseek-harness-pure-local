---
name: headless-web-search
description: "Use when search results from the managed headless browser must be handed off to a downstream deep-fetch workflow that runs in a SEPARATE session (or after the browser page is closed), or when the user asks for a browser search that does not touch their own Chrome. Runs a DuckDuckGo search (two pages) on the built-in managed headless browser (browser_* tools; no MCP bridge) — degrading to Brave, then Bing, when an engine blocks the headless browser — resolves every row to a clean real URL (no click needed on DuckDuckGo or Brave), captures each chosen page's full text while it is on screen, and emits a web-search-chrome-url-compatible JSON manifest of {title, source, date, snippet, url, fullText, published, type} plus an unresolved list with notes."
---

# Headless Web Search → Resolved URL Manifest

Search the web through the built-in managed headless browser (the `browser_*` tools) and emit a **structured JSON manifest**: clean real URLs, each page's captured full text, and the article's own published date — the handoff artifact a separate-session fetch workflow consumes **without the browser page and without opaque redirect tokens**. No MCP bridge and no user browser: the engine sees an anonymous plain-Chrome browser, so results are not personalized; state that in any downstream methodology.

## Why this skill exists

DuckDuckGo (the default engine) embeds the real URL in every result link (`uddg=` parameter — decode it, no navigation needed) and Brave rows carry the article's direct URL in `href`, so clean URLs come **free from the search page itself**: the default path and the first fallback both run with read-only tools and no approval-gated calls. The manifest is therefore the only output; there is no separate link-list mode. Bing — the last fallback — is the one engine whose `/ck/a` links resolve only by clicking its rows, so click resolution survives as a Bing-only step that a Brave answer avoids entirely.

## Preconditions

- The `browser_navigate`, `browser_act`, `browser_wait`, `browser_extract_list`, `browser_extract`, and `browser_close` tools must be in this session's catalog. If they are not, this skill cannot run: its output requires URL decoding/capture on live pages. Report the capability as unavailable and offer `web_search` as a degraded alternative (snippets only, no resolved URLs or full text). Do not loop.
- The first browser call can take a while: it launches Chrome Headless Shell, and on a fresh install downloads it first. Wait it out once.
- `browser_act` is needed only when the search ran on **Bing**. If a `browser_act` call is denied by the session's approval gate, stop click-resolving, emit the manifest with everything captured so far, and record the remaining Bing items under `unresolved` with the note `"approval denied"`. Never retry a denied call. DuckDuckGo and Brave items are unaffected — their rows already carry the clean URL.
- For a search in the user's own logged-in Chrome (personalized results), use `web-search-chrome` / `web-search-chrome-url` instead — they need the mcp-chrome bridge.

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions.
- **One managed page for the whole run**: every call reuses it; `browser_close` when done.
- **Never emit or pass a raw `href` token**: Bing `/ck/a` tokens go into no output; only resolved final URLs (DuckDuckGo's decoded `uddg` URL, or a Brave row's direct `href`) do.
- **Wall detection**: an HTTP 403, a navigation error, or rows whose fields are all empty means that engine refused this browser — degrade per Fallback engines. Never retry a blocked engine.
- **Two pages on DuckDuckGo, one page on a fallback engine**; cap 8 rows per page (12 on Brave — its row selector yields duplicate rows per URL, so the effective unique yield is ≈ 5–6) and 200 characters per field (the extraction call enforces both).

## Step 1 — Search DuckDuckGo (two pages)

1. Page 1: `browser_navigate` to `https://html.duckduckgo.com/html/?q=<url-encoded query>`. A 403 status means DuckDuckGo is unavailable — go to the fallback chain.
2. Extract with `browser_extract_list` (`limit: 8`, `maxFieldChars: 200`): selector `#links .result`, fields `title` → selector `.result__a`, `url` → selector `.result__a` attribute `href`, `snippet` → selector `.result__snippet`.
3. Each `url` value is `…/l/?uddg=<percent-encoded>`: URL-decode the `uddg` parameter value to get the clean real URL. **Discard ad rows**: a decoded URL pointing at `duckduckgo.com/y.js` is a sponsored redirect, not a result.
4. Page 2: `browser_navigate` to `https://html.duckduckgo.com/html/?q=<url-encoded query>&s=10&dc=11&v=l` and extract the same way. A refused page 2 still yields page 1 — present it and note the missing page.
5. Merge the two pages, deduplicate by title (keep the page-1 occurrence), preserve order, and assign a stable 0-based `index` to each surviving item.

## Fallback engines (only when DuckDuckGo is unavailable; try in order)

The first engine that answers is the search. Record which engine answered for the manifest's methodology.

1. **Brave**: `https://search.brave.com/search?q=<url-encoded query>` — navigate with `waitUntil: networkidle2`, because Brave renders its result column shortly after load (extracting at `load` can see 0 rows; `browser_wait` without a selector is the alternative). Extract with `browser_extract_list` (`limit: 12`): selector `div:has(> a[href^="https"]:not([href*="brave.com"]))`, fields `title` → selector `a[href^="https"]`, `url` → selector `a[href^="https"]` attribute `href`, `text` → (no field selector: reads the whole row). Each `url` is the article's **direct URL — no token, no click**: Brave items are handled exactly like DuckDuckGo items from here. The row's `text` carries the source domain, a relative date (e.g. "1 month ago") and a short snippet — derive `snippet` from it and set a relative `date` when one is printed, but resolve any item you cite through the Step 3 landed-page date probe. Still 0 rows after one `browser_snapshot` + selector adaptation means unavailable. Brave runs its **own independent index** (not a Google/Bing mirror), so its results are genuinely different coverage — say so downstream.
2. **Bing**: `https://www.bing.com/search?q=<url-encoded query>&setlang=en` — rows present but every field empty means a results-less shell was served: unavailable. Extract with selector `li.b_algo`, fields `title` → selector `h2`, `snippet` → selector `p`. Bing links are `/ck/a` tokens: no clean URL comes from the results page, so each item resolves only by the click step (Step 3.2).

If all three engines are unavailable, report that every engine blocked the headless browser, run `web_search` as the degraded alternative, and say so.

## Step 2 — Choose the resolution set

Pick the items the downstream workflow needs (top N, per-segment picks; the task decides). DuckDuckGo and Brave items already hold their clean URL; only Bing items carry a token into Step 3.

## Step 3 — Resolve and capture, one item at a time (ascending index)

1. **DuckDuckGo and Brave items**: `browser_navigate` to the recorded clean URL (DuckDuckGo's decoded `uddg`, or the Brave row's direct `href`) — the returned status is the landed page.
2. **Bing items**: `browser_act` with `action: click`, `index` = the item's 0-based position **within the current page's rows** (re-extract first to confirm alignment), target `#b_results h2 a`. The returned status is the landed page: its `url` is the clean real URL. If the status `url` is still on the Bing domain (slow redirect), `browser_wait` (no selector) once and re-read; still a token → `unresolved`, note `"redirect not completed"`.
3. For every landed page: verify the page `title` plausibly matches the result title; a mismatch means the wrong target landed — discard and say so.
4. **Capture full text** with `browser_extract` (no selector, `maxChars: 20000`): the rendered page's text. If the body is dominated by cookie/subscribe/paywall boilerplate or the status said 401/403, the item is paywalled/blocked — mark `unresolved` with a note and move on.
5. **Probe the article's own date** with `browser_extract_list`: selector `head, article, main, body`, fields `published` → selector `meta[property="article:published_time"]` attribute `content`, `date` → selector `meta[name="date"]` attribute `content`, `when` → selector `time[datetime]` attribute `datetime` (field selectors are resolved inside their row, so the `head` row supplies the `meta` values and the `article`/`main`/`body` rows supply visible `time` elements). First non-empty value wins → `published`; none → `published: null`.
6. **Return to results**: `browser_navigate` back to the recorded search URL (the DuckDuckGo page-1/2 URL, the Bing search URL, or the Brave search URL), re-extract, and verify the list still matches (row count + first title **of the post-decode, post-ad-filter list** — ad slots shuffle between loads) before the next item. None of the three engines needs session tokens; Brave appends its own `conversation=` parameter to the address bar after load, so always re-navigate to the ORIGINAL search URL you recorded, not the current address.

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
| DuckDuckGo 403 or navigation error | Engine unavailable — Brave, then Bing; never retry DuckDuckGo |
| Decoded `uddg` points at `duckduckgo.com/y.js` | Sponsored redirect — discard the row, do not resolve it |
| Bing rows with empty fields | Results-less shell — engine unavailable (it is the last fallback tier: all engines exhausted) |
| Bing status `url` still engine-token after click | `browser_wait` once; still a token → `unresolved`, note `"redirect not completed"` |
| Brave shows 0 rows right after navigation | Results render after load — `browser_wait` (no selector) or navigate with `networkidle2`, re-extract; still 0 after one selector adaptation → engine unavailable |
| Brave CAPTCHA/bot-challenge page (rare) | Engine unavailable — never retry a blocked engine |
| Consent/interstitial instead of the article | `unresolved`, note `"interstitial"`; do not solve it |
| Landed URL redirected to an unrelated domain with an unrelated title (full-page ad take-over) | `unresolved`, note `"ad hijack"`; no fact from that page may be used, even if the original result looked right |
| Landed status is non-200 (e.g. 204) yet body extraction returns the article text | Trust the body; record the landed status in the manifest note |
| Row list changed after return | Re-navigate to the search URL, re-extract, re-align indices, continue |
| 0 rows on a results page (first engine) | One `browser_snapshot`, adapt selectors once, else degrade engine |
| `browser_act` denied by approval gate (Bing only) | Stop click-resolving; emit what is captured; remaining Bing items `unresolved`, note `"approval denied"`; DuckDuckGo/Brave items unaffected |
| All three engines unavailable | Stop; `web_search` as degraded alternative; say so |
| Extraction reports `truncated` | Raise `limit`/`maxFieldChars` once if more is genuinely needed |
