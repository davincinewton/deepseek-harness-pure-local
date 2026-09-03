---
name: web-search-chrome
description: Use when the web_search tool fails (e.g. anti-bot detection errors) or when the user asks to search the web through the browser. Drives the mcp__chrome__* tools to run a Google search in the user's real Chrome and returns structured sources (title, source, date, snippet, URL).
---

# Web Search via Chrome

Search the web through the user's real Chrome browser (via the `mcp__chrome__*` MCP tools) and return structured results in the same shape `web_search` produces. Use this when `web_search` fails or when the user explicitly wants a browser-based search.

## Preconditions

- The `mcp__chrome__*` tools must be available (the mcp-chrome bridge is running with Chrome and its extension). If a chrome tool call fails with a connection error, stop and tell the user to check that Chrome and the mcp-chrome extension are running — do not retry in a loop.
- This drives the user's **real, logged-in browser**: results may be personalized by their Google account, and the browser's location/account state is visible to the search engine. That is expected; never claim neutral or anonymous results.

## Rules

- **Read-only**: navigate and read only. No logins, no purchases, no form submissions to third parties, no account changes.
- **Close what you open**: remember the search tab's `tabId` and close it with `chrome_close_tabs` when done.
- **Resolve URLs on demand**: search result links are opaque redirect tokens. Resolve a URL only for results you actually need to cite or follow up on (typically the top 1–3), never for the whole list.
- **Stop at anti-bot walls**: if Google shows a CAPTCHA or "unusual traffic" page, do not retry or attempt to solve it. Report the block and, if useful, fall back to Bing once.
- Cap the result list at 8 items and snippets at ~200 characters.

## Step 1 — Run the search

`chrome_navigate` to the search URL (note the returned `tabId`):

- Web: `https://www.google.com/search?q=<url-encoded query>`
- News: `https://www.google.com/search?q=<url-encoded query>&tbm=nws`

## Step 2 — Extract results

Run this with `chrome_javascript` on the search tab. It handles both Google layouts (standard and news) and returns clean fields only:

```js
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
const out = [];
// Standard layout: result rows under #rso with an h3 title link
let rows = [...document.querySelectorAll('#rso > div')].filter(el => el.querySelector('a h3'));
if (rows.length > 0) {
  for (const el of rows) {
    const a = el.querySelector('a h3').closest('a');
    const snip = el.querySelector('[data-sncf], .VwiC3b');
    const dates = [...el.querySelectorAll('span[role="presentation"]')].map(s => clean(s.textContent)).filter(Boolean);
    out.push({ title: clean(el.querySelector('a h3').textContent), href: a ? a.getAttribute('href') : '', snippet: clean(snip && snip.textContent).slice(0, 200), date: dates[0] || '' });
    if (out.length >= 8) break;
  }
  return JSON.stringify({ layout: 'standard', count: out.length, items: out });
}
// News layout: .WCv1we rows (no h3 elements)
rows = [...document.querySelectorAll('#rso .WCv1we')];
for (const el of rows) {
  const a = el.querySelector('a.aJWbwf');
  const titleEl = el.querySelector('[id^="news_title_tsuid_"], .n0jPhd');
  const snipEl = el.querySelector('.UqSP2b');
  const srcEl = el.querySelector('.MgUUmf');
  out.push({ title: clean(titleEl && titleEl.textContent), href: a ? a.getAttribute('href') : '', snippet: clean(snipEl && snipEl.textContent).slice(0, 200), source: clean(srcEl && srcEl.textContent) });
  if (out.length >= 8) break;
}
return JSON.stringify({ layout: 'news', count: out.length, items: out });
```

If the extraction returns 0 items, the layout changed: use `chrome_read_page` (filter `interactive`) to find the result links and adapt. If the page is a CAPTCHA/consent/error page instead of results, follow the anti-bot rule above.

## Step 3 — Resolve a result's real URL (on demand)

Result `href` values are opaque redirect tokens (`/goto?url=…` on Google, `/ck/a` on Bing). **Never pass these tokens between tool calls** — the tool output sanitizer redacts long token-like strings, corrupting them. Instead let the browser follow the redirect natively, in the search tab:

1. `chrome_javascript` — click the Nth result link (0-based):
   ```js
   // Google standard: #rso a h3 parents · Google news: #rso .WCv1we a.aJWbwf
   const links = document.querySelectorAll('#rso .WCv1we a.aJWbwf');
   links[N].click();
   return 'clicked';
   ```
2. `chrome_javascript` — read the final URL:
   ```js
   return JSON.stringify({ url: location.href.slice(0, 200) });
   ```
3. `chrome_javascript` — return to the results:
   ```js
   history.back();
   return 'back';
   ```

Do not use `chrome_navigate` with url `back` — it fails with a history error; `history.back()` from page JS is the working path.

## Step 4 — Present and clean up

- Present results as a markdown list: title (linked when resolved), source, date, snippet. Cite resolved URLs as markdown links; for unresolved items give title + source + snippet and note the URL is available on request.
- Close the search tab: `chrome_close_tabs` with its `tabId`.

## Fallback engine — Bing

If Google is blocked, search `https://www.bing.com/search?q=<query>` in a new tab. Results are `#b_results h2 a` with the snippet in the following `p`; links are also redirect tokens, so use the same click-based resolution (selector `#b_results h2 a`).

## Failure modes

| Symptom | Action |
|---|---|
| Chrome tool connection error | Tell the user to check Chrome + mcp-chrome extension; stop |
| CAPTCHA / "unusual traffic" | Stop; report; optionally one Bing fallback |
| 0 extracted items | Layout drift — re-discover via `chrome_read_page` and adapt selectors |
| Tool output `[BLOCKED: …]` | The output contained query-string/token data; re-query returning only clean fields (final URLs, text, booleans) |
| `history.back()` lands on a dead page | Re-run the search URL in the same tab |
