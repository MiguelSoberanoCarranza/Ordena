'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { DEFAULT_BASE_URL, DEFAULT_MODEL } = require('./minimax');

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  applyRulesToSubfolders: false,
  theme: 'system',
  deleteMode: 'quarantine',   // 'quarantine' (Ordena's recoverable folder) | 'trash' (system Recycle Bin)
  includeAppData: false,      // let the cleanup AI see application data (advanced)
};

/**
 * Persists settings in userData/settings.json. The API key is encrypted with Electron's
 * safeStorage (Keychain on macOS, DPAPI on Windows) when available.
 */
class Settings {
  constructor({ file, safeStorage }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.cache = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      this.cache = { ...DEFAULTS };
    }
    return this.cache;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  encryptionAvailable() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  /** Public view (never includes the key itself). */
  async getPublic() {
    const s = await this.load();
    return {
      baseUrl: s.baseUrl,
      model: s.model,
      applyRulesToSubfolders: Boolean(s.applyRulesToSubfolders),
      theme: s.theme,
      deleteMode: s.deleteMode === 'trash' ? 'trash' : 'quarantine',
      includeAppData: Boolean(s.includeAppData),
      hasApiKey: Boolean(s.apiKeyEncrypted || s.apiKeyPlain),
      apiKeyHint: s.apiKeyHint || '',
      encrypted: Boolean(s.apiKeyEncrypted),
      encryptionAvailable: this.encryptionAvailable(),
    };
  }

  async update(patch) {
    const s = await this.load();
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) s.baseUrl = patch.baseUrl.trim();
    if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim();
    if (typeof patch.applyRulesToSubfolders === 'boolean') s.applyRulesToSubfolders = patch.applyRulesToSubfolders;
    if (typeof patch.theme === 'string') s.theme = patch.theme;
    if (patch.deleteMode === 'trash' || patch.deleteMode === 'quarantine') s.deleteMode = patch.deleteMode;
    if (typeof patch.includeAppData === 'boolean') s.includeAppData = patch.includeAppData;
    if (typeof patch.apiKey === 'string') {
      const key = patch.apiKey.trim();
      delete s.apiKeyEncrypted;
      delete s.apiKeyPlain;
      delete s.apiKeyHint;
      if (key) {
        s.apiKeyHint = `…${key.slice(-4)}`;
        if (this.encryptionAvailable()) {
          s.apiKeyEncrypted = this.safeStorage.encryptString(key).toString('base64');
        } else {
          s.apiKeyPlain = key;
        }
      }
    }
    await this.save();
    return this.getPublic();
  }

  async getApiKey() {
    const s = await this.load();
    if (s.apiKeyEncrypted) {
      if (!this.encryptionAvailable()) throw new Error('No se puede descifrar la clave de API en este equipo. Vuelve a introducirla en Ajustes.');
      return this.safeStorage.decryptString(Buffer.from(s.apiKeyEncrypted, 'base64'));
    }
    if (s.apiKeyPlain) return s.apiKeyPlain;
    // Allow an environment variable for developers.
    return process.env.MINIMAX_API_KEY || '';
  }
}

module.exports = { Settings, DEFAULTS };
