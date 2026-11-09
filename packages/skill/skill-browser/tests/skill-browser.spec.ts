import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillBrowser from '@deepseek-ai/dsh-skill-browser'

const ASSETS = new URL('../assets/', import.meta.url)

const SKILL_NAMES = [
  'browser-research-report',
  'web-search-chrome',
  'web-search-chrome-url',
  'web-search-multi-engine',
  'headless-research-report',
  'headless-web-search',
  'headless-multi-engine-search',
] as const

/** Parse the leading YAML frontmatter block of a skill asset. */
function frontmatter(raw: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1]
  if (block === undefined) throw new Error('asset has no frontmatter')
  return parseYaml(block) as Record<string, unknown>
}

describe('dsh-skill-browser', () => {
  it('registers the seven bundled browser skills and disposes them', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBrowser)
    const resourcePath = fileURLToPath(ASSETS)

    const listed = await ctx.skills.list()
    expect(listed.map(skill => skill.name).sort()).toEqual([...SKILL_NAMES].sort())
    for (const skill of listed) {
      expect(skill.provider).toBe('dsh-browser')
      expect(skill.source).toBe('bundled')
      expect(skill.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(skill.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
    }

    for (const name of SKILL_NAMES) {
      const loaded = await ctx.skills.get(name)
      expect(loaded?.content).toMatch(/^# /)
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
    }

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('keeps every catalog description in sync with its asset frontmatter', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBrowser)
    try {
      for (const name of SKILL_NAMES) {
        const raw = await readFile(new URL(`${name}/SKILL.md`, ASSETS), 'utf8')
        const meta = frontmatter(raw)
        const listed = (await ctx.skills.list()).find(skill => skill.name === name)
        expect(listed?.description).toBe(meta.description)
      }
    } finally {
      await fiber.dispose()
    }
  })
})
