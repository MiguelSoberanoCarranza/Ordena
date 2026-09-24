'use strict';
// Every channel the renderer can invoke through the preload bridge must have a handler in main.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('preload channels all have main-process handlers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const handled = new Set([...main.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));
  const invoked = [...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length > 20);
  const missing = invoked.filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], `Canales sin manejador: ${missing.join(', ')}`);
  for (const must of ['scan:start', 'scan:duplicates', 'ai:organize', 'ai:cleanup', 'ai:chat', 'ai:explain', 'ops:applyMoves', 'ops:trash', 'ops:trashPath', 'ops:relocate', 'ops:undo', 'ops:purge', 'ops:removeEmptyDirs', 'settings:get']) {
    assert.ok(handled.has(must), `falta ${must}`);
  }
});
