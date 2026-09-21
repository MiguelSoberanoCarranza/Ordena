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
  maxFiles: 60000,            // files kept in memory in folder mode
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
  constructor(n, items = []) { this.n = n; this.items = []; this.min = -1; for (const it of items) this.push(it); }
  push(item) {
    if (this.items.length < this.n) {
      this.items.push(item);
      if (this.items.length === this.n) { this.items.sort((a, b) => a.size - b.size); this.min = this.items[0].size; }
      return;
    }
    if (item.size <= this.min) return;
    this.items[0] = item;
    this.items.sort((a, b) => a.size - b.size);
    this.min = this.items[0].size;
  }
  sorted() { return [...this.items].sort((a, b) => b.size - a.size); }
}

function joinRel(dir, name) { return dir ? `${dir}/${name}` : name; }
function parentOf(rel) { return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''; }
function absOf(scan, rel) { return rel ? path.join(scan.root, ...rel.split('/')) : scan.root; }

function newDirRecord(rel, name, parent, depth, entriesCount) {
  return {
    rel, name, parent, depth,
    directFiles: 0, directSize: 0,
    fileCount: 0, size: 0,             // aggregated (subtree)
    subdirCount: 0,
    empty: entriesCount === 0,
    junkDir: JUNK_DIR_NAMES.has(name),
    cats: {},                          // category -> [count, bytes] for direct files
    junkCount: 0, junkBytes: 0,        // direct junk files
  };
}

/**
 * Stat every direct file of one directory. Returns file records (all of them) and updates `dirRec`.
 * Subdirectory names are returned separately so the caller decides whether to descend.
 */
async function readDirLevel(rootAbs, rel, abs, depth, parent, errors) {
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err) {
    errors.push({ path: rel || '.', error: err.code || err.message });
    return null;
  }
  const dirRec = newDirRecord(rel, path.basename(abs) || abs, parent, depth, entries.length);
  const files = [];
  const subdirs = [];
  for (const entry of entries) {
    const entryAbs = path.join(abs, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { dirRec.subdirCount += 1; subdirs.push({ name: entry.name, abs: entryAbs }); continue; }
    if (!entry.isFile()) continue;
    let st;
    try {
      st = await fsp.stat(entryAbs);
    } catch (err) {
      if (errors.length < 500) errors.push({ path: joinRel(rel, entry.name), error: err.code || err.message });
      continue;
    }
    const size = st.size;
    const category = categoryOf(entry.name);
    const isJunk = looksLikeJunk(entry.name) || dirRec.junkDir;
    dirRec.directFiles += 1;
    dirRec.directSize += size;
    const c = dirRec.cats[category] || (dirRec.cats[category] = [0, 0]);
    c[0] += 1; c[1] += size;
    if (isJunk) { dirRec.junkCount += 1; dirRec.junkBytes += size; }
    files.push({
      rel: joinRel(rel, entry.name), name: entry.name, dir: rel, ext: extensionOf(entry.name), category,
      size, mtimeMs: Math.round(st.mtimeMs), depth, junk: isJunk,
    });
  }
  return { dirRec, files, subdirs };
}

/**
 * Walk `startRel` (relative to rootAbs, '' = root) recursively. Returns the raw subtree: dir records
 * (not yet aggregated), stored files, largest/junk candidates and per-walk counters.
 */
async function walk(rootAbs, startRel, opts, { parent = null, depth = 0 } = {}) {
  const diskMode = opts.mode === 'disk';
  const skipAbs = new Set([...(SKIP_BY_PLATFORM[process.platform] || []), ...opts.skipAbsolute].map((p) => path.resolve(p).toLowerCase()));
  const dirs = [];
  const files = [];
  const errors = [];
  const largest = new TopN(opts.topLargest);
  const junk = [];
  let totalSize = 0;
  let totalFiles = 0;
  let truncated = false;
  let cancelled = false;
  let lastProgress = 0;
  const report = (extra = {}) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (now - lastProgress > 200 || extra.done) {
      lastProgress = now;
      opts.onProgress({ files: totalFiles, dirs: dirs.length, bytes: totalSize, ...extra });
    }
  };
  const stack = [{ rel: startRel, abs: startRel ? path.join(rootAbs, ...startRel.split('/')) : rootAbs, depth, parent }];
  while (stack.length > 0) {
    if (opts.shouldCancel && opts.shouldCancel()) { cancelled = true; break; }
    const cur = stack.pop();
    const level = await readDirLevel(rootAbs, cur.rel, cur.abs, cur.depth, cur.parent, errors);
    if (!level) continue;
    dirs.push(level.dirRec);
    for (const f of level.files) {
      totalFiles += 1;
      totalSize += f.size;
      largest.push(f);
      if (f.junk && junk.length < opts.maxJunk) junk.push(f);
      const keep = diskMode ? f.size >= opts.minStoreSize : true;
      const cap = diskMode ? opts.maxStoredDiskFiles : opts.maxFiles;
      if (keep) { if (files.length < cap) files.push(f); else truncated = true; }
    }
    for (const sd of level.subdirs) {
      if (skipAbs.has(sd.abs.toLowerCase())) continue;
      if (cur.depth + 1 <= opts.maxDepth) stack.push({ rel: joinRel(cur.rel, sd.name), abs: sd.abs, depth: cur.depth + 1, parent: cur.rel });
    }
    report({ current: cur.rel || path.basename(rootAbs) });
  }
  report({ done: true });
  return { dirs, files, errors, largest: largest.sorted(), junk, totalSize, totalFiles, truncated, cancelled };
}

/** Sum direct sizes up the tree for a list of dir records (deepest first). */
function aggregate(dirs, index) {
  for (const d of dirs) { d.size = d.directSize; d.fileCount = d.directFiles; }
  const byDepth = [...dirs].sort((a, b) => b.depth - a.depth);
  for (const d of byDepth) {
    if (d.parent == null) continue;
    const p = index.get(d.parent);
    if (p) { p.size += d.size; p.fileCount += d.fileCount; }
  }
}

function buildIndex(scan) {
  scan.index = new Map(scan.dirs.map((d) => [d.rel, d]));
  return scan.index;
}

function indexOf(scan) {
  return scan.index && scan.index.size === scan.dirs.length ? scan.index : buildIndex(scan);
}

/** Full scan of `root`. */
async function scanDirectory(root, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rootAbs = path.resolve(root);
  const stat = await fsp.stat(rootAbs);
  if (!stat.isDirectory()) throw new Error('La ruta seleccionada no es una carpeta');
  const diskMode = opts.mode === 'disk';
  const w = await walk(rootAbs, '', opts);
  const scan = {
    root: rootAbs,
    mode: diskMode ? 'disk' : 'folder',
    options: { minStoreSize: opts.minStoreSize, maxFiles: opts.maxFiles, maxStoredDiskFiles: opts.maxStoredDiskFiles, maxDepth: opts.maxDepth, topLargest: opts.topLargest, maxJunk: opts.maxJunk },
    scannedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: w.files,
    dirs: w.dirs,
    errors: w.errors,
    totalSize: w.totalSize,
    totalFiles: w.totalFiles,
    truncated: w.truncated,
    cancelled: w.cancelled,
    stats: { largest: w.largest, junk: w.junk.sort((a, b) => b.size - a.size) },
  };
  aggregate(scan.dirs, buildIndex(scan));
  return scan;
}

/** Category totals over every directory's direct-file breakdown (exact, even in disk mode). */
function categoryTotals(scan) {
  const map = new Map();
  for (const d of scan.dirs) {
    for (const [cat, [count, bytes]] of Object.entries(d.cats || {})) {
      const e = map.get(cat) || { category: cat, count: 0, bytes: 0 };
      e.count += count; e.bytes += bytes;
      map.set(cat, e);
    }
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

function junkTotals(scan) {
  let count = 0; let bytes = 0;
  for (const d of scan.dirs) { count += d.junkCount || 0; bytes += d.junkBytes || 0; }
  return { count, bytes };
}

function summarize(scan, options = {}) {
  const now = options.now || Date.now();
  const topN = options.topN || 25;
  const dayMs = 86400000;
  const rootDir = indexOf(scan).get('');
  const rootFiles = rootDir ? rootDir.directFiles : 0;

  const byExtension = new Map();
  const ageBuckets = { '< 30 días': 0, '30-180 días': 0, '180-365 días': 0, '> 1 año': 0 };
  for (const f of scan.files) {
    const key = f.ext || '(sin extensión)';
    const e = byExtension.get(key) || { ext: key, count: 0, bytes: 0 };
    e.count += 1; e.bytes += f.size;
    byExtension.set(key, e);
    const age = (now - f.mtimeMs) / dayMs;
    if (age < 30) ageBuckets['< 30 días'] += f.size;
    else if (age < 180) ageBuckets['30-180 días'] += f.size;
    else if (age < 365) ageBuckets['180-365 días'] += f.size;
    else ageBuckets['> 1 año'] += f.size;
  }

  const oldLarge = scan.stats.largest
    .filter((f) => f.size >= 50 * 1024 * 1024 && now - f.mtimeMs > 180 * dayMs)
    .sort((a, b) => b.size - a.size)
    .slice(0, topN);
  const junk = junkTotals(scan);
  const emptyDirs = scan.dirs.filter((d) => d.empty && d.rel !== '');
  const topDirs = scan.dirs
    .filter((d) => d.depth === 1)
    .sort((a, b) => b.size - a.size)
    .slice(0, 30)
    .map((d) => ({ rel: d.rel, name: d.name, size: d.size, fileCount: d.fileCount }));

  return {
    root: scan.root,
    mode: scan.mode,
    scannedAt: scan.scannedAt,
    updatedAt: scan.updatedAt,
    totalFiles: scan.totalFiles,
    totalDirs: scan.dirs.length,
    totalSize: scan.totalSize,
    storedFiles: scan.files.length,
    rootFiles,
    truncated: scan.truncated,
    cancelled: scan.cancelled,
    errorCount: scan.errors.length,
    categories: categoryTotals(scan),
    extensions: [...byExtension.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
    extensionsPartial: scan.mode === 'disk',
    largest: scan.stats.largest.slice(0, topN),
    oldLarge,
    junk: scan.stats.junk,
    junkBytes: junk.bytes,
    junkCount: junk.count,
    emptyDirs,
    ageBuckets,
    topDirs,
  };
}

/** Children (dirs + stored files) of one directory, for the disk explorer view. */
function listChildren(scan, rel = '') {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const index = indexOf(scan);
  const node = index.get(clean);
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
    const n = index.get(cur);
    crumbs.unshift({ rel: cur, name: n ? n.name : cur.split('/').pop() });
    cur = n ? (n.parent || '') : '';
  }
  return {
    rel: clean, name: node.name, size: node.size, fileCount: node.fileCount,
    directFiles: node.directFiles, directSize: node.directSize,
    crumbs, dirs, files, filesPartial: scan.mode === 'disk',
  };
}

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

/** Add (or subtract, with sign -1) a subtree's totals to every ancestor of `rel`. */
function propagate(scan, fromRel, size, fileCount) {
  const index = indexOf(scan);
  let cur = fromRel;
  for (;;) {
    const node = index.get(cur);
    if (node) { node.size += size; node.fileCount += fileCount; }
    if (cur === '') break;
    cur = parentOf(cur);
  }
}

/** Drop a directory subtree or a single file from an in-memory scan (after move/trash). */
function removeSubtree(scan, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return scan;
  const prefix = `${clean}/`;
  const index = indexOf(scan);
  const dirNode = index.get(clean);
  const inSubtree = (r) => r === clean || r.startsWith(prefix);
  let removedSize = 0;
  let removedFiles = 0;
  if (dirNode) {
    removedSize = dirNode.size;
    removedFiles = dirNode.fileCount;
    scan.dirs = scan.dirs.filter((d) => !inSubtree(d.rel));
    scan.files = scan.files.filter((f) => !inSubtree(f.rel));
    scan.stats.largest = scan.stats.largest.filter((f) => !inSubtree(f.rel));
    scan.stats.junk = scan.stats.junk.filter((f) => !inSubtree(f.rel));
    buildIndex(scan);
    const parent = scan.index.get(parentOf(clean));
    if (parent) { parent.subdirCount = Math.max(0, parent.subdirCount - 1); parent.empty = parent.subdirCount === 0 && parent.directFiles === 0; }
    propagate(scan, parentOf(clean), -removedSize, -removedFiles);
  } else {
    const file = [...scan.files, ...scan.stats.largest, ...scan.stats.junk].find((f) => f.rel === clean);
    if (!file) return scan;
    removedSize = file.size;
    removedFiles = 1;
    scan.files = scan.files.filter((f) => f.rel !== clean);
    scan.stats.largest = scan.stats.largest.filter((f) => f.rel !== clean);
    scan.stats.junk = scan.stats.junk.filter((f) => f.rel !== clean);
    const parent = index.get(parentOf(clean));
    if (parent) {
      parent.directFiles -= 1;
      parent.directSize -= removedSize;
      const c = parent.cats[file.category];
      if (c) { c[0] -= 1; c[1] -= removedSize; if (c[0] <= 0) delete parent.cats[file.category]; }
      if (file.junk) { parent.junkCount -= 1; parent.junkBytes -= removedSize; }
      parent.empty = parent.subdirCount === 0 && parent.directFiles === 0;
    }
    propagate(scan, parentOf(clean), -removedSize, -removedFiles);
  }
  scan.totalSize -= removedSize;
  scan.totalFiles -= removedFiles;
  scan.updatedAt = new Date().toISOString();
  return scan;
}

/** Splice a freshly walked subtree (already prefixed with real rels) into the scan. */
function insertSubtree(scan, w, startRel) {
  const walkedIndex = new Map(w.dirs.map((d) => [d.rel, d]));
  aggregate(w.dirs, walkedIndex);
  const top = walkedIndex.get(startRel);
  scan.dirs.push(...w.dirs);
  scan.files.push(...w.files);
  scan.stats.largest = new TopN(scan.options?.topLargest || DEFAULTS.topLargest, [...scan.stats.largest, ...w.largest]).sorted();
  scan.stats.junk = [...scan.stats.junk, ...w.junk].sort((a, b) => b.size - a.size).slice(0, scan.options?.maxJunk || DEFAULTS.maxJunk);
  scan.errors = [...scan.errors.filter((e) => !(e.path === startRel || e.path.startsWith(`${startRel}/`))), ...w.errors].slice(0, 2000);
  buildIndex(scan);
  if (top && startRel !== '') {
    const parent = scan.index.get(parentOf(startRel));
    if (parent) { parent.subdirCount += 1; parent.empty = false; }
    propagate(scan, parentOf(startRel), top.size, top.fileCount);
  }
  scan.totalSize += w.totalSize;
  scan.totalFiles += w.totalFiles;
  if (w.truncated) scan.truncated = true;
  scan.updatedAt = new Date().toISOString();
}

/**
 * Re-scan one directory subtree from disk and replace it inside the existing scan.
 * Everything outside the subtree is left untouched.
 */
async function rescanSubtree(scan, rel, options = {}) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const opts = { ...DEFAULTS, ...(scan.options || {}), mode: scan.mode, ...options };
  const index = indexOf(scan);
  const existing = index.get(clean);
  const depth = existing ? existing.depth : (clean ? clean.split('/').length : 0);
  const parent = clean ? parentOf(clean) : null;
  if (clean) removeSubtree(scan, clean);
  else { scan.dirs = []; scan.files = []; scan.stats = { largest: [], junk: [] }; scan.errors = []; scan.totalSize = 0; scan.totalFiles = 0; buildIndex(scan); }
  let exists = true;
  try { await fsp.stat(absOf(scan, clean)); } catch { exists = false; }
  if (!exists) return { removed: true };
  const w = await walk(scan.root, clean, opts, { parent, depth });
  insertSubtree(scan, w, clean);
  return { removed: false, files: w.totalFiles, bytes: w.totalSize, cancelled: w.cancelled };
}

/**
 * Cheap refresh of ONE directory level: re-stat its direct files, pick up new subfolders (walked fully,
 * they are new) and drop vanished ones. Used after moving/trashing files so no full rescan is needed.
 */
async function refreshDirShallow(scan, rel, options = {}) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const opts = { ...DEFAULTS, ...(scan.options || {}), mode: scan.mode, ...options };
  const diskMode = scan.mode === 'disk';
  const index = indexOf(scan);
  const node = index.get(clean);
  if (!node) return rescanSubtree(scan, clean, options);
  const errors = [];
  const level = await readDirLevel(scan.root, clean, absOf(scan, clean), node.depth, node.parent, errors);
  if (!level) { removeSubtree(scan, clean); return { removed: true }; }
  const prefix = clean ? `${clean}/` : '';
  const isDirect = (f) => f.dir === clean;
  // Remove old direct files everywhere, keep the dir record but reset its direct counters.
  const oldSize = node.directSize;
  const oldFiles = node.directFiles;
  scan.files = scan.files.filter((f) => !isDirect(f));
  scan.stats.largest = scan.stats.largest.filter((f) => !isDirect(f));
  scan.stats.junk = scan.stats.junk.filter((f) => !isDirect(f));
  const fresh = level.dirRec;
  Object.assign(node, { directFiles: fresh.directFiles, directSize: fresh.directSize, cats: fresh.cats, junkCount: fresh.junkCount, junkBytes: fresh.junkBytes });
  for (const f of level.files) {
    const keep = diskMode ? f.size >= opts.minStoreSize : true;
    if (keep) scan.files.push(f);
  }
  scan.stats.largest = new TopN(opts.topLargest, [...scan.stats.largest, ...level.files]).sorted();
  scan.stats.junk = [...scan.stats.junk, ...level.files.filter((f) => f.junk)].sort((a, b) => b.size - a.size).slice(0, opts.maxJunk);
  const deltaSize = fresh.directSize - oldSize;
  const deltaFiles = fresh.directFiles - oldFiles;
  propagate(scan, clean, deltaSize, deltaFiles);
  scan.totalSize += deltaSize;
  scan.totalFiles += deltaFiles;
  // Subdirectories: new ones get walked, vanished ones removed.
  const currentNames = new Set(level.subdirs.map((s) => s.name));
  const knownChildren = scan.dirs.filter((d) => d.parent === clean);
  for (const child of knownChildren) if (!currentNames.has(child.name)) removeSubtree(scan, child.rel);
  const known = new Set(knownChildren.map((d) => d.name));
  for (const sd of level.subdirs) {
    if (known.has(sd.name)) continue;
    const childRel = prefix + sd.name;
    const w = await walk(scan.root, childRel, opts, { parent: clean, depth: node.depth + 1 });
    insertSubtree(scan, w, childRel);
  }
  node.subdirCount = level.subdirs.length;
  node.empty = level.subdirs.length === 0 && fresh.directFiles === 0;
  scan.updatedAt = new Date().toISOString();
  return { removed: false };
}

/** Refresh the minimal set of directories that contain the given files/dirs (after a batch of moves). */
async function refreshAffected(scan, rels, options = {}) {
  const dirs = new Set();
  const index = indexOf(scan);
  for (const r of rels) {
    const clean = String(r || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    dirs.add(index.get(clean) ? clean : parentOf(clean));
  }
  // Drop dirs whose ancestor is also in the set only if that ancestor will be fully rescanned (it is not: shallow),
  // so keep all of them but process shallowest first (parents may create new children we then know about).
  const list = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const d of list) await refreshDirShallow(scan, d, options);
  return { refreshed: list };
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

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
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = {
  scanDirectory, summarize, listChildren, findDuplicates, formatBytes, hashFile,
  removeSubtree, rescanSubtree, refreshDirShallow, refreshAffected, buildIndex, categoryTotals,
};
