/**
 * Bundled browser skill provider.
 *
 * Contributes the four mcp-chrome browser skills — `web-search-chrome`,
 * `web-search-chrome-url`, `web-search-multi-engine`, and
 * `browser-research-report` — to `ctx.skills` from this package's packaged
 * `assets/` directory, so every deployment that mounts the plugin knows the
 * browser capability regardless of its working directory or user skill roots.
 *
 * The skills drive the `mcp__chrome__*` tools that the built-in `mcp-chrome`
 * composition row exposes while the mcp-chrome bridge is running; with the
 * bridge down each skill's body falls back to the built-in `web_search` tool
 * or reports the capability unavailable.
 *
 * @module @deepseek-ai/dsh-skill-browser
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'dsh-browser'
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const RESOURCE_BASE = {
  kind: 'directory',
  path: ASSETS_DIR,
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** One shipped browser skill: its asset directory and catalog description. */
interface ShippedSkill {
  readonly name: string
  readonly description: string
}

/** The shipped browser skills, in asset-directory order. */
const SHIPPED_SKILLS: readonly ShippedSkill[] = [
  {
    name: 'browser-research-report',
    description: 'Use when the user wants a professional research report on a topic built from browser-based web research (e.g. "make a report on this week\'s crypto news"). Runs the full pipeline: scope → topic analysis (coverage map) → segmented search → deep article fetch → synthesis → report. Writes a dated markdown report to the workspace root.',
  },
  {
    name: 'web-search-chrome',
    description: 'Use when the web_search tool fails (e.g. anti-bot detection errors) or when the user asks to search the web through the browser. Drives the mcp__chrome__* tools to run a Google search in the user\'s real Chrome and returns structured sources (title, source, date, snippet, URL).',
  },
  {
    name: 'web-search-chrome-url',
    description: 'Use when search results must be handed off to a downstream deep-fetch workflow that runs in a SEPARATE session (or after the search tab is closed) — e.g. a fetch pipeline that navigates directly to article URLs. Unlike web-search-chrome (which presents a markdown source list and resolves only the top 1–3 on demand), this resolves a chosen set of results into clean real URLs AND captures each page\'s full text (since it is already on the page), emitting a structured JSON manifest of {title, source, date, snippet, url, fullText, published, type}.',
  },
  {
    name: 'web-search-multi-engine',
    description: 'Use when a search task needs broader or less biased coverage than a single engine — e.g. "search with multiple engines", "cross-check these results", or when one engine is blocked or its ranking is suspect. Runs the same query through Google, Bing, and DuckDuckGo in the user\'s real Chrome (mcp__chrome__*), merges the three lists with cross-engine dedup and corroboration (each item records which engines returned it), resolves a chosen set into clean real URLs with captured full text, and emits a web-search-chrome-url-compatible JSON manifest plus an engines field per item.',
  },
]

const CANDIDATES: readonly SkillCandidate[] = SHIPPED_SKILLS.map(skill => ({
  name: skill.name,
  description: skill.description,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: skill.name,
}))

/**
 * Strip the leading YAML frontmatter block from a skill asset, mirroring the
 * skill-filesystem body contract. Package-owned assets always carry the block
 * (the tests pin it); a file without one yields its whole text, so a missing
 * block degrades to the full Markdown instead of failing the load.
 * @param raw - full asset text.
 * @returns the Markdown body after the frontmatter, trimmed.
 */
function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const close = lines.indexOf('---', 1)
  return lines.slice(close + 1).join('\n').trim()
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
  /**
   * Load a shipped skill body. The registry only hands back candidates this
   * provider listed, so the locator is always one of `SHIPPED_SKILLS`; a
   * missing asset file rejects with the exact path instead of degrading.
   */
  async get(candidate): Promise<SkillDefinition | undefined> {
    const name = candidate.locator as string
    return {
      name,
      description: candidate.description,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: RESOURCE_BASE,
      content: stripFrontmatter(await readFile(`${ASSETS_DIR}/${name}/SKILL.md`, 'utf8')),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-browser'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled browser skill provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
