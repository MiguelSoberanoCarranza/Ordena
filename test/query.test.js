'use strict';
// The filtered listing lives in main.js as an IPC handler; this test mirrors its filtering logic
// through a small extracted helper to keep the contract stable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterFiles } = require('../src/main/query');

const now = Date.now();
const day = 86400000;
const f = (rel, size, ageDays, extra = {}) => {
  const name = rel.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return { rel, name, dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', ext, category: extra.category || 'Otros', size, mtimeMs: now - ageDays * day, junk: Boolean(extra.junk) };
};
const files = [
  f('Users/m/Downloads/setup.exe', 300e6, 400, { category: 'Instaladores' }),
  f('Users/m/Downloads/app.dmg', 100e6, 10, { category: 'Instaladores' }),
  f('Users/m/Videos/v.mp4', 900e6, 200, { category: 'Videos' }),
  f('Windows/Temp/x.tmp', 5e6, 50, { junk: true }),
  f('notas', 2e6, 1),
];

test('filterFiles by category, ext, age, junk, oldLarge, dir, search and sort', () => {
  assert.deepEqual(filterFiles(files, { category: 'Instaladores' }).list.map((x) => x.name), ['setup.exe', 'app.dmg']);
  assert.deepEqual(filterFiles(files, { ext: 'dmg' }).list.map((x) => x.name), ['app.dmg']);
  assert.deepEqual(filterFiles(files, { ext: '(sin extensión)' }).list.map((x) => x.name), ['notas']);
  assert.deepEqual(filterFiles(files, { age: '> 1 año' }).list.map((x) => x.name), ['setup.exe']);
  assert.deepEqual(filterFiles(files, { age: '30-180 días' }).list.map((x) => x.name), ['x.tmp']);
  assert.deepEqual(filterFiles(files, { junk: true }).list.map((x) => x.name), ['x.tmp']);
  assert.deepEqual(filterFiles(files, { oldLarge: true }, now).list.map((x) => x.name), ['v.mp4', 'setup.exe']);
  assert.deepEqual(filterFiles(files, { dir: 'Users/m/Downloads' }).list.map((x) => x.name), ['setup.exe', 'app.dmg']);
  assert.deepEqual(filterFiles(files, { search: 'SETUP' }).list.map((x) => x.name), ['setup.exe']);
  assert.deepEqual(filterFiles(files, { sort: 'date' }).list.map((x) => x.name), ['setup.exe', 'v.mp4', 'x.tmp', 'app.dmg', 'notas']);
  assert.deepEqual(filterFiles(files, { sort: 'name' }).list.map((x) => x.name), ['app.dmg', 'notas', 'setup.exe', 'v.mp4', 'x.tmp']);
  const r = filterFiles(files, { category: 'Instaladores' });
  assert.equal(r.totalBytes, 400e6);
  assert.deepEqual(r.topDirs[0], { dir: 'Users/m/Downloads', bytes: 400e6, count: 2 });
});
