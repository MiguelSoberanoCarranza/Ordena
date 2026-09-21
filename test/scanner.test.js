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
