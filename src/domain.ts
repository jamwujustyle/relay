import type { Activity, Attachment, Priority, Source, Status, Task, Workspace } from './types'

const MAX_TASKS = 2_000
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100
const STATUSES: Status[] = ['inbox', 'active', 'waiting', 'later', 'done']
const PRIORITIES: Priority[] = ['high', 'medium', 'low']
const SOURCES: Source[] = ['telegram', 'chatgpt', 'screenshot', 'note']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string, limit: number, required = false): string {
  if (typeof value !== 'string') fail(path, 'expected text')
  if (value.length > limit) fail(path, `must be at most ${limit.toLocaleString('en-US')} characters`)
  if (required && !value.trim()) fail(path, 'must not be empty')
  return value
}

function array(value: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected a list')
  if (value.length > limit) fail(path, `must contain at most ${limit} entries`)
  return value
}

function choice<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    fail(path, `expected one of ${choices.join(', ')}`)
  }
  return value as T
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected true or false')
  return value
}

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(2000, month - 1, day, 12)
  date.setFullYear(year)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function localDate(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

function checkedDate(value: unknown, path: string): string {
  const result = string(value, path, 10)
  if (result && !calendarDate(result)) fail(path, 'expected a real date in YYYY-MM-DD format, or empty text')
  return result
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path, 40, true)
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(result) || !calendarDate(result.slice(0, 10)) || !Number.isFinite(Date.parse(result))) {
    fail(path, 'expected an ISO date and time')
  }
  return result
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'contains duplicate IDs')
}

function checkedAttachment(value: unknown, path: string): Attachment {
  const entry = object(value, path)
  const type = choice(entry.type, IMAGE_TYPES, `${path}.type`)
  const dataUrl = string(entry.dataUrl, `${path}.dataUrl`, MAX_IMAGE_URL_LENGTH, true)
  const prefix = `data:${type};base64,`
  if (!dataUrl.startsWith(prefix)) fail(`${path}.dataUrl`, 'expected a PNG, JPEG, or WebP image matching its type')
  const payload = dataUrl.slice(prefix.length)
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    fail(`${path}.dataUrl`, 'expected a valid base64 image data URL')
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const bytes = payload.length / 4 * 3 - padding
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const trailingBits = alphabet.indexOf(payload[payload.length - padding - 1])
  if (bytes < 12 || bytes > MAX_IMAGE_BYTES || (padding === 2 && trailingBits % 16 !== 0) || (padding === 1 && trailingBits % 4 !== 0)) {
    fail(`${path}.dataUrl`, 'expected a valid image up to 5 MB')
  }
  const header = atob(payload.slice(0, 16))
  const signature = type === 'image/png'
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header.charCodeAt(index) === byte)
    : type === 'image/jpeg'
      ? header.charCodeAt(0) === 255 && header.charCodeAt(1) === 216 && header.charCodeAt(2) === 255
      : header.slice(0, 4) === 'RIFF' && header.slice(8, 12) === 'WEBP'
  if (!signature) fail(`${path}.dataUrl`, 'image content does not match its format')
  return {
    id: string(entry.id, `${path}.id`, 128, true),
    name: string(entry.name, `${path}.name`, 500, true),
    type,
    dataUrl,
  }
}

function checkedActivity(value: unknown, path: string): Activity {
  const entry = object(value, path)
  return {
    id: string(entry.id, `${path}.id`, 128, true),
    text: string(entry.text, `${path}.text`, 20_000, true),
    createdAt: timestamp(entry.createdAt, `${path}.createdAt`),
  }
}

function checkedTask(value: unknown, path: string): Task {
  const entry = object(value, path)
  const sourceUrl = string(entry.sourceUrl, `${path}.sourceUrl`, 2_048)
  if (sourceUrl) {
    let parsed: URL
    try { parsed = new URL(sourceUrl) } catch { fail(`${path}.sourceUrl`, 'expected a valid source URL') }
    if (!['https:', 'http:', 'tg:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(sourceUrl)) fail(`${path}.sourceUrl`, 'only web and Telegram links without credentials are supported')
    if (parsed.protocol === 'tg:' && !['resolve', 'privatepost', 'openmessage', 'user'].includes(parsed.hostname)) fail(`${path}.sourceUrl`, 'expected a Telegram conversation or message link')
  }
  if (typeof entry.order !== 'number' || !Number.isSafeInteger(entry.order) || entry.order < 0) {
    fail(`${path}.order`, 'expected a non-negative integer')
  }
  const attachments = array(entry.attachments, `${path}.attachments`, 6).map((attachment, index) => checkedAttachment(attachment, `${path}.attachments[${index}]`))
  const activity = array(entry.activity, `${path}.activity`, 500).map((event, index) => checkedActivity(event, `${path}.activity[${index}]`))
  const relatedIds = array(entry.relatedIds, `${path}.relatedIds`, 100).map((id, index) => string(id, `${path}.relatedIds[${index}]`, 128, true))
  unique(attachments.map(attachment => attachment.id), `${path}.attachments`)
  unique(activity.map(event => event.id), `${path}.activity`)
  unique(relatedIds, `${path}.relatedIds`)
  return {
    id: string(entry.id, `${path}.id`, 128, true),
    title: string(entry.title, `${path}.title`, 500, true),
    body: string(entry.body, `${path}.body`, 100_000),
    project: string(entry.project, `${path}.project`, 200),
    status: choice(entry.status, STATUSES, `${path}.status`),
    priority: choice(entry.priority, PRIORITIES, `${path}.priority`),
    source: choice(entry.source, SOURCES, `${path}.source`),
    sourceUrl,
    createdAt: timestamp(entry.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(entry.updatedAt, `${path}.updatedAt`),
    dueDate: checkedDate(entry.dueDate, `${path}.dueDate`),
    waitingOn: string(entry.waitingOn, `${path}.waitingOn`, 500),
    followUpDate: checkedDate(entry.followUpDate, `${path}.followUpDate`),
    committed: boolean(entry.committed, `${path}.committed`),
    order: entry.order,
    attachments,
    relatedIds,
    activity,
  }
}

export function createTask(input: Partial<Task> & { title: string }, existingCount = 0): Task {
  const now = new Date().toISOString()
  return checkedTask({
    id: input.id ?? globalThis.crypto.randomUUID(),
    title: input.title,
    body: input.body ?? '',
    project: input.project ?? '',
    status: input.status ?? 'inbox',
    priority: input.priority ?? 'medium',
    source: input.source ?? 'note',
    sourceUrl: input.sourceUrl ?? '',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    dueDate: input.dueDate ?? '',
    waitingOn: input.waitingOn ?? '',
    followUpDate: input.followUpDate ?? '',
    committed: input.committed ?? false,
    order: input.order ?? existingCount,
    attachments: input.attachments ?? [],
    relatedIds: input.relatedIds ?? [],
    activity: input.activity ?? [],
  }, 'Task')
}

export function emptyWorkspace(): Workspace {
  return { version: 1, tasks: [], focus: '', sample: false }
}

export function sampleWorkspace(): Workspace {
  const day = (offset: number) => {
    const date = new Date()
    date.setDate(date.getDate() + offset)
    return localDate(date)
  }
  const samples: Array<Partial<Task> & { title: string }> = [
    { id: 'demo-scenarios', title: 'Проверить генерацию сценариев', body: 'проверить генерацию сценариев', project: 'Демо · Генерация', status: 'active', source: 'telegram', committed: true, dueDate: day(1), relatedIds: ['demo-handoff'] },
    { id: 'demo-brief', title: 'Адаптировать брифинг под клиента', body: 'брифинг доллжен менять под специфики клиента', project: 'Демо · Клиенты', status: 'active', source: 'telegram', priority: 'high' },
    { id: 'demo-adsets', title: 'Адсеты', body: 'адсеты\nВот так будет запускаться на белую', project: 'Демо · Кампании', source: 'telegram' },
    { id: 'demo-pushes', title: 'Одноразовые пуши и фильтры по тегам', body: 'пуши эксклюзиные одноразовые\nпушить и на старые на свой риск рандомный тайминг предложение генерится перефразирование фильтры по тегам', project: 'Демо · Пуши', source: 'telegram', priority: 'high' },
    { id: 'demo-handoff', title: 'Продолжить работу со сценариями в ChatGPT', body: 'Демо передачи контекста: проверить генерацию сценариев, сохранить исходный запрос и продолжить обсуждение в ChatGPT.', project: 'Демо · Генерация', source: 'chatgpt', relatedIds: ['demo-scenarios'] },
    { id: 'demo-proof', title: 'Редактировать тип доказательства', body: 'редактировать тип доказательства', project: 'Демо · Клиенты', status: 'waiting', source: 'telegram', waitingOn: 'Демо: ждём список допустимых типов от клиента', followUpDate: day(0) },
    { id: 'demo-registrations', title: 'Сохранять регистрации', body: 'реги чтобы записывались', project: 'Демо · Кампании', status: 'waiting', source: 'telegram', waitingOn: 'Демо: ждём пример события регистрации', followUpDate: day(2) },
    { id: 'demo-translation', title: 'Перевод', body: 'перевод', project: 'Демо · Клиенты', status: 'later', source: 'telegram', priority: 'low' },
  ]
  return { version: 1, tasks: samples.map((task, index) => createTask(task, index)), focus: '', sample: true }
}

export function validateWorkspace(value: unknown): Workspace {
  const entry = object(value, 'Workspace')
  if (entry.version !== 1) fail('Workspace.version', 'only Relay workspace version 1 is supported')
  const result: Workspace = {
    version: 1,
    tasks: array(entry.tasks, 'Workspace.tasks', MAX_TASKS).map((task, index) => checkedTask(task, `Workspace.tasks[${index}]`)),
    focus: string(entry.focus, 'Workspace.focus', 2_000),
    sample: boolean(entry.sample, 'Workspace.sample'),
  }
  unique(result.tasks.map(task => task.id), 'Workspace.tasks')
  // Check the normalized schema, so unrelated properties cannot sneak into saved state.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_WORKSPACE_BYTES) {
    fail('Workspace', 'must be smaller than 32 MB')
  }
  return result
}

function byOrder(a: Task, b: Task): number {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

function inboxOrder(a: Task, b: Task): number {
  const aDue = calendarDate(a.dueDate) ? a.dueDate : ''
  const bDue = calendarDate(b.dueDate) ? b.dueDate : ''
  if (aDue !== bDue) {
    if (!aDue) return 1
    if (!bDue) return -1
    return aDue.localeCompare(bDue)
  }
  return Number(b.committed) - Number(a.committed) || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || byOrder(a, b)
}

export function recommendNext(tasks: Task[], focus: string): { task: Task; reason: string; alternatives: Task[] } | null {
  const active = tasks.filter(task => task.status === 'active').sort(byOrder)
  const inbox = tasks.filter(task => task.status === 'inbox').sort(inboxOrder)
  const queue = [...active, ...inbox]
  const task = queue[0]
  if (!task) return null
  const reasons = task.status === 'active' ? ['First in your active queue.'] : []
  if (task.dueDate && calendarDate(task.dueDate)) {
    reasons.push(isOverdue(task.dueDate) ? `Due ${dateLabel(task.dueDate)}; the date has passed.` : `Due ${dateLabel(task.dueDate).toLowerCase()}.`)
  }
  if (task.committed) reasons.push('You marked this as a commitment.')
  if (task.priority === 'high') reasons.push('You marked this high priority.')
  if (!reasons.length) reasons.push('Next by your saved inbox order.')
  if (focus.trim() && task.project.trim().toLocaleLowerCase() === focus.trim().toLocaleLowerCase()) {
    reasons.push(`Matches your focus: ${task.project}.`)
  }
  return { task, reason: reasons.join(' '), alternatives: queue.slice(1, 3) }
}

const STOP_WORDS = new Set('that this with from have will your about into then than them their just needs need task todo please сделать проверить нужно надо чтобы будет должен должна должны можно после перед когда также который которая какие таких этого этой these those some more work update create check demo демо'.split(' '))

function words(text: string): Set<string> {
  const tokens = text.toLocaleLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? []
  const result = new Set<string>()
  for (const token of tokens) {
    if (token.length < 3 || STOP_WORDS.has(token) || /^\d+$/.test(token)) continue
    let stem = token
    if (/[а-я]/.test(token) && token.length >= 5) {
      const stripped = token.replace(/(иями|ения|ению|ение|ений|ировать|овать|ями|ами|ого|его|ому|ему|ыми|ими|ить|ать|ять|иев|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ом|ем|ов|ев|ах|ях|ам|ям|а|я|ы|и|у|ю|е|о|ь|й)$/u, '')
      if (stripped.length >= 3) stem = stripped
    } else if (/^[a-z]+$/.test(token) && token.length >= 6) {
      stem = token.replace(/(ing|ed|es|s)$/, '')
    }
    result.add(stem)
  }
  return result
}

export function relatedTasks(task: Task, tasks: Task[]): Task[] {
  const keywords = words(`${task.title}\n${task.body}`)
  return tasks.filter(candidate => candidate.id !== task.id).map(candidate => {
    const explicit = task.relatedIds.includes(candidate.id) || candidate.relatedIds.includes(task.id)
    const shared = [...words(`${candidate.title}\n${candidate.body}`)].filter(word => keywords.has(word))
    const meaningful = shared.length >= 2 || shared.some(word => word.length >= 6)
    return { candidate, explicit, shared: shared.length, meaningful }
  }).filter(match => match.explicit || match.meaningful)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.shared - a.shared || byOrder(a.candidate, b.candidate))
    .map(match => match.candidate)
}

function capturedText(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}\n${fence}`
}

function taskDetails(task: Task): string[] {
  const lines = [
    `- Project: ${task.project || 'Not assigned'}`,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
    `- Explicit commitment: ${task.committed ? 'Yes' : 'No'}`,
    `- Source: ${task.source}`,
  ]
  if (task.sourceUrl) lines.push(`- Source URL: ${task.sourceUrl}`)
  if (task.dueDate) lines.push(`- Deadline: ${task.dueDate}`)
  if (task.waitingOn) lines.push(`- Waiting on: ${task.waitingOn}`)
  if (task.followUpDate) lines.push(`- Follow-up date: ${task.followUpDate}`)
  return lines
}

function progressNotes(task: Task, limit: number, nested = false): string[] {
  if (!task.activity.length) return []
  const notes = task.activity.slice(-limit)
  const heading = nested ? '###' : '##'
  const lines = ['', `${heading} Progress and saved handoffs`, '', 'Saved notes; outcomes have not been independently verified.']
  if (notes.length < task.activity.length) lines.push(`Showing the most recent ${notes.length} of ${task.activity.length} notes. Older notes remain in Relay.`)
  for (const note of notes) lines.push('', `${heading}# ${note.createdAt}`, '', capturedText(note.text))
  return lines
}

export function createHandoff(task: Task, related: Task[]): string {
  const lines = [
    `# ${task.title.replace(/[\r\n]+/g, ' ')}`,
    '',
    '## Saved task details',
    '',
    ...taskDetails(task),
    '',
    '## Original captured text',
    '',
    task.body ? capturedText(task.body) : 'No original text was saved.',
    ...progressNotes(task, 12),
  ]
  if (task.attachments.length) {
    lines.push('', '## Attached screenshots', '', 'The images are saved in Relay; this text brief includes their names only.', '', ...task.attachments.map(attachment => `- ${attachment.name} (${attachment.type})`))
  }
  const seen = new Set([task.id])
  for (const context of related) {
    if (seen.has(context.id)) continue
    seen.add(context.id)
    lines.push('', `## Related context: ${context.title.replace(/[\r\n]+/g, ' ')}`, '', ...taskDetails(context), '', context.body ? capturedText(context.body) : 'No original text was saved.', ...progressNotes(context, 3, true))
    if (context.attachments.length) lines.push('', 'Attachments (names only):', ...context.attachments.map(attachment => `- ${attachment.name} (${attachment.type})`))
  }
  return lines.join('\n')
}

export function dateLabel(date: string): string {
  const parsed = calendarDate(date)
  if (!parsed) return ''
  const today = new Date()
  if (date === localDate(today)) return 'Today'
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date === localDate(tomorrow)) return 'Tomorrow'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date === localDate(yesterday)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(parsed.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(parsed)
}

export function isOverdue(date: string): boolean {
  return calendarDate(date) !== null && date < localDate()
}
