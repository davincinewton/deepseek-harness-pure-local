/**
 * REAL-composition proof: the shipped YAML shape (system-prompt + tools
 * registry + browser seam + Puppeteer provider + tool-browser) boots through
 * the vendored Loader, the namespace plugins survive (no discarded default
 * exports), the tools are registered, and a navigation is refused by the
 * provider's loopback policy through the fully composed stack. No browser
 * process starts: the executable points at a nonexistent path and the policy
 * rejects the target before launch.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BrowserRuntime from '@deepseek-ai/dsh-browser'
import * as BrowserPuppeteer from '@deepseek-ai/dsh-browser-puppeteer'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-browser', BrowserRuntime],
    ['@deepseek-ai/dsh-browser-puppeteer', BrowserPuppeteer],
    ['@deepseek-ai/dsh-tool-browser', ToolBrowser],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('browser seam real composition (Loader)', () => {
  it('boots the shipped rows, registers the six tools, and enforces the policy end-to-end', async () => {
    const ctx = await loadYaml([
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: browser',
      "  name: '@deepseek-ai/dsh-browser'",
      '- id: browser-puppeteer',
      "  name: '@deepseek-ai/dsh-browser-puppeteer'",
      '  config:',
      '    executablePath: /nonexistent/chrome-headless-shell',
      '    provision: off',
      '- id: tool-browser',
      "  name: '@deepseek-ai/dsh-tool-browser'",
      '  config:',
      '    actRequiresApproval: false',
      '    screenshot: false',
    ])
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    expect(ctx.browser).toBeDefined()
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_act', 'browser_extract', 'browser_close']) {
      expect(ctx.tools.get(name), name).toBeDefined()
    }
    // screenshot is config-disabled; it must not appear even implicitly.
    expect(ctx.tools.get('browser_screenshot')).toBeUndefined()

    const blocked = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-blocked'),
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:9/admin' },
    })
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked.content)).toContain('is private or reserved')

    const unlaunchable = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-launch'),
      name: 'browser_navigate',
      arguments: { url: 'https://this-host-does-not-exist.invalid/' },
    })
    expect(unlaunchable.isError).toBe(true)
    // Policy passed (name unresolvable), so the failure is the missing binary —
    // proof the request reached the real provider, not a Consumer shortcut.
    expect(JSON.stringify(unlaunchable.content)).toContain('browser launch failed')
  })
})
