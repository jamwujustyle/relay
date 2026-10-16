import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Bell, Check, CheckCheck, ChevronDown,
  ChevronRight, Circle, Clock3, Copy, Download, FileText, Flag, Folder,
  ImagePlus, Inbox, Layers3, Link2, ListFilter, LoaderCircle, Pause,
  Play, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Target, Trash2, Upload,
  WandSparkles, X, Zap,
} from 'lucide-react'
import { bridge, isDesktop } from './bridge'
import { createHandoff, createTask, dateLabel, emptyWorkspace, isOverdue, recommendNext, relatedTasks, sampleWorkspace, validateWorkspace } from './domain'
import type { AIResult, Attachment, Priority, Settings, Source, Status, Task, Workspace } from './types'

type View = 'overview' | Status
const statusNames: Record<Status, string> = { inbox: 'Inbox', active: 'Active', waiting: 'Waiting', later: 'Later', done: 'Done' }
const sourceNames: Record<Source, string> = { telegram: 'Telegram', chatgpt: 'ChatGPT', screenshot: 'Screenshot', note: 'Quick note' }
const priorityNames: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const navItems = [
  { id: 'overview' as View, label: 'Overview', icon: Layers3 },
  { id: 'inbox' as View, label: 'Inbox', icon: Inbox },
  { id: 'active' as View, label: 'Active', icon: Zap },
  { id: 'waiting' as View, label: 'Waiting', icon: Clock3 },
  { id: 'later' as View, label: 'Later', icon: Pause },
  { id: 'done' as View, label: 'Done', icon: CheckCheck },
]
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const uid = () => crypto.randomUUID()
const today = () => new Date().toLocaleDateString('en-CA')

function Logo({ small = false }: { small?: boolean }) {
  return <div className={`logo ${small ? 'small' : ''}`}><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8 7h9a6 6 0 1 1 0 12H8V7Z" stroke="currentColor" strokeWidth="3.2"/><path d="m14 14 10 11M8 14h9" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"/></svg></div>
}

function SourceIcon({ source }: { source: Source }) {
  const Icon = source === 'telegram' ? Send : source === 'chatgpt' ? Sparkles : source === 'screenshot' ? ImagePlus : FileText
  return <span className={`source-icon ${source}`} title={sourceNames[source]}><Icon size={13} /></span>
}

function Dialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('input:not([disabled]),textarea,button')?.focus(), 30)
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current() }
      if (event.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]') ?? [])].filter(el => el.offsetParent !== null)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => { clearTimeout(timer); document.removeEventListener('keydown', handler, true); previous?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="modal-heading"><div><span className="eyebrow">RELAY</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</div></div>
}

async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  return Promise.all(files.map(file => new Promise<Attachment>((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return reject(new Error('Choose a PNG, JPEG, or WebP screenshot.'))
    if (file.size > 5 * 1024 * 1024) return reject(new Error('Each screenshot must be smaller than 5 MB.'))
    const reader = new FileReader()
    reader.onload = () => resolve({ id: uid(), name: file.name || 'Screenshot.png', dataUrl: String(reader.result), type: file.type })
    reader.onerror = () => reject(new Error('This screenshot could not be read.'))
    reader.readAsDataURL(file)
  })))
}

function CaptureDialog({ initial, projects, onClose, onSave }: {
  initial: { text: string; image?: string }; projects: string[]; onClose: () => void; onSave: (task: Task) => void
}) {
  const [body, setBody] = useState(initial.text)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [source, setSource] = useState<Source>(initial.image ? 'screenshot' : 'note')
  const [priority, setPriority] = useState<Priority>('medium')
  const [sourceUrl, setSourceUrl] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>(initial.image ? [{ id: uid(), name: 'Clipboard screenshot.png', dataUrl: initial.image, type: 'image/png' }] : [])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const addFiles = async (files: File[]) => {
    try {
      if (attachments.length + files.length > 3) throw new Error('You can attach up to 3 screenshots per capture.')
      const added = await filesToAttachments(files)
      setAttachments(current => [...current, ...added]); setError('')
    } catch (err) { setError(errorText(err)) }
  }
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!body.trim() && !title.trim() && attachments.length === 0) { setError('Add a note or screenshot to capture.'); return }
    if (sourceUrl && !/^(https?:\/\/|tg:\/\/)/i.test(sourceUrl)) { setError('Use a full https, http, or Telegram source link.'); return }
    const inferredTitle = body.split('\n').find(line => line.trim())?.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').trim().slice(0, 160)
    try {
      onSave(createTask({ title: title.trim() || inferredTitle || 'Screenshot to review', body: body.trim(), project: project.trim(), source, priority, sourceUrl: sourceUrl.trim(), attachments }))
    } catch (err) { setError(errorText(err)) }
  }
  return <Dialog title="Catch it before it slips away." onClose={onClose} className="capture-modal"><form onSubmit={submit} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit() } }}>
    <div className="capture-sources">{(Object.keys(sourceNames) as Source[]).map(s => <button key={s} type="button" className={source === s ? 'chosen' : ''} onClick={() => setSource(s)}><SourceIcon source={s} />{sourceNames[s]}</button>)}</div>
    <input className="capture-title" aria-label="Capture title" placeholder="A name for this, if you have one…" value={title} onChange={e => setTitle(e.target.value)} maxLength={300} />
    <textarea className="capture-body" aria-label="Original request" placeholder="Paste a request, drop a thought, or save a handoff. Your shorthand is welcome." value={body} onChange={e => setBody(e.target.value)} maxLength={50000} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files) } }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles([...event.dataTransfer.files]) }} />
    {attachments.length > 0 && <div className="capture-attachments">{attachments.map(a => <div key={a.id}><img src={a.dataUrl} alt={a.name} /><button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(current => current.filter(x => x.id !== a.id))}><X size={12} /></button></div>)}</div>}
    <div className="capture-tools"><button type="button" className="text-button" onClick={() => inputRef.current?.click()}><ImagePlus size={15} />Attach screenshot</button><span>or paste / drop an image</span><input type="file" ref={inputRef} accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addFiles([...(event.target.files ?? [])]); event.target.value = '' }} /></div>
    <div className="form-grid"><label>Project<input list="project-options" placeholder="Optional" value={project} onChange={e => setProject(e.target.value)} maxLength={120} /><datalist id="project-options">{projects.map(p => <option key={p} value={p} />)}</datalist></label><label>Priority<select aria-label="Priority" value={priority} onChange={e => setPriority(e.target.value as Priority)}>{Object.entries(priorityNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
    <label className="field-label">Source link <span>optional</span><input placeholder="Link back to the conversation" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} maxLength={2000} /></label>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer"><span><ShieldCheck size={14} />Saved on this device</span><button className="primary-button" type="submit">Save to inbox<ArrowRight size={16} /></button></div>
  </form></Dialog>
}

function SettingsDialog({ settings, onClose, onSave, onExport, onImport }: { settings: Settings | null; onClose: () => void; onSave: (settings: Settings) => void; onExport: () => void; onImport: () => void }) {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model ?? 'gemini-3.1-flash-lite')
  const [dailyLimit, setDailyLimit] = useState(settings?.dailyLimit ?? 30)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const save = async (removeKey = false) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await bridge.saveSettings({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), model: model.trim(), dailyLimit, removeKey })
      onSave(result); setApiKey(''); setMessage(removeKey ? 'API key removed.' : result.keyStorage === 'session' ? 'Saved for this session. Your system keyring is unavailable.' : 'Settings saved. AI runs only when you ask.')
    } catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  return <Dialog title="Make Relay yours." onClose={onClose} className="settings-modal">
    <div className="settings-section-title"><div className="soft-icon"><Sparkles size={18} /></div><div><h3>Your key. Your choice.</h3><p>Connect Gemini for suggestions when you need them.</p></div><span className={`connection-badge ${settings?.hasApiKey ? 'connected' : ''}`}>{settings?.hasApiKey ? 'Connected' : 'Optional'}</span></div>
    {!isDesktop && <div className="info-box">You’re in the browser preview. API keys and system shortcuts are available in the desktop app.</div>}
    <form onSubmit={event => { event.preventDefault(); void save() }}><label className="field-label">Gemini API key<input type="password" autoComplete="off" placeholder={settings?.hasApiKey ? 'Key connected · enter a new key to replace' : 'Paste your API key'} value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={!isDesktop} /></label>
      <div className="field-note"><ShieldCheck size={13} />{settings?.secureStorage ? 'Protected by your operating system’s key store.' : 'Without a system keyring, your key stays in memory for this session.'}</div>
      <div className="form-grid"><label>Model<input value={model} onChange={e => setModel(e.target.value)} maxLength={100} disabled={!isDesktop} /></label><label>Daily request limit<input type="number" min={1} max={500} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))} disabled={!isDesktop} /></label></div>
      <p className="settings-help">Each AI action sends the relevant task text, context, and attached screenshots to Google. Your key is billed by your provider. The daily limit caps requests, not dollars.</p>
      <div className="usage-line"><span>{settings?.callsToday ?? 0} / {settings?.dailyLimit ?? 30} requests today</span><button type="button" className="text-button" onClick={() => void bridge.openExternal('https://aistudio.google.com/apikey')}>Get an API key<ArrowUpRight size={13} /></button></div>
      {isDesktop && <div className="usage-estimate"><div><span>Estimated API usage today</span><strong>{settings?.estimatedCostToday === null ? 'Rate unavailable' : `$${(settings?.estimatedCostToday ?? 0).toFixed(4)}`}</strong></div><p>Based on reported tokens. Failed calls may not return usage. Your provider’s bill is authoritative.</p></div>}
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="success-text" role="status">{message}</p>}
      <div className="settings-save">{settings?.hasApiKey && <button type="button" className="text-button danger" onClick={() => void save(true)} disabled={busy}>Remove key</button>}<button className="primary-button" disabled={!isDesktop || busy} type="submit">{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save settings</button></div>
    </form>
    <div className="settings-divider" /><h3>Always close at hand</h3><div className="shortcut-row"><span>Capture from anywhere</span><kbd>Ctrl Shift Space</kbd></div><div className="shortcut-row"><span>Choose your next move</span><kbd>Ctrl Shift Enter</kbd></div>
    {isDesktop && settings?.shortcuts && (!settings.shortcuts.capture || !settings.shortcuts.next) && <p className="settings-help">A system shortcut couldn’t be registered. Use the tray menu or Relay’s buttons. Shortcut availability depends on your desktop environment.</p>}
    <div className="settings-divider" /><h3>Your workspace</h3><p className="settings-help">Keep a backup or move your requests to another computer. Your API key is never included.</p><div className="backup-actions"><button className="secondary-button" onClick={onExport}><Download size={15} />Export backup</button><button className="secondary-button" onClick={onImport}><Upload size={15} />Import backup</button></div>
  </Dialog>
}

function TaskRow({ task, selected, onSelect, onComplete, onMove, canUp, canDown }: { task: Task; selected: boolean; onSelect: () => void; onComplete: () => void; onMove: (direction: -1 | 1) => void; canUp: boolean; canDown: boolean }) {
  return <div className={`task-row ${selected ? 'selected' : ''} ${task.status === 'done' ? 'completed' : ''}`}>
    <button className="complete-button" onClick={onComplete} aria-label={task.status === 'done' ? `Reopen ${task.title}` : `Complete ${task.title}`}>{task.status === 'done' ? <Check size={14} /> : <span />}</button>
    <button className="task-main" onClick={onSelect}><span className="task-title">{task.title}{task.attachments.length > 0 && <ImagePlus size={13} />}</span><span className="task-meta"><SourceIcon source={task.source} /><span>{sourceNames[task.source]}</span>{task.project && <><i /> <span>{task.project}</span></>}{task.committed && <span className="commitment-tag">Promised</span>}</span></button>
    <div className="task-trailing">{task.dueDate && <span className={`due-label ${isOverdue(task.dueDate) ? 'overdue' : ''}`}><Clock3 size={12} />{dateLabel(task.dueDate)}</span>}<span className={`priority priority-${task.priority}`}><span />{priorityNames[task.priority]}</span><div className="reorder-buttons"><button className="icon-button" title="Move up" aria-label={`Move ${task.title} up`} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp size={13} /></button><button className="icon-button" title="Move down" aria-label={`Move ${task.title} down`} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown size={13} /></button></div><button className="icon-button row-open" aria-label={`Open ${task.title}`} onClick={onSelect}><ChevronRight size={16} /></button></div>
  </div>
}

function DetailPanel({ task, tasks, onClose, onUpdate, onDelete, onSelect, onCopy, onAI, aiBusy, aiResult, onApplyAI, onDismissAI }: { task: Task; tasks: Task[]; onClose: () => void; onUpdate: (patch: Partial<Task>, activity?: string) => boolean; onDelete: () => void; onSelect: (id: string) => void; onCopy: () => void; onAI: () => void; aiBusy: boolean; aiResult: AIResult | null; onApplyAI: () => void; onDismissAI: () => void }) {
  const [note, setNote] = useState('')
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  const related = relatedTasks(task, tasks)
  const submitNote = () => { if (note.trim() && onUpdate({}, note.trim())) setNote('') }
  return <aside className="detail-panel" aria-label="Request details"><div className="detail-header"><span><SourceIcon source={task.source} />{sourceNames[task.source]}</span><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={17} /></button></div>
    <div className="detail-scroll"><textarea rows={2} className="detail-title" aria-label="Task title" key={`${task.id}-title-${task.title}`} defaultValue={task.title} maxLength={300} onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== task.title) onUpdate({ title: e.target.value.trim() }); else e.target.value = task.title }} />
      <div className="detail-actions"><button className="primary-button" onClick={() => onUpdate({ status: task.status === 'done' ? 'inbox' : 'done' }, task.status === 'done' ? 'Reopened' : 'Completed')}><Check size={15} />{task.status === 'done' ? 'Reopen' : 'Mark done'}</button><button className="secondary-button" onClick={onCopy} title="Copy context for your next ChatGPT conversation"><Copy size={14} />Handoff</button></div>
      <div className="properties"><label><span><Circle size={14} />Status</span><select aria-label="Status" value={task.status} onChange={e => onUpdate({ status: e.target.value as Status }, `Moved to ${statusNames[e.target.value as Status]}`)}>{Object.entries(statusNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label><span><Flag size={14} />Priority</span><select aria-label="Priority" value={task.priority} onChange={e => onUpdate({ priority: e.target.value as Priority })}>{Object.entries(priorityNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label><span><Folder size={14} />Project</span><input key={`${task.id}-project-${task.project}`} defaultValue={task.project} placeholder="Add project" maxLength={120} onBlur={e => { if (e.target.value.trim() !== task.project) onUpdate({ project: e.target.value.trim() }) }} /></label><label><span><Clock3 size={14} />Deadline</span><input type="date" value={task.dueDate} onChange={e => onUpdate({ dueDate: e.target.value })} /></label><label className="commitment-control"><span><ShieldCheck size={14} />I promised this</span><input type="checkbox" checked={task.committed} onChange={e => onUpdate({ committed: e.target.checked })} /></label></div>
      {task.status === 'waiting' && <div className="waiting-fields"><label className="field-label">Waiting for<input key={`${task.id}-waiting`} defaultValue={task.waitingOn} placeholder="A person, answer, or dependency" onBlur={e => onUpdate({ waitingOn: e.target.value.trim() })} maxLength={500} /></label><label className="field-label">Follow up on<input type="date" value={task.followUpDate} onChange={e => onUpdate({ followUpDate: e.target.value })} /></label></div>}
      <div className="detail-section-heading"><h3>Original context</h3>{task.sourceUrl && <button className="text-button" onClick={() => void bridge.openExternal(task.sourceUrl).catch(() => {})}>Open source<ArrowUpRight size={13} /></button>}</div><div className="original-context">{task.body || 'Captured as a screenshot.'}</div>
      {task.attachments.length > 0 && <div className="detail-attachments">{task.attachments.map(a => <button key={a.id} onClick={() => setLightbox(a)}><img src={a.dataUrl} alt={a.name} /><span>{a.name}</span></button>)}</div>}
      <button className="ai-organize-button" onClick={onAI} disabled={aiBusy}>{aiBusy ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />} {aiBusy ? 'Reading the context…' : 'Ask AI to organize'}<span>Optional</span></button>
      {aiResult && <div className="ai-suggestion"><div className="detail-section-heading"><h3><Sparkles size={14} /> Suggested changes</h3><button className="icon-button" onClick={onDismissAI} aria-label="Dismiss AI suggestion"><X size={14} /></button></div>{aiResult.title && <strong>{aiResult.title}</strong>}{aiResult.project && <p>Project: {aiResult.project}</p>}{aiResult.summary && <p>{aiResult.summary}</p>}{!!aiResult.relatedIds?.length && <p>{aiResult.relatedIds.length} related request(s) found</p>}<button className="secondary-button" onClick={onApplyAI}><Check size={14} />Apply suggestion</button><small>Your original context stays attached.</small></div>}
      {related.length > 0 && <><div className="detail-section-heading"><h3>Related requests</h3><Link2 size={13} /></div><div className="related-list">{related.slice(0, 4).map(item => <div key={item.id}><button onClick={() => onSelect(item.id)}><span>{item.title}</span><ArrowUpRight size={13} /></button><button className={`link-toggle ${task.relatedIds.includes(item.id) ? 'linked' : ''}`} aria-label={`${task.relatedIds.includes(item.id) ? 'Unlink' : 'Link'} ${item.title}`} onClick={() => onUpdate({ relatedIds: task.relatedIds.includes(item.id) ? task.relatedIds.filter(id => id !== item.id) : [...task.relatedIds, item.id] })}>{task.relatedIds.includes(item.id) ? <Check size={13} /> : <Plus size={13} />}</button></div>)}</div></>}
      <div className="detail-section-heading"><h3>Progress & handoffs</h3><span>{task.activity.length}</span></div><div className="note-composer"><textarea placeholder="Add a note or paste your latest handoff…" aria-label="Progress note" value={note} onChange={e => setNote(e.target.value)} maxLength={20000} /><button className="icon-button" aria-label="Save progress note" disabled={!note.trim()} onClick={submitNote}><ArrowUp size={16} /></button></div><div className="activity-list">{[...task.activity].reverse().map(entry => <div key={entry.id}><span className="activity-dot" /><div><p>{entry.text}</p><time>{new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></div></div>)}</div>
      <div className="detail-bottom"><span>Captured {new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><button className="icon-button danger" aria-label="Delete request" onClick={onDelete}><Trash2 size={15} /></button></div>
    </div>{lightbox && <Dialog title={lightbox.name} onClose={() => setLightbox(null)} className="image-modal"><img src={lightbox.dataUrl} alt={lightbox.name} /></Dialog>}
  </aside>
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')
  const [view, setView] = useState<View>('overview')
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ text: string; image?: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [nextOpen, setNextOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void } | null>(null)
  const [handoff, setHandoff] = useState('')
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  const [aiSuggestion, setAiSuggestion] = useState<{ id: string; result: AIResult } | null>(null)
  const [nextSuggestion, setNextSuggestion] = useState<AIResult | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const initialized = useRef(false)
  const revision = useRef(0)
  const notify = useCallback((message: string) => setToast(message), [])

  useEffect(() => {
    let alive = true
    bridge.loadWorkspace().then(data => { if (alive) { setWorkspace(data ? validateWorkspace(data) : emptyWorkspace()); initialized.current = true } }).catch(error => { if (alive) setLoadError(errorText(error)) })
    bridge.getSettings().then(data => { if (alive) setSettings(data) }).catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!initialized.current || !workspace) return
    const id = ++revision.current
    setSaveState('saving')
    // Dispatch each committed change immediately; the desktop process serializes disk writes.
    void bridge.saveWorkspace(workspace).then(() => { if (id === revision.current) { setSaveState('saved'); setSaveError('') } }).catch(error => { if (id === revision.current) { setSaveState('error'); setSaveError(errorText(error)) } })
  }, [workspace])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer) }, [toast])

  const openCapture = useCallback(async (clipboard = false) => {
    if (capture) return
    setNextOpen(false); setSettingsOpen(false); setConfirm(null); setHandoff('')
    if (clipboard) {
      try { setCapture(await bridge.readClipboard()) }
      catch { setCapture({ text: '' }); notify('Paste your request into the capture window.') }
    } else setCapture({ text: '' })
  }, [notify, capture])
  useEffect(() => bridge.onAction(action => { if (action === 'capture') void openCapture(true); else if (!capture) { setSettingsOpen(false); setNextOpen(true) } }), [openCapture, capture])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus() }
      if (!isDesktop && event.ctrlKey && event.shiftKey && event.code === 'Space') { event.preventDefault(); void openCapture(true) }
      if (!isDesktop && event.ctrlKey && event.shiftKey && event.key === 'Enter') { event.preventDefault(); setNextOpen(true) }
      if (!editing && !capture && !settingsOpen && !nextOpen && !confirm && !handoff) {
        if (event.key === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void openCapture() }
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); searchRef.current?.focus() }
        if (event.key === 'Escape') setSelectedId(null)
      }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [openCapture, capture, settingsOpen, nextOpen, confirm, handoff])

  const tasks = workspace?.tasks ?? []
  const projects = [...new Set(tasks.map(task => task.project).filter(Boolean))].sort()
  const selected = tasks.find(task => task.id === selectedId)
  const recommendation = useMemo(() => recommendNext(tasks, workspace?.focus ?? ''), [tasks, workspace?.focus])
  const updateTask = (id: string, patch: Partial<Task>, activity?: string) => {
    if (activity && (tasks.find(task => task.id === id)?.activity.length ?? 0) >= 500) {
      if (Object.keys(patch).length === 0) { notify('This request has reached its history limit. Your note is still here; export a backup before starting a new request.'); return false }
      activity = undefined
    }
    setWorkspace(current => current && { ...current, tasks: current.tasks.map(task => task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString(), activity: activity ? [...task.activity, { id: uid(), text: activity, createdAt: new Date().toISOString() }] : task.activity } : task) })
    return true
  }
  const startTask = (task: Task) => {
    const activeIds = tasks.filter(t => t.status === 'active' && t.id !== task.id).sort((a, b) => a.order - b.order).map(t => t.id)
    const order = new Map([task.id, ...activeIds].map((id, i) => [id, i]))
    setWorkspace(current => current && { ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, status: 'active', order: 0, updatedAt: new Date().toISOString(), activity: item.activity.length < 500 ? [...item.activity, { id: uid(), text: item.status === 'active' ? 'Resumed work' : 'Started working on this', createdAt: new Date().toISOString() }] : item.activity } : order.has(item.id) ? { ...item, order: order.get(item.id)! } : item) })
    setSelectedId(task.id); setView('overview'); setNextOpen(false); setNextSuggestion(null); notify('Your next move is set. You’ve got this.')
  }
  const completeTask = (task: Task) => { updateTask(task.id, { status: task.status === 'done' ? 'inbox' : 'done' }, task.status === 'done' ? 'Reopened' : 'Completed'); notify(task.status === 'done' ? 'Moved back to your inbox.' : 'One less thing on your mind.'); setNextSuggestion(null) }
  const changeView = (id: View) => { setView(id); setProjectFilter(''); setSelectedId(null); setQuery(''); setPriorityFilter(false) }
  const saveCapture = (task: Task) => {
    task.order = Math.max(0, ...tasks.map(t => t.order)) + 1
    validateWorkspace({ ...workspace!, tasks: [...tasks, task] })
    setWorkspace(current => current && { ...current, tasks: [...current.tasks, task] }); setCapture(null); setSelectedId(task.id); setView('inbox'); setQuery(''); setProjectFilter(''); setPriorityFilter(false); notify('Captured. It’s safe in your inbox.')
  }
  const moveTask = (task: Task, direction: -1 | 1) => {
    const ordered = tasks.filter(t => t.status === task.status).sort((a, b) => a.order - b.order)
    const index = ordered.findIndex(t => t.id === task.id), other = ordered[index + direction]
    if (!other) return
    ;[ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]]
    const orders = new Map(ordered.map((t, i) => [t.id, i]))
    setWorkspace(current => current && { ...current, tasks: current.tasks.map(t => orders.has(t.id) ? { ...t, order: orders.get(t.id)! } : t) })
  }
  const copyHandoff = async (task: Task) => {
    const content = createHandoff(task, tasks.filter(t => task.relatedIds.includes(t.id) || t.relatedIds.includes(task.id)))
    try { await bridge.writeClipboard(content); notify('Handoff copied. Ready for your next conversation.') }
    catch { setHandoff(content) }
  }
  const runAI = async (mode: 'capture' | 'next', taskId?: string) => {
    if (!settings?.hasApiKey) { setNextOpen(false); setSettingsOpen(true); return }
    setAiBusy(taskId ?? 'next')
    try {
      const result = await bridge.runAI({ mode, taskId, focus: workspace?.focus ?? '', tasks: mode === 'next' ? tasks.filter(t => ['active', 'inbox'].includes(t.status)) : tasks })
      if (mode === 'capture' && taskId) setAiSuggestion({ id: taskId, result }); else setNextSuggestion(result)
      setSettings(await bridge.getSettings())
    } catch (error) { notify(errorText(error)); void bridge.getSettings().then(setSettings).catch(() => {}) }
    finally { setAiBusy(null) }
  }
  const exportWorkspace = () => {
    if (!workspace) return
    const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `relay-backup-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); notify('Your backup is ready.')
  }
  const importWorkspace = async (file: File) => {
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('Choose a Relay backup smaller than 32 MB.')
      const data = validateWorkspace(JSON.parse(await file.text()))
      setSettingsOpen(false); setConfirm({ title: 'Restore this workspace?', text: `This replaces your current workspace with ${data.tasks.length} requests from the backup. Export your current workspace first if you want to keep it.`, action: () => { setWorkspace(data); setSelectedId(null); setView('overview'); setQuery(''); setProjectFilter(''); setPriorityFilter(false); setConfirm(null); notify('Workspace restored.') } })
    } catch (error) { notify(`Couldn’t import backup: ${errorText(error)}`) }
  }

  const filtered = tasks.filter(task => {
    if (projectFilter && task.project !== projectFilter) return false
    if (priorityFilter && task.priority !== 'high') return false
    if (query.trim()) return [task.title, task.body, task.project, task.waitingOn, ...task.activity.map(a => a.text)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    if (view === 'overview') return projectFilter ? task.status !== 'done' : ['active', 'inbox'].includes(task.status)
    return task.status === view
  }).sort((a, b) => a.order - b.order)
  const waiting = tasks.filter(task => task.status === 'waiting').sort((a, b) => (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999'))
  const doneToday = tasks.filter(t => { const completed = [...t.activity].reverse().find(a => a.text === 'Completed'); return t.status === 'done' && completed && new Date(completed.createdAt).toLocaleDateString('en-CA') === today() }).length
  const hasFilters = Boolean(query || projectFilter || priorityFilter)
  const title = query ? 'Search your workspace' : projectFilter || (view === 'overview' ? 'Your next move.' : statusNames[view])
  const descriptions: Record<View, string> = { overview: 'A little clarity. A little less on your mind.', inbox: 'Everything that landed. Decide what deserves your attention.', active: 'Your chosen work, in the order that works for you.', waiting: 'Keep the thread, even when the next move isn’t yours.', later: 'Good ideas and future work, safely out of the way.', done: 'Look at all that space you’ve made.' }

  if (loadError) return <div className="load-screen"><Logo /><h1>Your workspace needs attention.</h1><p>Relay couldn’t read your saved data. It has been kept intact.</p><pre>{loadError}</pre><button className="secondary-button" onClick={() => location.reload()}>Try again</button></div>
  if (!workspace) return <div className="load-screen"><Logo /><LoaderCircle size={22} className="spin" /><p>Finding your place…</p></div>

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><Logo /><span>relay<span className="brand-period">.</span></span><span className="version-badge">BETA</span></div><button className="workspace-switch" onClick={() => changeView('overview')}><span className="workspace-avatar">Z</span><span>Personal workspace<small>Room for your next move</small></span><ChevronDown size={13} /></button>
      <div className="nav-label">WORKSPACE</div><nav aria-label="Workspace">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id && !projectFilter ? 'active' : ''}`} onClick={() => changeView(id)}><Icon size={17} /><span>{label}</span>{id !== 'overview' && <span className="nav-count">{tasks.filter(t => t.status === id).length || ''}</span>}{id === 'overview' && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="nav-label projects-label">PROJECTS<span>{projects.length}</span></div><div className="project-nav">{projects.length ? projects.map((project, i) => <button key={project} className={projectFilter === project ? 'selected-project' : ''} onClick={() => { setProjectFilter(project); setQuery(''); setView('overview'); setSelectedId(null) }}><span className={`project-dot dot-${i % 4}`} />{project}<span>{tasks.filter(t => t.project === project && t.status !== 'done').length}</span></button>) : <p>Your projects appear here<br />as you capture work.</p>}</div>
      <div className="sidebar-bottom"><div className="local-card"><span className="local-indicator" /><div>{saveState === 'error' ? 'Couldn’t save changes' : saveState === 'saving' ? 'Saving your changes…' : 'Everything in its place'}<small>{isDesktop ? 'Stored on your device' : 'Stored in this browser'}</small></div><ShieldCheck size={15} /></div><button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />Settings<span><ChevronRight size={13} /></span></button><div className="sidebar-foot"><span>Small steps. Clear head.</span><span>v0.1</span></div></div>
    </aside>

    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{projectFilter || (view === 'overview' ? 'Overview' : statusNames[view])}</strong></div><div className="topbar-actions"><div className="search-box"><Search size={15} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Find anything…" aria-label="Search requests" /><kbd>Ctrl K</kbd>{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div><button className="primary-button capture-button" onClick={() => void openCapture()}><Plus size={16} />Capture<span>N</span></button></div></header>
      {workspace.sample && <div className="sample-banner"><span><Sparkles size={13} />You’re exploring a sample workspace. All priorities and deadlines here are examples.</span><button onClick={() => setConfirm({ title: 'Make room for your work?', text: 'This clears the sample workspace, including any changes you made to it. Export it from Settings first if you want to keep it.', action: () => { setWorkspace(emptyWorkspace()); setSelectedId(null); setConfirm(null); setView('overview'); setProjectFilter(''); setQuery('') } })}>Start fresh<ArrowRight size={13} /></button></div>}
      {saveState === 'error' && <div className="save-error" role="alert">{saveError}<button onClick={exportWorkspace}>Export unsaved changes</button></div>}
      <div className={`content-layout ${selected ? 'has-details' : ''}`}><main className="main-content"><div className="page-heading"><div><div className="date-eyebrow">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</div><h1>{title}</h1><p>{query ? `${filtered.length} matching request${filtered.length === 1 ? '' : 's'}. All your context, in one place.` : descriptions[view]}</p></div><div className="heading-decoration" aria-hidden="true"><span /><span /><span /><Sparkles size={20} /></div></div>
        {tasks.length > 0 && view === 'overview' && !hasFilters && <><div className="overview-stats"><span><span className="stat-dot purple" /><strong>{tasks.filter(t => t.status === 'active').length}</strong> in motion</span><span><span className="stat-dot amber" /><strong>{waiting.length}</strong> waiting</span><span><Check size={13} /><strong>{doneToday}</strong> done today</span></div>{recommendation && <section className="next-card"><div className="next-card-content"><div className="next-eyebrow"><span><Zap size={13} fill="currentColor" />{recommendation.task.status === 'active' ? 'PICK UP WHERE YOU LEFT OFF' : 'A GOOD PLACE TO START'}</span><span className="stable-label">Your queue, your call</span></div><h2>{recommendation.task.title}</h2><p>{recommendation.reason}</p><div className="next-card-bottom"><span><span className="project-dot dot-0" />{recommendation.task.project || sourceNames[recommendation.task.source]}{recommendation.task.dueDate && <><i />{dateLabel(recommendation.task.dueDate)}</>}</span><div><button className="next-alternative" onClick={() => setNextOpen(true)}>Choose another</button><button className="dark-button" onClick={() => startTask(recommendation.task)}><Play size={13} fill="currentColor" />{recommendation.task.status === 'active' ? 'Continue' : 'Start here'}<ArrowRight size={15} /></button></div></div></div><div className="next-card-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><div className="orbit-center"><ArrowUpRight size={29} /></div><span className="orbit-spark">✦</span></div></section>}</>}
        {tasks.length === 0 ? <div className="welcome-card"><div className="welcome-art" aria-hidden="true"><div className="paper-note note-back"><Send size={18} /><span /><span /></div><div className="paper-note note-front"><Check size={18} /><span /><span /></div><div className="welcome-spark">✦</div></div><span className="eyebrow">A CLEARER PLACE TO BEGIN</span><h2>Get it out of your head.<br />Find your next move.</h2><p>Catch requests, screenshots, and handoffs.<br />Keep the context. Choose what matters next.</p><button className="primary-button" onClick={() => void openCapture()}><Plus size={16} />Capture your first request</button><button className="text-button sample-button" onClick={() => setWorkspace(sampleWorkspace())}>Explore a sample workspace<ArrowRight size={14} /></button><div className="welcome-hint"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd><span>to catch a thought from anywhere</span></div></div> : <section className="queue-section"><div className="section-toolbar"><div><h2>{query ? 'Search results' : projectFilter ? 'Project requests' : view === 'overview' ? 'Your working queue' : `${statusNames[view]} requests`}</h2><span>{filtered.length}</span></div><button className={`filter-button ${priorityFilter ? 'is-active' : ''}`} onClick={() => setPriorityFilter(current => !current)}><ListFilter size={14} />{priorityFilter ? 'High priority' : 'Filter'}{priorityFilter && <X size={12} />}</button></div>
          {view === 'overview' && !hasFilters ? <>{(['active', 'inbox'] as Status[]).map(status => { const group = filtered.filter(t => t.status === status); return group.length > 0 && <div className="task-group" key={status}><div className="group-label"><span className={`group-dot ${status}`} />{status === 'active' ? 'IN MOTION' : 'READY TO SORT'}<span>{group.length}</span></div>{group.map((task, i) => <TaskRow key={task.id} task={task} selected={selectedId === task.id} onSelect={() => setSelectedId(task.id)} onComplete={() => completeTask(task)} onMove={direction => moveTask(task, direction)} canUp={i > 0} canDown={i < group.length - 1} />)}</div> })}</> : filtered.map(task => { const order = tasks.filter(t => t.status === task.status).sort((a, b) => a.order - b.order); const i = order.findIndex(t => t.id === task.id); return <TaskRow key={task.id} task={task} selected={selectedId === task.id} onSelect={() => setSelectedId(task.id)} onComplete={() => completeTask(task)} onMove={direction => moveTask(task, direction)} canUp={i > 0} canDown={i < order.length - 1} /> })}
          {filtered.length === 0 && <div className="empty-list"><div className="soft-icon">{view === 'done' ? <CheckCheck size={24} /> : view === 'waiting' ? <Clock3 size={24} /> : <Inbox size={24} />}</div><h3>{hasFilters ? 'Nothing matches just yet.' : view === 'inbox' ? 'A little breathing room.' : view === 'done' ? 'Small wins will collect here.' : 'Nothing here right now.'}</h3><p>{hasFilters ? 'Try another search or clear your filters.' : view === 'waiting' ? 'Move a request to Waiting when someone else has the next move.' : 'Capture a request or move one here when you’re ready.'}</p>{hasFilters && <button className="text-button" onClick={() => { setQuery(''); setProjectFilter(''); setPriorityFilter(false) }}>Clear filters</button>}</div>}
          <button className="add-request-row" onClick={() => void openCapture()}><Plus size={16} />Capture something else<span>N</span></button><div className="queue-footnote"><ShieldCheck size={12} />Your queue stays steady. New requests wait in your inbox.</div>
        </section>}
        <footer className="content-footer"><Logo small /><span>One thing at a time is enough.</span><button className="text-button" onClick={() => setNextOpen(true)}>What’s next?<ArrowRight size={13} /></button></footer>
      </main>
      {selected ? <DetailPanel key={selected.id} task={selected} tasks={tasks} onClose={() => setSelectedId(null)} onUpdate={(patch, activity) => updateTask(selected.id, patch, activity)} onDelete={() => setConfirm({ title: 'Delete this request?', text: `“${selected.title}” and its attached context will be removed from this workspace.`, action: () => { setWorkspace(current => current && { ...current, tasks: current.tasks.filter(t => t.id !== selected.id).map(t => ({ ...t, relatedIds: t.relatedIds.filter(id => id !== selected.id) })) }); setSelectedId(null); setConfirm(null); notify('Request deleted.') } })} onSelect={setSelectedId} onCopy={() => void copyHandoff(selected)} onAI={() => void runAI('capture', selected.id)} aiBusy={aiBusy === selected.id} aiResult={aiSuggestion?.id === selected.id ? aiSuggestion.result : null} onApplyAI={() => { if (!aiSuggestion || aiSuggestion.id !== selected.id) return; const result = aiSuggestion.result; updateTask(selected.id, { title: result.title || selected.title, project: result.project || selected.project, relatedIds: [...new Set([...selected.relatedIds, ...(result.relatedIds ?? [])])] }, result.summary ? `AI-assisted summary: ${result.summary}` : 'Applied AI suggestion'); setAiSuggestion(null); notify('Suggestion applied. Original context preserved.') }} onDismissAI={() => setAiSuggestion(null)} /> : <aside className="context-sidebar"><div className="focus-card"><div className="aside-title"><span><Target size={16} />Today’s focus</span><span className="tiny-dot" /></div><textarea aria-label="Today's focus" value={workspace.focus} onChange={e => setWorkspace(current => current && { ...current, focus: e.target.value })} placeholder="What would make today a good day?" maxLength={500} /><div className="focus-caption">A direction, not another deadline.</div></div>
        <div className="waiting-card"><div className="aside-title"><span><Clock3 size={16} />Waiting on</span><span className="aside-count">{waiting.length}</span></div>{waiting.length ? waiting.slice(0, 3).map(task => <button className="waiting-item" key={task.id} onClick={() => setSelectedId(task.id)}><span className="waiting-avatar">{task.waitingOn ? task.waitingOn.charAt(0).toUpperCase() : '…'}</span><span><strong>{task.title}</strong><small>{task.waitingOn || 'A dependency or an answer'}</small>{task.followUpDate && <em className={isOverdue(task.followUpDate) || task.followUpDate === today() ? 'follow-up-due' : ''}>Follow up {dateLabel(task.followUpDate).toLowerCase()}</em>}</span><ChevronRight size={13} /></button>) : <div className="waiting-empty"><span className="waiting-empty-circle"><Check size={18} /></span><p>No loose threads.<small>Blocked work will wait here.</small></p></div>}{waiting.length > 0 && <button className="text-button aside-link" onClick={() => changeView('waiting')}>View all waiting<ArrowRight size={13} /></button>}</div>
        <div className="ai-card"><div className="ai-card-icon"><Sparkles size={19} /></div><h3>A second pair of eyes.</h3><p>Connect your own API key for a little help finding the next move.</p><button onClick={() => settings?.hasApiKey ? setNextOpen(true) : setSettingsOpen(true)}>{settings?.hasApiKey ? 'Ask for a suggestion' : 'Connect your API key'}<ArrowUpRight size={14} /></button><small>{settings?.hasApiKey ? 'Connected · runs when you ask' : 'Optional. Always your call.'}</small></div><div className="aside-note"><span>↳</span><p>You don’t have to hold<br />everything in your head.</p></div>
      </aside>}
      </div>
    </div>
    {capture && <CaptureDialog initial={capture} projects={projects} onClose={() => setCapture(null)} onSave={saveCapture} />}
    {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSave={setSettings} onExport={exportWorkspace} onImport={() => importRef.current?.click()} />}
    {nextOpen && <Dialog title="Choose your next move." onClose={() => setNextOpen(false)} className="next-modal"><p className="dialog-intro">Your chosen work comes first. Pick what fits this moment.</p>{recommendation ? (() => { const aiTask = nextSuggestion?.taskId ? tasks.find(t => t.id === nextSuggestion.taskId && ['active', 'inbox'].includes(t.status)) : null; const task = aiTask ?? recommendation.task; const alternatives = nextSuggestion?.alternatives ? nextSuggestion.alternatives.map(id => tasks.find(t => t.id === id && ['active', 'inbox'].includes(t.status))).filter((t): t is Task => !!t && t.id !== task.id).slice(0, 2) : recommendation.alternatives; return <><div className="next-choice"><span className="eyebrow">{aiTask ? 'AI SUGGESTION · YOUR CHOICE' : 'FROM YOUR WORKING QUEUE'}</span><h3>{task.title}</h3><p>{aiTask ? nextSuggestion?.reason : recommendation.reason}</p><div><button className="primary-button" onClick={() => startTask(task)}><Play size={14} />{task.status === 'active' ? 'Continue this' : 'Start this'}</button><button className="text-button" onClick={() => { updateTask(task.id, { status: 'later' }, 'Deferred for later'); setNextSuggestion(null); notify('Kept for later.') }}>Not now</button></div></div>{alternatives.length > 0 && <><span className="alternative-heading">OR, PICK ANOTHER</span>{alternatives.map(alt => <button className="alternative-row" key={alt.id} onClick={() => startTask(alt)}><span><strong>{alt.title}</strong><small>{alt.project || sourceNames[alt.source]}</small></span><ArrowRight size={16} /></button>)}</>}<button className="ai-organize-button" disabled={Boolean(aiBusy)} onClick={() => void runAI('next')}>{aiBusy === 'next' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{aiBusy === 'next' ? 'Considering your context…' : 'Get an AI perspective'}<span>Your API key</span></button></> })() : <div className="empty-list"><CheckCheck size={28} /><h3>Your queue is clear.</h3><p>Capture a request or bring something back from Later.</p><button className="primary-button" onClick={() => { setNextOpen(false); void openCapture() }}><Plus size={15} />Capture a request</button></div>}</Dialog>}
    {confirm && <Dialog title={confirm.title} onClose={() => setConfirm(null)} className="confirm-modal"><p className="dialog-intro">{confirm.text}</p><div className="confirm-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>Cancel</button><button className="primary-button" onClick={confirm.action}>Continue<ArrowRight size={15} /></button></div></Dialog>}
    {handoff && <Dialog title="Your handoff is ready." onClose={() => setHandoff('')}><p className="dialog-intro">Clipboard access was unavailable. Select and copy this context into your next conversation.</p><textarea className="handoff-text" readOnly value={handoff} onFocus={e => e.target.select()} /></Dialog>}
    <input type="file" ref={importRef} hidden accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importWorkspace(file); event.target.value = '' }} />
    {toast && <div className="toast" role="status"><span className="toast-mark"><Bell size={14} /></span>{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>
}
