'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { resolveInside, sanitizeRelPath } = require('../src/main/paths');

const root = path.resolve('/tmp/ordena-root');

test('resolveInside keeps paths inside root', () => {
  assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(resolveInside(root, 'a\\b.txt'), path.join(root, 'a', 'b.txt'));
});

test('resolveInside rejects escapes and absolute paths', () => {
  assert.throws(() => resolveInside(root, '../x'), /fuera/);
  assert.throws(() => resolveInside(root, 'a/../../x'), /fuera/);
  assert.throws(() => resolveInside(root, '/etc/passwd'), /absoluta/);
  assert.throws(() => resolveInside(root, 'C:\\Windows'), /absoluta/);
  assert.throws(() => resolveInside(root, ''), /vacía/);
  assert.throws(() => resolveInside(root, '.'), /fuera/);
});

test('sanitizeRelPath strips forbidden characters', () => {
  assert.equal(sanitizeRelPath('Docs/Fact:uras?/2024.'), 'Docs/Facturas/2024');
  assert.equal(sanitizeRelPath('./a//b/'), 'a/b');
});
