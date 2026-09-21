'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScanCache } = require('../src/main/cache');
const { scanDirectory, summarize, listChildren } = require('../src/main/scanner');

test('scan cache round-trips a scan and lists metadata', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ordena-cache-'));
  const data = path.join(base, 'data');
  fs.mkdirSync(path.join(data, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(data, 'a.pdf'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(data, 'sub', 'b.jpg'), Buffer.alloc(2000, 2));
  const scan = await scanDirectory(data);
  const cache = new ScanCache(path.join(base, 'cache'));

  assert.equal(await cache.meta(data), null);
  const meta = await cache.save(scan);
  assert.equal(meta.totalFiles, 2);
  assert.equal((await cache.meta(data)).totalSize, 5000);
  assert.equal((await cache.list()).length, 1);

  const loaded = await cache.load(data);
  assert.equal(loaded.root, scan.root);
  assert.equal(loaded.index, undefined); // index is rebuilt lazily after load
  assert.deepEqual(summarize(loaded).categories, summarize(scan).categories);
  assert.equal(listChildren(loaded, 'sub').files[0].name, 'b.jpg');

  await cache.remove(data);
  assert.equal(await cache.meta(data), null);
  fs.rmSync(base, { recursive: true, force: true });
});
