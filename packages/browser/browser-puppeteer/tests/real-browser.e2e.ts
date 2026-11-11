/**
 * Opt-in real-browser proof: with `DSH_BROWSER_REAL=1`, provisions (or reuses)
 * a real Chrome Headless Shell through the plugin's own `provision: auto`
 * path, then drives a local fixture page through the full seam: navigate,
 * snapshot with accessible names, fill and click via `::-p-aria`/`::-p-text`,
 * extract, structured extract-list, an indexed click among visible matches,
 * selector/navigation waits, and PNG screenshot. Skipped by default so CI and
 * offline runs are unaffected.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserPageKey } from '@deepseek-ai/dsh-browser'
import * as BrowserPuppeteer from '@deepseek-ai/dsh-browser-puppeteer'

const REAL = process.env.DSH_BROWSER_REAL === '1'
const pageKey = BrowserPageKey('e2e-1')

const PAGE_A = `<!doctype html><html><head><title>Fixture A</title></head><body>
<h1>Fixture Alpha</h1>
<input aria-label="Search box" type="text">
<a href="/b">Go to B</a>
</body></html>`

const PAGE_B = `<!doctype html><html><head><title>Fixture B</title></head><body>
<h1>Page B reached</h1>
<p id="quote">The title of this fixture page is B.</p>
</body></html>`

// Three visible rows and one display:none row; the hash in each href lets an
// indexed click prove which match it chose.
const PAGE_ROWS = `<!doctype html><html><head><title>Rows</title></head><body>
<ul>
  <li class="row"><h3>  First    result </h3><a href="/b#one">one</a></li>
  <li class="row"><h3>Second result</h3><a href="/b#two">two</a></li>
  <li class="row" style="display:none"><h3>Hidden result</h3><a href="/b#hidden">hidden</a></li>
  <li class="row"><h3>Third result</h3><a href="/b#three">three</a></li>
</ul>
</body></html>`

let server: Server | undefined
let baseUrl = ''
let ctx: Context | undefined
let cacheDir: string | undefined

beforeAll(async () => {
  if (!REAL) return
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/rows') === true) res.end(PAGE_ROWS)
    else res.end(req.url?.startsWith('/b') === true ? PAGE_B : PAGE_A)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server address missing')
  baseUrl = `http://127.0.0.1:${address.port}`
  cacheDir = await mkdtemp(join(tmpdir(), 'dsh-browser-e2e-cache-'))
  ctx = new Context()
  await ctx.plugin(BrowserRuntime, {})
  await ctx.plugin(BrowserPuppeteer, {
    provision: 'auto',
    cacheDir,
    allowLoopback: true,
  })
})

afterAll(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() =>{  resolve() }))
  server = undefined
  if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true })
  cacheDir = undefined
})

describe.skipIf(!REAL)('real Chrome Headless Shell through the seam', () => {
  it('navigates, snapshots, fills, clicks, extracts, and screenshots', async () => {
    const browser = ctx!.browser
    const status = await browser.navigate(pageKey, { url: `${baseUrl}/a`, waitUntil: 'domcontentloaded' })
    expect(status).toMatchObject({ url: `${baseUrl}/a`, title: 'Fixture A', statusCode: 200 })

    const snapshot = await browser.snapshot(pageKey, { maxTextChars: 2000, maxElements: 50 })
    expect(snapshot.text).toContain('Fixture Alpha')
    expect(snapshot.elements).toContainEqual(expect.objectContaining({ role: 'textbox', name: 'Search box' }))

    await browser.act(pageKey, { action: 'fill', target: '::-p-aria(Search box)', value: 'automate beyond recorder' })
    await browser.act(pageKey, { action: 'click', target: '::-p-text(Go to B)' })

    const extracted = await browser.extract(pageKey, { maxChars: 5000 })
    expect(extracted.url).toBe(`${baseUrl}/b`)
    expect(extracted.text).toContain('The title of this fixture page is B.')

    const shot = await browser.screenshot(pageKey, {})
    expect(shot.mediaType).toBe('image/png')
    expect(shot.width).toBeGreaterThan(0)
    expect(shot.height).toBeGreaterThan(0)
    expect(shot.bytes).toBe(shot.data.byteLength)

    await browser.close(pageKey)
    await expect(browser.snapshot(pageKey, { maxTextChars: 100, maxElements: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NO_PAGE' }))
  }, 300_000)

  it('reads structured rows, waits, and clicks the Nth visible match', async () => {
    const browser = ctx!.browser
    const key = BrowserPageKey('e2e-2')
    await browser.navigate(key, { url: `${baseUrl}/rows`, waitUntil: 'domcontentloaded' })

    const rows = await browser.extractList(key, {
      selector: '.row',
      fields: { title: { selector: 'h3' }, link: { selector: 'a', attribute: 'href' } },
      limit: 8,
      maxFieldChars: 100,
    })
    // Extraction projects every match (visibility-filtering is the act's job);
    // whitespace inside the h3 collapses and attributes project directly.
    expect(rows).toMatchObject({ count: 4, truncated: false })
    expect(rows.rows[0]).toEqual({ title: 'First result', link: '/b#one' })

    const capped = await browser.extractList(key, {
      selector: '.row', fields: { title: { selector: 'h3' } }, limit: 2, maxFieldChars: 5,
    })
    expect(capped.count).toBe(2)
    expect(capped.truncated).toBe(true)

    await browser.wait(key, { selector: '.row a', timeoutMs: 5000 })
    // The second VISIBLE row skips the display:none third match.
    await browser.act(key, { action: 'click', target: '.row a', index: 1 })
    const landed = await browser.wait(key, { timeoutMs: 5000 })
    expect(landed.url).toBe(`${baseUrl}/b#two`)
    expect(landed.title).toBe('Fixture B')

    await browser.close(key)
  }, 300_000)

  it('blocks non-loopback-private and file targets even when loopback is allowed', async () => {
    const browser = ctx!.browser
    await expect(browser.navigate(pageKey, { url: 'file:///etc/hosts' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_INVALID_URL' }))
    await expect(browser.navigate(pageKey, { url: 'http://169.254.169.254/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_BLOCKED_URL' }))
  })
})
