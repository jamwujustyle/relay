import { chromium } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })
  const svg = await readFile(new URL('../public/relay.svg', import.meta.url), 'utf8')
  await page.setContent(`<style>html,body{margin:0;width:512px;height:512px;background:transparent}svg{width:512px;height:512px;display:block}</style>${svg}`)
  await page.screenshot({ path: new URL('../public/relay-icon.png', import.meta.url).pathname, omitBackground: true })
} finally { await browser.close() }
