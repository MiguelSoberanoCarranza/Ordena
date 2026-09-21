'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { categoryOf, extensionOf, looksLikeJunk, JUNK_DIR_NAMES } = require('./categories');
const { toRel } = require('./paths');

const DEFAULTS = {
  // 'folder': keep every file (capped) for organizing a specific folder.
  // 'disk': aggregate sizes per directory and keep only files >= minStoreSize (whole drive / user home).
  mode: 'folder',
  maxFiles: 60000,          // files kept in memory in folder mode
  maxStoredDiskFiles: 250000, // files kept in memory in disk mode
  minStoreSize: 1024 * 1024,  // disk mode: only store files >= 1 MB
  maxDepth: 40,
  topLargest: 500,
  maxJunk: 5000,
  skipAbsolute: [],           // absolute paths never entered (e.g. /proc)
};

// Directories that make no sense to walk (virtual filesystems, other mounts).
const SKIP_BY_PLATFORM = {
  linux: ['/proc', '/sys', '/dev', '/run', '/snap'],
  darwin: ['/dev', '/Volumes', '/System/Volumes/Data', '/private/var/vm', '/.Spotlight-V100', '/.fseventsd'],
  win32: [],
};

class TopN {
  constructor(n) { this.n = n; this.items = []; this.min = -1; }
  push(item) {
    if (this.items.length < this.n) {
      this.items.push(item);
      if (this.items.length === this.n) this.items.sort((a, b) => a.size - b.size), this.min = this.items[0].size;
      return;
    }
    if (item.size <= this.min) return;
    this.items[0] = item;
    this.items.sort((a, b) => a.size - b.size);
    this.min = this.items[0].size;
  }
  sorted() { return [...this.items].sort((a, b) => b.size - a.size); }
}

/**
 * Walk `root` recursively. Returns file inventory (possibly partial in disk mode) plus a complete
 * per-directory size tree, category totals and top-N lists computed over EVERY file seen.
 * Symlinks / junctions are never followed.
 */
async function scanDirectory(root, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rootAbs = path.resolve(root);
  const stat = await fsp.stat(rootAbs);
  if (!stat.isDirectory()) throw new Error('La ruta seleccionada no es una carpeta');

  const diskMode = opts.mode === 'disk';
  const skipAbs = new Set([...(SKIP_BY_PLATFORM[process.platform] || []), ...opts.skipAbsolute].map((p) => path.resolve(p).toLowerCase()));

  const files = [];
  const dirs = [];
  const dirIndex = new Map(); // rel -> dir record
  const errors = [];
  const byCategory = new Map();
  const byExtension = new Map();
  const largest = new TopN(opts.topLargest);
  const junk = [];
  let junkBytes = 0;
  let junkCount = 0;
  let totalSize = 0;
  let totalFiles = 0;
  let truncated = false;
  let lastProgress = 0;
  let cancelled = false;

  const report = (extra = {}) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (now - lastProgress > 200 || extra.done) {
      lastProgress = now;
      opts.onProgress({ files: totalFiles, dirs: dirs.length, bytes: totalSize, ...extra });
    }
  };

  const bump = (map, key, size) => {
    const e = map.get(key) || { key, count: 0, bytes: 0 };
    e.count += 1;
    e.bytes += size;
    map.set(key, e);
  };

  const stack = [{ abs: rootAbs, depth: 0, parent: null }];
  while (stack.length > 0) {
    if (opts.shouldCancel && opts.shouldCancel()) { cancelled = true; break; }
    const { abs, depth, parent } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: toRel(rootAbs, abs) || '.', error: err.code || err.message });
      continue;
    }

    const rel = toRel(rootAbs, abs);
    const dirRec = {
      rel,
      name: path.basename(abs) || abs,
      parent,
      depth,
      directFiles: 0,
      directSize: 0,
      fileCount: 0,   // aggregated later
      size: 0,        // aggregated later
      subdirCount: 0,
      empty: entries.length === 0,
      junkDir: JUNK_DIR_NAMES.has(path.basename(abs)),
    };
    dirs.push(dirRec);
    dirIndex.set(rel, dirRec);

    for (const entry of entries) {
      const entryAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        dirRec.subdirCount += 1;
        if (skipAbs.has(entryAbs.toLowerCase())) continue;
        if (depth + 1 <= opts.maxDepth) stack.push({ abs: entryAbs, depth: depth + 1, parent: rel });
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = await fsp.stat(entryAbs);
      } catch (err) {
        if (errors.length < 500) errors.push({ path: toRel(rootAbs, entryAbs), error: err.code || err.message });
        continue;
      }
      const size = st.size;
      const ext = extensionOf(entry.name);
      const category = categoryOf(entry.name);
      totalFiles += 1;
      totalSize += size;
      dirRec.directFiles += 1;
      dirRec.directSize += size;
      bump(byCategory, category, size);
      bump(byExtension, ext || '(sin extensión)', size);

      const fileRel = rel ? `${rel}/${entry.name}` : entry.name;
      const isJunk = looksLikeJunk(entry.name) || dirRec.junkDir;
      const record = {
        rel: fileRel,
        name: entry.name,
        dir: rel,
        ext,
        category,
        size,
        mtimeMs: Math.round(st.mtimeMs),
        depth,
        junk: isJunk,
      };
      largest.push(record);
      if (isJunk) {
        junkCount += 1;
        junkBytes += size;
        if (junk.length < opts.maxJunk) junk.push(record);
      }
      const keep = diskMode ? size >= opts.minStoreSize : true;
      const cap = diskMode ? opts.maxStoredDiskFiles : opts.maxFiles;
      if (keep) {
        if (files.length < cap) files.push(record);
        else truncated = true;
      }
    }
    report({ current: rel || path.basename(rootAbs) });
  }

  // Aggregate sizes bottom-up (deepest first).
  const byDepth = [...dirs].sort((a, b) => b.depth - a.depth);
  for (const d of byDepth) {
    d.size += d.directSize;
    d.fileCount += d.directFiles;
    if (d.parent != null) {
      const p = dirIndex.get(d.parent);
      if (p) { p.size += d.size; p.fileCount += d.fileCount; }
    }
  }

  report({ done: true });

  return {
    root: rootAbs,
    mode: diskMode ? 'disk' : 'folder',
    scannedAt: new Date().toISOString(),
    files,
    dirs,
    errors,
    totalSize,
    totalFiles,
    truncated,
    cancelled,
    stats: {
      categories: [...byCategory.values()].map((c) => ({ category: c.key, count: c.count, bytes: c.bytes })).sort((a, b) => b.bytes - a.bytes),
      extensions: [...byExtension.values()].map((e) => ({ ext: e.key, count: e.count, bytes: e.bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 40),
      largest: largest.sorted(),
      junk: junk.sort((a, b) => b.size - a.size),
      junkBytes,
      junkCount,
    },
  };
}

function summarize(scan, options = {}) {
  const now = options.now || Date.now();
  const topN = options.topN || 25;
  const dayMs = 86400000;
  const rootDir = scan.dirs.find((d) => d.rel === '');
  const rootFiles = rootDir ? rootDir.directFiles : 0;

  const oldLarge = scan.stats.largest
    .filter((f) => f.size >= 50 * 1024 * 1024 && now - f.mtimeMs > 180 * dayMs)
    .sort((a, b) => b.size - a.size)
    .slice(0, topN);
  const emptyDirs = scan.dirs.filter((d) => d.empty && d.rel !== '');

  // Age buckets over stored files (complete in folder mode, files >= 1 MB in disk mode).
  const ageBuckets = { '< 30 días': 0, '30-180 días': 0, '180-365 días': 0, '> 1 año': 0 };
  for (const f of scan.files) {
    const age = (now - f.mtimeMs) / dayMs;
    if (age < 30) ageBuckets['< 30 días'] += f.size;
    else if (age < 180) ageBuckets['30-180 días'] += f.size;
    else if (age < 365) ageBuckets['180-365 días'] += f.size;
    else ageBuckets['> 1 año'] += f.size;
  }

  const topDirs = scan.dirs
    .filter((d) => d.depth === 1)
    .sort((a, b) => b.size - a.size)
    .slice(0, 30)
    .map((d) => ({ rel: d.rel, name: d.name, size: d.size, fileCount: d.fileCount }));

  return {
    root: scan.root,
    mode: scan.mode,
    totalFiles: scan.totalFiles,
    totalDirs: scan.dirs.length,
    totalSize: scan.totalSize,
    storedFiles: scan.files.length,
    rootFiles,
    truncated: scan.truncated,
    cancelled: scan.cancelled,
    errorCount: scan.errors.length,
    categories: scan.stats.categories,
    extensions: scan.stats.extensions.slice(0, 30),
    largest: scan.stats.largest.slice(0, topN),
    oldLarge,
    junk: scan.stats.junk,
    junkBytes: scan.stats.junkBytes,
    junkCount: scan.stats.junkCount,
    emptyDirs,
    ageBuckets,
    topDirs,
  };
}

/** Children (dirs + stored files) of one directory, for the disk explorer view. */
function listChildren(scan, rel = '') {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const node = scan.dirs.find((d) => d.rel === clean);
  if (!node) return null;
  const dirs = scan.dirs
    .filter((d) => d.parent === clean)
    .sort((a, b) => b.size - a.size)
    .map((d) => ({ rel: d.rel, name: d.name, size: d.size, fileCount: d.fileCount, subdirCount: d.subdirCount, empty: d.empty }));
  const files = scan.files
    .filter((f) => f.dir === clean)
    .sort((a, b) => b.size - a.size)
    .slice(0, 200);
  const crumbs = [];
  let cur = clean;
  while (cur) {
    const n = scan.dirs.find((d) => d.rel === cur);
    crumbs.unshift({ rel: cur, name: n ? n.name : cur.split('/').pop() });
    cur = n ? n.parent : '';
  }
  return {
    rel: clean,
    name: node.name,
    size: node.size,
    fileCount: node.fileCount,
    directFiles: node.directFiles,
    directSize: node.directSize,
    crumbs,
    dirs,
    files,
    filesPartial: scan.mode === 'disk',
  };
}

async function hashFile(abs, { partial = false } = {}) {
  const hash = crypto.createHash('sha1');
  if (partial) {
    const fd = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      hash.update(buf.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
    return hash.digest('hex');
  }
  return new Promise((resolve, reject) => {
    fs.createReadStream(abs)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Find duplicate files among the stored inventory: group by size, then partial hash, then full hash.
 */
async function findDuplicates(scan, options = {}) {
  const minSize = options.minSize ?? 1;
  const onProgress = options.onProgress || (() => {});
  const bySize = new Map();
  for (const f of scan.files) {
    if (f.size < minSize) continue;
    const list = bySize.get(f.size) || [];
    list.push(f);
    bySize.set(f.size, list);
  }
  const candidates = [...bySize.values()].filter((list) => list.length > 1);
  const total = candidates.reduce((s, l) => s + l.length, 0);
  let processed = 0;
  const groups = [];

  for (const list of candidates) {
    if (options.shouldCancel && options.shouldCancel()) break;
    const byPartial = new Map();
    for (const f of list) {
      try {
        const h = await hashFile(path.join(scan.root, f.rel), { partial: true });
        const l = byPartial.get(h) || [];
        l.push(f);
        byPartial.set(h, l);
      } catch { /* unreadable, skip */ }
      processed += 1;
      if (processed % 20 === 0) onProgress({ processed, total });
    }
    for (const partialGroup of byPartial.values()) {
      if (partialGroup.length < 2) continue;
      const byFull = new Map();
      for (const f of partialGroup) {
        try {
          const h = f.size <= 64 * 1024 ? 'small' : await hashFile(path.join(scan.root, f.rel));
          const l = byFull.get(h) || [];
          l.push(f);
          byFull.set(h, l);
        } catch { /* skip */ }
      }
      for (const [hash, fullGroup] of byFull) {
        if (fullGroup.length < 2) continue;
        fullGroup.sort((a, b) => a.rel.length - b.rel.length || a.mtimeMs - b.mtimeMs);
        groups.push({ hash, size: fullGroup[0].size, files: fullGroup, wastedBytes: fullGroup[0].size * (fullGroup.length - 1) });
      }
    }
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes);
  onProgress({ processed: total, total, done: true });
  return {
    groups,
    wastedBytes: groups.reduce((s, g) => s + g.wastedBytes, 0),
    duplicateFiles: groups.reduce((s, g) => s + g.files.length - 1, 0),
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = { scanDirectory, summarize, listChildren, findDuplicates, formatBytes, hashFile };

/** Drop a directory subtree or a single file from an in-memory scan after it was moved/trashed. */
function removeSubtree(scan, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return scan;
  const prefix = `${clean}/`;
  const dirNode = scan.dirs.find((d) => d.rel === clean);
  let removedSize = 0;
  let removedFiles = 0;
  if (dirNode) {
    removedSize = dirNode.size;
    removedFiles = dirNode.fileCount;
    scan.dirs = scan.dirs.filter((d) => d.rel !== clean && !d.rel.startsWith(prefix));
    scan.files = scan.files.filter((f) => !f.rel.startsWith(prefix));
    scan.stats.largest = scan.stats.largest.filter((f) => !f.rel.startsWith(prefix));
    scan.stats.junk = scan.stats.junk.filter((f) => !f.rel.startsWith(prefix));
  } else {
    const file = [...scan.files, ...scan.stats.largest, ...scan.stats.junk].find((f) => f.rel === clean);
    if (!file) return scan;
    removedSize = file.size;
    removedFiles = 1;
    scan.files = scan.files.filter((f) => f.rel !== clean);
    scan.stats.largest = scan.stats.largest.filter((f) => f.rel !== clean);
    scan.stats.junk = scan.stats.junk.filter((f) => f.rel !== clean);
    const parent = scan.dirs.find((d) => d.rel === (clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : ''));
    if (parent) { parent.directFiles -= 1; parent.directSize -= removedSize; }
  }
  // Walk up the ancestors subtracting.
  let cur = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
  for (;;) {
    const node = scan.dirs.find((d) => d.rel === cur);
    if (node) { node.size -= removedSize; node.fileCount -= removedFiles; if (dirNode && node.rel === (dirNode.parent || '')) node.subdirCount -= 1; }
    if (cur === '') break;
    cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
  }
  scan.totalSize -= removedSize;
  scan.totalFiles -= removedFiles;
  return scan;
}

module.exports.removeSubtree = removeSubtree;
