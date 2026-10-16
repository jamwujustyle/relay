import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Task, Workspace } from '../src/types'

const require = createRequire(import.meta.url)
const validation = require('../electron/validation.cjs')
const { JsonStore } = require('../electron/storage.cjs')
const { SettingsManager, secureAvailable } = require('../electron/settings.cjs')
const { GeminiClient, prepareRequest, parseResult } = require('../electron/ai.cjs')
const key = 'test_key_for_backend_123456789'
const insecure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw Error('should not encrypt') } }
const secure = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
}
const task = (id = 'one', status: Task['status'] = 'inbox'): Task => ({
  id, title: `Request ${id}`, body: 'Original request context', project: 'Relay', status, priority: 'medium',
  source: 'note', sourceUrl: '', createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z',
  dueDate: '', waitingOn: '', followUpDate: '', committed: false, order: 0, attachments: [], relatedIds: [], activity: [],
})
const workspace = (title = 'Request one'): Workspace => ({ version: 1, sample: false, focus: 'Ship Relay', tasks: [{ ...task(), title }] })
async function withDirectory(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-backend-'))
  try { await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const configStore = (directory: string) => new JsonStore(path.join(directory, 'settings.json'), validation.config, 16384)
const answer = (value: object) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } })

test('workspace validation rejects malformed IDs, statuses and executable image URLs', () => {
  assert.doesNotThrow(() => validation.workspace(workspace()))
  assert.throws(() => validation.workspace({ ...workspace(), tasks: [task(), task()] }), /unique/)
  assert.throws(() => validation.workspace({ ...workspace(), tasks: [{ ...task(), status: 'unknown' }] }), /status/)
  assert.throws(() => validation.workspace({ ...workspace(), tasks: [{ ...task(), attachments: [{ id: 'image', name: 'bad', type: 'image/png', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }] }] }), /Image|PNG/)
})

test('workspace saves are atomic, serialized and survive restart', async () => withDirectory(async directory => {
  const filename = path.join(directory, 'workspace.json')
  const store = new JsonStore(filename, validation.workspace, validation.MAX_WORKSPACE_BYTES)
  assert.equal(await store.load(), null)
  await Promise.all([store.save(workspace('First')), store.save(workspace('Second')), store.save(workspace('Third'))])
  const restarted = new JsonStore(filename, validation.workspace, validation.MAX_WORKSPACE_BYTES)
  assert.equal((await restarted.load()).tasks[0].title, 'Third')
}))

test('corrupt existing workspaces are preserved and cannot be overwritten by defaults', async () => withDirectory(async directory => {
  const filename = path.join(directory, 'workspace.json')
  await writeFile(filename, '{ broken data')
  const store = new JsonStore(filename, validation.workspace, validation.MAX_WORKSPACE_BYTES)
  await assert.rejects(store.load(), /preserved/)
  await assert.rejects(store.save(workspace()), /preserved/)
  assert.equal(await readFile(filename, 'utf8'), '{ broken data')
}))

test('storage checks for corruption introduced after an earlier valid load', async () => withDirectory(async directory => {
  const filename = path.join(directory, 'workspace.json')
  const store = new JsonStore(filename, validation.workspace, validation.MAX_WORKSPACE_BYTES)
  await store.save(workspace())
  await writeFile(filename, 'corrupted externally')
  await assert.rejects(store.save(workspace('Updated')), /preserved/)
  assert.equal(await readFile(filename, 'utf8'), 'corrupted externally')
}))

test('basic_text keeps credentials in the session without writing a key', async () => withDirectory(async directory => {
  assert.equal(secureAvailable(insecure, 'linux'), false)
  const manager = new SettingsManager(configStore(directory), insecure, { platform: 'linux' })
  const settings = await manager.save({ apiKey: key })
  assert.equal(settings.keyStorage, 'session')
  assert.equal(settings.hasApiKey, true)
  assert.equal(settings.secureStorage, false)
  assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes(key), false)
  const restarted = new SettingsManager(configStore(directory), insecure, { platform: 'linux' })
  assert.equal((await restarted.get()).hasApiKey, false)
}))

test('OS-encrypted keys can be loaded after restart and removed', async () => withDirectory(async directory => {
  const manager = new SettingsManager(configStore(directory), secure, { platform: 'linux' })
  const settings = await manager.save({ apiKey: key })
  assert.equal(settings.keyStorage, 'encrypted')
  assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes(key), false)
  const restarted = new SettingsManager(configStore(directory), secure, { platform: 'linux' })
  assert.equal((await restarted.get()).hasApiKey, true)
  await restarted.save({ removeKey: true })
  assert.equal((await restarted.get()).keyStorage, 'none')
  assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('encryptedKey'), false)
}))

test('daily request reservations cannot race past the persisted cap and reset next day', async () => withDirectory(async directory => {
  let now = new Date(2026, 9, 16, 23, 59)
  const manager = new SettingsManager(configStore(directory), insecure, { platform: 'linux', now: () => now })
  await manager.save({ apiKey: key, dailyLimit: 2 })
  const reservations = await Promise.allSettled([manager.reserveCall(), manager.reserveCall(), manager.reserveCall()])
  assert.equal(reservations.filter(item => item.status === 'fulfilled').length, 2)
  assert.equal((await manager.get()).callsToday, 2)
  now = new Date(2026, 9, 17, 0, 1)
  assert.equal((await manager.get()).callsToday, 0)
  await manager.reserveCall()
  assert.equal((await manager.get()).callsToday, 1)
}))

test('next recommendations exclude waiting, later and done, and ground alternatives', () => {
  const prepared = prepareRequest({ mode: 'next', tasks: [task(), task('two', 'active'), task('wait', 'waiting'), task('later', 'later'), task('done', 'done')], focus: '' })
  assert.deepEqual([...prepared.allowedIds], ['one', 'two'])
  assert.throws(() => parseResult(answer({ taskId: 'wait', reason: 'Wait', alternatives: [] }), prepared), /invalid fields/)
  assert.throws(() => parseResult(answer({ taskId: 'one', reason: 'Do it', alternatives: ['made-up'] }), prepared), /invalid fields/)
  const result = parseResult(answer({ taskId: 'one', reason: 'It is actionable.', alternatives: ['two'] }), prepared)
  assert.equal(result.taskId, 'one')
  assert.equal(result.inputTokens, 120)
  const withThinking = answer({ taskId: 'one', reason: 'It is actionable.', alternatives: [] })
  const usage = withThinking.usageMetadata as typeof withThinking.usageMetadata & { thoughtsTokenCount: number }
  usage.thoughtsTokenCount = 50
  assert.equal(parseResult(withThinking, prepared).outputTokens, 80)
})

test('AI prioritization receives order and latest handoff context', () => {
  const updated = { ...task(), order: 7, activity: [{ id: 'event', text: 'Client approved the revised flow; next implement the export.', createdAt: '2026-10-16T13:00:00.000Z' }] }
  const prepared = prepareRequest({ mode: 'next', tasks: [updated], focus: '' })
  const content = JSON.parse(prepared.body.contents[0].parts[0].text)
  assert.equal(content.candidates[0].order, 7)
  assert.match(content.candidates[0].recentActivity[0].text, /Client approved/)
})

test('capture sends original context and only the selected request image', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const attachment = { id: 'image', name: 'capture.png', type: 'image/png', dataUrl: png }
  const selected = { ...task(), body: 'Original request with a specific deadline', attachments: [attachment] }
  const other = { ...task('two'), attachments: [attachment] }
  const prepared = prepareRequest({ mode: 'capture', tasks: [selected, other], taskId: 'one', focus: 'Build' })
  const parts = prepared.body.contents[0].parts
  assert.equal(parts.length, 2)
  assert.match(parts[0].text, /Original request with a specific deadline/)
  assert.equal(parts[1].inlineData.mimeType, 'image/png')
  assert.throws(() => parseResult(answer({ title: 'Organized', project: 'Relay', summary: 'Do this', relatedIds: ['one'] }), prepared), /invalid fields/)
})

test('Gemini request uses a fixed HTTPS endpoint and header key, with validated JSON output', async () => {
  let reservations = 0
  const client = new GeminiClient({ reserveCall: async () => { reservations++; return { apiKey: key, model: 'gemini-3.1-flash-lite' } }, recordUsage: async () => {} }, {
    fetch: async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent')
      assert.equal((options.headers as Record<string, string>)['x-goog-api-key'], key)
      assert.equal(String(options.body).includes(key), false)
      return new Response(JSON.stringify(answer({ taskId: 'one', reason: 'Matches the focus', alternatives: [] })))
    },
  })
  const result = await client.run({ mode: 'next', tasks: [task()], focus: '' })
  assert.equal(result.reason, 'Matches the focus')
  assert.equal(reservations, 1)
  assert.equal(JSON.stringify(result).includes(key), false)
})

test('provider errors and network exceptions never echo upstream credentials', async () => {
  for (const fetch of [
    async () => new Response(`invalid key ${key}`, { status: 403 }),
    async () => { throw Error(`network failure contains ${key}`) },
  ]) {
    const client = new GeminiClient({ reserveCall: async () => ({ apiKey: key, model: 'gemini-3.1-flash-lite' }), recordUsage: async () => {} }, { fetch })
    await assert.rejects(client.run({ mode: 'next', tasks: [task()], focus: '' }), (error: Error) => !error.message.includes(key))
  }
})

test('invalid AI input spends no request and concurrent calls do not double-dispatch', async () => {
  let reservations = 0
  let finish: (() => void) | undefined
  const client = new GeminiClient({ reserveCall: async () => { reservations++; return { apiKey: key, model: 'gemini-3.1-flash-lite' } }, recordUsage: async () => {} }, {
    fetch: async () => { await new Promise<void>(resolve => { finish = resolve }); return new Response(JSON.stringify(answer({ taskId: 'one', reason: 'Actionable', alternatives: [] }))) },
  })
  await assert.rejects(client.run({ mode: 'next', tasks: [task('wait', 'waiting')], focus: '' }), /Add an inbox/)
  assert.equal(reservations, 0)
  const first = client.run({ mode: 'next', tasks: [task()], focus: '' })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(client.run({ mode: 'next', tasks: [task()], focus: '' }), /already running/)
  finish?.()
  await first
  assert.equal(reservations, 1)
})

test('AI timeout produces a controlled error', async () => {
  const client = new GeminiClient({ reserveCall: async () => ({ apiKey: key, model: 'gemini-3.1-flash-lite' }), recordUsage: async () => {} }, {
    timeoutMs: 10,
    fetch: async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(Error('Aborted')))),
  })
  await assert.rejects(client.run({ mode: 'next', tasks: [task()], focus: '' }), /timed out/)
})

test('external links reject executable protocols, credentials and unrelated Telegram actions', () => {
  assert.equal(validation.externalUrl('https://t.me/team/123'), 'https://t.me/team/123')
  assert.equal(validation.externalUrl('tg://resolve?domain=team&post=123'), 'tg://resolve?domain=team&post=123')
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com', 'tg://proxy?server=evil', 'https://example.com\n']) {
    assert.throws(() => validation.externalUrl(url))
  }
})

test('reported token spend accumulates using the model used for each call and survives restart', async () => withDirectory(async directory => {
  const manager = new SettingsManager(configStore(directory), insecure, { platform: 'linux' })
  await manager.save({ apiKey: key })
  await manager.reserveCall()
  await manager.recordUsage('gemini-3.1-flash-lite', 1000000, 2000000)
  await manager.save({ model: 'gemini-3.5-flash-lite' })
  await manager.reserveCall()
  await manager.recordUsage('gemini-3.5-flash-lite', 1000000, 1000000)
  const settings = await manager.get()
  assert.equal(settings.callsToday, 2)
  assert.equal(settings.inputTokensToday, 2000000)
  assert.equal(settings.outputTokensToday, 3000000)
  assert.equal(settings.estimatedCostToday, 6.05)
  const restarted = new SettingsManager(configStore(directory), insecure, { platform: 'linux' })
  assert.equal((await restarted.get()).estimatedCostToday, 6.05)
  assert.equal((await restarted.get()).inputTokensToday, 2000000)
}))

test('unpriced model usage makes the daily estimate unknown until the next local day', async () => withDirectory(async directory => {
  let now = new Date(2026, 9, 16, 20, 0)
  const manager = new SettingsManager(configStore(directory), insecure, { platform: 'linux', now: () => now })
  await manager.save({ apiKey: key })
  await manager.reserveCall()
  await manager.recordUsage('gemini-unpriced-model', 100, 200)
  await manager.recordUsage('gemini-3.1-flash-lite', 300, 400)
  assert.equal((await manager.get()).estimatedCostToday, null)
  assert.equal((await manager.get()).inputTokensToday, 400)
  now = new Date(2026, 9, 17, 0, 1)
  const reset = await manager.get()
  assert.equal(reset.callsToday, 0)
  assert.equal(reset.inputTokensToday, 0)
  assert.equal(reset.outputTokensToday, 0)
  assert.equal(reset.estimatedCostToday, 0)
  await manager.reserveCall()
  await manager.recordUsage('gemini-3.1-flash-lite', 1000000, 0)
  assert.equal((await manager.get()).estimatedCostToday, 0.25)
  assert.equal((await manager.get()).inputTokensToday, 1000000)
}))

test('legacy settings without token fields load as zero and preserve the existing request count', async () => withDirectory(async directory => {
  const store = configStore(directory)
  const now = new Date(2026, 9, 16, 20, 0)
  await store.save({ version: 1, model: 'gemini-3.1-flash-lite', dailyLimit: 30, usage: { date: '2026-10-16', count: 3 } })
  const manager = new SettingsManager(store, insecure, { platform: 'linux', now: () => now })
  const old = await manager.get()
  assert.equal(old.callsToday, 3)
  assert.equal(old.inputTokensToday, 0)
  assert.equal(old.outputTokensToday, 0)
  assert.equal(old.estimatedCostToday, 0)
  await manager.save({ apiKey: key })
  await manager.reserveCall()
  await manager.recordUsage('gemini-3.1-flash-lite', 1000, 1000)
  assert.equal((await manager.get()).callsToday, 4)
  assert.equal((await manager.get()).estimatedCostToday, 0.00175)
  await assert.rejects(manager.recordUsage('gemini-3.1-flash-lite', -1, 100), /Invalid provider/)
  await assert.rejects(manager.recordUsage('gemini-3.1-flash-lite', 10000001, 100), /Invalid provider/)
}))

test('an invalid AI suggestion still records reported input, output and thought tokens', async () => withDirectory(async directory => {
  const manager = new SettingsManager(configStore(directory), insecure, { platform: 'linux' })
  await manager.save({ apiKey: key })
  const data = answer({ taskId: 'invented', reason: 'Invalid reference', alternatives: [] })
  const usage = data.usageMetadata as typeof data.usageMetadata & { thoughtsTokenCount: number }
  usage.promptTokenCount = 10
  usage.candidatesTokenCount = 20
  usage.thoughtsTokenCount = 30
  const client = new GeminiClient(manager, { fetch: async () => new Response(JSON.stringify(data)) })
  await assert.rejects(client.run({ mode: 'next', tasks: [task()], focus: '' }), /invalid fields/)
  const settings = await manager.get()
  assert.equal(settings.callsToday, 1)
  assert.equal(settings.inputTokensToday, 10)
  assert.equal(settings.outputTokensToday, 50)
  assert.equal(settings.estimatedCostToday, 0.0000775)
}))
