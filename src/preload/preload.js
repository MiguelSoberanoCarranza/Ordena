'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((res) => {
  if (!res || typeof res !== 'object') throw new Error('Respuesta IPC inválida');
  if (!res.ok) {
    const err = new Error(res.error?.message || 'Error desconocido');
    err.code = res.error?.code || null;
    throw err;
  }
  return res.data;
});

const on = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('ordena', {
  pickFolder: () => invoke('dialog:pickFolder'),
  commonFolders: () => invoke('app:commonFolders'),
  info: () => invoke('app:info'),
  targetInfo: (root) => invoke('app:targetInfo', root),
  drives: () => invoke('app:drives'),
  scan: (root, options) => invoke('scan:start', root, options),
  cancelScan: () => invoke('scan:cancel'),
  children: (rel) => invoke('scan:children', rel),
  pickDestination: () => invoke('dialog:pickDestination'),
  findDuplicates: () => invoke('scan:duplicates'),
  searchFiles: (q) => invoke('scan:files', q),
  ai: {
    organize: (options) => invoke('ai:organize', options),
    cleanup: (options) => invoke('ai:cleanup', options),
    chat: (history) => invoke('ai:chat', history),
    explain: (rels) => invoke('ai:explain', rels),
    cancel: () => invoke('ai:cancel'),
    test: () => invoke('ai:test'),
  },
  ops: {
    applyMoves: (moves) => invoke('ops:applyMoves', moves),
    trash: (paths) => invoke('ops:trash', paths),
    removeEmptyDirs: (dirs) => invoke('ops:removeEmptyDirs', dirs),
    relocate: (rel, destDir, options) => invoke('ops:relocate', rel, destDir, options),
    trashPath: (rel) => invoke('ops:trashPath', rel),
    journal: () => invoke('ops:journal'),
    undo: (id) => invoke('ops:undo', id),
  },
  shell: {
    reveal: (rel) => invoke('shell:reveal', rel),
    open: (rel) => invoke('shell:open', rel),
    openExternal: (url) => invoke('shell:openExternal', url),
    openTrash: () => invoke('shell:openTrash'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    models: () => invoke('settings:models'),
  },
  onScanProgress: (cb) => on('scan:progress', cb),
  onDupesProgress: (cb) => on('dupes:progress', cb),
  onOpsProgress: (cb) => on('ops:progress', cb),
  onMenuOpenFolder: (cb) => on('menu:openFolder', cb),
  onDevScan: (cb) => on('dev:scan', cb),
  onDevView: (cb) => on('dev:view', cb),
  onDevAction: (cb) => on('dev:action', cb),
});
