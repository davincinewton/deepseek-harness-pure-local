# Agent Note: The mcp-chrome browser capability ships built-in with dsh-base

Status: implemented

## Problem

The browser capability — four skills driving the user's real Chrome through the [mcp-chrome bridge](https://github.com/davincinewton/mcp-chrome-python) — lived in two places an installed machine never sees. The skills sat in the repository root's `.agents/skills/`, which no npm tarball ships; the MCP wiring was an opt-in overlay under `examples/mcp-chrome/`, which is not a release member either. A deployment from the registry therefore did not know the capability existed: no catalog entry, no row, no documentation path that discovered itself.

## Decision

**The skills ship as a bundled provider package.** `@deepseek-ai/dsh-skill-browser` (`packages/skill/skill-browser`) owns the four skill bodies as packaged assets and contributes them to `ctx.skills` at `BUNDLED_SKILL_RANK` with provider name `dsh-browser`, mirroring the [skill-badge](../../../../packages/skill/skill-badge/README.md) pattern. The bodies moved from `.agents/skills/` into the package's `assets/` — one source of truth, no copy. `record-browser-gif` stays repository-local: it is a repo-development workflow (Agent Notes, PR asset branches), not a deployment capability.

**The MCP row ships built-in and enabled.** `dsh-base` mounts an `mcp-chrome` row on `@deepseek-ai/dsh-mcp-client` with `serverName: chrome`, `transport: streamable-http`, `url: http://127.0.0.1:12306/mcp`, and the client defaults (`failOnStartupError: false`; bounded reconnect per [MCP client auto-reconnect](2026-08-06-mcp-client-auto-reconnect.md)). A down bridge is an expected state, not a failure: activation succeeds with no tools, the row logs its bounded retry series, and every other tool is unaffected.

**The skill bodies carry an explicit bridge-unavailable branch.** With no `mcp__chrome__*` tools in the catalog, `web-search-chrome` falls back to the built-in `web_search` tool (same result shape) and notes the degradation; `web-search-chrome-url`, `web-search-multi-engine`, and `browser-research-report` report the capability unavailable rather than produce degraded output — a snippet-only research report is a failed report by that skill's own standard.

**Port changes and opt-out go through the patch layers.** A patch replaces a row's whole config, so an override restates the complete config (`serverName`, `transport`, new `url`); disabling is `disabled: true` on the row. Scopes: one run via `--patch`, one profile via `$DSH_HOME/profiles/<name>/cordis.patch.yml`, machine-wide via `$DSH_HOME/cordis.patch.yml`. The user guide owns the mechanics: [docs/user/guide/browser.md](../../../../docs/user/guide/browser.md).

**The examples leaf was deleted.** `examples/mcp-chrome/` existed only to carry the opt-in overlay; with the row built in, its insert would duplicate the row id, and its facts now have one home in the user guide (including the third-party interoperability disclaimer).

## Alternatives considered

- **Keep the wiring opt-in and make it discoverable through documentation** — rejected at the source: `examples/` is not shipped in npm installs, so a docs page cannot make an installed machine discover a file it does not have.
- **Ship the skills from `.agents/skills/` via a discovery root** — the repository root is in no tarball; a per-install copy would fork the source of truth, and a new bundled provider is the pattern the registry already has (skill-badge).
- **Auto-reconnect for Streamable HTTP endpoints that were down at startup** — deferred: the [auto-reconnect supervisor](2026-08-06-mcp-client-auto-reconnect.md) is stdio-oriented, and a new session already picks up a running bridge; the guide tells users to start the bridge before the session that needs it.

## Consequences

Every boot attempts one localhost connect to `127.0.0.1:12306` per `mcp-chrome` row. The endpoint is loopback-only by the bridge's design, and the documented port override is the mitigation for a crowded or exposed default port; the cost of the attempt is an immediate connection refusal plus bounded log lines.

Every session's skill catalog gains four descriptions (about 1.7 KB per request); sessions that make a model turn now render one `skill-catalog` context-injection row, which the affected web e2e goldens record. The web e2e scaffold pins the row to a dead loopback port so a live developer bridge cannot change replay requests or goldens.

A latent defect surfaced while moving the assets: `browser-research-report`'s frontmatter was invalid YAML (an unquoted description containing `pipeline:`), so skill-filesystem silently ignored the file and the skill had never been discovered even in the development checkout. The description is now quoted, and the package test pins all four catalog descriptions against their asset frontmatter so the pair cannot drift again.

## Testing

`packages/skill/skill-browser/tests/skill-browser.spec.ts` registers the provider through the real `SkillRegistry`, asserts the four candidates (provider, source, invocation, resource base), loads every body through `get()`, proves disposal empties the catalog, and keeps each catalog description in sync with its asset frontmatter. `apps/web/tests/shipped-composition.e2e.ts` asserts the deployment facts against the shipped layer stack — the `skill-browser` row enabled and the `mcp-chrome` row at the default bridge URL — and, with the scaffold's dead-port pin making the bridge down by construction, that a preset-mounted agent's catalog still carries all four skills while no `mcp__chrome__*` tool appears. The web e2e goldens whose sessions gain the catalog injection row were refreshed in replay mode.
