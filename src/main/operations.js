'use strict';

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
async function trashFiles(root, rels, { trashImpl, journal, onProgress } = {}) {
  if (typeof trashImpl !== 'function') throw new Error('No hay implementación de papelera disponible');
  const done = [];
  const failed = [];
  let bytes = 0;
  for (let i = 0; i < rels.length; i += 1) {
    const rel = rels[i];
    try {
      const abs = resolveInside(root, rel);
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

async function removeEmptyDirs(root, rels) {
  const done = [];
  const failed = [];
  const sorted = [...rels].sort((a, b) => b.length - a.length);
  for (const rel of sorted) {
    try {
      const abs = resolveInside(root, rel);
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
