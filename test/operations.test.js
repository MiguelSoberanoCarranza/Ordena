'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal, applyMoves, undoMoves, trashFiles, removeEmptyDirs } = require('../src/main/operations');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordena-ops-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'a');
  fs.writeFileSync(path.join(dir, 'b.pdf'), 'b');
  fs.mkdirSync(path.join(dir, 'Docs'));
  fs.writeFileSync(path.join(dir, 'Docs', 'b.pdf'), 'existing');
  fs.mkdirSync(path.join(dir, 'vacia'));
  return dir;
}

test('applyMoves moves files, avoids overwrites and can be undone', async () => {
  const dir = fixture();
  const journal = new Journal(path.join(dir, '.journal', 'j.json'));
  const res = await applyMoves(dir, [
    { from: 'a.pdf', to: 'Docs/Nuevo/a.pdf' },
    { from: 'b.pdf', to: 'Docs/b.pdf' },
    { from: '../evil', to: 'x' },
  ], { journal });
  assert.equal(res.done.length, 2);
  assert.equal(res.failed.length, 1);
  assert.equal(res.done[1].to, 'Docs/b (1).pdf');
  assert.ok(fs.existsSync(path.join(dir, 'Docs', 'Nuevo', 'a.pdf')));
  assert.equal(fs.readFileSync(path.join(dir, 'Docs', 'b.pdf'), 'utf8'), 'existing');

  const [entry] = await journal.read();
  assert.equal(entry.type, 'move');
  assert.deepEqual(entry.createdDirs, ['Docs/Nuevo']);

  const undo = await undoMoves(entry, { journal });
  assert.equal(undo.restored.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'a.pdf')));
  assert.ok(fs.existsSync(path.join(dir, 'b.pdf')));
  assert.ok(!fs.existsSync(path.join(dir, 'Docs', 'Nuevo')));
  assert.equal((await journal.read())[0].undone, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trashFiles uses the injected trash implementation and journals bytes', async () => {
  const dir = fixture();
  const trashed = [];
  const journal = new Journal(path.join(dir, '.journal', 'j.json'));
  const res = await trashFiles(dir, ['a.pdf', 'missing.txt', '/etc/passwd'], { journal, trashImpl: async (abs) => { trashed.push(abs); fs.unlinkSync(abs); } });
  assert.deepEqual(trashed, [path.join(dir, 'a.pdf')]);
  assert.equal(res.done.length, 1);
  assert.equal(res.failed.length, 2);
  assert.equal(res.bytes, 1);
  assert.equal((await journal.read())[0].type, 'trash');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeEmptyDirs only removes empty directories', async () => {
  const dir = fixture();
  const res = await removeEmptyDirs(dir, ['vacia', 'Docs']);
  assert.deepEqual(res.done, ['vacia']);
  assert.equal(res.failed.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('relocate copies a folder elsewhere, removes the source, leaves a link and can be undone', async () => {
  const { relocate, undoRelocate } = require('../src/main/operations');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ordena-reloc-'));
  const src = path.join(base, 'Videos');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.mp4'), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(src, 'sub', 'b.mp4'), Buffer.alloc(3000, 2));
  const destDir = path.join(base, 'OtroDisco');
  const journal = new Journal(path.join(base, 'j.json'));
  const progress = [];

  await assert.rejects(relocate(src, path.join(src, 'sub'), {}), /dentro del origen/);
  await assert.rejects(relocate(src, destDir, { isProtected: () => true }), /sistema/);

  const res = await relocate(src, destDir, { journal, leaveLink: true, onProgress: (p) => progress.push(p) });
  assert.equal(res.dest, path.join(destDir, 'Videos'));
  assert.equal(res.bytes, 8000);
  assert.equal(res.files, 2);
  assert.ok(progress.length >= 2);
  assert.ok(fs.existsSync(path.join(destDir, 'Videos', 'sub', 'b.mp4')));
  assert.ok(fs.lstatSync(src).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(src, 'a.mp4'))); // reachable through the link

  const [entry] = await journal.read();
  assert.equal(entry.type, 'relocate');
  await undoRelocate(entry, { journal });
  assert.ok(!fs.lstatSync(src).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(src, 'sub', 'b.mp4')));
  assert.ok(!fs.existsSync(path.join(destDir, 'Videos')));
  assert.equal((await journal.read())[0].undone, true);
  fs.rmSync(base, { recursive: true, force: true });
});
