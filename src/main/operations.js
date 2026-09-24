'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { resolveInside } = require('./paths');

const JOURNAL_LIMIT = 100;

class Journal {
  constructor(file) {
    this.file = file;
  }

  async read() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async write(entries) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(entries.slice(-JOURNAL_LIMIT), null, 2), 'utf8');
  }

  async append(entry) {
    const entries = await this.read();
    entries.push(entry);
    await this.write(entries);
    return entry;
  }

  async update(id, patch) {
    const entries = await this.read();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    entries[idx] = { ...entries[idx], ...patch };
    await this.write(entries);
    return entries[idx];
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function uniqueDestination(abs) {
  if (!(await exists(abs))) return abs;
  const ext = path.extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No se encontró un nombre libre para ${abs}`);
}

async function moveFile(fromAbs, toAbs) {
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fsp.rename(fromAbs, toAbs);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(fromAbs, toAbs);
    await fsp.unlink(fromAbs);
  }
}

/**
 * Apply a list of moves (relative paths) inside root. Records an undoable journal entry.
 */
async function applyMoves(root, moves, { journal, onProgress } = {}) {
  const done = [];
  const failed = [];
  const createdDirs = new Set();
  for (let i = 0; i < moves.length; i += 1) {
    const m = moves[i];
    try {
      const fromAbs = resolveInside(root, m.from);
      let toAbs = resolveInside(root, m.to);
      toAbs = await uniqueDestination(toAbs);
      const dir = path.dirname(toAbs);
      if (!(await exists(dir))) createdDirs.add(dir);
      await moveFile(fromAbs, toAbs);
      done.push({ from: m.from, to: path.relative(root, toAbs).split(path.sep).join('/') });
    } catch (err) {
      failed.push({ from: m.from, to: m.to, error: err.message });
    }
    if (onProgress) onProgress({ current: i + 1, total: moves.length });
  }
  const entry = {
    id: crypto.randomUUID(),
    type: 'move',
    root,
    at: new Date().toISOString(),
    count: done.length,
    entries: done,
    createdDirs: [...createdDirs].map((d) => path.relative(root, d).split(path.sep).join('/')),
    undone: false,
  };
  if (journal && done.length > 0) await journal.append(entry);
  return { journalId: entry.id, done, failed };
}

/** Undo a previous move entry: move files back and remove directories that were created and are now empty. */
async function undoMoves(entry, { journal } = {}) {
  const restored = [];
  const failed = [];
  for (const e of [...entry.entries].reverse()) {
    try {
      const fromAbs = resolveInside(entry.root, e.to);
      const toAbs = await uniqueDestination(resolveInside(entry.root, e.from));
      await moveFile(fromAbs, toAbs);
      restored.push({ from: e.to, to: path.relative(entry.root, toAbs).split(path.sep).join('/') });
    } catch (err) {
      failed.push({ from: e.to, to: e.from, error: err.message });
    }
  }
  // Remove created directories, deepest first, only if empty.
  const dirs = [...(entry.createdDirs || [])].sort((a, b) => b.length - a.length);
  for (const rel of dirs) {
    try {
      const abs = resolveInside(entry.root, rel);
      const items = await fsp.readdir(abs);
      if (items.length === 0) await fsp.rmdir(abs);
    } catch { /* ignore */ }
  }
  if (journal) await journal.update(entry.id, { undone: true, undoneAt: new Date().toISOString() });
  return { restored, failed };
}

/** Send files to the system trash. `trashImpl` is Electron's shell.trashItem (injectable for tests). */
async function trashFiles(root, rels, { trashImpl, journal, onProgress, isProtected, shouldCancel } = {}) {
  if (typeof trashImpl !== 'function') throw new Error('No hay implementación de papelera disponible');
  const done = [];
  const failed = [];
  let bytes = 0;
  for (let i = 0; i < rels.length; i += 1) {
    const rel = rels[i];
    if (shouldCancel && shouldCancel()) { failed.push({ path: rel, error: 'Cancelado' }); continue; }
    try {
      const abs = resolveInside(root, rel);
      if (isProtected && isProtected(abs)) throw new Error('Ruta del sistema protegida');
      const st = await fsp.stat(abs);
      await trashImpl(abs);
      bytes += st.size;
      done.push({ path: rel, size: st.size });
    } catch (err) {
      failed.push({ path: rel, error: err.message });
    }
    if (onProgress) onProgress({ current: i + 1, total: rels.length });
  }
  const entry = {
    id: crypto.randomUUID(),
    type: 'trash',
    root,
    at: new Date().toISOString(),
    count: done.length,
    bytes,
    entries: done,
    undone: false,
  };
  if (journal && done.length > 0) await journal.append(entry);
  return { journalId: entry.id, done, failed, bytes };
}

async function removeEmptyDirs(root, rels, { isProtected, onProgress, shouldCancel } = {}) {
  const done = [];
  const failed = [];
  const sorted = [...rels].sort((a, b) => b.length - a.length);
  for (let i = 0; i < sorted.length; i += 1) {
    const rel = sorted[i];
    if (shouldCancel && shouldCancel()) { failed.push({ path: rel, error: 'Cancelado' }); continue; }
    if (onProgress && i % 25 === 0) onProgress({ current: i + 1, total: sorted.length });
    try {
      const abs = resolveInside(root, rel);
      if (isProtected && isProtected(abs)) throw new Error('Ruta del sistema protegida');
      const items = await fsp.readdir(abs);
      if (items.length > 0) throw new Error('La carpeta no está vacía');
      await fsp.rmdir(abs);
      done.push(rel);
    } catch (err) {
      failed.push({ path: rel, error: err.message });
    }
  }
  return { done, failed };
}

module.exports = { Journal, applyMoves, undoMoves, trashFiles, removeEmptyDirs, uniqueDestination };

// ---------------------------------------------------------------------------
// Relocate a folder or file to another disk (copy → verify → delete → optional link back).
// ---------------------------------------------------------------------------

async function walkFiles(abs, list) {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isSymbolicLink()) { list.push({ abs: p, link: true }); continue; }
    if (e.isDirectory()) await walkFiles(p, list);
    else if (e.isFile()) list.push({ abs: p, size: (await fsp.stat(p)).size });
  }
  return list;
}

/**
 * Move `srcAbs` (file or directory) into `destDirAbs` (a folder on another disk).
 * Source is only deleted after every file was copied and its size verified.
 * @param {object} o
 * @param {boolean} [o.leaveLink]  leave a symlink/junction at the old location pointing to the new one
 * @param {(p:{current:number,total:number,bytes:number,totalBytes:number,file:string})=>void} [o.onProgress]
 */
async function relocate(srcAbs, destDirAbs, { leaveLink = true, journal, onProgress, isProtected } = {}) {
  srcAbs = path.resolve(srcAbs);
  destDirAbs = path.resolve(destDirAbs);
  if (isProtected && isProtected(srcAbs)) throw new Error('Esta carpeta es del sistema y no se puede mover.');
  const rel = path.relative(srcAbs, destDirAbs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('El destino no puede estar dentro del origen.');
  const srcStat = await fsp.lstat(srcAbs);
  if (srcStat.isSymbolicLink()) throw new Error('El origen ya es un enlace; no hay nada que mover.');
  const destAbs = await uniqueDestination(path.join(destDirAbs, path.basename(srcAbs)));
  await fsp.mkdir(destDirAbs, { recursive: true });

  const isDir = srcStat.isDirectory();
  const items = isDir ? await walkFiles(srcAbs, []) : [{ abs: srcAbs, size: srcStat.size }];
  const totalBytes = items.reduce((s, i) => s + (i.size || 0), 0);
  let bytes = 0;
  const failed = [];

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const target = isDir ? path.join(destAbs, path.relative(srcAbs, it.abs)) : destAbs;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (it.link) {
        const linkTarget = await fsp.readlink(it.abs);
        await fsp.symlink(linkTarget, target).catch(() => {});
      } else {
        await fsp.copyFile(it.abs, target, fs.constants.COPYFILE_EXCL);
        const st = await fsp.stat(target);
        if (st.size !== it.size) throw new Error('tamaño distinto tras copiar');
        try { const s = await fsp.stat(it.abs); await fsp.utimes(target, s.atime, s.mtime); } catch { /* ignore */ }
        bytes += it.size;
      }
    } catch (err) {
      failed.push({ path: it.abs, error: err.message });
    }
    if (onProgress) onProgress({ current: i + 1, total: items.length, bytes, totalBytes, file: path.basename(it.abs) });
  }

  if (failed.length > 0) {
    // Leave the source untouched; remove the partial copy so the user can retry.
    await fsp.rm(destAbs, { recursive: true, force: true }).catch(() => {});
    const err = new Error(`No se pudieron copiar ${failed.length} archivos (p. ej. ${path.basename(failed[0].path)}: ${failed[0].error}). El original no se ha tocado.`);
    err.failed = failed;
    throw err;
  }

  // Copy verified: remove source, then link back.
  const rm = await rmrf(srcAbs);
  if (rm.failed.length > 0) {
    const err = new Error(`Se copió todo a ${destAbs}, pero ${rm.failed.length} elementos del origen no se pudieron borrar (${rm.failed[0].error}). Revisa permisos o bórralos a mano; la copia en el destino está completa.`);
    err.failed = rm.failed;
    err.dest = destAbs;
    throw err;
  }
  let linked = false;
  if (leaveLink && isDir) {
    try {
      await fsp.symlink(destAbs, srcAbs, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch { linked = false; }
  }
  const entry = {
    id: crypto.randomUUID(),
    type: 'relocate',
    root: path.dirname(srcAbs),
    at: new Date().toISOString(),
    count: items.length,
    bytes,
    src: srcAbs,
    dest: destAbs,
    linked,
    entries: [{ from: srcAbs, to: destAbs }],
    undone: false,
  };
  if (journal) await journal.append(entry);
  return { journalId: entry.id, src: srcAbs, dest: destAbs, bytes, files: items.length, linked };
}

/** Undo a relocation: remove the link, copy everything back, delete the copy on the other disk. */
async function undoRelocate(entry, { journal, onProgress } = {}) {
  const { src, dest } = entry;
  try {
    const lst = await fsp.lstat(src);
    if (lst.isSymbolicLink()) {
      await fsp.unlink(src).catch(() => fsp.rmdir(src));
    } else {
      throw new Error('La ubicación original ya está ocupada por otra cosa.');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const res = await relocate(dest, path.dirname(src), { leaveLink: false, onProgress });
  if (path.resolve(res.dest) !== path.resolve(src)) {
    // uniqueDestination renamed it (should not happen after removing the link) — rename back if possible
    try { await fsp.rename(res.dest, src); } catch { /* keep */ }
  }
  if (journal) await journal.update(entry.id, { undone: true, undoneAt: new Date().toISOString() });
  return { restored: src, bytes: res.bytes };
}

async function trashPathAbs(abs, { trashImpl, isProtected, journal } = {}) {
  if (isProtected && isProtected(abs)) throw new Error('Esta ruta es del sistema y no se puede eliminar.');
  const st = await fsp.stat(abs);
  await trashImpl(abs);
  const entry = { id: crypto.randomUUID(), type: 'trash', root: path.dirname(abs), at: new Date().toISOString(), count: 1, bytes: st.isDirectory() ? 0 : st.size, entries: [{ path: abs }], undone: false };
  if (journal) await journal.append(entry);
  return entry;
}

module.exports.relocate = relocate;
module.exports.undoRelocate = undoRelocate;
module.exports.trashPathAbs = trashPathAbs;
module.exports.walkFiles = walkFiles;

// ---------------------------------------------------------------------------
// Quarantine: Ordena's own recoverable trash. Files are RENAMED (instant, same volume) into a
// quarantine folder keeping their relative path, so "Restaurar" puts them back exactly.
// Space is only freed when the user empties the quarantine.
// ---------------------------------------------------------------------------

function sanitizeForFs(rel) {
  return rel.split('/').map((seg) => seg.replace(/[<>:"|?*\u0000-\u001f]/g, '_')).join(path.sep);
}

/**
 * @param {string} root            scan root
 * @param {string[]} rels          files/folders to quarantine (relative to root)
 * @param {object} o
 * @param {(abs:string)=>Promise<string>} o.quarantineDirFor  returns the quarantine base dir for that file's volume
 * @param {(abs:string)=>Promise<void>} [o.trashImpl]        fallback when a rename is impossible
 */
async function quarantineFiles(root, rels, { quarantineDirFor, trashImpl, journal, onProgress, isProtected, shouldCancel } = {}) {
  const opId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const done = [];
  const failed = [];
  let bytes = 0;
  let fellBack = 0;
  for (let i = 0; i < rels.length; i += 1) {
    const rel = rels[i];
    if (shouldCancel && shouldCancel()) { failed.push({ path: rel, error: 'Cancelado' }); continue; }
    try {
      const abs = resolveInside(root, rel);
      if (isProtected && isProtected(abs)) throw new Error('Ruta del sistema protegida');
      const st = await fsp.lstat(abs);
      const size = st.isDirectory() ? await dirSize(abs) : st.size;
      const base = await quarantineDirFor(abs);
      const dest = path.join(base, opId, sanitizeForFs(rel.replace(/\\/g, '/')));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fsp.rename(abs, dest);
        done.push({ path: rel, to: dest, size, mode: 'quarantine' });
      } catch (err) {
        if (!trashImpl || !['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        await trashImpl(abs);
        fellBack += 1;
        done.push({ path: rel, size, mode: 'trash' });
      }
      bytes += size;
    } catch (err) {
      failed.push({ path: rel, error: err.message });
    }
    if (onProgress) onProgress({ current: i + 1, total: rels.length });
  }
  const entry = {
    id: crypto.randomUUID(),
    type: 'quarantine',
    opId,
    root,
    at: new Date().toISOString(),
    count: done.length,
    bytes,
    entries: done,
    fellBack,
    undone: false,
    purged: false,
  };
  if (journal && done.length > 0) await journal.append(entry);
  return { journalId: entry.id, done, failed, bytes, fellBack };
}

/**
 * Delete a file or folder tree, clearing read-only attributes (Windows EPERM) and retrying.
 * Never throws: returns { removed, failed: [{path, error}] }.
 */
async function rmrf(abs, { onProgress, shouldCancel } = {}) {
  const failed = [];
  let removed = 0;
  let bytes = 0;
  let cancelled = false;
  let lastReport = 0;
  const report = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (force || now - lastReport > 250) { lastReport = now; onProgress({ removed, bytes }); }
  };
  async function walk(p) {
    if (shouldCancel && shouldCancel()) { cancelled = true; return; }
    let st;
    try { st = await fsp.lstat(p); } catch (err) { if (err.code !== 'ENOENT') failed.push({ path: p, error: err.code || err.message }); return; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      let entries = [];
      try { entries = await fsp.readdir(p); } catch (err) {
        try { await fsp.chmod(p, 0o777); entries = await fsp.readdir(p); } catch (err2) { failed.push({ path: p, error: err2.code || err2.message }); return; }
      }
      for (const name of entries) { await walk(path.join(p, name)); if (cancelled) return; }
      try { await fsp.rmdir(p); } catch (err) {
        if (err.code === 'ENOENT') return;
        try { await fsp.chmod(p, 0o777); await fsp.rmdir(p); } catch (err2) { failed.push({ path: p, error: err2.code || err2.message }); }
      }
      return;
    }
    try {
      await fsp.unlink(p);
      removed += 1; bytes += st.size || 0;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      try {
        await fsp.chmod(p, 0o666); // clears the Windows read-only attribute
        await fsp.unlink(p);
        removed += 1; bytes += st.size || 0;
      } catch (err2) {
        failed.push({ path: p, error: err2.code || err2.message });
      }
    }
    report(false);
  }
  await walk(abs);
  report(true);
  if (cancelled) return { removed, bytes, failed, cancelled: true };
  if (failed.length > 0 && process.platform === 'win32') {
    // Last resort on Windows: clear attributes with the shell and remove the tree.
    try {
      const { execFile } = require('child_process');
      await new Promise((resolve) => execFile('cmd.exe', ['/d', '/s', '/c', `attrib -R -S -H "${abs}\\*" /S /D & rd /s /q "${abs}"`], { windowsHide: true, timeout: 300000 }, () => resolve()));
      let still = true;
      try { await fsp.lstat(abs); } catch (err) { if (err.code === 'ENOENT') still = false; }
      if (!still) return { removed: removed + failed.length, bytes, failed: [], cancelled: false };
    } catch { /* keep the failures below */ }
  }
  return { removed, bytes, failed, cancelled: false };
}

async function dirSize(abs) {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* skip */ } }
    }
  }
  return total;
}

/** Put quarantined items back where they were. */
async function restoreQuarantine(entry, { journal, onProgress } = {}) {
  const restored = [];
  const failed = [];
  const items = entry.entries.filter((e) => e.mode === 'quarantine' && e.to);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    try {
      const target = await uniqueDestination(resolveInside(entry.root, it.path));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(it.to, target);
      restored.push({ from: it.to, to: path.relative(entry.root, target).split(path.sep).join('/') });
    } catch (err) {
      if (err.code === 'ENOENT') failed.push({ path: it.path, error: 'Ya no está en la cuarentena' });
      else failed.push({ path: it.path, error: err.message });
    }
    if (onProgress) onProgress({ current: i + 1, total: items.length });
  }
  // Remove the now-empty op folders.
  for (const base of new Set(items.map((it) => it.to.slice(0, it.to.indexOf(entry.opId) + entry.opId.length)))) {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
  if (journal) await journal.update(entry.id, { undone: failed.length === 0, restoredAt: new Date().toISOString(), restoredCount: restored.length });
  return { restored, failed, inTrash: entry.entries.filter((e) => e.mode === 'trash').length };
}

/** Permanently delete the quarantined items of one operation (frees the space). */
async function purgeQuarantine(entry, { journal, onProgress, shouldCancel } = {}) {
  let bytes = 0;
  const bases = new Set();
  for (const it of entry.entries) {
    if (it.mode !== 'quarantine' || !it.to) continue;
    bases.add(it.to.slice(0, it.to.indexOf(entry.opId) + entry.opId.length));
    bytes += it.size || 0;
  }
  const failed = [];
  let cancelled = false;
  let removedBytes = 0;
  for (const base of bases) {
    const r = await rmrf(base, { onProgress: onProgress ? (p) => onProgress({ ...p, bytes: removedBytes + p.bytes }) : undefined, shouldCancel });
    failed.push(...r.failed);
    removedBytes += r.bytes || 0;
    if (r.cancelled) { cancelled = true; break; }
  }
  if (journal) {
    if (!cancelled && failed.length === 0) await journal.update(entry.id, { purged: true, purgedAt: new Date().toISOString() });
    else await journal.update(entry.id, { purgeFailed: failed.length, purgeError: cancelled ? 'Detenido por el usuario' : failed[0].error, purgeAttemptAt: new Date().toISOString(), bytes: Math.max(0, (entry.bytes || 0) - removedBytes) });
  }
  return { bytes: cancelled || failed.length ? removedBytes : bytes, failed, partial: failed.length > 0, cancelled };
}

module.exports.quarantineFiles = quarantineFiles;
module.exports.restoreQuarantine = restoreQuarantine;
module.exports.purgeQuarantine = purgeQuarantine;
module.exports.dirSize = dirSize;
module.exports.rmrf = rmrf;
