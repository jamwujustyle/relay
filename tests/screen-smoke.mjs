// Run after npm run build: xvfb-run -a node tests/screen-smoke.mjs
// Refuses the normal desktop; captures only a controlled fixture on xvfb-run's display.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

assert.match(process.env.XAUTHORITY ?? '', /\/xvfb-run\.[^/]+\/Xauthority$/, 'Run this test through xvfb-run -a so no user desktop pixels are captured.');
assert.match(process.env.DISPLAY ?? '', /^:\d+$/, 'An isolated Xvfb display is required.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.relay-test', 'screen-smoke');
await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const env = { ...process.env, RELAY_DATA_DIR: dataDir, XDG_SESSION_TYPE: 'x11' };
delete env.WAYLAND_DISPLAY;
// Desktop capture can introduce a one-step color conversion difference.
const fixturePixel = pixel => pixel.length === 4 && pixel[3] === 255 && [67, 107, 30].every((channel, index) => Math.abs(pixel[index] - channel) <= 2);
let app;
try {
  app = await electron.launch({ args: [root, '--ozone-platform=x11'], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.relay?.readScreenCapture));
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  const fixture = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const relay = BrowserWindow.getAllWindows()[0];
    const bounds = screen.getPrimaryDisplay().bounds;
    const controlled = new BrowserWindow({
      ...bounds, frame: false, fullscreen: true, show: false, backgroundColor: '#1e6b43',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await controlled.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:#1e6b43;height:100vh;overflow:hidden"><div style="position:absolute;bottom:20px;right:20px;color:white;font:20px sans-serif">Relay isolated screen fixture</div></body></html>'));
    controlled.show();
    relay.show(); relay.moveTop(); relay.focus();
    return { relayId: relay.id, fixtureId: controlled.id, width: bounds.width, height: bounds.height };
  });
  await page.waitForTimeout(300);
  const before = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1920 } });
    const image = (sources.find(item => item.display_id === String(display.id)) ?? sources[0]).thumbnail;
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const offset = (Math.floor(height * 0.35) * width + Math.floor(width * 0.35)) * 4;
    return [...bitmap.subarray(offset, offset + 4)];
  });
  assert.equal(fixturePixel(before), false, 'Relay must cover the fixture before calling screen capture, so hiding is tested.');
  const captured = await page.evaluate(() => window.relay.readScreenCapture());
  assert.equal(captured.text, '');
  assert.match(captured.image ?? '', /^data:image\/(png|jpeg);base64,/);
  const result = await app.evaluate(({ BrowserWindow, nativeImage }, { imageUrl, relayId }) => {
    const image = nativeImage.createFromDataURL(imageUrl);
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const samples = [[0.25, 0.25], [0.35, 0.35], [0.7, 0.6]].map(([x, y]) => {
      const offset = (Math.floor(height * y) * width + Math.floor(width * x)) * 4;
      return [...bitmap.subarray(offset, offset + 4)];
    });
    const relay = BrowserWindow.fromId(relayId);
    return { width, height, samples, visible: relay.isVisible(), destroyed: relay.isDestroyed() };
  }, { imageUrl: captured.image, relayId: fixture.relayId });
  assert.ok(result.width > 0 && result.height > 0);
  assert.ok(result.width <= 1920 && result.height <= 1920);
  assert.equal(result.width / result.height, fixture.width / fixture.height);
  for (const pixel of result.samples) assert.equal(fixturePixel(pixel), true, `Captured interior must match the controlled fixture while Relay is hidden; got ${pixel}.`);
  assert.equal(result.visible, true, 'Relay should be restored after capture.');
  assert.equal(result.destroyed, false);
  console.log(`Screen smoke passed on isolated Xvfb: ${result.width}×${result.height}, fixture pixels verified, Relay hidden for capture and restored, no API calls.`);
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().startsWith('data:')) window.destroy();
    }).catch(() => {});
    await app.close().catch(() => {});
  }
}
