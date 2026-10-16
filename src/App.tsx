import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Bell, Check, CheckCheck,
  ChevronRight, Circle, Clock3, Copy, Download, FileText, Flag, Folder,
  ImagePlus, Inbox, Layers3, Link2, ListFilter, LoaderCircle, Pause,
  Play, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Target, Trash2, Upload, Monitor, Keyboard,
  WandSparkles, X, Zap,
} from 'lucide-react'
import { bridge, isDesktop } from './bridge'
import { createHandoff, createTask, dateLabel, emptyWorkspace, isOverdue, recommendNext, relatedTasks, sampleWorkspace, validateWorkspace } from './domain'
import type { AIResult, Attachment, CaptureInput, ExtractedRequest, Priority, Settings, Source, Status, Task, Workspace } from './types'

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
    const timer = setTimeout(() => (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled])') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus(), 30)
    const handler = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== ref.current) return
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
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</div></div>
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

function CaptureDialog({ initial, projects, tasks, focus, settings, onSettings, onUsage, onClose, onSave }: {
  initial: CaptureInput; projects: string[]; tasks: Task[]; focus: string; settings: Settings | null;
  onSettings: () => void; onUsage: () => void; onClose: () => void; onSave: (tasks: Task[]) => void
}) {
  const [body, setBody] = useState(initial.text)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [source, setSource] = useState<Source>(initial.image ? 'screenshot' : 'note')
  const [priority, setPriority] = useState<Priority>('medium')
  const [sourceUrl, setSourceUrl] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>(initial.image ? [{ id: uid(), name: initial.image.startsWith('data:image/jpeg') ? 'Captured screenshot.jpg' : 'Captured screenshot.png', dataUrl: initial.image, type: initial.image.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png' }] : [])
  const [error, setError] = useState('')
  const [readingFiles, setReadingFiles] = useState(0)
  const attachmentCount = useRef(initial.image ? 1 : 0)
  const pendingReads = useRef(0)
  const [extracting, setExtracting] = useState(false)
  const [suggestions, setSuggestions] = useState<(ExtractedRequest & { selected: boolean })[] | null>(null)
  const [explanation, setExplanation] = useState('')
  const [preview, setPreview] = useState<Attachment | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editRevision = useRef(0)
  const invalidate = () => { editRevision.current++; setSuggestions(null); setExplanation('') }
  const addFiles = async (files: File[]) => {
    if (!files.length) return
    if (attachmentCount.current + files.length > 3) { setError('You can attach up to 3 screenshots per capture.'); return }
    attachmentCount.current += files.length
    pendingReads.current += files.length
    setReadingFiles(pendingReads.current); invalidate()
    try {
      const added = await filesToAttachments(files)
      setAttachments(current => [...current, ...added]); setError('')
    } catch (err) { attachmentCount.current -= files.length; setError(errorText(err)) }
    finally { pendingReads.current -= files.length; setReadingFiles(pendingReads.current) }
  }
  const extract = async () => {
    if (pendingReads.current) return
    if (!settings?.hasApiKey) { onSettings(); return }
    const revision = editRevision.current
    setExtracting(true); setError(''); setSuggestions(null); setExplanation('')
    try {
      const contextTasks = tasks.map(task => ({ ...task, body: '', attachments: [], activity: [] }))
      const result = await bridge.runAI({ mode: 'extract', tasks: contextTasks, focus, capture: { text: body, attachments } })
      if (revision !== editRevision.current) { setError('The capture changed while AI was reading it. Extract again to use the latest version.'); return }
      if (!Array.isArray(result.requests)) throw new Error('AI returned no usable extraction. You can still save this capture manually.')
      setSuggestions(result.requests.map(item => ({ ...item, selected: true })))
      setExplanation(result.explanation || (result.requests.length ? 'Review the requests before saving.' : 'No actionable requests found. You can save this capture as a note.'))
    } catch (err) { setError(errorText(err)) }
    finally { setExtracting(false); onUsage() }
  }
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (extracting || pendingReads.current) return
    if (!body.trim() && !title.trim() && attachments.length === 0) { setError('Add a note or screenshot to capture.'); return }
    if (sourceUrl && !/^(https?:\/\/|tg:\/\/)/i.test(sourceUrl)) { setError('Use a full https, http, or Telegram source link.'); return }
    const base = { body, source, priority, sourceUrl: sourceUrl.trim(), attachments }
    try {
      if (suggestions?.length) {
        const chosen = suggestions.filter(item => item.selected)
        if (!chosen.length) { setError('Select at least one request, or return to the original capture.'); return }
        onSave(chosen.map(item => createTask({ ...base, title: item.title.trim(), project: project.trim() || item.project, relatedIds: item.relatedIds, activity: item.summary ? [{ id: uid(), text: `AI extraction: ${item.summary}`, createdAt: new Date().toISOString() }] : [] })))
      } else {
        const inferredTitle = body.split('\n').find(line => line.trim())?.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').trim().slice(0, 160)
        onSave([createTask({ ...base, title: title.trim() || inferredTitle || 'Screenshot to review', project: project.trim() })])
      }
    } catch (err) { setError(errorText(err)) }
  }
  const selectedCount = suggestions?.filter(item => item.selected).length ?? 0
  return <Dialog title="Capture request" onClose={onClose} className="capture-modal">
    <form onSubmit={submit} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit() } }}>
      <div className="capture-form-body">
      <div className="capture-sources" aria-label="Request source">{(Object.keys(sourceNames) as Source[]).map(s => <button key={s} type="button" aria-pressed={source === s} className={source === s ? 'chosen' : ''} onClick={() => setSource(s)}><SourceIcon source={s} />{sourceNames[s]}</button>)}</div>
      <input className="capture-title" aria-label="Capture title" placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} maxLength={300} />
      <textarea data-autofocus className="capture-body" aria-label="Original request" placeholder="Paste messages or a handoff. You can also paste or drop a screenshot." value={body} onChange={e => { invalidate(); setBody(e.target.value) }} maxLength={50000} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files) } }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles([...event.dataTransfer.files]) }} />
      {attachments.length > 0 && <div className="capture-attachments">{attachments.map(a => <div key={a.id}><button className="attachment-preview" type="button" onClick={() => setPreview(a)} aria-label={`Preview ${a.name}`}><img src={a.dataUrl} alt={a.name} /></button><button className="attachment-remove" type="button" aria-label={`Remove ${a.name}`} onClick={() => { attachmentCount.current--; invalidate(); setAttachments(current => current.filter(x => x.id !== a.id)) }}><X size={12} /></button></div>)}</div>}
      <div className="capture-tools"><button type="button" className="text-button" onClick={() => inputRef.current?.click()}><ImagePlus size={15} />Attach screenshot</button><span>{readingFiles ? 'Reading screenshots…' : 'PNG, JPEG or WebP'}</span><input type="file" ref={inputRef} accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addFiles([...(event.target.files ?? [])]); event.target.value = '' }} /></div>
      <div className="capture-intelligence"><div><button type="button" className="secondary-button" onClick={() => void extract()} disabled={extracting || readingFiles > 0 || (!body.trim() && !attachments.length)}>{extracting ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}{extracting ? 'Extracting…' : 'Extract requests'}</button><button type="button" className="text-button" onClick={onSettings}>AI settings</button></div><p>{settings?.hasApiKey ? 'Sends this capture and workspace context to Gemini. Review before saving.' : 'Optional · connect your Gemini key in Settings to extract requests.'}</p></div>
      {suggestions !== null && <section className="extraction-review" aria-label="Extracted requests"><div className="detail-section-heading"><h3>{suggestions.length ? 'Review extracted requests' : 'No requests found'}</h3><button className="text-button" type="button" onClick={() => { setSuggestions(null); setExplanation('') }}>Use original capture</button></div><p>{explanation}</p>{suggestions.map((item, index) => <div className={`extracted-request ${item.selected ? '' : 'deselected'}`} key={index}><label className="extraction-check"><input type="checkbox" aria-label={`Include ${item.title}`} checked={item.selected} onChange={e => setSuggestions(current => current?.map((value, i) => i === index ? { ...value, selected: e.target.checked } : value) ?? null)} /><span>Request {index + 1}</span></label><input aria-label={`Extracted title ${index + 1}`} value={item.title} maxLength={300} onChange={e => setSuggestions(current => current?.map((value, i) => i === index ? { ...value, title: e.target.value } : value) ?? null)} /><p>{item.summary}</p>{(item.project || item.relatedIds.length > 0) && <small>{item.project}{item.project && item.relatedIds.length > 0 ? ' · ' : ''}{item.relatedIds.length > 0 ? `${item.relatedIds.length} related request${item.relatedIds.length === 1 ? '' : 's'}` : ''}</small>}</div>)}{suggestions.length > 0 && <small className="extraction-source-note">Each request keeps the original text and screenshots. Priority stays your choice.</small>}</section>}
      <div className="form-grid"><label>Project<input list="project-options" placeholder="Optional" value={project} onChange={e => setProject(e.target.value)} maxLength={120} /><datalist id="project-options">{projects.map(p => <option key={p} value={p} />)}</datalist></label><label>Priority<select aria-label="Priority" value={priority} onChange={e => setPriority(e.target.value as Priority)}>{Object.entries(priorityNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
      <label className="field-label">Source link <span>optional</span><input placeholder="Link back to the conversation" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} maxLength={2000} /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="modal-footer"><span><kbd>Ctrl Enter</kbd> to save</span><button className="primary-button" type="submit" disabled={extracting || readingFiles > 0 || Boolean(suggestions?.length && !selectedCount)}><Check size={15} />{suggestions?.length ? `Save selected (${selectedCount})` : 'Save to inbox'}</button></div>
    </form>{preview && <Dialog title={preview.name} onClose={() => setPreview(null)} className="image-modal"><img src={preview.dataUrl} alt={preview.name} /></Dialog>}
  </Dialog>
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
  return <Dialog title="Settings" onClose={onClose} className="settings-modal">
    <div className="settings-section-title"><div className="soft-icon"><Sparkles size={18} /></div><div><h3>AI assistance</h3><p>Extract requests and organize captured context with Gemini.</p></div><span className={`connection-badge ${settings?.hasApiKey ? 'connected' : ''}`}>{settings?.hasApiKey ? 'Connected' : 'Optional'}</span></div>
    {!isDesktop && <div className="info-box">You’re in the browser preview. API keys and system shortcuts are available in the desktop app.</div>}
    <form onSubmit={event => { event.preventDefault(); void save() }}><label className="field-label">Gemini API key<input type="password" autoComplete="off" placeholder={settings?.hasApiKey ? 'Key connected · enter a new key to replace' : 'Paste your API key'} value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={!isDesktop} /></label>
      <div className="field-note"><ShieldCheck size={13} />{settings?.secureStorage ? 'Protected by your operating system’s key store.' : 'Without a system keyring, your key stays in memory for this session.'}</div>
      <div className="form-grid"><label>Model<input value={model} onChange={e => setModel(e.target.value)} maxLength={100} disabled={!isDesktop} /></label><label>Daily request limit<input type="number" min={1} max={500} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))} disabled={!isDesktop} /></label></div>
      <p className="settings-help">Each AI action sends the relevant task text, context, and attached screenshots to Google. Your key is billed by your provider. The daily limit caps requests, not dollars.</p>
      <div className="usage-line"><span>{settings?.callsToday ?? 0} / {settings?.dailyLimit ?? 30} requests today</span><button type="button" className="text-button" onClick={() => void bridge.openExternal('https://aistudio.google.com/apikey')}>Get an API key<ArrowUpRight size={13} /></button></div>
      {isDesktop && <div className="usage-estimate"><div><span>Estimated API usage today</span><strong>{settings?.estimatedCostToday === null ? 'Rate unavailable' : `$${(settings?.estimatedCostToday ?? 0).toLocaleString('en-US', { maximumFractionDigits: 12 })}`}</strong></div><p>Based on reported tokens. Failed calls may not return usage. Your provider’s bill is authoritative.</p></div>}
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="success-text" role="status">{message}</p>}
      <div className="settings-save">{settings?.hasApiKey && <button type="button" className="text-button danger" onClick={() => void save(true)} disabled={busy}>Remove key</button>}<button className="primary-button" disabled={!isDesktop || busy} type="submit">{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save settings</button></div>
    </form>
    <div className="settings-divider" /><h3>Keyboard shortcuts</h3>
    <p className="settings-help">From Telegram, ChatGPT, or any app: copy a message first, or capture the visible screen. Nothing is read in the background.</p>
    <div className="shortcut-row"><span>Capture copied text or image{isDesktop && settings?.shortcuts && !settings.shortcuts.capture && <small>Unavailable · use the tray menu</small>}</span><kbd>Ctrl Shift Space</kbd></div>
    <div className="shortcut-row"><span>Capture current screen{isDesktop && settings?.shortcuts && !settings.shortcuts.screen && <small>Unavailable · use the tray menu</small>}</span><kbd>Ctrl Alt Space</kbd></div>
    <div className="shortcut-row"><span>Choose next request{isDesktop && settings?.shortcuts && !settings.shortcuts.next && <small>Unavailable · use the tray menu</small>}</span><kbd>Ctrl Shift Enter</kbd></div>
    <p className="settings-help">Screen capture opens a preview. Click Extract requests to use AI, then choose what to save. On some Linux desktops the system asks which screen to share. If capture is unavailable, take a system screenshot, copy it, and use clipboard capture.</p>
    <div className="shortcut-row"><span>New capture in Relay</span><kbd>N</kbd></div>
    <div className="shortcut-row"><span>Search requests</span><kbd>Ctrl K</kbd></div>
    <div className="shortcut-row"><span>Save a capture</span><kbd>Ctrl Enter</kbd></div>
    <div className="shortcut-row"><span>Close dialog or details</span><kbd>Esc</kbd></div>
    <div className="settings-divider" /><h3>Your workspace</h3><p className="settings-help">Keep a backup or move your requests to another computer. Your API key is never included.</p><div className="backup-actions"><button className="secondary-button" onClick={onExport}><Download size={15} />Export backup</button><button className="secondary-button" onClick={onImport}><Upload size={15} />Import backup</button></div>
  </Dialog>
}

function TaskRow({ task, selected, onSelect, onComplete, onMove, canUp, canDown }: { task: Task; selected: boolean; onSelect: () => void; onComplete: () => void; onMove: (direction: -1 | 1) => void; canUp: boolean; canDown: boolean }) {
  const followUp = task.status === 'waiting' ? task.followUpDate : ''
  const displayedDate = followUp || task.dueDate
  const needsAttention = displayedDate && (isOverdue(displayedDate) || Boolean(followUp && followUp === today()))
  return <div className={`task-row ${selected ? 'selected' : ''} ${task.status === 'done' ? 'completed' : ''}`}>
    <button className="complete-button" onClick={onComplete} aria-label={task.status === 'done' ? `Reopen ${task.title}` : `Complete ${task.title}`}>{task.status === 'done' ? <Check size={14} /> : <span />}</button>
    <button className="task-main" onClick={onSelect}><span className="task-title">{task.title}{task.attachments.length > 0 && <ImagePlus size={13} />}</span><span className="task-meta"><SourceIcon source={task.source} /><span>{sourceNames[task.source]}</span>{task.project && <><i /> <span>{task.project}</span></>}{task.status === 'waiting' && task.waitingOn && <><i /><span>{task.waitingOn}</span></>}{task.committed && <span className="commitment-tag">Promised</span>}</span></button>
    <div className="task-trailing">{displayedDate && <span className={`due-label ${needsAttention ? 'overdue' : ''}`} title={followUp ? `Follow up ${displayedDate}` : `Due ${displayedDate}`}><Clock3 size={12} />{followUp ? 'Follow up ' : ''}{dateLabel(displayedDate)}</span>}<span className={`priority priority-${task.priority}`}><span />{priorityNames[task.priority]}</span><div className="reorder-buttons"><button className="icon-button" title="Move up" aria-label={`Move ${task.title} up`} disabled={!canUp} onClick={() => onMove(-1)}><ArrowUp size={13} /></button><button className="icon-button" title="Move down" aria-label={`Move ${task.title} down`} disabled={!canDown} onClick={() => onMove(1)}><ArrowDown size={13} /></button></div><button className="icon-button row-open" aria-label={`Open ${task.title}`} onClick={onSelect}><ChevronRight size={16} /></button></div>
  </div>
}

function DetailPanel({ task, tasks, onClose, onUpdate, onDelete, onSelect, onCopy, onAI, aiBusy, aiResult, onApplyAI, onDismissAI }: { task: Task; tasks: Task[]; onClose: () => void; onUpdate: (patch: Partial<Task>, activity?: string) => boolean; onDelete: () => void; onSelect: (id: string) => void; onCopy: () => void; onAI: () => void; aiBusy: boolean; aiResult: AIResult | null; onApplyAI: () => void; onDismissAI: () => void }) {
  const [note, setNote] = useState('')
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  const related = useMemo(() => relatedTasks(task, tasks), [task, tasks])
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
  const [capture, setCapture] = useState<CaptureInput | null>(null)
  const [captureBusy, setCaptureBusy] = useState(false)
  const captureOpening = useRef(false)
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

  const openCapture = useCallback(async (mode: 'blank' | 'clipboard' | 'screen' = 'blank') => {
    if (capture || captureOpening.current) {
      if (mode === 'screen') { await bridge.readScreenCapture().catch(() => {}); notify('Finish or close the current capture before taking another.') }
      return
    }
    captureOpening.current = true
    setNextOpen(false); setSettingsOpen(false); setConfirm(null); setHandoff('')
    if (mode === 'screen') setCaptureBusy(true)
    try {
      if (mode === 'screen') setCapture(await bridge.readScreenCapture())
      else if (mode === 'clipboard') {
        try { setCapture(await bridge.readClipboard()) }
        catch { setCapture({ text: '' }); notify('Paste your request into the capture window.') }
      } else setCapture({ text: '' })
    } catch (error) { notify(errorText(error)) }
    finally { captureOpening.current = false; setCaptureBusy(false) }
  }, [notify, capture])
  useEffect(() => bridge.onAction(action => {
    if (action === 'capture' || action === 'screen') void openCapture(action === 'screen' ? 'screen' : 'clipboard')
    else if (!capture) { setSettingsOpen(false); setNextOpen(true) }
  }), [openCapture, capture])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); return }
      if (!isDesktop && event.ctrlKey && event.shiftKey && event.code === 'Space') { event.preventDefault(); void openCapture('clipboard'); return }
      if (!isDesktop && event.ctrlKey && event.shiftKey && event.key === 'Enter') { event.preventDefault(); setNextOpen(true); return }
      if (!editing) {
        if (event.key === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void openCapture() }
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); searchRef.current?.focus() }
        if (event.key === 'Escape') setSelectedId(null)
      }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [openCapture])

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
    setSelectedId(task.id); setView('overview'); setNextOpen(false); setNextSuggestion(null); notify('Moved to the top of Active.')
  }
  const completeTask = (task: Task) => { updateTask(task.id, { status: task.status === 'done' ? 'inbox' : 'done' }, task.status === 'done' ? 'Reopened' : 'Completed'); notify(task.status === 'done' ? 'Moved back to your inbox.' : 'Request completed.'); setNextSuggestion(null) }
  const changeView = (id: View) => { setView(id); setProjectFilter(''); setSelectedId(null); setQuery(''); setPriorityFilter(false) }
  const saveCapture = (captured: Task[]) => {
    const firstOrder = Math.max(0, ...tasks.map(t => t.order)) + 1
    const additions = captured.map((task, index) => ({ ...task, order: firstOrder + index }))
    validateWorkspace({ ...workspace!, tasks: [...tasks, ...additions] })
    setWorkspace(current => current && { ...current, tasks: [...current.tasks, ...additions] })
    setCapture(null); setSelectedId(additions.length === 1 ? additions[0].id : null); setView('inbox'); setQuery(''); setProjectFilter(''); setPriorityFilter(false)
    notify(additions.length === 1 ? 'Saved to inbox.' : `${additions.length} requests saved to inbox.`)
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
  const followUps = tasks.filter(task => task.status === 'waiting' && task.followUpDate && task.followUpDate <= today()).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))
  const doneToday = tasks.filter(t => { const completed = [...t.activity].reverse().find(a => a.text === 'Completed'); return t.status === 'done' && completed && new Date(completed.createdAt).toLocaleDateString('en-CA') === today() }).length
  const hasFilters = Boolean(query || projectFilter || priorityFilter)
  const title = query ? 'Search results' : projectFilter || (view === 'overview' ? 'Overview' : statusNames[view])
  const rowPositions = useMemo(() => {
    const positions = new Map<string, { canUp: boolean; canDown: boolean }>()
    for (const status of Object.keys(statusNames) as Status[]) {
      const group = tasks.filter(task => task.status === status).sort((a, b) => a.order - b.order)
      group.forEach((task, index) => positions.set(task.id, { canUp: index > 0, canDown: index < group.length - 1 }))
    }
    return positions
  }, [tasks])
  const renderRow = (task: Task) => <TaskRow key={task.id} task={task} selected={selectedId === task.id} onSelect={() => setSelectedId(task.id)} onComplete={() => completeTask(task)} onMove={direction => moveTask(task, direction)} {...rowPositions.get(task.id)!} />

  if (loadError) return <div className="load-screen"><Logo /><h1>Your workspace needs attention.</h1><p>Relay couldn’t read your saved data. It has been kept intact.</p><pre>{loadError}</pre><button className="secondary-button" onClick={() => location.reload()}>Try again</button></div>
  if (!workspace) return <div className="load-screen"><Logo /><LoaderCircle size={22} className="spin" /><p>Finding your place…</p></div>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Logo /><span>Relay</span></div>
      <nav aria-label="Workspace">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id && !projectFilter ? 'active' : ''}`} onClick={() => changeView(id)} aria-current={view === id && !projectFilter ? 'page' : undefined}><Icon size={16} /><span>{label}</span>{id !== 'overview' && <span className={`nav-count ${id === 'waiting' && followUps.length ? 'nav-due' : ''}`}>{tasks.filter(t => t.status === id).length || ''}</span>}</button>)}</nav>
      {projects.length > 0 && <><div className="nav-label projects-label">Projects</div><div className="project-nav">{projects.map((project, i) => <button key={project} className={projectFilter === project ? 'selected-project' : ''} onClick={() => { setProjectFilter(project); setQuery(''); setView('overview'); setSelectedId(null) }}><span className={`project-dot dot-${i % 4}`} /><span className="project-name">{project}</span><span>{tasks.filter(t => t.project === project && t.status !== 'done').length}</span></button>)}</div></>}
      <div className="sidebar-bottom"><button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />Settings</button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><h1>{title}</h1><div className="topbar-actions"><div className="search-box"><Search size={14} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search requests" aria-label="Search requests" /><kbd>Ctrl K</kbd>{query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}</div><button className="icon-button screen-capture-button" aria-label="Capture screen" title="Capture screen · Ctrl Alt Space" disabled={!isDesktop || captureBusy} onClick={() => void openCapture('screen')}>{captureBusy ? <LoaderCircle className="spin" size={16} /> : <Monitor size={16} />}</button><button className="primary-button capture-button" onClick={() => void openCapture()}><Plus size={15} />Capture<kbd>N</kbd></button></div></header>
      {workspace.sample && <div className="sample-banner"><span>Sample requests · priorities and dates are examples</span><button onClick={() => setConfirm({ title: 'Clear sample workspace?', text: 'This clears all sample requests, including any changes or additions. Export a backup first if you want to keep them.', action: () => { setWorkspace(emptyWorkspace()); setSelectedId(null); setConfirm(null); setView('overview'); setProjectFilter(''); setQuery(''); setPriorityFilter(false) } })}>Start fresh<X size={12} /></button></div>}
      {saveState === 'error' && <div className="save-error" role="alert">{saveError}<button onClick={exportWorkspace}>Export unsaved changes</button></div>}
      <div className={`content-layout ${selected ? 'has-details' : ''}`}>
        <main className="main-content">
          {tasks.length > 0 && view === 'overview' && !hasFilters && <>
            <div className="context-strip"><label className="focus-label" htmlFor="today-focus"><Target size={14} />Focus</label><input id="today-focus" className="focus-input" aria-label="Today's focus" placeholder="What matters today?" key={workspace.focus} defaultValue={workspace.focus} maxLength={500} onBlur={e => { const value = e.target.value.trim(); if (value !== workspace.focus) setWorkspace(current => current && { ...current, focus: value }) }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><button className="focus-shortcut text-button" onClick={() => setNextOpen(true)}>Choose next<ArrowRight size={14} /></button></div>
            {recommendation && <section className="next-card" aria-label="Next request"><div className="next-card-content"><div className="next-eyebrow"><span><Play size={12} />{recommendation.task.status === 'active' ? 'Continue working' : 'Suggested next'}</span></div><h2>{recommendation.task.title}</h2><p>{recommendation.reason}</p><div className="next-card-bottom"><span>{recommendation.task.project || sourceNames[recommendation.task.source]}{recommendation.task.dueDate && <><i />{dateLabel(recommendation.task.dueDate)}</>}</span><div><button className="next-alternative" onClick={() => setNextOpen(true)}>Choose another</button><button className="dark-button" onClick={() => startTask(recommendation.task)}><Play size={13} />{recommendation.task.status === 'active' ? 'Continue' : 'Start'}</button></div></div></div></section>}
            {followUps.length > 0 && <button className="followup-strip" onClick={() => changeView('waiting')}><Clock3 size={14} /><span>{followUps.length} follow-up{followUps.length === 1 ? '' : 's'} due</span><span className="followup-preview">{followUps[0].title}</span><ChevronRight size={14} /></button>}
          </>}
          {tasks.length === 0 ? <div className="welcome-card"><div className="welcome-icon"><Inbox size={25} /></div><h2>No requests yet</h2><p>Capture a message, screenshot or handoff.<br />Decide what to work on when you’re ready.</p><button className="primary-button" onClick={() => void openCapture()}><Plus size={15} />Capture request</button><div className="quick-capture-list"><button onClick={() => void openCapture('clipboard')}><Copy size={15} /><span>Capture copied text or image</span><kbd>Ctrl Shift Space</kbd></button><button disabled={!isDesktop || captureBusy} onClick={() => void openCapture('screen')}><Monitor size={15} /><span>Capture your current screen</span><kbd>Ctrl Alt Space</kbd></button></div><button className="text-button sample-button" onClick={() => setWorkspace(sampleWorkspace())}>Explore sample requests<ArrowRight size={13} /></button></div> : <section className="queue-section" aria-label="Requests"><div className="section-toolbar"><span className="list-count">{filtered.length} request{filtered.length === 1 ? '' : 's'}{query ? ' found' : ''}</span><button className={`filter-button ${priorityFilter ? 'is-active' : ''}`} aria-pressed={priorityFilter} onClick={() => setPriorityFilter(current => !current)}><ListFilter size={13} />High priority{priorityFilter && <X size={12} />}</button></div>
            {view === 'overview' && !hasFilters ? (['active', 'inbox'] as Status[]).map(status => { const group = filtered.filter(t => t.status === status); return group.length > 0 && <div className="task-group" key={status}><div className="group-label"><span className={`group-dot ${status}`} />{statusNames[status]}<span>{group.length}</span></div>{group.map(task => renderRow(task))}</div> }) : filtered.map(task => renderRow(task))}
            {filtered.length === 0 && <div className="empty-list"><div className="soft-icon">{view === 'done' ? <CheckCheck size={24} /> : view === 'waiting' ? <Clock3 size={24} /> : <Inbox size={24} />}</div><h3>{hasFilters ? 'No matching requests' : view === 'inbox' ? 'Inbox is clear' : view === 'done' ? 'No completed requests' : view === 'waiting' ? 'Nothing waiting' : 'No requests here'}</h3><p>{hasFilters ? 'Try another search or clear your filters.' : view === 'waiting' ? 'Move a request here when you need an answer or a dependency.' : 'Capture a request or move an existing one here.'}</p>{hasFilters && <button className="text-button" onClick={() => { setQuery(''); setProjectFilter(''); setPriorityFilter(false) }}>Clear filters</button>}</div>}
          </section>}
        </main>
        {selected && <DetailPanel key={selected.id} task={selected} tasks={tasks} onClose={() => setSelectedId(null)} onUpdate={(patch, activity) => updateTask(selected.id, patch, activity)} onDelete={() => setConfirm({ title: 'Delete this request?', text: `“${selected.title}” and its attached context will be removed from this workspace.`, action: () => { setWorkspace(current => current && { ...current, tasks: current.tasks.filter(t => t.id !== selected.id).map(t => ({ ...t, relatedIds: t.relatedIds.filter(id => id !== selected.id) })) }); setSelectedId(null); setConfirm(null); notify('Request deleted.') } })} onSelect={setSelectedId} onCopy={() => void copyHandoff(selected)} onAI={() => void runAI('capture', selected.id)} aiBusy={aiBusy === selected.id} aiResult={aiSuggestion?.id === selected.id ? aiSuggestion.result : null} onApplyAI={() => { if (!aiSuggestion || aiSuggestion.id !== selected.id) return; const result = aiSuggestion.result; updateTask(selected.id, { title: result.title || selected.title, project: result.project || selected.project, relatedIds: [...new Set([...selected.relatedIds, ...(result.relatedIds ?? [])])] }, result.summary ? `AI-assisted summary: ${result.summary}` : 'Applied AI suggestion'); setAiSuggestion(null); notify('Suggestion applied.') }} onDismissAI={() => setAiSuggestion(null)} />}
      </div>
      <footer className="statusbar"><span className={`save-indicator ${saveState}`} title={isDesktop ? 'Stored on this device' : 'Stored in this browser'}><span />{saveState === 'error' ? 'Changes not saved' : saveState === 'saving' ? 'Saving…' : 'Saved locally'}</span>{tasks.length > 0 && <span>{tasks.length} requests{doneToday ? ` · ${doneToday} completed today` : ''}</span>}<button onClick={() => setSettingsOpen(true)}><Keyboard size={13} />Shortcuts</button></footer>
    </div>
    {capture && <CaptureDialog initial={capture} projects={projects} tasks={tasks} focus={workspace.focus} settings={settings} onSettings={() => setSettingsOpen(true)} onUsage={() => { void bridge.getSettings().then(setSettings).catch(() => {}) }} onClose={() => setCapture(null)} onSave={saveCapture} />}
    {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} onSave={setSettings} onExport={exportWorkspace} onImport={() => importRef.current?.click()} />}
    {nextOpen && <Dialog title="Choose next" onClose={() => setNextOpen(false)} className="next-modal"><p className="dialog-intro">Your chosen work comes first. Pick what fits this moment.</p>{recommendation ? (() => { const aiTask = nextSuggestion?.taskId ? tasks.find(t => t.id === nextSuggestion.taskId && ['active', 'inbox'].includes(t.status)) : null; const task = aiTask ?? recommendation.task; const alternatives = nextSuggestion?.alternatives ? nextSuggestion.alternatives.map(id => tasks.find(t => t.id === id && ['active', 'inbox'].includes(t.status))).filter((t): t is Task => !!t && t.id !== task.id).slice(0, 2) : recommendation.alternatives; return <><div className="next-choice"><span className="eyebrow">{aiTask ? 'AI SUGGESTION · YOUR CHOICE' : 'FROM YOUR WORKING QUEUE'}</span><h3>{task.title}</h3><p>{aiTask ? nextSuggestion?.reason : recommendation.reason}</p><div><button className="primary-button" onClick={() => startTask(task)}><Play size={14} />{task.status === 'active' ? 'Continue this' : 'Start this'}</button><button className="text-button" onClick={() => { updateTask(task.id, { status: 'later' }, 'Deferred for later'); setNextSuggestion(null); notify('Kept for later.') }}>Not now</button></div></div>{alternatives.length > 0 && <><span className="alternative-heading">OR, PICK ANOTHER</span>{alternatives.map(alt => <button className="alternative-row" key={alt.id} onClick={() => startTask(alt)}><span><strong>{alt.title}</strong><small>{alt.project || sourceNames[alt.source]}</small></span><ArrowRight size={16} /></button>)}</>}<button className="ai-organize-button" disabled={Boolean(aiBusy)} onClick={() => void runAI('next')}>{aiBusy === 'next' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{aiBusy === 'next' ? 'Considering your context…' : 'Get an AI perspective'}<span>Your API key</span></button></> })() : <div className="empty-list"><CheckCheck size={28} /><h3>Your queue is clear.</h3><p>Capture a request or bring something back from Later.</p><button className="primary-button" onClick={() => { setNextOpen(false); void openCapture() }}><Plus size={15} />Capture a request</button></div>}</Dialog>}
    {confirm && <Dialog title={confirm.title} onClose={() => setConfirm(null)} className="confirm-modal"><p className="dialog-intro">{confirm.text}</p><div className="confirm-actions"><button className="secondary-button" onClick={() => setConfirm(null)}>Cancel</button><button className="primary-button" onClick={confirm.action}>Continue<ArrowRight size={15} /></button></div></Dialog>}
    {handoff && <Dialog title="Copy handoff" onClose={() => setHandoff('')}><p className="dialog-intro">Clipboard access was unavailable. Select and copy this context into your next conversation.</p><textarea className="handoff-text" readOnly value={handoff} onFocus={e => e.target.select()} /></Dialog>}
    <input type="file" ref={importRef} hidden accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importWorkspace(file); event.target.value = '' }} />
    {toast && <div className="toast" role="status"><span className="toast-mark"><Bell size={14} /></span>{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>
}
