export type Status = 'inbox' | 'active' | 'waiting' | 'later' | 'done'
export type Priority = 'high' | 'medium' | 'low'
export type Source = 'telegram' | 'chatgpt' | 'screenshot' | 'note'
export interface Attachment { id: string; name: string; dataUrl: string; type: string }
export interface Activity { id: string; text: string; createdAt: string }
export interface Task {
  id: string; title: string; body: string; project: string; status: Status; priority: Priority;
  source: Source; sourceUrl: string; createdAt: string; updatedAt: string;
  dueDate: string; waitingOn: string; followUpDate: string; committed: boolean;
  order: number; attachments: Attachment[]; relatedIds: string[]; activity: Activity[];
}
export interface Workspace { version: 1; tasks: Task[]; focus: string; sample: boolean }
export interface Settings {
  hasApiKey: boolean; secureStorage: boolean; model: string; dailyLimit: number;
  callsToday: number; keyStorage: 'encrypted' | 'session' | 'none';
  inputTokensToday?: number; outputTokensToday?: number; estimatedCostToday?: number | null;
  shortcuts?: { capture: boolean; next: boolean; screen?: boolean };
}
export interface CaptureInput { text: string; image?: string }
export interface ExtractedRequest { title: string; summary: string; project: string; relatedIds: string[] }
export interface AIRequest { mode: 'capture' | 'next' | 'extract'; tasks: Task[]; focus: string; taskId?: string; capture?: { text: string; attachments: Attachment[] } }
export interface AIResult {
  title?: string; project?: string; summary?: string; relatedIds?: string[];
  taskId?: string; reason?: string; alternatives?: string[];
  requests?: ExtractedRequest[]; explanation?: string;
  inputTokens: number; outputTokens: number;
}
export type SettingsInput = { apiKey?: string; model?: string; dailyLimit?: number; removeKey?: boolean }
export interface RelayBridge {
  loadWorkspace(): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: SettingsInput): Promise<Settings>;
  runAI(request: AIRequest): Promise<AIResult>;
  readClipboard(): Promise<{ text: string; image?: string }>;
  readScreenCapture(): Promise<CaptureInput>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onAction(callback: (action: 'capture' | 'screen' | 'next') => void): () => void;
}
declare global { interface Window { relay?: RelayBridge } }
