'use strict';

const AGE_RANGES = { '< 30 días': [0, 30], '30-180 días': [30, 180], '180-365 días': [180, 365], '> 1 año': [365, Infinity] };

/**
 * Filter + sort stored file records.
 * q: { category, ext, age, junk, oldLarge, search, dir, sort: 'size'|'date'|'name' }
 * Returns { list, totalBytes, topDirs } where topDirs groups by the first 3 path levels.
 */
function filterFiles(files, q = {}, now = Date.now()) {
  const dayMs = 86400000;
  let list = files;
  if (q.category) list = list.filter((f) => f.category === q.category);
  if (q.ext) list = list.filter((f) => (f.ext || '(sin extensión)') === q.ext);
  if (q.junk) list = list.filter((f) => f.junk);
  if (q.oldLarge) list = list.filter((f) => f.size >= 50 * 1024 * 1024 && now - f.mtimeMs > 180 * dayMs);
  if (q.age && AGE_RANGES[q.age]) {
    const [lo, hi] = AGE_RANGES[q.age];
    list = list.filter((f) => { const a = (now - f.mtimeMs) / dayMs; return a >= lo && a < hi; });
  }
  if (q.dir) { const d = String(q.dir).replace(/\\/g, '/'); list = list.filter((f) => f.dir === d || f.dir.startsWith(`${d}/`)); }
  if (q.search) { const t = String(q.search).toLowerCase(); list = list.filter((f) => f.rel.toLowerCase().includes(t)); }
  const sort = q.sort || 'size';
  list = [...list].sort(sort === 'date' ? (a, b) => a.mtimeMs - b.mtimeMs : sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.size - a.size);
  const byDir = new Map();
  let totalBytes = 0;
  for (const f of list) {
    totalBytes += f.size;
    const key = f.dir.split('/').slice(0, 3).join('/') || '(raíz)';
    const e = byDir.get(key) || { dir: key, bytes: 0, count: 0 };
    e.bytes += f.size; e.count += 1;
    byDir.set(key, e);
  }
  return { list, totalBytes, topDirs: [...byDir.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10) };
}

module.exports = { filterFiles, AGE_RANGES };
