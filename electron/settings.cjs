const validate = require('./validation.cjs');
// USD per million standard API tokens. Estimates use provider-reported usage;
// account-specific discounts, free allowances, and failed requests may differ.
const MODEL_PRICING = Object.freeze({
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
});

function dayKey(now = new Date()) {
  // Limits reset at local midnight, matching the day shown in the desktop UI.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function secureAvailable(safeStorage, platform = process.platform) {
  try {
    return safeStorage.isEncryptionAvailable() && (platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()));
  } catch { return false; }
}
function dailyUsage(usage, date) {
  if (!usage || usage.date !== date) return { date, count: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  return {
    date, count: usage.count, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    estimatedCost: usage.estimatedCost === null ? null : usage.estimatedCost ?? 0,
  };
}
class SettingsManager {
  constructor(store, safeStorage, options = {}) {
    this.store = store;
    this.safeStorage = safeStorage;
    this.now = options.now || (() => new Date());
    this.platform = options.platform || process.platform;
    this.queue = Promise.resolve();
    this.state = null;
    this.sessionKey = '';
    this.loadedKey = '';
  }
  serial(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  secure() { return secureAvailable(this.safeStorage, this.platform); }
  async initialize() {
    if (this.state) return;
    this.state = await this.store.load() || { version: 1, model: 'gemini-3.1-flash-lite', dailyLimit: 30, usage: { date: dayKey(this.now()), count: 0 } };
    if (this.state.encryptedKey && this.secure()) {
      try { this.loadedKey = this.safeStorage.decryptString(Buffer.from(this.state.encryptedKey, 'base64')); } catch { this.loadedKey = ''; }
    }
  }
  publicSettings(shortcuts) {
    const encrypted = Boolean(this.loadedKey && this.state.encryptedKey);
    const usage = dailyUsage(this.state.usage, dayKey(this.now()));
    return {
      hasApiKey: Boolean(this.sessionKey || this.loadedKey), secureStorage: this.secure(),
      keyStorage: this.sessionKey ? 'session' : encrypted ? 'encrypted' : 'none',
      model: this.state.model, dailyLimit: this.state.dailyLimit,
      callsToday: usage.count, inputTokensToday: usage.inputTokens, outputTokensToday: usage.outputTokens,
      estimatedCostToday: usage.estimatedCost,
      ...(shortcuts ? { shortcuts } : {}),
    };
  }
  get(shortcuts) { return this.serial(async () => { await this.initialize(); return this.publicSettings(shortcuts); }); }
  save(input, shortcuts) {
    return this.serial(async () => {
      validate.object(input, 'Settings');
      if (Object.keys(input).some(key => !['apiKey', 'model', 'dailyLimit', 'removeKey'].includes(key))) throw new Error('Unsupported settings field.');
      if (input.removeKey !== undefined && typeof input.removeKey !== 'boolean') throw new Error('Invalid remove key option.');
      if (input.apiKey !== undefined) validate.text(input.apiKey, 256, 'API key');
      await this.initialize();
      const updated = structuredClone(this.state);
      if (input.model !== undefined) updated.model = validate.model(input.model);
      if (input.dailyLimit !== undefined) updated.dailyLimit = validate.dailyLimit(input.dailyLimit);
      let nextSession = this.sessionKey;
      let nextLoaded = this.loadedKey;
      if (input.removeKey) { delete updated.encryptedKey; nextSession = ''; nextLoaded = ''; }
      else if (input.apiKey !== undefined && input.apiKey.trim()) {
        const key = input.apiKey.trim();
        if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('The API key format is invalid.');
        delete updated.encryptedKey; nextSession = ''; nextLoaded = '';
        if (this.secure()) {
          try { updated.encryptedKey = this.safeStorage.encryptString(key).toString('base64'); nextLoaded = key; }
          catch { nextSession = key; }
        } else nextSession = key;
      }
      await this.store.save(updated);
      this.state = updated; this.sessionKey = nextSession; this.loadedKey = nextLoaded;
      return this.publicSettings(shortcuts);
    });
  }
  reserveCall() {
    return this.serial(async () => {
      await this.initialize();
      const apiKey = this.sessionKey || this.loadedKey;
      if (!apiKey) throw new Error('Add your Gemini API key in Settings first.');
      const date = dayKey(this.now());
      const usage = dailyUsage(this.state.usage, date);
      if (usage.count >= this.state.dailyLimit) throw new Error('Your daily AI request limit has been reached. It resets at local midnight.');
      const updated = { ...this.state, usage: { ...usage, count: usage.count + 1 } };
      // Count an attempted request before dispatch, including failed requests.
      await this.store.save(updated);
      this.state = updated;
      return { apiKey, model: this.state.model };
    });
  }
  recordUsage(model, inputTokens, outputTokens) {
    return this.serial(async () => {
      validate.model(model);
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > 10000000 || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 20000000) throw new Error('Invalid provider-reported usage.');
      await this.initialize();
      const usage = dailyUsage(this.state.usage, dayKey(this.now()));
      const price = MODEL_PRICING[model];
      const estimatedCost = !price || usage.estimatedCost === null ? null
        : Math.round((usage.estimatedCost + (inputTokens * price.input + outputTokens * price.output) / 1000000) * 1e12) / 1e12;
      const updated = { ...this.state, usage: { ...usage, inputTokens: usage.inputTokens + inputTokens, outputTokens: usage.outputTokens + outputTokens, estimatedCost } };
      await this.store.save(updated);
      this.state = updated;
    });
  }
  flush() { return this.queue; }
}

module.exports = { SettingsManager, secureAvailable, dayKey };
