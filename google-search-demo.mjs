/**
 * Google search demo driven by the vendored `puppeteer-core` and ONLY the
 * bundled Chrome Headless Shell provisioned at `~/.cache/puppeteer` (the same
 * binary the managed `browser_*` tools drive). Mirrors the Puppeteer doc
 * snippet flow (`::-p-aria(Search)` + `fill` + Enter) against google.com.
 */
import puppeteer from '/home/yl/deepseek-harness-pure-local/node_modules/.pnpm/puppeteer-core@25.16.0/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const QUERY = 'australia open'
const SHOT = '/home/yl/deepseek-harness-pure-local/google-search-australia-open.png'
const EXECUTABLE = '/home/yl/.cache/puppeteer/chrome-headless-shell/linux-157.0.8103.38/chrome-headless-shell-linux64/chrome-headless-shell'

const browser = await puppeteer.launch({
  executablePath: EXECUTABLE,
  // The provisioned binary IS headless, so 'shell' launches it without a flag.
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
})

try {
  const page = await browser.newPage()
  await page.setUserAgent(UA)
  await page.setViewport({ width: 1280, height: 1150 })

  await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  console.log(`home: ${page.url()}`)

  // The doc-snippet interaction: accessible-name locator, fill, Enter.
  await page.locator('::-p-aria(Search)').fill(QUERY)
  await page.keyboard.press('Enter')
  await page.waitForSelector('#rso h3, #search h3, #topstuff h3', { timeout: 20000 })
    .catch(() => console.log('no result headings seen within 20s'))

  const url = page.url()
  if (url.includes('/sorry/')) {
    console.log(`BLOCKED (sorry/captcha): ${url}`)
    process.exitCode = 2
  } else {
    console.log(`results: ${url}`)
    console.log(`title: ${await page.title()}`)
    await page.screenshot({ path: SHOT, fullPage: false })
    console.log(`screenshot saved: ${SHOT}`)
  }
} finally {
  await browser.close()
}
