'use strict';

// Persists the last scan of each root so the app can reopen it in seconds instead of walking the disk again.

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const FORMAT = 2;

class ScanCache {
  constructor(dir) {
    this.dir = dir;
    this.timers = new Map();
  }

  keyFor(root) {
    return crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  }

  dataFile(root) { return path.join(this.dir, `${this.keyFor(root)}.json.gz`); }
  metaFile(root) { return path.join(this.dir, `${this.keyFor(root)}.meta.json`); }

  async save(scan) {
    await fsp.mkdir(this.dir, { recursive: true });
    const { index, ...serializable } = scan; // index is rebuilt on load
    const payload = { format: FORMAT, scan: serializable };
    const buf = await gzip(Buffer.from(JSON.stringify(payload)), { level: 6 });
    const tmp = `${this.dataFile(scan.root)}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, this.dataFile(scan.root));
    const meta = {
      format: FORMAT,
      root: scan.root,
      mode: scan.mode,
      scannedAt: scan.scannedAt,
      updatedAt: scan.updatedAt || scan.scannedAt,
      totalSize: scan.totalSize,
      totalFiles: scan.totalFiles,
      totalDirs: scan.dirs.length,
      bytes: buf.length,
    };
    await fsp.writeFile(this.metaFile(scan.root), JSON.stringify(meta), 'utf8');
    return meta;
  }

  /** Save at most once per `delayMs` per root (mutations come in bursts). */
  saveDebounced(scan, delayMs = 3000) {
    const key = this.keyFor(scan.root);
    clearTimeout(this.timers.get(key)?.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.save(scan).catch((err) => console.error('[cache] save failed', err));
    }, delayMs);
    this.timers.set(key, { timer, scan });
  }

  hasPending() { return this.timers.size > 0; }

  /** Write every pending debounced save now (called before the app quits). */
  async flush() {
    const pending = [...this.timers.values()];
    for (const p of pending) clearTimeout(p.timer);
    this.timers.clear();
    await Promise.all(pending.map((p) => this.save(p.scan).catch((err) => console.error('[cache] save failed', err))));
  }

  async meta(root) {
    try {
      const m = JSON.parse(await fsp.readFile(this.metaFile(root), 'utf8'));
      if (m.format !== FORMAT) return null;
      await fsp.access(this.dataFile(root));
      return m;
    } catch {
      return null;
    }
  }

  async load(root) {
    const buf = await fsp.readFile(this.dataFile(root));
    const payload = JSON.parse((await gunzip(buf)).toString('utf8'));
    if (payload.format !== FORMAT || !payload.scan) throw new Error('El análisis guardado tiene un formato antiguo; vuelve a analizar.');
    return payload.scan;
  }

  async list() {
    try {
      const names = (await fsp.readdir(this.dir)).filter((n) => n.endsWith('.meta.json'));
      const metas = [];
      for (const n of names) {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(this.dir, n), 'utf8'));
          if (m.format === FORMAT) metas.push(m);
        } catch { /* skip */ }
      }
      return metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } catch {
      return [];
    }
  }

  async remove(root) {
    await Promise.all([fsp.rm(this.dataFile(root), { force: true }), fsp.rm(this.metaFile(root), { force: true })]);
  }
}

module.exports = { ScanCache };
