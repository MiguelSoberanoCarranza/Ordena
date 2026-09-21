'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, nativeTheme } = require('electron');
const path = require('path');
const { scanDirectory, summarize, findDuplicates } = require('./scanner');
const planner = require('./planner');
const minimax = require('./minimax');
const { Journal, applyMoves, undoMoves, trashFiles, removeEmptyDirs } = require('./operations');
const { Settings } = require('./settings');

const isMac = process.platform === 'darwin';
let mainWindow = null;

// In-memory session state (one scanned folder at a time).
const state = {
  scan: null,
  summary: null,
  duplicates: null,
  organizePlan: null,
  cleanupPlan: null,
  aiAbort: null,
};

const settings = new Settings({ file: path.join(app.getPath('userData'), 'settings.json'), safeStorage });
const journal = new Journal(path.join(app.getPath('userData'), 'journal.json'));

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'Ordena',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12141a' : '#f6f7fb',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Developer hooks: ORDENA_DEV_SCAN=<carpeta> analiza al arrancar; ORDENA_SCREENSHOT=<png> captura y cierra.
  mainWindow.webContents.once('did-finish-load', async () => {
    if (process.env.ORDENA_DEV_SCAN) send('dev:scan', process.env.ORDENA_DEV_SCAN);
    if (process.env.ORDENA_DEV_ACTION) setTimeout(() => send('dev:action', process.env.ORDENA_DEV_ACTION), 1200);
    if (process.env.ORDENA_SCREENSHOT) {
      const delay = Number(process.env.ORDENA_SCREENSHOT_DELAY || 2500);
      setTimeout(async () => {
        try {
          if (process.env.ORDENA_DEV_VIEW) send('dev:view', process.env.ORDENA_DEV_VIEW);
          await new Promise((r) => setTimeout(r, 400));
          const image = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.ORDENA_SCREENSHOT, image.toPNG());
          console.log(`screenshot: ${process.env.ORDENA_SCREENSHOT}`);
        } catch (err) {
          console.error('screenshot failed', err);
        }
        app.quit();
      }, delay);
    }
  });
}

function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'Acerca de Ordena' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Ordena' },
        { role: 'hideOthers', label: 'Ocultar otros' },
        { role: 'unhide', label: 'Mostrar todo' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir de Ordena' },
      ],
    }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir carpeta…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:openFolder') },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
        { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }, { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño real' }, { role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Obtener clave de API de MiniMax', click: () => shell.openExternal('https://platform.minimax.io/user-center/basic-information/interface-key') },
        { label: 'Código fuente', click: () => shell.openExternal('https://github.com/miguelsoberanocarranza/ordena') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- helpers -------------------------------------------------------------

function requireScan() {
  if (!state.scan) throw new Error('Primero analiza una carpeta.');
  return state.scan;
}

async function runAi(messages, { maxTokens } = {}) {
  const s = await settings.load();
  const apiKey = await settings.getApiKey();
  if (state.aiAbort) state.aiAbort.abort();
  const controller = new AbortController();
  state.aiAbort = controller;
  try {
    return await minimax.chat({ apiKey, baseUrl: s.baseUrl, model: s.model, messages, maxTokens, signal: controller.signal });
  } finally {
    if (state.aiAbort === controller) state.aiAbort = null;
  }
}

function serializeError(err) {
  return { message: err?.message || String(err), code: err?.code || null };
}

/** Wrap an IPC handler so errors reach the renderer as {ok:false,error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: serializeError(err) };
    }
  });
}

// ---- IPC ------------------------------------------------------------------

handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Elige la carpeta que quieres ordenar',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('downloads'),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

handle('app:commonFolders', async () => ({
  downloads: app.getPath('downloads'),
  desktop: app.getPath('desktop'),
  documents: app.getPath('documents'),
  pictures: app.getPath('pictures'),
  videos: app.getPath('videos'),
  music: app.getPath('music'),
}));

handle('scan:start', async (root) => {
  if (typeof root !== 'string' || !root) throw new Error('Carpeta inválida');
  const forbidden = [app.getPath('home'), path.parse(root).root];
  if (forbidden.includes(path.resolve(root))) {
    throw new Error('Por seguridad, elige una subcarpeta concreta (Descargas, Escritorio, Documentos…) en lugar de todo el disco o la carpeta de usuario.');
  }
  state.scan = null; state.summary = null; state.duplicates = null; state.organizePlan = null; state.cleanupPlan = null;
  const scan = await scanDirectory(root, { onProgress: (p) => send('scan:progress', p) });
  state.scan = scan;
  state.summary = summarize(scan);
  return { summary: state.summary, errors: scan.errors.slice(0, 50) };
});

handle('scan:duplicates', async () => {
  const scan = requireScan();
  const dupes = await findDuplicates(scan, { minSize: 1024, onProgress: (p) => send('dupes:progress', p) });
  state.duplicates = { ...dupes, groups: dupes.groups.slice(0, 500) };
  return state.duplicates;
});

handle('scan:files', async (query) => {
  const scan = requireScan();
  const q = String(query || '').toLowerCase();
  const list = q ? scan.files.filter((f) => f.rel.toLowerCase().includes(q)) : scan.files;
  return list.slice(0, 2000);
});

handle('ai:organize', async (options = {}) => {
  const scan = requireScan();
  const s = await settings.load();
  const messages = planner.buildOrganizeMessages(state.summary, scan.files, { instructions: options.instructions || '' });
  const res = await runAi(messages, { maxTokens: 12000 });
  const json = minimax.extractJson(res.rawContent);
  const plan = planner.buildOrganizePlan(json, scan, { applyRulesToSubfolders: Boolean(options.applyRulesToSubfolders ?? s.applyRulesToSubfolders) });
  state.organizePlan = plan;
  return { plan, usage: res.usage, model: res.model };
});

handle('ai:cleanup', async (options = {}) => {
  const scan = requireScan();
  if (!state.duplicates) {
    const dupes = await findDuplicates(scan, { minSize: 1024, onProgress: (p) => send('dupes:progress', p) });
    state.duplicates = { ...dupes, groups: dupes.groups.slice(0, 500) };
  }
  const messages = planner.buildCleanupMessages(state.summary, state.duplicates, { instructions: options.instructions || '' });
  const res = await runAi(messages, { maxTokens: 12000 });
  const json = minimax.extractJson(res.rawContent);
  const plan = planner.buildCleanupPlan(json, scan, state.duplicates);
  state.cleanupPlan = plan;
  return { plan, usage: res.usage, model: res.model, duplicates: state.duplicates };
});

handle('ai:chat', async (history) => {
  if (!Array.isArray(history)) throw new Error('Historial inválido');
  const messages = planner.buildChatMessages(state.summary, state.duplicates, history);
  const res = await runAi(messages, { maxTokens: 2048 });
  return { content: res.content, usage: res.usage };
});

handle('ai:cancel', async () => {
  if (state.aiAbort) state.aiAbort.abort();
  return true;
});

handle('ai:test', async () => {
  const res = await runAi([{ role: 'user', content: 'Responde solo con la palabra: OK' }], { maxTokens: 64 });
  return { content: res.content, model: res.model };
});

handle('ops:applyMoves', async (moves) => {
  const scan = requireScan();
  if (!Array.isArray(moves) || moves.length === 0) throw new Error('No hay movimientos seleccionados');
  const clean = moves.map((m) => ({ from: String(m.from), to: String(m.to) }));
  const result = await applyMoves(scan.root, clean, { journal, onProgress: (p) => send('ops:progress', p) });
  // Refresh inventory so later actions see the new layout.
  state.scan = await scanDirectory(scan.root);
  state.summary = summarize(state.scan);
  state.duplicates = null;
  return { ...result, summary: state.summary };
});

handle('ops:trash', async (paths) => {
  const scan = requireScan();
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('No hay archivos seleccionados');
  const result = await trashFiles(scan.root, paths.map(String), { journal, trashImpl: (abs) => shell.trashItem(abs), onProgress: (p) => send('ops:progress', p) });
  state.scan = await scanDirectory(scan.root);
  state.summary = summarize(state.scan);
  state.duplicates = null;
  return { ...result, summary: state.summary };
});

handle('ops:removeEmptyDirs', async (dirs) => {
  const scan = requireScan();
  const result = await removeEmptyDirs(scan.root, Array.isArray(dirs) ? dirs.map(String) : []);
  state.scan = await scanDirectory(scan.root);
  state.summary = summarize(state.scan);
  return { ...result, summary: state.summary };
});

handle('ops:journal', async () => (await journal.read()).slice().reverse());

handle('ops:undo', async (id) => {
  const entries = await journal.read();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('Operación no encontrada');
  if (entry.type !== 'move') throw new Error('Los archivos enviados a la Papelera se recuperan desde la Papelera del sistema.');
  if (entry.undone) throw new Error('Esta operación ya fue deshecha');
  const result = await undoMoves(entry, { journal });
  if (state.scan && state.scan.root === entry.root) {
    state.scan = await scanDirectory(entry.root);
    state.summary = summarize(state.scan);
    state.duplicates = null;
  }
  return { ...result, summary: state.summary };
});

handle('shell:reveal', async (rel) => {
  const scan = requireScan();
  const { resolveInside } = require('./paths');
  shell.showItemInFolder(resolveInside(scan.root, rel));
  return true;
});

handle('shell:open', async (rel) => {
  const scan = requireScan();
  const { resolveInside } = require('./paths');
  const err = await shell.openPath(resolveInside(scan.root, rel));
  if (err) throw new Error(err);
  return true;
});

handle('shell:openExternal', async (url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url);
  return true;
});

handle('shell:openTrash', async () => {
  if (isMac) await shell.openPath(path.join(app.getPath('home'), '.Trash'));
  else if (process.platform === 'win32') await shell.openExternal('shell:RecycleBinFolder');
  return true;
});

handle('settings:get', async () => settings.getPublic());
handle('settings:set', async (patch) => settings.update(patch || {}));
handle('settings:models', async () => minimax.KNOWN_MODELS);
handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') }));

// ---- lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
