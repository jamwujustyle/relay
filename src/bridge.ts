import type { RelayBridge, Settings } from './types'
import { validateWorkspace } from './domain'

const STORAGE_KEY = 'relay.workspace.v1'
export const isDesktop = Boolean(window.relay)
const previewSettings: Settings = { hasApiKey: false, secureStorage: false, model: 'gemini-3.1-flash-lite', dailyLimit: 30, callsToday: 0, keyStorage: 'none' }
export const bridge: RelayBridge = window.relay ?? {
  async loadWorkspace() {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? validateWorkspace(JSON.parse(raw)) : null
  },
  async saveWorkspace(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(validateWorkspace(data))) },
  async getSettings() { return { ...previewSettings } },
  async saveSettings() { throw new Error('API keys are available in the desktop app. Run npm run desktop to connect your key.') },
  async runAI() { throw new Error('Open Relay on your desktop to use your API key.') },
  async readClipboard() { return { text: await navigator.clipboard.readText() } },
  async writeClipboard(text) { await navigator.clipboard.writeText(text) },
  async openExternal(url) {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'tg:'].includes(parsed.protocol)) throw new Error('Use an https, http, or Telegram link.')
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  onAction() { return () => {} },
}
