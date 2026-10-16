const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, clipboard, shell, globalShortcut, safeStorage, dialog } = require('electron');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { JsonStore } = require('./storage.cjs');
const { SettingsManager } = require('./settings.cjs');
const { GeminiClient } = require('./ai.cjs');
const validate = require('./validation.cjs');

const isDev = process.argv.includes('--dev') && !app.isPackaged;
const rendererURL = isDev ? 'http://127.0.0.1:5173/' : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
const testDataPath = process.env.RELAY_DATA_DIR;
if (testDataPath) {
  const allowed = path.resolve(__dirname, '../.relay-test');
  const requested = path.resolve(testDataPath);
  if (requested !== allowed && !requested.startsWith(`${allowed}${path.sep}`)) throw new Error('RELAY_DATA_DIR must be inside the .relay-test directory.');
  app.setPath('userData', requested);
}
app.setName('Relay');
if (process.platform === 'win32') app.setAppUserModelId('app.relay.desktop');
if (process.platform === 'linux') app.setDesktopName('relay-desktop.desktop');

let window;
let tray;
let quitting = false;
let quitFlushing = false;
let ready = false;
let actionReady = false;
let pendingAction;
let settings;
let workspaceStore;
let configStore;
const shortcuts = { capture: false, next: false };

function focus(action) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  if (action) {
    if (ready && actionReady) window.webContents.send('relay:action', action);
    else pendingAction = action;
  }
}

// A generated PNG avoids platform-dependent SVG tray support and extra assets.
function trayIcon() {
  const size = 32;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const offset = row + 1 + x * 4;
      const inside = (x >= 5 && x <= 13 && y >= 7 && y <= 24) || (x >= 13 && x <= 22 && y >= 7 && y <= 12) || (x >= 13 && x <= 19 && y >= 15 && y <= 19) || (x >= 17 && x <= 25 && y >= 20 && y <= 24);
      raw[offset] = inside ? 235 : 78; raw[offset + 1] = inside ? 242 : 91; raw[offset + 2] = inside ? 255 : 223; raw[offset + 3] = (x < 2 || x > 29 || y < 2 || y > 29) ? 0 : 255;
    }
  }
  const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function trustedSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return isDev ? url.origin === 'http://127.0.0.1:5173' : url.href.split('#')[0] === rendererURL;
  } catch { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted request.');
    try { return await fn(...args); }
    catch (error) { throw new Error(error instanceof Error ? error.message : 'The operation failed.'); }
  });
}

function setupIPC(ai) {
  ipcMain.on('relay:action-ready', event => {
    if (!trustedSender(event)) return;
    actionReady = true;
    if (ready && pendingAction) { const action = pendingAction; pendingAction = undefined; focus(action); }
  });
  handle('relay:load-workspace', () => workspaceStore.load());
  handle('relay:save-workspace', value => workspaceStore.save(value));
  handle('relay:get-settings', () => settings.get(shortcuts));
  handle('relay:save-settings', value => settings.save(value, shortcuts));
  handle('relay:run-ai', value => ai.run(value));
  handle('relay:read-clipboard', () => {
    const text = clipboard.readText();
    validate.text(text, 100000, 'Clipboard text');
    const image = clipboard.readImage();
    if (image.isEmpty()) return { text };
    const png = image.toPNG();
    if (png.length > validate.MAX_IMAGE_BYTES) throw new Error('Clipboard image exceeds 5 MB. Resize it before capturing.');
    return { text, image: `data:image/png;base64,${png.toString('base64')}` };
  });
  handle('relay:write-clipboard', value => { validate.text(value, 100000, 'Clipboard text'); clipboard.writeText(value); });
  handle('relay:open-external', async value => {
    const url = validate.externalUrl(value);
    try { await shell.openExternal(url); } catch { throw new Error('Could not open this link. Check your default app.'); }
  });
}

function createWindow() {
  const icon = trayIcon();
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1050, minHeight: 680, title: 'Relay', backgroundColor: '#f7f8fa', show: false, icon,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('did-start-loading', () => { ready = false; actionReady = false; });
  window.webContents.on('did-finish-load', () => {
    ready = true;
    if (actionReady && pendingAction) { const action = pendingAction; pendingAction = undefined; focus(action); }
  });
  window.on('ready-to-show', () => window.show());
  window.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { window = undefined; });
  window.loadURL(rendererURL).catch(() => {
    dialog.showErrorBox('Relay could not start', isDev ? 'Start the development server on 127.0.0.1:5173 and launch Relay again.' : 'The app UI is missing. Run npm run build before npm start.');
    quitting = true; app.quit();
  });
  try {
    tray = new Tray(icon);
    tray.setToolTip('Relay — your request inbox');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Relay', click: () => focus() },
      { label: 'Capture request', click: () => focus('capture') },
      { label: 'Next move', click: () => focus('next') },
      { type: 'separator' }, { label: 'Quit Relay', click: () => app.quit() },
    ]));
    tray.on('click', () => focus());
  } catch { tray = undefined; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => focus());
  app.on('activate', () => { if (window) focus(); else createWindow(); });
  app.whenReady().then(() => {
    const directory = app.getPath('userData');
    workspaceStore = new JsonStore(path.join(directory, 'workspace.json'), validate.workspace, validate.MAX_WORKSPACE_BYTES);
    configStore = new JsonStore(path.join(directory, 'settings.json'), validate.config, 16384);
    settings = new SettingsManager(configStore, safeStorage);
    setupIPC(new GeminiClient(settings));
    createWindow();
    try { shortcuts.capture = globalShortcut.register('CommandOrControl+Shift+Space', () => focus('capture')); } catch {}
    try { shortcuts.next = globalShortcut.register('CommandOrControl+Shift+Enter', () => focus('next')); } catch {}
  }).catch(() => {
    dialog.showErrorBox('Relay could not start', 'Desktop initialization failed. Check your system display and app installation.');
    quitting = true; app.quit();
  });
  app.on('before-quit', event => {
    quitting = true;
    if (quitFlushing) return;
    event.preventDefault();
    Promise.all([settings?.flush(), workspaceStore?.flush(), configStore?.flush()]).finally(() => { quitFlushing = true; app.quit(); });
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
