---
name: headless-research-report
description: "Use when the user wants a professional research report on a topic built from browser-based web research (e.g. \"make a report on this week's crypto news\") without using their own Chrome or the mcp-chrome bridge. Runs the full pipeline on the built-in managed headless browser (browser_* tools): scope → topic analysis (coverage map) → segmented search → deep article fetch → synthesis → report. Writes a dated markdown report to the workspace root."
---

# Headless Research Report

Build a professional research report on a topic using the built-in managed headless browser (the `browser_*` tools). Unlike `headless-web-search` — which stops at a manifest of resolved sources — this skill **reads the actual articles and writes a synthesized report**. A report made only from search snippets is a failed report. No MCP bridge and no user browser are involved: the engines see an anonymous plain-Chrome browser, so results are not personalized.

## Preconditions

- The `browser_*` tools must be available (same list as `headless-web-search`). If they are not, do not start the pipeline: the deep article fetch that makes this a real report requires the browser, and a snippet-only report is a failed report by this skill's own standard. Report that the research report cannot be produced.
- The search stage delegates to the `headless-web-search` skill (DuckDuckGo two pages per query with Bing/Baidu fallbacks, wall detection). Load it before searching. Its manifest already carries each item's clean `url`, captured `fullText`, and `published` date — feed Stage 2 selection and Stage 3 fetch from the manifest instead of re-resolving or re-navigating what was already captured. Use `headless-multi-engine-search` instead when the user asks for cross-engine coverage or the topic is contested.
- If a `browser_act` call is denied by the approval gate, the pipeline can still run: click-resolution is only needed for Bing rows — DuckDuckGo and Baidu items resolve by navigation, and manifest items are already in hand. Note the limitation in the methodology. Never retry a denied call.

## Pipeline

### Stage 0 — Scope

Restate the assignment: question, time window, audience. Resolve relative windows to concrete dates using the current date from the session context (e.g. "this week" → Mon 2026-09-01 … Sat 2026-09-05). If the window or audience is genuinely ambiguous, ask once before searching.

### Stage 1 — Topic analysis (coverage map)

Before any searching, decompose the topic into a coverage map:

1. **Segments / sub-domains** — the parts the topic is made of. A report that covers only the dominant segment (e.g. all BTC, no ETH/DeFi for a crypto topic) is a failed report.
2. **Key entities / actors** — the organizations, people, and institutions that drive the topic.
3. **Recurring sub-themes** — e.g. price, policy, adoption, technology, risk.

Produce a **coverage checklist**: every major segment must appear in the final report, or be explicitly noted as "no significant news this period."

**Show the coverage map to the user** as one short block before the fetch phase — it is the cheap course-correction point. Proceed if they do not object.

Worked example — "crypto": segments = BTC, ETH, DeFi, stablecoins, altcoins, regulation, ETFs/fund flows, corporate treasuries, security incidents. Entities = SEC, major protocols, Strategy, large exchanges. Sub-themes = price, policy, adoption, technology, risk.

### Stage 2 — Search & select

- Run **one query per major segment** (plus one query for the topic itself), each with two pages via `headless-web-search`. When an engine blocks mid-run, its degradation rules apply per query — record which engine answered each segment's search for the methodology.
- From the merged pool, select **6–10 articles** to read in full, applying a **per-segment quota**: any segment with real news gets at least one article in the fetch budget.
- Selection criteria, in order: date inside the window → source authority → primary over secondary → complementary angles → dedupe by story.

### Stage 3 — Deep fetch

Per selected article, all on the one managed page:

1. Reach the article: use the search manifest's `fullText` when present; otherwise `browser_navigate` to the resolved URL (DuckDuckGo decoded `uddg` or Baidu `link?url=` token), or — for Bing rows only — `browser_act` click at the result's row `index` (per `headless-web-search` Step 3) then note the landed `url`.
2. Extract the full text with `browser_extract` (no selector, `maxChars: 20000`): the rendered page's text.
3. Pull out: key facts, figures, attributed quotes, dates.
4. **Repair span gaps**: numbers and prices often live in styled spans that generic text extraction garbles (symptom: "traded nearon Sept. 4"). Re-read the suspect region with a targeted `browser_extract` `selector` (e.g. `article`, `article p`, the figure's container) before using it.
5. Paywall or bot wall (body is cookie/subscribe boilerplate, or the landed status said 401/403) → skip, note it in the report, move on.
6. If a page's layout decides what counts (charts, tables), take one `browser_screenshot` before trusting the text.

### Stage 4 — Synthesize

- Cross-check figures across ≥2 sources; **flag conflicts explicitly** — never silently pick one.
- Identify the 3–5 story spine.
- **Verify the coverage checklist**: a gap triggers one targeted follow-up search round for that segment; if it is still empty, the report says so explicitly.
- Every claim in the report must trace to a fetched article body — no orphan snippets.

### Stage 5 — Write

Adaptive structure — organize the body however fits the topic (by story, theme, or timeline) — but this minimal skeleton is always required:

1. Title + date + one-line scope.
2. **Executive summary** — 3–5 bullets, the "so what" first.
3. **Body** — organized by the coverage map; segments with substance become sections.
4. **Numbered sources** — linked, with access date.
5. **Methodology footnote** — queries used (per segment), pages fetched, which engine answered each search, which engines blocked the headless browser, and the caveat: an anonymous headless browser was used, so results are not personalized.

Output: `<topic-slug>-<YYYY-MM-DD>.md` in the workspace root. Then `browser_close` to release the managed page.

## Quality rules (anti-pattern list)

- **No snippet-only claims** — every cited fact came from a fetched article body.
- **No stale items** — nothing older than the time window without an explicit "background" label.
- **Conflicts flagged, never silently resolved.**
- **Broken extraction detected and repaired** before publishing (dropped spans).
- **Quotes attributed** — name + outlet.

## Effort budget

6–10 articles ≈ 15–25 browser tool calls. **Stop fetching once the story spine is saturated** — do not burn the budget on marginal articles. One follow-up search round for coverage gaps is allowed; more means the coverage map was wrong, so say so in the methodology.

## Failure modes

| Symptom | Action |
|---|---|
| No `browser_*` tools in catalog | Do not start; report the report cannot be produced |
| DuckDuckGo 403 (`headless-web-search` Step 1) | Engine blocked — Bing/Baidu per its fallback chain; record it for the methodology; never retry a blocked engine |
| Bing rows with empty fields / Baidu verification page | That engine unavailable; use whichever engine answers; if none, stop and report |
| Segment search returns only stale/irrelevant items | Mark the segment "no significant news this period"; do not pad with old items |
| Paywall on a key article | Skip; try one secondary source for the same story; note the gap |
| Figure conflict across sources | Report both with attribution; state which is more authoritative and why |
| `browser_act` denied by approval gate | Continue with directly navigable URLs; note the limitation |
