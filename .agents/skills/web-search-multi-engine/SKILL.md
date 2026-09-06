---
name: web-search-multi-engine
description: Use when a search task needs broader or less biased coverage than a single engine — e.g. "search with multiple engines", "cross-check these results", or when one engine is blocked or its ranking is suspect. Runs the same query through Google, Bing, and DuckDuckGo in the user's real Chrome (mcp__chrome__*), merges the three lists with cross-engine dedup and corroboration (each item records which engines returned it), resolves a chosen set into clean real URLs with captured full text, and emits a web-search-chrome-url-compatible JSON manifest plus an engines field per item.
---

# Multi-Engine Web Search → Corroborated URL Manifest

Run the **same query through 3 search engines** (Google, Bing, DuckDuckGo) in the user's real Chrome (via `mcp__chrome__*`), merge the three result lists with **cross-engine dedup and corroboration**, resolve a **chosen set** into **clean, real URLs** with captured full text, and emit a **structured JSON manifest** in the `web-search-chrome-url` shape plus an `engines` field per item.

## Why this skill exists

Single-engine results are biased by that engine's index, ranking model, and personalization. Cross-engine agreement is a cheap relevance/authority signal: a result returned by 2–3 independent engines is more likely genuinely on-topic than one that appears only in a single engine.

`web-search-chrome` and `web-search-chrome-url` both search **Google only** (Bing is a one-shot fallback there). This skill makes the three engines first-class: it runs all three, merges with dedup, and keeps the handoff contract of `web-search-chrome-url` so a downstream fetch workflow consumes the manifest unchanged.

DuckDuckGo's HTML endpoint is the deliberate third engine: no JS rendering, no anti-bot wall in practice, and — unlike Google's `/goto` and Bing's `/ck/a` tokens — its links carry the real URL in a short, stable `uddg` parameter that survives the tool-output sanitizer. That makes cross-engine **URL** dedup possible without click-resolving every result.

## Preconditions

- The `mcp__chrome__*` tools must be available (same as `web-search-chrome`). On a connection error, stop and tell the user to check Chrome + the mcp-chrome extension — do not retry in a loop.
- This drives the user's **real, logged-in browser**: Google results are personalized by the user's account; Bing by its account/region; DuckDuckGo by region only. State that in any downstream report's methodology.
- Reuse `web-search-chrome`'s Google extraction JS. Load that skill for the exact code; the Google extraction here is identical (standard `#rso` layout; if the query is news-shaped and the news layout appears, use its news branch).

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions.
- **One tab, reused**: a single search tab navigates Google → Bing → DuckDuckGo in sequence; remember its `tabId` and close it once at the end.
- **Never emit or pass a raw `href` token** — Google `/goto` and Bing `/ck/a` tokens go into no output; only resolved `location.href` values (or DDG's decoded `uddg` real URL) do.
- **Stop at anti-bot walls, per engine**: an engine blocked by CAPTCHA / "unusual traffic" is **degraded, not fatal** — record it as unavailable, continue with the other two. Only stop entirely if all three are blocked.
- **One page per engine** (cap 8 items each, ~24 raw items before merge) to bound the call budget; the Google-only skills use two pages because they are single-engine.
- **Resolve in a fixed order** (ascending index) and **verify the results list is intact after every `history.back()`** (see Step 3) — back-navigation does not always restore the DOM perfectly.

## Step 1 — Search all 3 engines (1 page each)

In the single search tab, in this order (note the `tabId` from the first navigation):

**Snippet sanitization (all engines):** the tool-output sanitizer blocks output containing cookie/query-string-like patterns — e.g. snippet text such as `(mild = 2m; extreme = 4m)` is redacted as `[BLOCKED: Cookie/query string data]` because `x = y; x = y` matches the cookie shape. Sanitize every snippet before returning it: **replace `;` with `,`**. Also **drop the `href` field for Google/Bing** — their redirect tokens are blocked outright, and Step 3 clicks by `pos`, so the token is never needed. This makes the block rare rather than guaranteed on data-heavy queries.

1. **Google:** `https://www.google.com/search?q=<url-encoded query>` — extract with `web-search-chrome`'s Step 2 JS, with the snippet sanitized as above and **without the `href` field**.
2. **Bing:** `https://www.bing.com/search?q=<url-encoded query>` — extract with:
   ```js
   function clean(s) { return (s || '').replace(/\s+/g, ' ').trim().replace(/;/g, ','); }
   const out = [];
   for (const h2 of document.querySelectorAll('#b_results h2')) {
     const a = h2.querySelector('a');
     const row = a ? a.closest('li.b_algo') || a.closest('li') : null;
     const snip = row ? row.querySelector('p') : null;
     out.push({ title: clean(h2.textContent), snippet: clean(snip && snip.textContent).slice(0, 200) });
     if (out.length >= 8) break;
   }
   return JSON.stringify({ layout: 'bing', count: out.length, items: out });
   ```
3. **DuckDuckGo (HTML):** `https://html.duckduckgo.com/html/?q=<url-encoded query>` — extract with:
   ```js
   function clean(s) { return (s || '').replace(/\s+/g, ' ').trim().replace(/;/g, ','); }
   function realUrl(h) {
     if (!h) return '';
     const m = h.match(/[?&]uddg=([^&]+)/);
     return m ? decodeURIComponent(m[1]) : (h.startsWith('//') ? 'https:' + h : h);
   }
   const out = [];
   for (const el of document.querySelectorAll('#links .result')) {
     const a = el.querySelector('.result__a');
     const snip = el.querySelector('.result__snippet');
     out.push({ title: clean(a && a.textContent), url: realUrl(a && a.getAttribute('href')), snippet: clean(snip && snip.textContent).slice(0, 200) });
     if (out.length >= 8) break;
   }
   return JSON.stringify({ layout: 'ddg-html', count: out.length, items: out });
   ```
   DDG items carry a **clean real URL** in `url` (decoded from `uddg`) — no click resolution needed for these.

Per-engine result: `{ engine, count, items: [{ title, source?, date?, snippet(≤200), url?, pos }] }` where `pos` is the 0-based position within that engine's extraction (the number you click in Step 3) and `url` is present only for DDG items (clean real URL; Google/Bing items get their URL in Step 3). Google items get `source`/`date` per `web-search-chrome`; Bing and DDG items get `source`/`date` empty unless the extraction surfaces them.

If an engine's page is a CAPTCHA / "unusual traffic" / consent wall, or extraction returns 0 items twice (re-discover via `chrome_read_page` once first), record that engine as **unavailable** and continue. If all three are unavailable, stop and report.

## Step 2 — Merge and dedupe across engines

The same article typically appears on 2–3 engines with **different URLs and different title renderings** (Google truncates with "…", Bing capitalizes differently, DDG appends " | Site", and the same URL arrives with `www.`, trailing slashes, and tracking params). Exact matching would keep near-identical rows, so dedup is two-stage:

**Stage 1 — normalized-URL match** (when a real URL is known: all DDG items, and Google/Bing items once resolved in Step 3): lowercase host, strip `www.`, strip trailing slash and fragment, drop tracking params (`utm_*`, `gclid`, `fbclid`, `ref`, `source`). Equal normalized URLs ⇒ duplicate.

**Stage 2 — normalized-title match** (catches different-domain syndication and covers the pre-resolution phase): lowercase, collapse whitespace, strip punctuation, strip a trailing site suffix (` | X`, ` - X`, ` – X`), strip a trailing ellipsis. Duplicates if normalized titles are **equal**, or **one is a prefix of the other with length ≥ 20 chars** (handles Google's truncated titles vs. full titles elsewhere).

**Merge policy for duplicates** (union, not discard):

- `engines` = union of every engine that returned it — the corroboration signal.
- `url` = best provenance: clean DDG real URL > click-resolved URL > `null` until Step 3 resolves it.
- `snippet` = the longest of the duplicates; `source`/`date` = first non-empty in engine priority Google > Bing > DuckDuckGo.
- Record the surviving item's `pos` **per engine occurrence** (e.g. `{ google: 2, bing: 0, ddg: 5 }`), so Step 3 can click it on any engine's page.

**Known limitation (state it in the output):** the same article on genuinely different domains with rewritten titles survives both stages — rare, and the `engines` field plus the markdown table let the caller spot it.

**Rank the merged list (fixed, documented):**

1. engine count descending (3 > 2 > 1) — cross-engine corroboration;
2. within a count tier: first-seen engine in priority Google > Bing > DuckDuckGo;
3. within an engine: original result order.

Assign a **stable 0-based `index`** to each surviving item. Present the indexed list (title, source, date, snippet, **engines**) to the user (or the calling workflow) so the Step 3 selection is explicit.

## Step 3 — Resolve the chosen set (click → read → back)

Resolve only what the downstream fetch actually needs. Accept the selection as an explicit **index list** (e.g. `[0, 2, 5]`), **"top N"**, or **"all"**. Default suggestion when the caller defers: 6–10, ranked by the Step 2 order. Confirm the selection before resolving if it is large (>8) to bound the call budget.

For each selected index, **in ascending order**:

1. **Ensure the right engine's results page is showing.** Prefer an engine occurrence whose real URL is already known (a DDG item) — skip straight to Step 2's direct path. Otherwise, if the tab is not on that item's engine results page, `chrome_navigate` the same tab to that engine's search URL first.
2. **Click the result at the item's recorded `pos`** for that engine:
   ```js
   // Google standard — N = pos
   const a = [...document.querySelectorAll('#rso > div')].filter(el => el.querySelector('a h3'))[N].querySelector('a h3').closest('a');
   a.click(); return 'clicked ' + N;
   // Bing — N = pos
   // document.querySelectorAll('#b_results h2 a')[N].click();
   ```
   **Direct path (DDG items, or any item with a known real URL):** `chrome_navigate` the same tab to the known real URL instead of clicking.
3. **Read the resolved URL** (wait for the load; a short `chrome_computer` `wait` or a second `chrome_javascript` call if `location.href` is still a token):
   ```js
   return JSON.stringify({ url: location.href, title: document.title.slice(0, 120) });
   ```
   - If `url` still starts with `/goto` or is a `/ck/a` token, the redirect hasn't completed — wait and re-read once. If it is a consent/interstitial page, note it and mark the item `url: null, note: "interstitial"`.
3.5. **Capture the full text while you are on the page** (you are already here — do not defer this to the downstream fetch). Two paths, in order:
   1. **Primary:** `chrome_get_web_content` on this tab with `textContent: true`. Store `article.metadata.published` (if present) as the item's `published` — the article's own date, preferred over the search-result `date` for time-window checks.
   2. **Detect a JS-heavy page.** If the returned `textContent` is a **JSON page-state blob** rather than readable prose — it starts with `{` or `"`, or contains keys like `"component"`, `"PageInfo"`, `"Hero"`, `"jcrCreated"` — the page renders its body client-side and `chrome_get_web_content` captured the data layer, not the text. This is common on official tourism/marketing sites.
   3. **Fallback:** for a JS-heavy page, capture the rendered body with `chrome_javascript`:
      ```js
      const t = document.body.innerText.replace(/\s+\n/g, '\n').trim();
      return JSON.stringify({ len: t.length, text: t.slice(0, 20000) });
      ```
      Use `text` as `fullText` (cap at ~20 000 chars; note the cap if truncated).
   - Store whichever path yields the readable body as the item's `fullText`, and record which path was used (`captureMethod: "web_content"` or `"innerText"`) so the caller knows the provenance.
   - If the page is a **video** (YouTube) or a true shell with little body text, `fullText` will be short or empty — that is expected; store what is there, set `type` accordingly (see Step 4), and do not treat an empty `fullText` as a failure.
4. **Return to the results** (click path only — the direct path re-navigates anyway):
   ```js
   history.back(); return 'back';
   ```
   Do **not** use `chrome_navigate` with url `back` (it errors); `history.back()` from page JS is the working path.
5. **Verify the list is intact** before the next iteration (click path only):
   ```js
   const rows = [...document.querySelectorAll('#rso > div')].filter(el => el.querySelector('a h3'));
   return JSON.stringify({ count: rows.length, first: rows[0] ? rows[0].querySelector('a h3').textContent.slice(0, 40) : '' });
   ```
   (Use the engine-appropriate row selector for Bing/DDG.) If the count or the first title no longer matches the recorded list, **re-`chrome_navigate` to the current engine's search URL** to restore, then continue. This guards against back-navigation not restoring the DOM.

Collect per item: `{ title, source, date, snippet, url, fullText, captureMethod, published, type, engines }` (use the resolved page `title` from Step 3.3 as a fallback/correction if the result title was truncated). `type` is `article` / `video` / `qa` / `social` / `hub` (helps the caller decide how to use `fullText`).

## Step 4 — Emit the manifest

Output the resolved set as a **JSON object** — this is the handoff artifact a separate-session fetch workflow parses:

```json
{
  "query": "…",
  "engines": ["google", "bing", "duckduckgo"],
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
      "engines": ["google", "bing", "duckduckgo"],
      "captureMethod": "web_content",
      "fullText": "…(captured article body; may be long)…"
    }
  ],
  "unresolved": []
}
```

- `engines` lists every engine that returned the item (corroboration signal); `unavailableEngines` lists engines blocked in Step 1 (empty when all three ran).
- `fullText` is the captured article body (Step 3.5). It can be long; that is the point — the downstream fetch workflow reads it instead of re-navigating. For very long articles you may cap it (e.g. first ~20 000 chars) and note the cap, but do not drop the field.
- `published` (the article's own date from metadata) is preferred over the search-result `date` for time-window checks; keep both.
- Include **only** resolved items with a real `url` in `items`; list any that failed (paywall/interstitial/redirect-not-completed) in `unresolved` with a `note`, so the caller can decide whether to retry via a same-session click.
- Also render a short markdown table (title → linked url, source, date, **engines**) for human readability. The **JSON is the contract**; the table is convenience.
- Do not include `href` tokens anywhere in the output.

## Step 5 — Clean up

`chrome_close_tabs` with the search `tabId`. The manifest is now self-sufficient: a downstream session reads each item's `fullText` directly (and only re-navigates to `url` when `fullText` is empty/short) — no search tabs, no tokens.

## Handoff contract (for the consuming workflow)

Identical to `web-search-chrome-url`: a separate-session workflow consumes the manifest per item, either **read-only** (use `fullText` directly — the common case) or **re-fetch** (`chrome_navigate` to `url` → `chrome_get_web_content` → extract → close tab, when `fullText` is empty/short). No search, no redirect resolution, no token handling is required downstream. `browser-research-report`'s Stage 3 (deep fetch) is the reference consumer: it can take this manifest in place of its own Stage 2 search, and the `engines` field additionally lets it weight sources by cross-engine corroboration.

## Failure modes

| Symptom | Action |
|---|---|
| Chrome tool connection error | Tell the user to check Chrome + mcp-chrome extension; stop |
| One engine blocked (CAPTCHA / "unusual traffic" / consent wall) | Record it in `unavailableEngines`; continue with the other two |
| All 3 engines blocked | Stop; report |
| DDG page is a JS/consent page instead of `#links` | Re-discover via `chrome_read_page` once; if still blocked, treat DDG as unavailable |
| `location.href` still a `/goto` or `/ck/a` token after click | Redirect not complete — wait and re-read once; if still a token, mark `unresolved` |
| Consent/interstitial page instead of the article | Mark `unresolved, note: "interstitial"`; do not attempt to solve it |
| Results list changed after `history.back()` | Re-`chrome_navigate` to that engine's search URL to restore, then continue |
| 0 extracted items on an engine | Layout drift — re-discover via `chrome_read_page` and adapt selectors (per `web-search-chrome`); if still 0, treat that engine as unavailable |
| Tool output `[BLOCKED: …]` | Output contained token data or a cookie/query-string-like pattern (e.g. `x = y; x = y` inside a snippet) — re-query returning only clean fields: drop `href` tokens, sanitize snippets (`;` → `,`), or split the payload into smaller pieces |
