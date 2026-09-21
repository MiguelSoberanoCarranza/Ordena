'use strict';

/* global ordena */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  root: null,
  summary: null,
  duplicates: null,
  organizePlan: null,
  cleanupPlan: null,
  chat: [],
  settings: null,
  busy: false,
};

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('es', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtInt(n) { return Number(n || 0).toLocaleString('es'); }

function pathHtml(rel) {
  const idx = rel.lastIndexOf('/');
  if (idx === -1) return `<span class="path">${esc(rel)}</span>`;
  return `<span class="path"><span class="dir">${esc(rel.slice(0, idx + 1))}</span>${esc(rel.slice(idx + 1))}</span>`;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

function confirmDialog({ title, bodyHtml, okText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    const ok = $('#modalOk');
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    modal.hidden = false;
    const done = (v) => { modal.hidden = true; ok.onclick = null; $('#modalCancel').onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

function setBusy(v) {
  state.busy = v;
  $$('.btn-primary, .btn-danger').forEach((b) => { if (!b.closest('#modal')) b.disabled = v; });
}

// ---------- navigation ----------

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettingsForm();
}

function updateNavAvailability() {
  $$('[data-needs-scan]').forEach((b) => { b.disabled = !state.summary; });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn && !btn.disabled) showView(btn.dataset.view);
});

// ---------- settings / API status ----------

async function refreshSettings() {
  state.settings = await ordena.settings.get();
  const badge = $('#apiBadge');
  const banner = $('#apiBanner');
  if (state.settings.hasApiKey) {
    badge.textContent = `MiniMax · ${state.settings.model}`;
    badge.className = 'api-badge ok';
    banner.hidden = true;
  } else {
    badge.textContent = 'Sin clave de API';
    badge.className = 'api-badge missing';
    banner.hidden = false;
  }
}

async function loadSettingsForm() {
  await refreshSettings();
  const s = state.settings;
  $('#apiKey').value = '';
  $('#apiKey').placeholder = s.hasApiKey ? `Clave guardada ${s.apiKeyHint} (escribe otra para reemplazarla)` : 'Pega aquí tu clave de MiniMax';
  $('#apiKeyStatus').textContent = s.hasApiKey
    ? (s.encrypted ? 'Clave guardada y cifrada con el almacén seguro del sistema.' : 'Clave guardada sin cifrar: este equipo no ofrece almacén seguro.')
    : 'Aún no hay clave guardada.';
  $('#model').value = s.model;
  $('#baseUrl').value = s.baseUrl;
  $('#settingSubfolders').checked = s.applyRulesToSubfolders;
  $('#organizeSubfolders').checked = s.applyRulesToSubfolders;
  const models = await ordena.settings.models();
  $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

$('#btnToggleKey').addEventListener('click', () => {
  const input = $('#apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('#btnToggleKey').textContent = show ? 'Ocultar' : 'Mostrar';
});

$('#btnSaveSettings').addEventListener('click', async () => {
  const patch = {
    model: $('#model').value,
    baseUrl: $('#baseUrl').value,
    applyRulesToSubfolders: $('#settingSubfolders').checked,
  };
  const key = $('#apiKey').value.trim();
  if (key) patch.apiKey = key;
  try {
    await ordena.settings.set(patch);
    $('#settingsStatus').textContent = 'Guardado ✓';
    setTimeout(() => { $('#settingsStatus').textContent = ''; }, 2500);
    await loadSettingsForm();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#settingSubfolders').addEventListener('change', (e) => ordena.settings.set({ applyRulesToSubfolders: e.target.checked }).catch(() => {}));

$('#btnTestApi').addEventListener('click', async () => {
  const key = $('#apiKey').value.trim();
  const status = $('#settingsStatus');
  status.textContent = 'Probando…';
  try {
    if (key) await ordena.settings.set({ apiKey: key, model: $('#model').value, baseUrl: $('#baseUrl').value });
    const r = await ordena.ai.test();
    status.textContent = `Conexión correcta ✓ (${r.model})`;
    await loadSettingsForm();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

$('#linkGetKey').addEventListener('click', (e) => {
  e.preventDefault();
  ordena.shell.openExternal('https://platform.minimax.io/user-center/basic-information/interface-key');
});

// ---------- folder selection & scan ----------

async function scanFolder(root) {
  if (!root) return;
  const progress = $('#scanProgress');
  progress.hidden = false;
  $('#scanProgressText').textContent = '';
  setBusy(true);
  try {
    const { summary, errors } = await ordena.scan(root);
    state.root = root;
    state.summary = summary;
    state.duplicates = null;
    state.organizePlan = null;
    state.cleanupPlan = null;
    $('#organizeResult').hidden = true;
    $('#cleanupResult').hidden = true;
    $('#dupesCard').hidden = true;
    $('#folderPill').hidden = false;
    $('#folderPath').textContent = root;
    $('#folderPath').title = root;
    renderAnalysis(errors);
    updateNavAvailability();
    showView('analysis');
    if (summary.truncated) toast('La carpeta es muy grande: se analizaron los primeros 60 000 archivos.', 'error');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    progress.hidden = true;
    setBusy(false);
  }
}

ordena.onScanProgress((p) => {
  $('#scanProgressText').textContent = `${fmtInt(p.files)} archivos · ${fmtBytes(p.bytes)}`;
});

$('#btnPick').addEventListener('click', async () => scanFolder(await ordena.pickFolder()));
$('#btnChangeFolder').addEventListener('click', async () => scanFolder(await ordena.pickFolder()));
$('#btnRescan').addEventListener('click', () => scanFolder(state.root));
ordena.onMenuOpenFolder(async () => scanFolder(await ordena.pickFolder()));
ordena.onDevScan((root) => scanFolder(root));
ordena.onDevView((view) => showView(view));
ordena.onDevAction((action) => { const b = { organize: '#btnOrganize', cleanup: '#btnCleanup', dupes: '#btnDupes' }[action]; if (b) $(b).click(); });

async function renderQuickFolders() {
  const folders = await ordena.commonFolders();
  const labels = { downloads: 'Descargas', desktop: 'Escritorio', documents: 'Documentos', pictures: 'Imágenes', videos: 'Videos', music: 'Música' };
  $('#quickFolders').innerHTML = Object.entries(folders)
    .filter(([, p]) => p)
    .map(([k, p]) => `<button class="quick-folder" data-path="${esc(p)}"><strong>${labels[k]}</strong><span>${esc(p)}</span></button>`)
    .join('');
  $$('.quick-folder').forEach((b) => b.addEventListener('click', () => scanFolder(b.dataset.path)));
}

// ---------- analysis ----------

function barsHtml(rows, total) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return rows.map((r) => `
    <div class="bar-row" title="${esc(r.label)}: ${fmtBytes(r.value)} (${total ? Math.round((r.value / total) * 100) : 0}%)${r.sub ? ' · ' + esc(r.sub) : ''}">
      <span class="bar-label">${esc(r.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (r.value / max) * 100)}%"></div></div>
      <span class="bar-value">${fmtBytes(r.value)}</span>
    </div>`).join('');
}

function renderAnalysis(errors = []) {
  const s = state.summary;
  if (!s) return;
  const tiles = [
    { label: 'Archivos', value: fmtInt(s.totalFiles), sub: `${fmtInt(s.totalDirs - 1)} subcarpetas` },
    { label: 'Espacio total', value: fmtBytes(s.totalSize) },
    { label: 'Sueltos en la raíz', value: fmtInt(s.rootFiles), sub: 'candidatos a organizar' },
    { label: 'Temporales / basura', value: fmtBytes(s.junkBytes), sub: `${fmtInt(s.junk.length)} archivos` },
    { label: 'Grandes sin uso', value: fmtBytes(s.oldLarge.reduce((a, f) => a + f.size, 0)), sub: '≥ 50 MB y +180 días' },
    { label: 'Carpetas vacías', value: fmtInt(s.emptyDirs.length) },
  ];
  if (state.duplicates) tiles.push({ label: 'Duplicados', value: fmtBytes(state.duplicates.wastedBytes), sub: `${fmtInt(state.duplicates.groups.length)} grupos` });
  $('#tiles').innerHTML = tiles.map((t) => `<div class="tile"><div class="tile-label">${t.label}</div><div class="tile-value">${t.value}</div>${t.sub ? `<div class="tile-sub">${t.sub}</div>` : ''}</div>`).join('');

  $('#categoryBars').innerHTML = barsHtml(s.categories.slice(0, 10).map((c) => ({ label: c.category, value: c.bytes, sub: `${fmtInt(c.count)} archivos` })), s.totalSize) || '<div class="empty">Sin archivos</div>';
  $('#ageBars').innerHTML = barsHtml(Object.entries(s.ageBuckets).map(([k, v]) => ({ label: k, value: v })), s.totalSize);
  $('#extChips').innerHTML = s.extensions.slice(0, 14).map((e) => `<span class="chip"><strong>.${esc(e.ext)}</strong> ${fmtBytes(e.bytes)} · ${fmtInt(e.count)}</span>`).join('');

  $('#largestTable tbody').innerHTML = s.largest.slice(0, 20).map((f) => `
    <tr>
      <td>${pathHtml(f.rel)}</td>
      <td><span class="badge badge-neutral">${esc(f.category)}</span></td>
      <td>${fmtDate(f.mtimeMs)}</td>
      <td class="num">${fmtBytes(f.size)}</td>
      <td><button class="btn-link" data-reveal="${esc(f.rel)}">Mostrar</button></td>
    </tr>`).join('');

  const errCard = $('#errorsCard');
  if (errors.length) {
    errCard.hidden = false;
    $('#errorsList').innerHTML = errors.map((e) => `<li><code>${esc(e.path)}</code> — ${esc(e.error)}</li>`).join('') + (s.errorCount > errors.length ? `<li>… y ${s.errorCount - errors.length} más</li>` : '');
  } else errCard.hidden = true;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (b) ordena.shell.reveal(b.dataset.reveal).catch((err) => toast(err.message, 'error'));
});

function renderDuplicates() {
  const d = state.duplicates;
  const card = $('#dupesCard');
  if (!d) { card.hidden = true; return; }
  card.hidden = false;
  $('#dupesSummary').textContent = d.groups.length ? `· ${fmtInt(d.duplicateFiles)} copias de más en ${fmtInt(d.groups.length)} grupos · ${fmtBytes(d.wastedBytes)} recuperables` : '· no se encontraron duplicados';
  $('#dupesList').innerHTML = d.groups.slice(0, 60).map((g) => `
    <div class="dupe-group">
      <div class="dupe-group-title">${g.files.length} copias · ${fmtBytes(g.size)} cada una · ${fmtBytes(g.wastedBytes)} recuperables</div>
      ${g.files.map((f, i) => `<div class="dupe-file ${i === 0 ? 'keep' : ''}">${esc(f.rel)}</div>`).join('')}
    </div>`).join('') + (d.groups.length > 60 ? `<p class="small muted">Mostrando 60 de ${d.groups.length} grupos.</p>` : '');
}

$('#btnDupes').addEventListener('click', async () => {
  const btn = $('#btnDupes');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    state.duplicates = await ordena.findDuplicates();
    renderAnalysis();
    renderDuplicates();
    toast(state.duplicates.groups.length ? `${fmtBytes(state.duplicates.wastedBytes)} en duplicados` : 'No hay duplicados exactos', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar duplicados';
  }
});

ordena.onDupesProgress((p) => {
  if (!p.done) {
    $('#btnDupes').textContent = `Comparando ${fmtInt(p.processed)}/${fmtInt(p.total)}…`;
    $('#cleanupProgressText').textContent = `Buscando duplicados… ${fmtInt(p.processed)}/${fmtInt(p.total)}`;
  } else {
    $('#cleanupProgressText').textContent = 'MiniMax está evaluando qué se puede eliminar…';
  }
});

// ---------- organize ----------

function renderOrganizePlan() {
  const plan = state.organizePlan;
  $('#organizeResult').hidden = !plan;
  if (!plan) return;
  $('#organizeSummary').textContent = plan.summary || 'Plan generado.';
  $('#organizeFolders').innerHTML = plan.folders.map((f) => `<span class="chip" title="${esc(f.description)}">📁 <strong>${esc(f.path)}</strong></span>`).join('');
  $('#organizeRejected').textContent = plan.rejected.length ? `Se descartaron ${plan.rejected.length} propuestas no válidas de la IA (rutas inexistentes o inseguras).` : '';

  if (plan.moves.length === 0) {
    $('#movesList').innerHTML = '<div class="empty">La IA no propuso movimientos. Prueba con instrucciones más concretas o activa las reglas en subcarpetas.</div>';
    updateMovesSelection();
    return;
  }
  const groups = new Map();
  for (const m of plan.moves) {
    const dir = m.to.includes('/') ? m.to.slice(0, m.to.lastIndexOf('/')) : '(raíz)';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(m);
  }
  $('#movesList').innerHTML = [...groups.entries()].map(([dir, moves]) => `
    <div class="move-group">
      <div class="move-group-header">
        <input type="checkbox" class="group-check" data-group="${esc(dir)}" checked />
        <span>📁</span><span class="path">${esc(dir)}</span>
        <span class="muted small">· ${moves.length} archivo${moves.length === 1 ? '' : 's'} · ${fmtBytes(moves.reduce((a, m) => a + m.size, 0))}</span>
      </div>
      ${moves.map((m) => {
        const idx = plan.moves.indexOf(m);
        const renamed = m.from.split('/').pop() !== m.to.split('/').pop();
        return `
        <label class="move-row">
          <input type="checkbox" class="move-check" data-index="${idx}" data-group="${esc(dir)}" checked />
          <div>
            ${pathHtml(m.from)}${renamed ? ` → <span class="path">${esc(m.to.split('/').pop())}</span>` : ''}
            <span class="tag">${m.source === 'rule' ? 'regla' : 'IA'}</span>
            ${m.reason ? `<div class="reason">${esc(m.reason)}</div>` : ''}
          </div>
          <span class="size">${fmtBytes(m.size)}</span>
        </label>`;
      }).join('')}
    </div>`).join('');

  $$('.group-check').forEach((g) => g.addEventListener('change', () => {
    $$(`.move-check[data-group="${CSS.escape(g.dataset.group)}"]`).forEach((c) => { c.checked = g.checked; });
    updateMovesSelection();
  }));
  $$('.move-check').forEach((c) => c.addEventListener('change', updateMovesSelection));
  updateMovesSelection();
}

function selectedMoves() {
  const plan = state.organizePlan;
  if (!plan) return [];
  return $$('.move-check:checked').map((c) => plan.moves[Number(c.dataset.index)]);
}

function updateMovesSelection() {
  const sel = selectedMoves();
  const bytes = sel.reduce((a, m) => a + m.size, 0);
  $('#movesSelectedText').textContent = sel.length ? `${sel.length} movimiento${sel.length === 1 ? '' : 's'} seleccionado${sel.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}` : 'Nada seleccionado';
  $('#btnApplyMoves').disabled = sel.length === 0 || state.busy;
  $('#btnApplyMoves').textContent = sel.length ? `Aplicar ${sel.length} movimiento${sel.length === 1 ? '' : 's'}` : 'Aplicar movimientos';
}

$('#orgSelectAll').addEventListener('click', () => { $$('.move-check, .group-check').forEach((c) => { c.checked = true; }); updateMovesSelection(); });
$('#orgSelectNone').addEventListener('click', () => { $$('.move-check, .group-check').forEach((c) => { c.checked = false; }); updateMovesSelection(); });

$('#btnOrganize').addEventListener('click', async () => {
  if (!state.settings?.hasApiKey) { showView('settings'); toast('Configura primero tu clave de MiniMax', 'error'); return; }
  $('#organizeProgress').hidden = false;
  $('#btnOrganizeCancel').hidden = false;
  setBusy(true);
  try {
    const { plan } = await ordena.ai.organize({
      instructions: $('#organizeInstructions').value,
      applyRulesToSubfolders: $('#organizeSubfolders').checked,
    });
    state.organizePlan = plan;
    renderOrganizePlan();
    toast(`Plan listo: ${plan.moves.length} movimientos propuestos`, 'ok');
  } catch (err) {
    if (err.code !== 'ABORTED') toast(err.message, 'error');
  } finally {
    $('#organizeProgress').hidden = true;
    $('#btnOrganizeCancel').hidden = true;
    setBusy(false);
    updateMovesSelection();
  }
});
$('#btnOrganizeCancel').addEventListener('click', () => ordena.ai.cancel());

$('#btnApplyMoves').addEventListener('click', async () => {
  const moves = selectedMoves();
  if (!moves.length) return;
  const newDirs = new Set(moves.filter((m) => m.createsFolder).map((m) => m.to.slice(0, m.to.lastIndexOf('/'))));
  const ok = await confirmDialog({
    title: `¿Mover ${moves.length} archivo${moves.length === 1 ? '' : 's'}?`,
    bodyHtml: `<p>Se moverán <strong>${moves.length}</strong> archivos (${fmtBytes(moves.reduce((a, m) => a + m.size, 0))}) dentro de la carpeta analizada.` +
      (newDirs.size ? ` Se crearán ${newDirs.size} carpeta${newDirs.size === 1 ? '' : 's'} nueva${newDirs.size === 1 ? '' : 's'}.` : '') +
      '</p><p class="small muted">Podrás deshacerlo desde Historial.</p>',
    okText: 'Mover archivos',
  });
  if (!ok) return;
  setBusy(true);
  try {
    const res = await ordena.ops.applyMoves(moves.map((m) => ({ from: m.from, to: m.to })));
    state.summary = res.summary;
    state.duplicates = null;
    state.organizePlan = null;
    renderAnalysis();
    renderDuplicates();
    renderOrganizePlan();
    toast(res.failed.length ? `${res.done.length} movidos, ${res.failed.length} fallaron: ${res.failed[0].error}` : `${res.done.length} archivos movidos ✓`, res.failed.length ? 'error' : 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

// ---------- cleanup ----------

function renderCleanupPlan() {
  const plan = state.cleanupPlan;
  $('#cleanupResult').hidden = !plan;
  if (!plan) return;
  $('#cleanupSummary').textContent = plan.summary || 'Análisis completado.';
  $('#cleanupTips').innerHTML = plan.tips.map((t) => `<li>${esc(t)}</li>`).join('');
  const visible = new Set($$('.conf-filter:checked').map((c) => c.value));
  $('#cleanupTable tbody').innerHTML = plan.suggestions.length ? plan.suggestions.map((s, i) => `
    <tr data-conf="${s.confidence}" ${visible.has(s.confidence) ? '' : 'hidden'}>
      <td><input type="checkbox" class="cl-check" data-index="${i}" ${s.confidence === 'alta' ? 'checked' : ''} /></td>
      <td>${pathHtml(s.path)}<div class="small muted">${esc(s.category)} · ${fmtDate(s.mtimeMs)}</div></td>
      <td class="small">${esc(s.reason)}</td>
      <td><span class="badge badge-${s.confidence}">${s.confidence}</span><div class="small muted">${esc(s.kind)}</div></td>
      <td class="num">${fmtBytes(s.size)}</td>
      <td><button class="btn-link" data-reveal="${esc(s.path)}">Mostrar</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">La IA no encontró nada que valga la pena eliminar.</td></tr>';
  $$('.cl-check').forEach((c) => c.addEventListener('change', updateCleanupSelection));
  updateCleanupSelection();

  const emptyCard = $('#emptyDirsCard');
  if (plan.emptyDirs.length) {
    emptyCard.hidden = false;
    $('#emptyDirsCount').textContent = `· ${plan.emptyDirs.length}`;
    $('#emptyDirsList').innerHTML = plan.emptyDirs.slice(0, 40).map((d) => `<span class="chip">${esc(d)}</span>`).join('') + (plan.emptyDirs.length > 40 ? `<span class="chip">… y ${plan.emptyDirs.length - 40} más</span>` : '');
  } else emptyCard.hidden = true;
}

function applyConfFilter() {
  const visible = new Set($$('.conf-filter:checked').map((c) => c.value));
  $$('#cleanupTable tbody tr[data-conf]').forEach((tr) => { tr.hidden = !visible.has(tr.dataset.conf); });
  updateCleanupSelection();
}
$$('.conf-filter').forEach((c) => c.addEventListener('change', applyConfFilter));

function selectedCleanup() {
  const plan = state.cleanupPlan;
  if (!plan) return [];
  return $$('.cl-check:checked').filter((c) => !c.closest('tr').hidden).map((c) => plan.suggestions[Number(c.dataset.index)]);
}

function updateCleanupSelection() {
  const sel = selectedCleanup();
  const bytes = sel.reduce((a, s) => a + s.size, 0);
  $('#cleanupSelectedText').textContent = sel.length ? `${sel.length} archivo${sel.length === 1 ? '' : 's'} · liberarías ${fmtBytes(bytes)}` : 'Nada seleccionado';
  $('#btnTrash').disabled = sel.length === 0 || state.busy;
  $('#btnTrash').textContent = sel.length ? `Enviar ${sel.length} a la Papelera (${fmtBytes(bytes)})` : 'Enviar a la Papelera';
}

$('#clSelectAll').addEventListener('click', () => { $$('#cleanupTable tbody tr:not([hidden]) .cl-check').forEach((c) => { c.checked = true; }); updateCleanupSelection(); });
$('#clSelectNone').addEventListener('click', () => { $$('.cl-check').forEach((c) => { c.checked = false; }); updateCleanupSelection(); });

$('#btnCleanup').addEventListener('click', async () => {
  if (!state.settings?.hasApiKey) { showView('settings'); toast('Configura primero tu clave de MiniMax', 'error'); return; }
  $('#cleanupProgress').hidden = false;
  $('#cleanupProgressText').textContent = state.duplicates ? 'MiniMax está evaluando qué se puede eliminar…' : 'Buscando duplicados…';
  $('#btnCleanupCancel').hidden = false;
  setBusy(true);
  try {
    const { plan, duplicates } = await ordena.ai.cleanup({ instructions: $('#cleanupInstructions').value });
    state.cleanupPlan = plan;
    state.duplicates = duplicates;
    renderAnalysis();
    renderDuplicates();
    renderCleanupPlan();
    toast(`${plan.suggestions.length} sugerencias · hasta ${fmtBytes(plan.totalBytes)} recuperables`, 'ok');
  } catch (err) {
    if (err.code !== 'ABORTED') toast(err.message, 'error');
  } finally {
    $('#cleanupProgress').hidden = true;
    $('#btnCleanupCancel').hidden = true;
    setBusy(false);
    updateCleanupSelection();
  }
});
$('#btnCleanupCancel').addEventListener('click', () => ordena.ai.cancel());

$('#btnTrash').addEventListener('click', async () => {
  const sel = selectedCleanup();
  if (!sel.length) return;
  const low = sel.filter((s) => s.confidence === 'baja').length;
  const ok = await confirmDialog({
    title: `¿Enviar ${sel.length} archivo${sel.length === 1 ? '' : 's'} a la Papelera?`,
    bodyHtml: `<p>Liberarás aproximadamente <strong>${fmtBytes(sel.reduce((a, s) => a + s.size, 0))}</strong>. Los archivos van a la Papelera del sistema y podrás recuperarlos desde allí.</p>` +
      (low ? `<p class="small" style="color:var(--danger)">Atención: ${low} de ellos tienen confianza baja. Revísalos antes de continuar.</p>` : ''),
    okText: 'Enviar a la Papelera',
    danger: true,
  });
  if (!ok) return;
  setBusy(true);
  try {
    const res = await ordena.ops.trash(sel.map((s) => s.path));
    state.summary = res.summary;
    state.duplicates = null;
    const removed = new Set(res.done.map((d) => d.path));
    state.cleanupPlan.suggestions = state.cleanupPlan.suggestions.filter((s) => !removed.has(s.path));
    renderAnalysis();
    renderDuplicates();
    renderCleanupPlan();
    toast(res.failed.length ? `${res.done.length} enviados, ${res.failed.length} fallaron: ${res.failed[0].error}` : `Liberados ${fmtBytes(res.bytes)} ✓`, res.failed.length ? 'error' : 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('#btnRemoveEmpty').addEventListener('click', async () => {
  const dirs = state.cleanupPlan?.emptyDirs || [];
  if (!dirs.length) return;
  const ok = await confirmDialog({ title: `¿Eliminar ${dirs.length} carpetas vacías?`, bodyHtml: '<p>Solo se eliminan carpetas que no contienen ningún archivo.</p>', okText: 'Eliminar' });
  if (!ok) return;
  try {
    const res = await ordena.ops.removeEmptyDirs(dirs);
    state.summary = res.summary;
    state.cleanupPlan.emptyDirs = res.failed.map((f) => f.path);
    renderAnalysis();
    renderCleanupPlan();
    toast(`${res.done.length} carpetas eliminadas`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- chat ----------

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.textContent = text;
  $('#chatMessages').appendChild(el);
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  return el;
}

async function sendChat(text) {
  const q = text.trim();
  if (!q) return;
  if (!state.settings?.hasApiKey) { showView('settings'); toast('Configura primero tu clave de MiniMax', 'error'); return; }
  addMsg('user', q);
  state.chat.push({ role: 'user', content: q });
  $('#chatInput').value = '';
  $('#btnChatSend').disabled = true;
  const pending = addMsg('assistant', '…');
  try {
    const { content } = await ordena.ai.chat(state.chat);
    pending.textContent = content;
    state.chat.push({ role: 'assistant', content });
  } catch (err) {
    pending.className = 'msg msg-error';
    pending.textContent = err.message;
    state.chat.pop();
  } finally {
    $('#btnChatSend').disabled = false;
    $('#chatInput').focus();
  }
}

$('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chatInput').value); });
$$('#chatSuggestions .chip-btn').forEach((b) => b.addEventListener('click', () => sendChat(b.textContent)));
$('#btnChatClear').addEventListener('click', () => {
  state.chat = [];
  $('#chatMessages').innerHTML = '<div class="msg msg-assistant">Conversación reiniciada. ¿Qué quieres saber de tu carpeta?</div>';
});

// ---------- history ----------

async function loadHistory() {
  const list = $('#historyList');
  try {
    const entries = await ordena.ops.journal();
    if (!entries.length) { list.innerHTML = '<div class="card empty">Todavía no has realizado operaciones.</div>'; return; }
    list.innerHTML = entries.map((e) => `
      <div class="card history-item ${e.undone ? 'undone' : ''}">
        <div>
          <div><strong>${e.type === 'move' ? `Movidos ${e.count} archivos` : `Enviados ${e.count} archivos a la Papelera${e.bytes ? ` (${fmtBytes(e.bytes)})` : ''}`}</strong>${e.undone ? ' <span class="badge badge-neutral">deshecho</span>' : ''}</div>
          <div class="meta">${new Date(e.at).toLocaleString('es')} · <span class="path">${esc(e.root)}</span></div>
          <details><summary>Ver detalle</summary><ul>${e.entries.slice(0, 200).map((x) => `<li>${esc(x.from ?? x.path)}${x.to ? ` → ${esc(x.to)}` : ''}</li>`).join('')}</ul></details>
        </div>
        ${e.type === 'move' && !e.undone ? `<button class="btn" data-undo="${e.id}">Deshacer</button>` : ''}
      </div>`).join('');
    $$('[data-undo]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '¿Deshacer estos movimientos?', bodyHtml: '<p>Los archivos volverán a su ubicación anterior y se eliminarán las carpetas que quedaron vacías.</p>', okText: 'Deshacer' });
      if (!ok) return;
      b.disabled = true;
      try {
        const res = await ordena.ops.undo(b.dataset.undo);
        if (res.summary) { state.summary = res.summary; state.duplicates = null; state.organizePlan = null; renderAnalysis(); renderDuplicates(); renderOrganizePlan(); }
        toast(res.failed.length ? `${res.restored.length} restaurados, ${res.failed.length} fallaron` : `${res.restored.length} archivos restaurados ✓`, res.failed.length ? 'error' : 'ok');
        loadHistory();
      } catch (err) {
        toast(err.message, 'error');
        b.disabled = false;
      }
    }));
  } catch (err) {
    list.innerHTML = `<div class="card">${esc(err.message)}</div>`;
  }
}

$('#btnOpenTrash').addEventListener('click', () => ordena.shell.openTrash().catch(() => {}));

// ---------- ops progress ----------
ordena.onOpsProgress((p) => {
  if (p.total > 20) toast(`Procesando ${p.current}/${p.total}…`);
});

// ---------- init ----------

(async function init() {
  const info = await ordena.info();
  document.body.classList.toggle('mac', info.platform === 'darwin');
  $('#version').textContent = `v${info.version}`;
  $('#appInfo').textContent = `Ordena ${info.version} · ${info.platform} · datos en ${info.userData}`;
  await refreshSettings();
  await renderQuickFolders();
  updateNavAvailability();
})();
