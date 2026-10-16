// Run after npm run build: node tests/desktop-smoke.mjs
// Uses a dedicated test data folder and never calls a hosted model.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.relay-test', 'desktop-smoke');
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const now = new Date().toISOString();
const workspace = { version: 1, focus: 'Desktop smoke', sample: false, tasks: [{
  id: 'desktop-smoke-request', title: 'Check the native desktop bridge', body: 'Source context survives restart.',
  project: 'Relay', status: 'inbox', priority: 'high', source: 'note', sourceUrl: '',
  createdAt: now, updatedAt: now, dueDate: '', waitingOn: '', followUpDate: '', committed: true,
  order: 0, attachments: [], relatedIds: [], activity: [],
}] };
await writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace));
const launch = () => electron.launch({ args: [root, '--ozone-platform=x11'], env: { ...process.env, RELAY_DATA_DIR: dataDir }, timeout: 30000 });
let app;
let savedClipboard;
try {
  app = await launch();
  const pageErrors = [];
  app.context().on('page', opened => opened.on('pageerror', error => pageErrors.push(error.message)));
  const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.relay));
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const isolation = await app.evaluate(({ BrowserWindow }) => {
    const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration, sandbox: options.sandbox };
  });
  assert.deepEqual(isolation, { contextIsolation: true, nodeIntegration: false, sandbox: true });
  const loaded = await page.evaluate(() => window.relay.loadWorkspace());
  assert.deepEqual(loaded, workspace);
  await expect(page.getByRole('heading', { name: 'Your next move.', exact: true })).toBeVisible();
  await expect(page.getByText('Check the native desktop bridge', { exact: true }).first()).toBeVisible();
  assert.deepEqual(pageErrors, [], 'The built desktop UI should render without page errors');
  const settings = await page.evaluate(() => window.relay.getSettings());
  assert.equal(settings.dailyLimit, 30);
  assert.equal(settings.model, 'gemini-3.1-flash-lite');
  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.keyStorage, 'none');
  assert.equal(settings.inputTokensToday, 0);
  assert.equal(settings.outputTokensToday, 0);
  assert.equal(settings.estimatedCostToday, 0);
  assert.equal(typeof settings.shortcuts.capture, 'boolean');
  savedClipboard = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
  await page.evaluate(() => window.relay.writeClipboard('Relay clipboard smoke'));
  assert.equal((await page.evaluate(() => window.relay.readClipboard())).text, 'Relay clipboard smoke');
  await app.evaluate(({ clipboard, nativeImage }, previous) => {
    const image = previous.image ? nativeImage.createFromDataURL(previous.image) : undefined;
    clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, ...(image && !image.isEmpty() ? { image } : {}) });
  }, savedClipboard);
  await assert.rejects(page.evaluate(() => window.relay.openExternal('file:///tmp/relay-test')), /Only web/);
  await assert.rejects(page.evaluate(() => window.relay.runAI({ mode: 'next', tasks: [], focus: '' })), /Add an inbox/);
  const hidden = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.close(); return !window.isVisible() && !window.isDestroyed();
  });
  assert.equal(hidden, true, 'Closing the window should hide it to the tray');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  workspace.tasks[0].title = 'Latest write survives immediate native quit';
  await page.evaluate(data => { void window.relay.saveWorkspace(data); }, workspace);
  await app.close(); app = undefined;
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'workspace.json'), 'utf8')).tasks[0].title, workspace.tasks[0].title);
  app = await launch();
  const restarted = await app.firstWindow();
  const restartErrors = [];
  restarted.on('pageerror', error => restartErrors.push(error.message));
  await restarted.waitForFunction(() => Boolean(window.relay));
  assert.equal((await restarted.evaluate(() => window.relay.loadWorkspace())).tasks[0].title, workspace.tasks[0].title);
  await expect(restarted.getByRole('heading', { name: 'Your next move.', exact: true })).toBeVisible();
  await expect(restarted.getByText(workspace.tasks[0].title, { exact: true }).first()).toBeVisible();
  assert.deepEqual(restartErrors, [], 'The restarted desktop UI should render without page errors');
  console.log('Desktop smoke passed: built UI, no page errors, sandbox, bridge, settings, clipboard, URL guard, tray close, quit flush, restart persistence.');
} finally {
  if (app) {
    if (savedClipboard) await app.evaluate(({ clipboard, nativeImage }, previous) => {
      const image = previous.image ? nativeImage.createFromDataURL(previous.image) : undefined;
      clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, ...(image && !image.isEmpty() ? { image } : {}) });
    }, savedClipboard).catch(() => {});
    await app.close().catch(() => {});
  }
}
