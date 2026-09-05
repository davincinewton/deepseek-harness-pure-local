---
name: web-search-chrome-url
description: Use when search results must be handed off to a downstream deep-fetch workflow that runs in a SEPARATE session (or after the search tab is closed) — e.g. a fetch pipeline that navigates directly to article URLs. Unlike web-search-chrome (which presents a markdown source list and resolves only the top 1–3 on demand), this resolves a chosen set of results into clean real URLs AND captures each page's full text (since it is already on the page), emitting a structured JSON manifest of {title, source, date, snippet, url, fullText, published, type}.
---

# Web Search → Resolved URL Manifest (cross-session handoff)

Search the web through the user's real Chrome (via `mcp__chrome__*`), then resolve a **chosen set** of results into **clean, real URLs** and emit a **structured JSON manifest** that a downstream fetch workflow can consume **without the search tab and without opaque redirect tokens**.

## Why this skill exists

Google result `href`s are **opaque `/goto?url=<token>` redirect tokens** — the real URL is *not* embedded in them (the `q` param is empty), and the tool-output sanitizer redacts long token-like strings, so a raw `href` can never be carried between tool calls or sessions. The only way to obtain a real URL is to let the browser follow the redirect (click → read `location.href`).

`web-search-chrome` resolves only the top 1–3 on demand and then **closes the tab**, so it cannot feed a separate-session fetch pipeline for arbitrary results. This skill makes that handoff real: it resolves a chosen set and emits a stable, parseable manifest.

## Preconditions

- The `mcp__chrome__*` tools must be available (same as `web-search-chrome`). On a connection error, stop and tell the user to check Chrome + the mcp-chrome extension — do not retry in a loop.
- This drives the user's **real, logged-in browser**: results may be personalized. State that in any downstream report's methodology.
- Reuse `web-search-chrome`'s search + extraction (two pages, `start=0` + `start=10`). Load it for the exact extraction JS if needed; the extraction here is identical.

## Rules

- **Read-only**: navigate and read only. No logins, purchases, or form submissions.
- **Close what you open**: remember the search tab's `tabId`; close it at the end.
- **Never emit or pass a raw `href` token** — only the resolved `location.href` (a clean URL) goes into the manifest.
- **Stop at anti-bot walls**: on a CAPTCHA / "unusual traffic" page, stop and report; optionally one Bing fallback (see `web-search-chrome`).
- **Resolve in a fixed order** (ascending index) and **verify the results list is intact after every `history.back()`** (see Step 3) — back-navigation does not always restore the DOM perfectly.

## Step 1 — Search (two pages) and index the merged list

`chrome_navigate` to page 1 (note the `tabId`), extract (Step 2 of `web-search-chrome`), then navigate the **same tab** to page 2 (`&start=10`) and extract again. Merge and **dedupe by title** (keep the page-1 occurrence of a title that appears on both pages), preserving each page's own order. Assign a **stable 0-based `index`** to each surviving item and record, per item:

- `index` — position in the merged list (for selection in Step 2).
- `page` — 1 or 2 (which search page it came from; needed to navigate before clicking).
- `pos` — **0-based position within its own page's extraction** (this is the number you click in Step 3; record it directly from the extraction order, do not recompute it — cross-page dedup makes global-index arithmetic unreliable).
- `title`, `source` (news) / `date` (web), `snippet` (~200 chars).

Present the indexed list to the user (or the calling workflow) so the selection in Step 2 is explicit.

## Step 2 — Select which results to resolve

Resolve only what the downstream fetch actually needs — not all 16. Accept the selection as:

- an explicit **index list** (e.g. `[0, 2, 5]`), or
- **"top N"** (first N by the caller's ranking), or
- **"all"**.

Default suggestion when the caller defers: the N the fetch pipeline will read (commonly 6–10), ranked date-in-window → source authority → primary over secondary. Confirm the selection before resolving if it is large (>8) to bound the call budget.

## Step 3 — Resolve each selected URL (click → read → back)

For each selected index, **in ascending order**:

1. **Ensure the correct page is showing.** If the item's `page` differs from the page currently loaded in the search tab, `chrome_navigate` the same tab to that page's URL first.
2. **Click the result at the item's recorded `pos`** (its 0-based position within the currently-loaded page):
   ```js
   // standard web layout — N = item.pos
   const a = [...document.querySelectorAll('#rso > div')].filter(el => el.querySelector('a h3'))[N].querySelector('a h3').closest('a');
   a.click(); return 'clicked ' + N;
   // news layout
   // document.querySelectorAll('#rso .WCv1we a.aJWbwf')[N].click();
   ```
3. **Read the resolved URL** (wait for the load; a short `chrome_computer` `wait` or a second `chrome_javascript` call if `location.href` is still the `/goto` token):
   ```js
   return JSON.stringify({ url: location.href, title: document.title.slice(0, 120) });
   ```
   - If `url` still starts with `/goto` or `news.google.com/rsshub`, the redirect hasn't completed — wait and re-read once. If it is a consent/interstitial page, note it and mark the item `url: null, note: "interstitial"`.
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
4. **Return to the results**:
   ```js
   history.back(); return 'back';
   ```
   Do **not** use `chrome_navigate` with url `back` (it errors); `history.back()` from page JS is the working path.
5. **Verify the list is intact** before the next iteration:
   ```js
   const rows = [...document.querySelectorAll('#rso > div')].filter(el => el.querySelector('a h3'));
   return JSON.stringify({ count: rows.length, first: rows[0] ? rows[0].querySelector('a h3').textContent.slice(0, 40) : '' });
   ```
   If the count or the first title no longer matches the recorded list, **re-`chrome_navigate` to the current page's search URL** to restore, then continue. This guards against back-navigation not restoring the DOM.

Collect per item: `{ title, source, date, snippet, url, fullText, captureMethod, published, type }` (use the resolved `title` from Step 3.3 as a fallback/correction if the result-title was truncated). `fullText` is the captured article body (Step 3.5); `captureMethod` is `"web_content"` or `"innerText"` (which path produced `fullText`); `published` is the article's own date from its metadata; `type` is `article` / `video` / `qa` / `social` / `hub` (helps the caller decide how to use `fullText`).

## Step 4 — Emit the manifest

Output the resolved set as a **JSON array** — this is the handoff artifact a separate-session fetch workflow parses and navigates to, one URL at a time:

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
    "captureMethod": "web_content",
    "fullText": "…(captured article body; may be long)… "
  }
]
```

- `fullText` is the captured article body (Step 3.5). It can be long; that is the point — the downstream fetch workflow reads it instead of re-navigating. For very long articles you may cap it (e.g. first ~20 000 chars) and note the cap, but do not drop the field.
- `published` (the article's own date from metadata) is preferred over the search-result `date` for time-window checks; keep both.

- Include **only** resolved items with a real `url` in the primary array; list any that failed (paywall/interstitial/redirect-not-completed) in a separate `unresolved` array with a `note`, so the caller can decide whether to retry via a same-session click.
- Also render a short markdown table (title → linked url, source, date) for human readability. The **JSON is the contract**; the table is convenience.
- Do not include `href` tokens anywhere in the output.

## Step 5 — Clean up

`chrome_close_tabs` with the search `tabId`. The manifest is now self-sufficient: a downstream session reads each item's `fullText` directly (and only re-navigates to `url` when `fullText` is empty/short) — no search tab, no tokens.

## Handoff contract (for the consuming workflow)

A separate-session workflow consumes the manifest two ways, per item:

- **Read-only (default):** use the item's `fullText` directly — no navigation needed. This is the common case and why the skill captures the text up front.
- **Re-fetch (when `fullText` is empty/short — e.g. a video, a JS shell, or a capped article):** `chrome_navigate` to `url` → `chrome_get_web_content` (`textContent`) → extract → close tab.

Either way, no Google search, no redirect resolution, and no token handling is required downstream. `browser-research-report`'s Stage 3 (deep fetch) is the reference consumer: it can take this manifest in place of its own Stage 2 search (and, when `fullText` is present, skip most of Stage 3's fetching too) when the search already ran in an earlier session.

## Failure modes

| Symptom | Action |
|---|---|
| Chrome tool connection error | Tell the user to check Chrome + mcp-chrome extension; stop |
| CAPTCHA / "unusual traffic" | Stop; report; optionally one Bing fallback per `web-search-chrome` |
| `location.href` still a `/goto` token after click | Redirect not complete — wait and re-read once; if still a token, mark `unresolved` |
| Consent/interstitial page instead of the article | Mark `unresolved, note: "interstitial"`; do not attempt to solve it |
| Results list changed after `history.back()` | Re-`chrome_navigate` to the page's search URL to restore, then continue |
| 0 extracted items on a page | Layout drift — re-discover via `chrome_read_page` and adapt selectors (per `web-search-chrome`) |
| Tool output `[BLOCKED: …]` | Output contained token data — re-query returning only clean fields (final URLs, text, booleans) |
