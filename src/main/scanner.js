'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { categoryOf, extensionOf, looksLikeJunk, JUNK_DIR_NAMES } = require('./categories');
const { toRel } = require('./paths');

const DEFAULTS = {
  maxFiles: 60000,
  maxDepth: 14,
  followSymlinks: false,
};

/**
 * Walk `root` recursively and return a flat inventory of files and directories.
 * Symlinks are never followed (avoids loops and touching files outside root).
 */
async function scanDirectory(root, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rootAbs = path.resolve(root);
  const stat = await fsp.stat(rootAbs);
  if (!stat.isDirectory()) throw new Error('La ruta seleccionada no es una carpeta');

  const files = [];
  const dirs = [];
  const errors = [];
  let totalSize = 0;
  let truncated = false;
  let lastProgress = 0;

  const report = () => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (now - lastProgress > 150) {
      lastProgress = now;
      opts.onProgress({ files: files.length, dirs: dirs.length, bytes: totalSize });
    }
  };

  const stack = [{ abs: rootAbs, depth: 0 }];
  while (stack.length > 0) {
    const { abs, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: toRel(rootAbs, abs) || '.', error: err.code || err.message });
      continue;
    }

    let fileCount = 0;
    let subdirCount = 0;
    for (const entry of entries) {
      const entryAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirCount += 1;
        if (depth + 1 <= opts.maxDepth) stack.push({ abs: entryAbs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= opts.maxFiles) {
        truncated = true;
        continue;
      }
      let st;
      try {
        st = await fsp.stat(entryAbs);
      } catch (err) {
        errors.push({ path: toRel(rootAbs, entryAbs), error: err.code || err.message });
        continue;
      }
      fileCount += 1;
      totalSize += st.size;
      const rel = toRel(rootAbs, entryAbs);
      files.push({
        rel,
        name: entry.name,
        dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
        ext: extensionOf(entry.name),
        category: categoryOf(entry.name),
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        depth,
        junk: looksLikeJunk(entry.name) || JUNK_DIR_NAMES.has(path.basename(abs)),
      });
    }
    dirs.push({
      rel: toRel(rootAbs, abs) || '',
      name: path.basename(abs),
      depth,
      fileCount,
      subdirCount,
      empty: entries.length === 0,
    });
    report();
  }

  if (opts.onProgress) opts.onProgress({ files: files.length, dirs: dirs.length, bytes: totalSize, done: true });

  return {
    root: rootAbs,
    scannedAt: new Date().toISOString(),
    files,
    dirs,
    errors,
    totalSize,
    truncated,
  };
}

function summarize(scan, options = {}) {
  const now = options.now || Date.now();
  const topN = options.topN || 25;
  const dayMs = 86400000;

  const byCategory = new Map();
  const byExtension = new Map();
  let rootFiles = 0;
  for (const f of scan.files) {
    const cat = byCategory.get(f.category) || { category: f.category, count: 0, bytes: 0 };
    cat.count += 1;
    cat.bytes += f.size;
    byCategory.set(f.category, cat);

    const key = f.ext || '(sin extensión)';
    const ext = byExtension.get(key) || { ext: key, count: 0, bytes: 0 };
    ext.count += 1;
    ext.bytes += f.size;
    byExtension.set(key, ext);

    if (f.dir === '') rootFiles += 1;
  }

  const sortedBySize = [...scan.files].sort((a, b) => b.size - a.size);
  const largest = sortedBySize.slice(0, topN);
  const oldLarge = scan.files
    .filter((f) => f.size >= 50 * 1024 * 1024 && now - f.mtimeMs > 180 * dayMs)
    .sort((a, b) => b.size - a.size)
    .slice(0, topN);
  const junk = scan.files.filter((f) => f.junk).sort((a, b) => b.size - a.size);
  const emptyDirs = scan.dirs.filter((d) => d.empty && d.rel !== '');

  const ageBuckets = { '< 30 días': 0, '30-180 días': 0, '180-365 días': 0, '> 1 año': 0 };
  for (const f of scan.files) {
    const age = (now - f.mtimeMs) / dayMs;
    if (age < 30) ageBuckets['< 30 días'] += f.size;
    else if (age < 180) ageBuckets['30-180 días'] += f.size;
    else if (age < 365) ageBuckets['180-365 días'] += f.size;
    else ageBuckets['> 1 año'] += f.size;
  }

  return {
    root: scan.root,
    totalFiles: scan.files.length,
    totalDirs: scan.dirs.length,
    totalSize: scan.totalSize,
    rootFiles,
    truncated: scan.truncated,
    errorCount: scan.errors.length,
    categories: [...byCategory.values()].sort((a, b) => b.bytes - a.bytes),
    extensions: [...byExtension.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
    largest,
    oldLarge,
    junk,
    junkBytes: junk.reduce((s, f) => s + f.size, 0),
    emptyDirs,
    ageBuckets,
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
 * Find duplicate files: group by size, then by partial hash, then by full hash.
 * Returns groups sorted by wasted bytes (size * (copies - 1)).
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
        groups.push({
          hash,
          size: fullGroup[0].size,
          files: fullGroup,
          wastedBytes: fullGroup[0].size * (fullGroup.length - 1),
        });
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

module.exports = { scanDirectory, summarize, findDuplicates, formatBytes, hashFile };
