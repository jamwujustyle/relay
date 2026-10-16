import assert from 'node:assert/strict'
import test from 'node:test'
import { createHandoff, createTask, dateLabel, emptyWorkspace, isOverdue, recommendNext, relatedTasks, sampleWorkspace, validateWorkspace } from '../src/domain.ts'
import type { Task, Workspace } from '../src/types.ts'

const makeTask = (id: string, properties: Partial<Task> = {}) => createTask({ id, title: id, ...properties })
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const workspace = (tasks: Task[]): Workspace => ({ ...emptyWorkspace(), tasks })
const day = (offset: number): string => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

test('new workspaces are empty; illustrative sample data requires a separate call', () => {
  assert.deepEqual(emptyWorkspace(), { version: 1, tasks: [], focus: '', sample: false })
  const demo = sampleWorkspace()
  assert.equal(demo.sample, true)
  assert.equal(demo.tasks.length, 8)
  assert.equal(demo.tasks.filter(task => task.status === 'active').length, 2)
  assert.equal(demo.tasks.filter(task => task.status === 'waiting').length, 2)
  assert.ok(demo.tasks.every(task => task.project.startsWith('Демо')))
  assert.deepEqual(validateWorkspace(demo), demo)
})

test('an explicitly ordered active choice remains first despite new deadlines and priority', () => {
  const chosen = makeTask('chosen', { status: 'active', order: 2 })
  const second = makeTask('second', { status: 'active', order: 4, priority: 'high', committed: true })
  const urgent = makeTask('deadline', { dueDate: day(-1), priority: 'high' })
  const tasks = [urgent, second, chosen]
  const result = recommendNext(tasks, '')
  assert.equal(result?.task.id, 'chosen')
  assert.match(result?.reason ?? '', /active queue/)
  assert.deepEqual(result?.alternatives.map(task => task.id), ['second', 'deadline'])
  assert.deepEqual(tasks.map(task => task.id), ['deadline', 'second', 'chosen'])
})

test('inbox recommendations use saved deadlines, commitments, priority, then order', () => {
  const tasks = [
    makeTask('ordinary', { order: 0 }),
    makeTask('loud-message', { title: 'URGENT ASAP IMPORTANT!!!', order: 10 }),
    makeTask('priority', { priority: 'high', order: 20 }),
    makeTask('promised', { committed: true, order: 30 }),
    makeTask('tomorrow', { dueDate: day(1), order: 40 }),
    makeTask('yesterday', { dueDate: day(-1), order: 50 }),
  ]
  assert.equal(recommendNext(tasks, '')?.task.id, 'yesterday')
  assert.equal(recommendNext(tasks.filter(task => !task.dueDate), '')?.task.id, 'promised')
  assert.equal(recommendNext(tasks.filter(task => !task.dueDate && !task.committed), '')?.task.id, 'priority')
  assert.equal(recommendNext(tasks.filter(task => !task.dueDate && !task.committed && task.priority !== 'high'), '')?.task.id, 'ordinary')
})

test('waiting, completed, and intentionally deferred work are not recommended', () => {
  const excluded = ['waiting', 'done', 'later'].map(status => makeTask(status, { status: status as Task['status'], priority: 'high', dueDate: day(-2), committed: true }))
  assert.equal(recommendNext(excluded, ''), null)
  assert.equal(recommendNext([...excluded, makeTask('available')], '')?.task.id, 'available')
})

test('task creation preserves source wording and clones supplied arrays', () => {
  const input = { title: 'Перевод', body: 'брифинг доллжен менять под специфики клиента', relatedIds: ['other'], activity: [] }
  const task = createTask(input, 7)
  assert.equal(task.order, 7)
  assert.equal(task.body, input.body)
  task.relatedIds.push('third')
  assert.deepEqual(input.relatedIds, ['other'])
})

test('workspace imports reject malformed structures and unknown enum values with useful paths', () => {
  for (const value of [null, 'workspace', [], 4]) assert.throws(() => validateWorkspace(value), /Workspace: expected an object/)
  assert.throws(() => validateWorkspace({ ...emptyWorkspace(), version: 2 }), /version/)
  assert.throws(() => validateWorkspace({ ...emptyWorkspace(), tasks: 'not a list' }), /tasks/)
  for (const [field, value] of [['status', 'urgent'], ['priority', 'critical'], ['source', 'slack'], ['committed', 'yes'], ['title', null], ['order', -1], ['dueDate', '2025-02-29'], ['createdAt', '2025-02-30T12:00:00Z'], ['updatedAt', '2026-10-16T24:00:00Z']] as const) {
    const invalid = { ...makeTask('bad'), [field]: value }
    assert.throws(() => validateWorkspace({ ...emptyWorkspace(), tasks: [invalid] }), new RegExp(`tasks\\[0\\]\\.${field}`))
  }
})

test('workspace imports reject duplicate IDs, excessive text, and oversized task counts', () => {
  const task = makeTask('duplicate')
  assert.throws(() => validateWorkspace(workspace([task, task])), /duplicate IDs/)
  assert.throws(() => validateWorkspace({ ...emptyWorkspace(), focus: 'x'.repeat(2_001) }), /focus/)
  assert.throws(() => validateWorkspace({ ...emptyWorkspace(), tasks: Array(2_001).fill(task) }), /at most 2000/)
  const normalized = validateWorkspace({ ...workspace([task]), unexpected: '<script>', tasks: [{ ...task, unexpected: '<script>' }] })
  assert.equal('unexpected' in normalized, false)
  assert.equal('unexpected' in normalized.tasks[0], false)
})

test('workspace imports permit image data and reject active content, malformed attachments, and unsafe links', () => {
  const image = { id: 'image', name: 'capture.png', type: 'image/png', dataUrl: PNG }
  assert.equal(validateWorkspace(workspace([makeTask('safe', { attachments: [image] })])).tasks[0].attachments[0].name, 'capture.png')
  for (const badAttachment of [
    null,
    { ...image, type: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { ...image, dataUrl: 'https://example.com/capture.png' },
    { ...image, dataUrl: 'data:image/png;base64,not base64' },
    { ...image, dataUrl: 'data:image/png;base64,iVBORw==' },
    { ...image, dataUrl: 'data:image/jpeg;base64,iVBORw==' },
    { ...image, dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 100)}` },
  ]) {
    assert.throws(() => validateWorkspace({ ...emptyWorkspace(), tasks: [{ ...makeTask('bad'), attachments: [badAttachment] }] }), /attachments/)
  }
  for (const sourceUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a URL', 'https://user:password@example.com', 'https://example.com\n', 'tg://join?invite=example']) {
    assert.throws(() => validateWorkspace({ ...emptyWorkspace(), tasks: [{ ...makeTask('bad'), sourceUrl }] }), /sourceUrl/)
  }
  assert.equal(validateWorkspace(workspace([makeTask('telegram', { sourceUrl: 'tg://resolve?domain=example' })])).tasks.length, 1)
})

test('related context uses explicit links both ways and meaningful Russian words', () => {
  const task = makeTask('scenarios', { title: 'Проверить генерацию сценариев', relatedIds: ['explicit'] })
  const matches = relatedTasks(task, [
    task,
    makeTask('noise', { title: 'а я и в', body: 'а я и в' }),
    makeTask('generic', { title: 'Проверить и сделать' }),
    makeTask('related', { title: 'Ошибка генерации сценариев' }),
    makeTask('explicit', { title: 'Перевод' }),
    makeTask('reverse', { title: 'Ответ клиента', relatedIds: [task.id] }),
  ])
  assert.deepEqual(matches.map(match => match.id), ['explicit', 'reverse', 'related'])
})

test('handoffs preserve original wording, saved choices, blockers, links, and image names without embedding images', () => {
  const body = 'брифинг доллжен менять под специфики клиента\n```\noriginal code\n```'
  const task = makeTask('brief', {
    title: 'Брифинг', body, project: 'Client A', status: 'waiting', committed: true,
    waitingOn: 'Список требований', dueDate: '2027-01-10', followUpDate: '2027-01-08',
    source: 'telegram', sourceUrl: 'https://t.me/example/123',
    attachments: [{ id: 'image', name: 'client-request.png', type: 'image/png', dataUrl: PNG }],
    activity: [{ id: 'handoff', createdAt: '2026-10-16T12:00:00Z', text: 'ChatGPT handoff: changed the briefing prompt. Still need to check it with a real client example.' }],
  })
  const related = makeTask('related', { title: 'Перевод', body: 'Оригинал связанного сообщения', activity: [{ id: 'related-note', createdAt: '2026-10-16T12:30:00Z', text: 'Translation draft is ready for review.' }] })
  const handoff = createHandoff(task, [task, related, related])
  for (const text of [body, 'Client A', 'waiting', 'Explicit commitment: Yes', 'Список требований', '2027-01-10', '2027-01-08', 'https://t.me/example/123', 'client-request.png', related.body, task.activity[0].text, task.activity[0].createdAt, related.activity[0].text]) assert.ok(handoff.includes(text), text)
  assert.equal(handoff.includes('data:image'), false)
  assert.equal(handoff.split('## Related context:').length - 1, 1)
  assert.ok(handoff.includes('````text'))
  assert.match(handoff, /Progress and saved handoffs/)
  assert.match(handoff, /not been independently verified/)
  assert.equal(task.body, body)
})

test('handoffs include latest progress and disclose when older notes are omitted', () => {
  const task = makeTask('history', { activity: Array.from({ length: 14 }, (_, index) => ({ id: `event-${index}`, text: `Saved progress ${index}`, createdAt: '2026-10-16T12:00:00Z' })) })
  const handoff = createHandoff(task, [])
  assert.ok(handoff.includes('Saved progress 13'))
  assert.ok(handoff.includes('Saved progress 2'))
  assert.equal(handoff.includes('Saved progress 0\n'), false)
  assert.match(handoff, /most recent 12 of 14/)
  const longNote = makeTask('long-note', { activity: [{ id: 'long', text: 'x'.repeat(20_000), createdAt: '2026-10-16T12:00:00Z' }] })
  assert.equal(validateWorkspace(workspace([longNote])).tasks[0].activity[0].text.length, 20_000)
})

test('calendar dates use local day boundaries and reject impossible dates', () => {
  assert.equal(dateLabel(day(0)), 'Today')
  assert.equal(dateLabel(day(1)), 'Tomorrow')
  assert.equal(dateLabel(day(-1)), 'Yesterday')
  assert.equal(isOverdue(day(-1)), true)
  assert.equal(isOverdue(day(0)), false)
  assert.equal(isOverdue(day(1)), false)
  for (const invalid of ['', '2025-02-29', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-16T00:00:00Z']) {
    assert.equal(dateLabel(invalid), '')
    assert.equal(isOverdue(invalid), false)
  }
})
