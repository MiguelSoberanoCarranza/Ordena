'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanDirectory, summarize, findDuplicates, formatBytes } = require('../src/main/scanner');
const { categoryOf, looksLikeJunk } = require('../src/main/categories');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordena-scan-'));
  fs.writeFileSync(path.join(dir, 'foto.jpg'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(dir, 'foto copia.jpg'), Buffer.alloc(3000, 1)); // duplicate
  fs.writeFileSync(path.join(dir, 'informe.pdf'), Buffer.alloc(5000, 2));
  fs.writeFileSync(path.join(dir, 'Thumbs.db'), Buffer.alloc(10, 3));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'notas.txt'), 'hola');
  fs.writeFileSync(path.join(dir, 'sub', 'otra.jpg'), Buffer.alloc(3000, 9)); // same size, different content
  fs.mkdirSync(path.join(dir, 'vacia'));
  const old = new Date(Date.now() - 400 * 86400000);
  fs.utimesSync(path.join(dir, 'informe.pdf'), old, old);
  return dir;
}

test('categoryOf and looksLikeJunk', () => {
  assert.equal(categoryOf('a.JPG'), 'Imágenes');
  assert.equal(categoryOf('setup.exe'), 'Instaladores');
  assert.equal(categoryOf('x'), 'Otros');
  assert.equal(looksLikeJunk('Thumbs.db'), true);
  assert.equal(looksLikeJunk('~$doc.docx'), true);
  assert.equal(looksLikeJunk('instalador (2).dmg'), true);
  assert.equal(looksLikeJunk('foto.jpg'), false);
});

test('scanDirectory inventories files and dirs', async () => {
  const dir = makeFixture();
  const scan = await scanDirectory(dir);
  assert.equal(scan.files.length, 6);
  assert.equal(scan.dirs.length, 3);
  const pdf = scan.files.find((f) => f.name === 'informe.pdf');
  assert.equal(pdf.category, 'PDF');
  assert.equal(pdf.dir, '');
  const notas = scan.files.find((f) => f.name === 'notas.txt');
  assert.equal(notas.rel, 'sub/notas.txt');
  assert.equal(notas.dir, 'sub');
  assert.equal(scan.files.find((f) => f.name === 'Thumbs.db').junk, true);
  assert.ok(scan.dirs.find((d) => d.rel === 'vacia').empty);

  const summary = summarize(scan);
  assert.equal(summary.rootFiles, 4);
  assert.equal(summary.emptyDirs.length, 1);
  assert.equal(summary.junk.length, 1);
  assert.equal(summary.categories[0].category, 'Imágenes');
  assert.ok(summary.ageBuckets['> 1 año'] >= 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findDuplicates detects exact copies only', async () => {
  const dir = makeFixture();
  const scan = await scanDirectory(dir);
  const dupes = await findDuplicates(scan);
  assert.equal(dupes.groups.length, 1);
  assert.deepEqual(dupes.groups[0].files.map((f) => f.rel).sort(), ['foto copia.jpg', 'foto.jpg']);
  assert.equal(dupes.groups[0].files[0].rel, 'foto.jpg'); // shortest path is the keeper
  assert.equal(dupes.wastedBytes, 3000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50 MB');
});

test('disk mode aggregates directory sizes and keeps only large files', async () => {
  const dir = makeFixture();
  const scan = await scanDirectory(dir, { mode: 'disk', minStoreSize: 4000 });
  assert.equal(scan.mode, 'disk');
  assert.equal(scan.totalFiles, 6);
  assert.deepEqual(scan.files.map((f) => f.name), ['informe.pdf']); // only file >= 4000 bytes stored
  const root = scan.dirs.find((d) => d.rel === '');
  assert.equal(root.size, scan.totalSize);
  assert.equal(root.fileCount, 6);
  const sub = scan.dirs.find((d) => d.rel === 'sub');
  assert.equal(sub.size, 3004);
  assert.equal(sub.fileCount, 2);
  assert.equal(scan.stats.largest[0].name, 'informe.pdf');
  const sum = summarize(scan);
  assert.equal(sum.junkCount, 1);
  assert.equal(sum.categories[0].category, 'Imágenes');
  assert.equal(sum.categories.reduce((a, c) => a + c.bytes, 0), scan.totalSize);

  const { listChildren } = require('../src/main/scanner');
  const level = listChildren(scan, '');
  assert.equal(level.dirs[0].rel, 'sub');
  assert.equal(level.files.length, 1);
  const subLevel = listChildren(scan, 'sub');
  assert.deepEqual(subLevel.crumbs.map((c) => c.rel), ['sub']);
  assert.equal(subLevel.files.length, 0); // small files not stored in disk mode
  assert.equal(listChildren(scan, 'nope'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('incremental refresh keeps totals exact after deleting, adding and moving files', async () => {
  const { removeSubtree, rescanSubtree, refreshDirShallow, refreshAffected } = require('../src/main/scanner');
  const dir = makeFixture();
  const scan = await scanDirectory(dir, { mode: 'disk', minStoreSize: 2000 });
  const before = summarize(scan);

  // 1) Delete a whole subfolder on disk, then refresh only its parent (shallow).
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  await refreshDirShallow(scan, '');
  let sum = summarize(scan);
  assert.equal(sum.totalFiles, before.totalFiles - 2);
  assert.equal(sum.totalSize, before.totalSize - 3004);
  assert.equal(scan.dirs.find((d) => d.rel === 'sub'), undefined);
  assert.equal(sum.categories.find((c) => c.category === 'Documentos'), undefined);

  // 2) Add a new folder with a big file; shallow refresh of root must walk it fully.
  fs.mkdirSync(path.join(dir, 'nueva', 'honda'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nueva', 'honda', 'grande.mp4'), Buffer.alloc(9000, 7));
  await refreshDirShallow(scan, '');
  sum = summarize(scan);
  assert.equal(scan.dirs.find((d) => d.rel === 'nueva/honda').size, 9000);
  assert.equal(scan.dirs.find((d) => d.rel === 'nueva').size, 9000);
  assert.equal(sum.totalSize, before.totalSize - 3004 + 9000);
  assert.equal(sum.largest[0].name, 'grande.mp4');
  assert.equal(sum.categories.find((c) => c.category === 'Videos').bytes, 9000);
  assert.ok(scan.files.some((f) => f.rel === 'nueva/honda/grande.mp4'));

  // 3) Move a root file into the new folder, refresh only the affected dirs.
  fs.renameSync(path.join(dir, 'informe.pdf'), path.join(dir, 'nueva', 'informe.pdf'));
  await refreshAffected(scan, ['informe.pdf', 'nueva/informe.pdf']);
  sum = summarize(scan);
  assert.equal(sum.totalSize, before.totalSize - 3004 + 9000);
  assert.equal(scan.dirs.find((d) => d.rel === 'nueva').size, 14000);
  assert.equal(scan.dirs.find((d) => d.rel === '').directFiles, 3);
  assert.ok(scan.files.some((f) => f.rel === 'nueva/informe.pdf'));
  assert.ok(!scan.files.some((f) => f.rel === 'informe.pdf'));

  // 4) Full subtree rescan of one folder after changing a file size.
  fs.writeFileSync(path.join(dir, 'nueva', 'honda', 'grande.mp4'), Buffer.alloc(1000, 7));
  await rescanSubtree(scan, 'nueva');
  sum = summarize(scan);
  assert.equal(scan.dirs.find((d) => d.rel === 'nueva').size, 6000);
  assert.equal(sum.totalSize, before.totalSize - 3004 + 1000);
  assert.equal(sum.categories.reduce((a, c) => a + c.bytes, 0), sum.totalSize);

  // 5) In-memory removal of a single file keeps categories consistent.
  removeSubtree(scan, 'Thumbs.db');
  sum = summarize(scan);
  assert.equal(sum.junkCount, 0);
  assert.equal(sum.categories.reduce((a, c) => a + c.bytes, 0), sum.totalSize);
  assert.equal(scan.dirs.find((d) => d.rel === '').directFiles, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
