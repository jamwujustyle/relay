const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// All operations share one queue. A damaged existing file is never replaced by a
// default workspace: both reads and writes stop until the user recovers it.
class JsonStore {
  constructor(filename, validate, maxBytes) {
    this.filename = filename;
    this.validate = validate;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
  }
  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async readExisting() {
    try {
      const stat = await fs.stat(this.filename);
      if (!stat.isFile() || stat.size > this.maxBytes) throw new Error('invalid');
      const raw = await fs.readFile(this.filename, 'utf8');
      if (Buffer.byteLength(raw) > this.maxBytes) throw new Error('invalid');
      return this.validate(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`${path.basename(this.filename)} could not be read safely. Your file has been preserved. Recover or move it from Relay's data folder before saving again.`);
    }
  }
  load() { return this.serial(() => this.readExisting()); }
  save(value) {
    // Clone immediately so a caller cannot mutate data while a write is queued.
    let raw;
    try { this.validate(value); raw = JSON.stringify(value, null, 2); } catch (error) { return Promise.reject(error); }
    if (Buffer.byteLength(raw) > this.maxBytes) return Promise.reject(new Error('Saved data is too large.'));
    return this.serial(async () => {
      await this.readExisting();
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(raw, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temporary, this.filename);
        // Directory fsync is available on Linux; some Windows filesystems reject it.
        try { const directory = await fs.open(path.dirname(this.filename), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
      } catch {
        throw new Error(`Could not save ${path.basename(this.filename)}. Your previous file has been preserved.`);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    });
  }
  flush() { return this.queue; }
}

module.exports = { JsonStore };
