---
name: browser-research-report
description: Use when the user wants a professional research report on a topic built from browser-based web research (e.g. "make a report on this week's crypto news"). Runs the full pipeline: scope → topic analysis (coverage map) → segmented search → deep article fetch → synthesis → report. Writes a dated markdown report to the workspace root.
---

# Browser Research Report

Build a professional research report on a topic using the user's real Chrome browser (via the `mcp__chrome__*` tools). Unlike `web-search-chrome` — which returns a list of sources — this skill **reads the actual articles and writes a synthesized report**. A report made only from search snippets is a failed report.

## Preconditions

- The `mcp__chrome__*` tools must be available (same as `web-search-chrome`). If a chrome tool call fails with a connection error, stop and tell the user to check Chrome and the mcp-chrome extension.
- The search stage delegates to the `web-search-chrome` skill (two pages per query, `start=0` + `start=10`). Load it before searching.
- This drives the user's **real, logged-in browser**: results may be personalized. State that caveat in the report's methodology footnote.

## Pipeline

### Stage 0 — Scope

Restate the assignment: question, time window, audience. Resolve relative windows to concrete dates (e.g. "this week" → Mon 2026-09-01 … Sat 2026-09-05, using the browser's clock via `chrome_javascript` `new Date()`). If the window or audience is genuinely ambiguous, ask once before searching.

### Stage 1 — Topic analysis (coverage map)

Before any searching, decompose the topic into a coverage map:

1. **Segments / sub-domains** — the parts the topic is made of. A report that covers only the dominant segment (e.g. all BTC, no ETH/DeFi for a crypto topic) is a failed report.
2. **Key entities / actors** — the organizations, people, and institutions that drive the topic.
3. **Recurring sub-themes** — e.g. price, policy, adoption, technology, risk.

Produce a **coverage checklist**: every major segment must appear in the final report, or be explicitly noted as "no significant news this period."

**Show the coverage map to the user** as one short block before the fetch phase — it is the cheap course-correction point. Proceed if they do not object.

Worked example — "crypto": segments = BTC, ETH, DeFi, stablecoins, altcoins, regulation, ETFs/fund flows, corporate treasuries, security incidents. Entities = SEC, major protocols, Strategy, large exchanges. Sub-themes = price, policy, adoption, technology, risk.

### Stage 2 — Search & select

- Run **one query per major segment** (plus one query for the topic itself), each with two pages via `web-search-chrome` (`start=0` + `start=10`).
- From the merged pool, select **6–10 articles** to read in full, applying a **per-segment quota**: any segment with real news gets at least one article in the fetch budget.
- Selection criteria, in order: date inside the window → source authority → primary over secondary → complementary angles → dedupe by story.

### Stage 3 — Deep fetch

Per selected article:

1. `chrome_navigate` (remember the `tabId`).
2. Extract full text with `chrome_get_web_content` (`textContent`).
3. Pull out: key facts, figures, attributed quotes, dates.
4. **Repair span gaps**: numbers and prices often live in styled spans that text extraction drops (symptom: "traded nearon Sept. 4"). If a sentence looks broken, re-read the element with a targeted `selector` or `chrome_read_page` before using it.
5. Paywall or bot wall → skip, note it in the report, move on.
6. Close every tab you opened (`chrome_close_tabs`) — including at the end of the whole run.

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
5. **Methodology footnote** — queries used (per segment), pages fetched, browser/personalization caveat.

Output: `<topic-slug>-<YYYY-MM-DD>.md` in the workspace root.

## Quality rules (anti-pattern list)

- **No snippet-only claims** — every cited fact came from a fetched article body.
- **No stale items** — nothing older than the time window without an explicit "background" label.
- **Conflicts flagged, never silently resolved.**
- **Broken extraction detected and repaired** before publishing (dropped spans).
- **Quotes attributed** — name + outlet.

## Effort budget

6–10 articles ≈ 20–30 chrome tool calls. **Stop fetching once the story spine is saturated** — do not burn the budget on marginal articles. One follow-up search round for coverage gaps is allowed; more means the coverage map was wrong, so say so in the methodology.

## Failure modes

| Symptom | Action |
|---|---|
| Chrome tool connection error | Tell the user to check Chrome + mcp-chrome extension; stop |
| CAPTCHA / "unusual traffic" | Stop; report; optionally one Bing fallback per `web-search-chrome` |
| Segment search returns only stale/irrelevant items | Mark the segment "no significant news this period"; do not pad with old items |
| Paywall on a key article | Skip; try one secondary source for the same story; note the gap |
| Figure conflict across sources | Report both with attribution; state which is more authoritative and why |
