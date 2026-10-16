const { MAX_IMAGE_BYTES } = require('./validation.cjs');

const UNAVAILABLE = 'Screen capture was cancelled or is unavailable. Use your system screenshot tool, copy the image, then press Ctrl+Shift+Space.';
const MAX_EDGE = 1920;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function boundedImage(image) {
  if (!image || image.isEmpty()) throw new Error(UNAVAILABLE);
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error(UNAVAILABLE);
  if (Math.max(size.width, size.height) > MAX_EDGE) {
    const ratio = MAX_EDGE / Math.max(size.width, size.height);
    image = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'best' });
  }
  const png = image.toPNG();
  if (png.length <= MAX_IMAGE_BYTES) return `data:image/png;base64,${png.toString('base64')}`;
  // A noisy full-screen image can exceed the PNG bound even after resizing.
  const jpeg = image.toJPEG(88);
  if (jpeg.length > MAX_IMAGE_BYTES) throw new Error(UNAVAILABLE);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

async function captureScreen({ desktopCapturer, screen, window, platform = process.platform, env = process.env, delay = wait }) {
  const visible = window && !window.isDestroyed() && window.isVisible();
  let display;
  try {
    // Wayland does not expose global cursor coordinates; the portal chooses the source.
    if (!(platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY))) {
      display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }
    if (visible) window.hide();
    // Allow the compositor to remove Relay and close the tray menu before capture.
    await delay(180);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: MAX_EDGE, height: MAX_EDGE }, fetchWindowIcons: false });
    const source = sources.length === 1 ? sources[0] : display && sources.find(item => item.display_id === String(display.id));
    if (!source) throw new Error(UNAVAILABLE);
    return { text: '', image: boundedImage(source.thumbnail) };
  } catch {
    throw new Error(UNAVAILABLE);
  } finally {
    if (visible && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
    }
  }
}

// A hotkey captures first, then brings Relay forward. Its next IPC read consumes
// that exact snapshot instead of accidentally capturing Relay itself.
class ScreenCaptureService {
  constructor(capture, notify) { this.capture = capture; this.notify = notify; this.inFlight = null; this.pending = null; }
  take() {
    if (this.inFlight) return Promise.reject(new Error('A screen capture is already in progress.'));
    const operation = Promise.resolve().then(() => this.capture());
    this.inFlight = operation;
    return operation.finally(() => { this.inFlight = null; });
  }
  async request() {
    if (this.inFlight) return;
    this.pending = null;
    try { this.pending = { value: await this.take() }; }
    catch (error) { this.pending = { error }; }
    this.notify();
  }
  read() {
    const pending = this.pending;
    this.pending = null;
    if (pending?.error) return Promise.reject(pending.error);
    if (pending) return Promise.resolve(pending.value);
    return this.take();
  }
}

module.exports = { captureScreen, boundedImage, ScreenCaptureService, UNAVAILABLE };
