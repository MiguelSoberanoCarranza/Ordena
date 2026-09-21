'use strict';

// Persists the last scan of each root so the app can reopen it in seconds instead of walking the disk again.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

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

  /**
   * Write the scan as gzipped JSON in chunks, yielding to the event loop between chunks so a
   * multi-hundred-thousand-entry scan does not freeze the app while it is being saved.
   */
  async save(scan) {
    await fsp.mkdir(this.dir, { recursive: true });
    const { index, dirs, files, stats, errors, ...head } = scan; // index is rebuilt on load
    const file = this.dataFile(scan.root);
    const tmp = `${file}.tmp`;
    const gz = zlib.createGzip({ level: 5 });
    const out = fs.createWriteStream(tmp);
    const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
    gz.pipe(out);
    const write = (chunk) => new Promise((resolve) => { if (!gz.write(chunk)) gz.once('drain', resolve); else setImmediate(resolve); });
    const writeArray = async (key, arr, chunkSize) => {
      await write(`"${key}":[`);
      for (let i = 0; i < arr.length; i += chunkSize) {
        const part = arr.slice(i, i + chunkSize).map((x) => JSON.stringify(x)).join(',');
        await write((i > 0 && part ? ',' : '') + part);
      }
      await write(']');
    };
    await write(`{"format":${FORMAT},"scan":{`);
    const headJson = JSON.stringify(head);
    await write(headJson.slice(1, -1) + ',');
    await write(`"stats":${JSON.stringify(stats)},"errors":${JSON.stringify(errors || [])},`);
    await writeArray('dirs', dirs, 2000);
    await write(',');
    await writeArray('files', files, 2000);
    await write('}}');
    gz.end();
    await finished;
    await fsp.rename(tmp, file);
    const st = await fsp.stat(file);
    const meta = {
      format: FORMAT,
      root: scan.root,
      mode: scan.mode,
      scannedAt: scan.scannedAt,
      updatedAt: scan.updatedAt || scan.scannedAt,
      totalSize: scan.totalSize,
      totalFiles: scan.totalFiles,
      totalDirs: dirs.length,
      bytes: st.size,
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
