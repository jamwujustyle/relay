import { test, expect, type Page } from '@playwright/test'
import type { AIResult } from '../src/types'

const screenshot = { name: 'capture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6HkAAAAAASUVORK5CYII=', 'base64') }

async function openCapture(page: Page) {
  await page.getByRole('button', { name: 'Capture N', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Capture request', exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
}

async function mockDesktop(page: Page, result: AIResult, error = '') {
  await page.addInitScript(({ result, error, image }) => {
    const settings = { hasApiKey: true, secureStorage: false, model: 'gemini-3.1-flash-lite', dailyLimit: 30, callsToday: 0, keyStorage: 'session' as const, shortcuts: { capture: true, screen: true, next: true } }
    window.relay = {
      loadWorkspace: async () => JSON.parse(localStorage.getItem('mock-workspace') || 'null'),
      saveWorkspace: async value => { localStorage.setItem('mock-workspace', JSON.stringify(value)) },
      getSettings: async () => settings,
      saveSettings: async () => settings,
      runAI: async request => {
        localStorage.setItem('mock-ai-request', JSON.stringify(request))
        if (error) throw new Error(error)
        return result
      },
      readClipboard: async () => ({ text: 'Copied request from Telegram' }),
      readScreenCapture: async () => {
        localStorage.setItem('mock-screen-reads', String(Number(localStorage.getItem('mock-screen-reads') || 0) + 1))
        return { text: '', image }
      },
      writeClipboard: async text => { localStorage.setItem('mock-clipboard', text) },
      openExternal: async () => {},
      onAction: callback => {
        const listener = (event: Event) => callback((event as CustomEvent<'capture' | 'screen' | 'next'>).detail)
        window.addEventListener('test-relay-action', listener)
        return () => window.removeEventListener('test-relay-action', listener)
      },
    }
  }, { result, error, image: `data:image/png;base64,${screenshot.buffer.toString('base64')}` })
}

test('captures original context, keeps active work steady, saves waiting and survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toBeVisible()
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Check scenario generation')
  await page.getByRole('textbox', { name: 'Original request' }).fill('проверить генерацию сценариев\nOriginal request must survive edits.')
  await page.getByRole('button', { name: 'Telegram', exact: true }).click()
  await page.getByRole('button', { name: 'Save to inbox' }).click()
  await expect(page.getByLabel('Request details')).toBeVisible()
  await expect(page.getByText('Original request must survive edits.', { exact: false })).toBeVisible()
  await page.getByLabel('Request details').getByLabel('Status', { exact: true }).selectOption('active')
  await page.getByRole('textbox', { name: 'Progress note' }).fill('Confirmed the reproduction. Next: fix the template.')
  await page.getByRole('button', { name: 'Save progress note' }).click()
  await expect(page.getByText('Confirmed the reproduction. Next: fix the template.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close details' }).click()
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Urgent incoming idea')
  await page.getByRole('textbox', { name: 'Original request' }).fill('New request with no commitment.')
  await page.getByLabel('Priority', { exact: true }).selectOption('high')
  await page.getByRole('button', { name: 'Save to inbox' }).click()
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Overview' }).click()
  await expect(page.locator('.next-card h2')).toHaveText('Check scenario generation')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Request details').getByLabel('Status', { exact: true }).selectOption('waiting')
  await page.getByPlaceholder('A person, answer, or dependency').fill('Client approval')
  await page.getByLabel('Follow up on').fill('2026-12-20')
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect.poll(async () => page.evaluate(() => { const data = localStorage.getItem(window.relay ? 'mock-workspace' : 'relay.workspace.v1'); return data ? JSON.parse(data).tasks.length : 0 })).toBeGreaterThan(0)
  await page.reload()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /Waiting/ }).click()
  await page.getByRole('button', { name: 'Open Check scenario generation', exact: true }).click()
  await expect(page.getByPlaceholder('A person, answer, or dependency')).toHaveValue('Client approval')
  await expect(page.getByLabel('Follow up on')).toHaveValue('2026-12-20')
  await expect(page.getByText('Original request must survive edits.', { exact: false })).toBeVisible()
})

test('supports screenshots, searching, completion, backup export and safe import', async ({ page }) => {
  await page.goto('/')
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Screenshot request')
  await page.locator('input[type=file]').first().setInputFiles(screenshot)
  await page.getByRole('button', { name: 'Save to inbox' }).click()
  await expect(page.getByRole('img', { name: 'capture.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Mark done' }).click()
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.getByRole('textbox', { name: 'Search requests' }).fill('screenshot')
  await expect(page.getByRole('button', { name: 'Open Screenshot request', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: false }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^relay-backup-/)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.locator('input[type=file]').last().setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"tasks":[{"title":"bad"}]}') })
  await expect(page.getByRole('status')).toContainText('Couldn’t import backup')
  await expect(page.getByRole('button', { name: 'Open Screenshot request', exact: true })).toBeVisible()
})

test('sample workspace, next actions, keyboard capture and settings are usable', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Explore sample requests' }).click()
  await expect(page.locator('.sample-banner')).toBeVisible()
  await page.getByRole('button', { name: 'Choose another' }).click()
  await page.getByRole('button', { name: 'Not now', exact: true }).click()
  await expect(page.locator('.next-choice h3')).toHaveText('Адаптировать брифинг под клиента')
  await page.getByRole('button', { name: 'Continue this' }).click()
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.keyboard.press('n')
  await expect(page.getByRole('dialog', { name: 'Capture request' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings', exact: false }).click()
  await expect(page.getByLabel('Gemini API key')).toBeDisabled()
  await expect(page.getByText('You’re in the browser preview.', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Start fresh' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toBeVisible()
})

test('AI suggestions require acceptance and preserve original context and handoff notes', async ({ page }) => {
  await mockDesktop(page, { title: 'Suggested title', project: 'Relay', summary: 'A grounded suggestion.', relatedIds: [], inputTokens: 100, outputTokens: 50 })
  await page.goto('/')
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Initial title')
  await page.getByRole('textbox', { name: 'Original request' }).fill('Verbatim request from Telegram.')
  await page.getByRole('button', { name: 'Save to inbox' }).click()
  await page.getByRole('textbox', { name: 'Task title' }).fill('Manually edited title')
  await page.getByRole('textbox', { name: 'Task title' }).press('Tab')
  await page.getByRole('button', { name: 'Ask AI to organize' }).click()
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Manually edited title')
  await page.getByRole('button', { name: 'Apply suggestion' }).click()
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Suggested title')
  await page.getByRole('textbox', { name: 'Task title' }).focus()
  await page.getByRole('textbox', { name: 'Task title' }).press('Tab')
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Suggested title')
  await page.getByRole('textbox', { name: 'Progress note' }).fill('Next session: check edge cases.')
  await page.getByRole('button', { name: 'Save progress note' }).click()
  await page.getByRole('button', { name: 'Handoff', exact: true }).click()
  const copied = await page.evaluate(() => localStorage.getItem('mock-clipboard'))
  expect(copied).toContain('Verbatim request from Telegram.')
  expect(copied).toContain('Next session: check edge cases.')
  expect(copied).toContain('Suggested title')
  await expect.poll(async () => page.evaluate(() => { const data = localStorage.getItem(window.relay ? 'mock-workspace' : 'relay.workspace.v1'); return data ? JSON.parse(data).tasks.length : 0 })).toBeGreaterThan(0)
  await page.reload()
  await page.getByRole('textbox', { name: 'Search requests' }).fill('Suggested title')
  await expect(page.getByRole('button', { name: 'Open Suggested title', exact: true })).toBeVisible()
})

test('extraction is reviewed before selected requests are saved with their original context', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 640 })
  await mockDesktop(page, {
    requests: [
      { title: 'Fix scenario generation', summary: 'Check the generated scenarios.', project: 'Client A', relatedIds: [] },
      { title: 'Translate the briefing', summary: 'Translate the approved briefing.', project: 'Client A', relatedIds: [] },
    ],
    explanation: 'Two requests found in the conversation.', inputTokens: 120, outputTokens: 80,
  })
  await page.goto('/')
  await openCapture(page)
  await expect(page.getByRole('button', { name: 'Save to inbox', exact: true })).toBeInViewport({ ratio: 1 })
  const original = 'проверить генерацию сценариев\nперевод брифинга\nKeep this exact source context.'
  await page.getByRole('textbox', { name: 'Original request' }).fill(original)
  await page.getByRole('button', { name: 'Telegram', exact: true }).click()
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(screenshot)
  await page.getByRole('button', { name: 'Preview capture.png', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'capture.png', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Capture request', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Original request' })).toHaveValue(original)
  await page.getByRole('button', { name: 'Extract requests', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Fix scenario generation' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Translate the briefing' })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Save selected (2)', exact: true })).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-workspace') || '{}').tasks)).toEqual([])
  const sent = await page.evaluate(() => JSON.parse(localStorage.getItem('mock-ai-request') || '{}'))
  expect(sent.mode).toBe('extract')
  expect(sent.capture.text).toContain(original)
  expect(sent.capture.attachments).toHaveLength(1)
  await page.getByRole('checkbox', { name: 'Translate the briefing' }).uncheck()
  await page.getByRole('button', { name: 'Save selected (1)', exact: true }).click()
  await expect(page.getByLabel('Request details')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Fix scenario generation')
  await expect(page.getByText(original, { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'capture.png' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mock-workspace') || '{}').tasks?.length)).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: 'Open Fix scenario generation', exact: true }).click()
  await expect(page.getByText(original, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Translate the briefing', exact: true })).toHaveCount(0)
})

for (const scenario of [
  { name: 'provider error', error: 'The provider is temporarily unavailable.', explanation: '' },
  { name: 'no actionable requests', error: '', explanation: 'No actionable requests were found in this capture.' },
]) {
  test(`extraction with ${scenario.name} preserves the draft and allows manual capture`, async ({ page }) => {
    await mockDesktop(page, { requests: [], explanation: scenario.explanation, inputTokens: 40, outputTokens: 10 }, scenario.error)
    await page.goto('/')
    await openCapture(page)
    await page.getByRole('textbox', { name: 'Capture title' }).fill('Keep this manually')
    await page.getByRole('textbox', { name: 'Original request' }).fill('Original shorthand that I understand.')
    await page.getByRole('button', { name: 'Extract requests', exact: true }).click()
    await expect(page.getByText(scenario.error || scenario.explanation, { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Original request' })).toHaveValue('Original shorthand that I understand.')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-workspace') || '{}').tasks)).toEqual([])
    await page.getByRole('button', { name: 'Save to inbox', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Keep this manually')
    await expect(page.getByText('Original shorthand that I understand.', { exact: true })).toBeVisible()
  })
}

test('compact desktop keeps details usable and modal keyboard focus contained', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 640 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Explore sample requests', exact: true }).click()
  await page.getByRole('button', { name: /^Open / }).first().click()
  await expect(page.getByLabel('Request details')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark done', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const details = await page.getByLabel('Request details').boundingBox()
  expect(details).not.toBeNull()
  expect(details!.x).toBeGreaterThanOrEqual(0)
  expect(details!.x + details!.width).toBeLessThanOrEqual(981)
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Original request' }).focus()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: 'Original request' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(await page.getByRole('dialog', { name: 'Capture request' }).evaluate(dialog => dialog.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close details', exact: true }).click()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('textbox', { name: 'Search requests' })).toBeFocused()
})

test('pending screenshot reads block saving and extraction until the image is attached', async ({ page }) => {
  await mockDesktop(page, { requests: [], explanation: '', inputTokens: 0, outputTokens: 0 })
  await page.addInitScript(() => {
    const read = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (this: FileReader, file: Blob) {
      window.addEventListener('relay-test-release-file-read', () => read.call(this, file), { once: true })
    }
  })
  await page.goto('/')
  await openCapture(page)
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Keep the screenshot with this request')
  await page.getByRole('textbox', { name: 'Original request' }).fill('The image contains the reproduction steps.')
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(screenshot)
  await expect(page.getByRole('button', { name: 'Save to inbox', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Extract requests', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Original request' }).press('Control+Enter')
  await expect(page.getByRole('dialog', { name: 'Capture request', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-workspace') || '{}').tasks)).toEqual([])
  await page.evaluate(() => window.dispatchEvent(new Event('relay-test-release-file-read')))
  await expect(page.getByRole('button', { name: 'Preview capture.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save to inbox', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Extract requests', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click()
  await expect(page.getByLabel('Request details')).toBeVisible()
  await expect(page.getByRole('img', { name: 'capture.png', exact: true })).toBeVisible()
})


test('desktop capture actions open screenshots and preserve an existing draft', async ({ page }) => {
  await mockDesktop(page, { requests: [], explanation: '', inputTokens: 0, outputTokens: 0 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-relay-action', { detail: 'screen' })))
  await expect(page.getByRole('dialog', { name: 'Capture request', exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Captured screenshot.png', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('mock-screen-reads'))).toBe('1')
  await page.getByRole('textbox', { name: 'Capture title' }).fill('Current screen request')
  await page.getByRole('textbox', { name: 'Original request' }).fill('Keep this in-progress explanation.')
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(screenshot)
  await expect(page.getByRole('img', { name: 'capture.png', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-relay-action', { detail: 'screen' })))
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mock-screen-reads'))).toBe('2')
  await expect(page.getByRole('textbox', { name: 'Capture title' })).toHaveValue('Current screen request')
  await expect(page.getByRole('textbox', { name: 'Original request' })).toHaveValue('Keep this in-progress explanation.')
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(2)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-workspace') || '{}').tasks)).toEqual([])
  await page.getByRole('button', { name: 'Save to inbox', exact: true }).click()
  await expect(page.getByLabel('Request details')).toBeVisible()
  await expect(page.getByLabel('Request details').locator('img')).toHaveCount(2)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-relay-action', { detail: 'capture' })))
  await expect(page.getByRole('dialog', { name: 'Capture request', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Original request' })).toHaveValue('Copied request from Telegram')
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(0)
})
