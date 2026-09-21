'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../src/main/planner');
const { summarize } = require('../src/main/scanner');

const now = Date.now();
const file = (rel, size = 100, ageDays = 1, extra = {}) => {
  const name = rel.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return { rel, name, dir, ext, size, mtimeMs: now - ageDays * 86400000, category: 'Otros', depth: dir ? 1 : 0, junk: false, ...extra };
};
const scan = {
  root: '/tmp/x',
  totalSize: 1000,
  truncated: false,
  errors: [],
  files: [
    file('factura-2024.pdf', 200),
    file('factura-2023.pdf', 200, 500),
    file('vacaciones.jpg', 300),
    file('setup.exe', 100),
    file('Proyectos/app/index.js', 50),
    file('Docs/ya.pdf', 50),
    file('Docs/factura-2024.pdf', 60),
    file('node_modules/x/y.js', 10),
  ],
  dirs: [{ rel: '', empty: false, depth: 0, directFiles: 4 }, { rel: 'Proyectos', empty: false, depth: 1 }, { rel: 'Proyectos/app', empty: false, depth: 2 }, { rel: 'Docs', empty: false, depth: 1 }, { rel: 'node_modules', empty: false, depth: 1 }, { rel: 'node_modules/x', empty: false, depth: 2 }, { rel: 'vacia', empty: true, depth: 1 }],
};
scan.totalFiles = scan.files.length;
scan.stats = { categories: [], extensions: [], largest: [...scan.files].sort((a, b) => b.size - a.size), junk: [], junkBytes: 0, junkCount: 0 };

test('buildOrganizeMessages lists files and folder summary', () => {
  const msgs = planner.buildOrganizeMessages(summarize(scan), scan.files, { instructions: 'agrupa por año' });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /JSON/);
  assert.match(msgs[1].content, /factura-2024\.pdf/);
  assert.match(msgs[1].content, /agrupa por año/);
  assert.doesNotMatch(msgs[1].content, /node_modules\/x\/y\.js/);
});

test('buildOrganizePlan validates explicit moves', () => {
  const ai = {
    summary: 'ok',
    folders: [{ path: 'Documentos/Facturas', description: 'facturas' }],
    moves: [
      { from: 'factura-2024.pdf', to: 'Documentos/Facturas/factura-2024.pdf', reason: 'factura' },
      { from: 'factura-2023.pdf', to: 'Documentos/Facturas', reason: 'solo carpeta' },
      { from: 'vacaciones.jpg', to: '../fuera/vacaciones.jpg' },
      { from: 'no-existe.pdf', to: 'Documentos/no-existe.pdf' },
      { from: 'setup.exe', to: 'Instaladores/setup.txt' },
      { from: 'node_modules/x/y.js', to: 'Código/y.js' },
      { from: 'Docs/ya.pdf', to: 'Docs/ya.pdf' },
    ],
  };
  const plan = planner.buildOrganizePlan(ai, scan);
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to]), [
    ['factura-2024.pdf', 'Documentos/Facturas/factura-2024.pdf'],
    ['factura-2023.pdf', 'Documentos/Facturas/factura-2023.pdf'],
  ]);
  assert.equal(plan.rejected.length, 5);
  assert.match(plan.rejected.find((r) => r.from === 'vacaciones.jpg').reason, /fuera/);
  assert.equal(plan.folders[0].path, 'Documentos/Facturas');
  assert.equal(plan.totalBytes, 400);
  assert.ok(plan.moves[0].createsFolder);
});

test('buildOrganizePlan expands rules to root files only by default and avoids collisions', () => {
  const ai = {
    rules: [
      { name: 'PDF', extensions: ['pdf'], destination: 'Docs' },
      { name: 'Código', extensions: ['js'], destination: 'Código' },
    ],
    moves: [],
  };
  const plan = planner.buildOrganizePlan(ai, scan);
  const byFrom = Object.fromEntries(plan.moves.map((m) => [m.from, m.to]));
  assert.equal(byFrom['factura-2024.pdf'], 'Docs/factura-2024 (1).pdf'); // Docs/factura-2024.pdf exists
  assert.equal(byFrom['factura-2023.pdf'], 'Docs/factura-2023.pdf');
  assert.equal(byFrom['Proyectos/app/index.js'], undefined); // subfolder untouched
  assert.equal(byFrom['Docs/ya.pdf'], undefined);

  const deep = planner.buildOrganizePlan(ai, scan, { applyRulesToSubfolders: true });
  const deepFrom = Object.fromEntries(deep.moves.map((m) => [m.from, m.to]));
  assert.equal(deepFrom['Proyectos/app/index.js'], 'Código/index.js');
  assert.equal(deepFrom['node_modules/x/y.js'], undefined); // protected
});

test('buildOrganizePlan applies olderThanDays and namePattern', () => {
  const ai = { rules: [{ name: 'viejas', extensions: ['pdf'], namePattern: '^factura', olderThanDays: 365, destination: 'Archivo' }] };
  const plan = planner.buildOrganizePlan(ai, scan);
  assert.deepEqual(plan.moves.map((m) => m.from), ['factura-2023.pdf']);
});

test('buildCleanupPlan validates suggestions and completes duplicate groups', () => {
  const dupes = { groups: [{ size: 200, files: [scan.files[0], scan.files[6]], wastedBytes: 200 }], wastedBytes: 200 };
  const ai = {
    summary: 's',
    tips: ['vacía la papelera'],
    suggestions: [
      { path: 'setup.exe', reason: 'instalador viejo', confidence: 'alta', kind: 'instalador' },
      { path: 'fantasma.zip', reason: 'x', confidence: 'alta' },
      { path: 'vacaciones.jpg', reason: 'foto', confidence: 'rara' },
      { path: 'node_modules/x/y.js', reason: 'x', confidence: 'alta' },
    ],
  };
  const plan = planner.buildCleanupPlan(ai, scan, dupes);
  const paths = plan.suggestions.map((s) => s.path);
  assert.ok(paths.includes('setup.exe'));
  assert.ok(paths.includes('Docs/factura-2024.pdf')); // duplicate copy auto-added
  assert.ok(!paths.includes('factura-2024.pdf')); // keeper not suggested
  assert.ok(!paths.includes('fantasma.zip'));
  assert.equal(plan.suggestions.find((s) => s.path === 'vacaciones.jpg').confidence, 'baja');
  assert.equal(plan.rejected.length, 2);
  assert.deepEqual(plan.emptyDirs, ['vacia']);
  assert.equal(plan.tips[0], 'vacía la papelera');
});

test('buildChatMessages includes context and trims history', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const msgs = planner.buildChatMessages(summarize(scan), null, history);
  assert.equal(msgs.length, 21);
  assert.match(msgs[0].content, /aún no analizados/);
});

test('buildExplainMessages / buildExplainResult', () => {
  const items = [
    { path: 'C:\\Windows', size: 30e9, isDir: true, fileCount: 100000, kind: 'sistema', hint: { what: 'Windows', del: 'no', move: 'no' } },
    { path: 'C:\\Users\\m\\Videos', size: 80e9, isDir: true, fileCount: 300, kind: 'usuario', hint: null },
  ];
  const msgs = planner.buildExplainMessages('C:\\', items, { platform: 'win32', drives: [{ name: 'D:', path: 'D:\\', free: 5e11, total: 1e12 }] });
  assert.match(msgs[1].content, /Windows/);
  assert.match(msgs[1].content, /D:\\/);
  const res = planner.buildExplainResult({ summary: 's', items: [
    { path: 'C:\\Users\\m\\Videos', what: 'Tus vídeos', delete: 'parcial', move: 'Si', how: 'Propiedades → Ubicación', risk: 'bajo' },
    { path: 'C:\\otra', what: 'inventada', delete: 'sí', move: 'sí' },
  ], plan: ['Mover Vídeos a D:'] }, items);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].move, 'sí');
  assert.equal(res.items[0].delete, 'parcial');
  assert.deepEqual(res.plan, ['Mover Vídeos a D:']);
});

test('cleanup plan and prompt exclude protected paths', () => {
  const guard = (rel) => rel.startsWith('Windows/');
  const sys = file('Windows/Temp/x.tmp', 999, 400, { junk: true });
  const s2 = { ...scan, files: [...scan.files, sys], stats: { ...scan.stats, largest: [sys, ...scan.stats.largest], junk: [sys] } };
  s2.dirs = [...scan.dirs, { rel: 'Windows', empty: false, depth: 1 }, { rel: 'Windows/vacia', empty: true, depth: 2 }];
  const sum = summarize(s2);
  const msgs = planner.buildCleanupMessages(sum, null, { isProtected: guard });
  assert.doesNotMatch(msgs[1].content, /Windows\/Temp/);
  const plan = planner.buildCleanupPlan({ suggestions: [{ path: 'Windows/Temp/x.tmp', confidence: 'alta' }, { path: 'setup.exe', confidence: 'alta' }] }, s2, null, { isProtected: guard });
  assert.deepEqual(plan.suggestions.map((x) => x.path), ['setup.exe']);
  assert.equal(plan.rejected[0].reason, 'Carpeta protegida');
  assert.ok(!plan.emptyDirs.includes('Windows/vacia'));
  assert.ok(plan.emptyDirs.includes('vacia'));
});
