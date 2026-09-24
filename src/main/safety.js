'use strict';

// Ownership / risk classification of paths. Every directory gets a tier:
//   'sistema'    : operating system or installed programs -> never touched
//   'aplicacion' : data owned by an application or game -> deleting may break it; never auto-suggested
//   'cache'      : regenerable caches/temp -> safe to delete, the app rebuilds them
//   'usuario'    : the person's own folders (Descargas, Documentos, Escritorio…) -> normal
//   'otro'       : anything else (custom folders, external disks)
// `owner` names the application when we can tell (shown in the UI and sent to the AI).

const path = require('path');

const P = { win32: path.win32, darwin: path.posix, linux: path.posix };

function relToVolume(abs, platform) {
  const pp = P[platform] || path.posix;
  const parsed = pp.parse(abs);
  return pp.relative(parsed.root, abs).split(pp.sep).join('/');
}

const CACHE_DIR_NAMES = /^(cache|caches|\.cache|cache2|code cache|gpucache|shadercache|dxcache|grshadercache|cachestorage|service worker|temp|tmp|crashdumps|crashpad|crash reports|logs?|deriveddata|__pycache__|\.pytest_cache|node_modules\/\.cache|npm-cache|_cacache|pip|yarn|nuget|blob_storage|thumbnails)$/i;

const VENDOR_NAMES = {
  google: 'Google Chrome', 'brave software': 'Brave', mozilla: 'Firefox', 'microsoft\\edge': 'Microsoft Edge',
  microsoft: 'Microsoft / Windows', packages: 'Apps de Microsoft Store y WSL', docker: 'Docker Desktop', android: 'Android SDK / Emulador',
  discord: 'Discord', spotify: 'Spotify', slack: 'Slack', zoom: 'Zoom', jetbrains: 'JetBrains IDEs', 'code': 'Visual Studio Code', cursor: 'Cursor',
  'riot games': 'Riot Games (League of Legends / Valorant)', steam: 'Steam', 'epic games': 'Epic Games', 'xboxgames': 'Xbox / Game Pass', 'battle.net': 'Battle.net',
  nvidia: 'NVIDIA', 'nvidia corporation': 'NVIDIA', adobe: 'Adobe', apple: 'Apple (iTunes / iCloud)', 'apple computer': 'Apple', whatsapp: 'WhatsApp', telegram: 'Telegram Desktop',
  programs: 'Programas instalados por usuario', temp: 'Temporales', 'io.rebost.desktop': 'Rebost', claude: 'Claude', ollama: 'Ollama', 'lm studio': 'LM Studio', unity: 'Unity', 'unreal engine': 'Unreal Engine',
};

function vendorName(seg) {
  const k = seg.toLowerCase();
  return VENDOR_NAMES[k] || seg;
}

/** Classify an absolute path. Returns { tier, owner, note }. */
function classify(abs, platform = process.platform) {
  const rel = relToVolume(abs, platform);
  const segs = rel.split('/').filter(Boolean);
  const lower = segs.map((s) => s.toLowerCase());
  const last = lower[lower.length - 1] || '';
  const cacheHit = lower.findIndex((s) => CACHE_DIR_NAMES.test(s));

  if (platform === 'win32') {
    if (['windows', 'program files', 'program files (x86)', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'programdata'].includes(lower[0])) {
      if (lower[0] === 'programdata' && lower[1] && !['microsoft', 'package cache', 'packages', 'usoshared', 'regid.1991-06.com.microsoft', 'ssh', 'ntuser.pol'].includes(lower[1])) {
        return { tier: 'aplicacion', owner: vendorName(segs[1]), note: 'Datos compartidos de un programa (ProgramData).' };
      }
      return { tier: 'sistema', owner: lower[0] === 'programdata' ? 'Windows' : (lower[0].startsWith('program files') ? vendorName(segs[1] || 'Programas instalados') : 'Windows'), note: 'Sistema o programa instalado.' };
    }
    if (/^(hiberfil|pagefile|swapfile)\.sys$/i.test(last) && segs.length === 1) return { tier: 'sistema', owner: 'Windows', note: 'Archivo del sistema.' };
    if (lower[0] === 'users' && lower[1]) {
      if (['default', 'public', 'all users', 'default user'].includes(lower[1])) return { tier: 'sistema', owner: 'Windows', note: 'Perfil del sistema.' };
      const home = lower.slice(2);
      const seg2 = home[0] || '';
      if (seg2 === 'appdata') {
        const vendor = segs[4] || '';
        const owner = vendorName(vendor);
        if (cacheHit >= 0 && cacheHit >= 3) return { tier: 'cache', owner, note: 'Caché o temporales que la aplicación regenera.' };
        if (home[1] === 'local' && home[2] === 'temp') return { tier: 'cache', owner: 'Temporales', note: 'Carpeta temporal.' };
        return { tier: 'aplicacion', owner: owner || 'Aplicación', note: 'Datos y configuración de una aplicación. Borrarlos puede hacer que deje de funcionar o pierda su configuración.' };
      }
      if (seg2.startsWith('.')) {
        const map = { '.android': 'Android SDK / Emulador', '.gradle': 'Gradle', '.m2': 'Maven', '.nuget': 'NuGet', '.cargo': 'Rust (cargo)', '.rustup': 'Rust', '.docker': 'Docker', '.vscode': 'Visual Studio Code', '.cursor': 'Cursor', '.conda': 'Conda', '.ollama': 'Ollama', '.npm': 'npm', '.cache': 'Cachés', '.ssh': 'SSH', '.aws': 'AWS CLI' };
        const owner = map[seg2] || segs[2];
        if (seg2 === '.cache' || cacheHit >= 3) return { tier: 'cache', owner, note: 'Caché regenerable.' };
        if (seg2 === '.ssh' || seg2 === '.aws' || seg2 === '.gnupg') return { tier: 'sistema', owner, note: 'Credenciales. Nunca se tocan.' };
        return { tier: 'aplicacion', owner, note: 'Datos de una herramienta de desarrollo.' };
      }
      if (/^(anaconda3|miniconda3|scoop|go|\.?venv)$/.test(seg2)) return { tier: 'aplicacion', owner: segs[2], note: 'Entorno o herramienta instalada.' };
      if (['downloads', 'descargas', 'desktop', 'escritorio', 'documents', 'documentos', 'pictures', 'imágenes', 'imagenes', 'videos', 'vídeos', 'music', 'música', 'musica', 'onedrive', 'dropbox', 'google drive', 'icloud drive'].includes(seg2) || seg2.startsWith('onedrive')) {
        if (cacheHit >= 0) return { tier: 'cache', owner: null, note: 'Caché.' };
        return { tier: 'usuario', owner: null, note: 'Carpeta personal.' };
      }
      if (home.length === 0) return { tier: 'usuario', owner: null, note: 'Carpeta de usuario.' };
      if (['ntuser.dat', 'ntuser.ini'].some((n) => last.startsWith(n))) return { tier: 'sistema', owner: 'Windows', note: 'Registro del usuario.' };
      if (cacheHit >= 0) return { tier: 'cache', owner: null, note: 'Caché.' };
      return { tier: 'usuario', owner: null, note: 'Carpeta dentro de tu perfil.' };
    }
    // Outside Users: game launchers and dev tools at the drive root
    if (lower.some((s) => ['windowsapps', 'wpsystem', 'modifiablewindowsapps', 'wumodifiablewindowsapps'].includes(s))) return { tier: 'sistema', owner: 'Xbox / Microsoft Store', note: 'Instalación de apps y juegos de Microsoft Store con permisos especiales. Desinstala desde Configuración → Aplicaciones o la app Xbox.' };
    const games = ['riot games', 'steam', 'steamlibrary', 'steamapps', 'epic games', 'xboxgames', 'xbox', 'games', 'juegos', 'battle.net', 'origin games', 'ea games', 'ea', 'gog games', 'gog galaxy', 'ubisoft', 'ubisoft game launcher', 'rockstar games', 'bethesda', 'blizzard'];
    const gi = lower.findIndex((s) => games.includes(s));
    if (gi >= 0) {
      const launcher = lower[gi] === 'xbox' || lower[gi] === 'xboxgames' ? 'Xbox / Game Pass' : null;
      const game = segs[gi + 1] ? segs[gi + 1] : segs[gi];
      return { tier: 'aplicacion', owner: launcher ? `${game} (${launcher})` : vendorName(game), note: launcher ? 'Juego de Xbox / Game Pass. Desinstálalo o muévelo desde la app Xbox; sus archivos tienen permisos especiales.' : 'Archivos de un juego o su lanzador. Desinstala o mueve desde el propio lanzador.' };
    }
    if (/microsoft flight simulator|call of duty|forza|halo|minecraft|fortnite|valorant|league of legends|genshin|steamapps/i.test(rel)) return { tier: 'aplicacion', owner: segs.find((s) => /flight simulator|call of duty|forza|halo|minecraft|fortnite|valorant|league of legends|genshin/i.test(s)) || 'Juego', note: 'Archivos de un juego. Desinstálalo desde su lanzador.' };
    const dev = ['vulkansdk', 'python27', 'python311', 'python312', 'python313', 'cygwin64', 'msys64', 'mingw64', 'nvidia', 'intel', 'amd', 'xampp', 'wamp', 'flutter', 'android', 'go', 'ruby', 'perl', 'strawberry', 'nodejs', 'php', 'java', 'jdk', 'octave', 'r', 'sqlite', 'postgresql', 'mysql', 'mongodb'];
    if (dev.includes(lower[0])) return { tier: 'aplicacion', owner: segs[0], note: 'Herramienta instalada en la raíz del disco.' };
    if (cacheHit >= 0) return { tier: 'cache', owner: null, note: 'Caché o temporales.' };
    if (lower.includes('node_modules') || lower.includes('.git')) return { tier: 'aplicacion', owner: 'Proyecto de desarrollo', note: 'Dependencias o repositorio de un proyecto.' };
    return { tier: 'otro', owner: null, note: '' };
  }

  if (platform === 'darwin') {
    if (['system', 'library', 'private', 'usr', 'bin', 'sbin', 'etc', 'var', 'cores', 'opt', 'applications'].includes(lower[0])) {
      if (lower[0] === 'applications') return { tier: 'sistema', owner: (segs[1] || '').replace(/\.app$/i, '') || 'Aplicaciones', note: 'Aplicación instalada. Desinstálala desde Finder.' };
      return { tier: 'sistema', owner: 'macOS', note: 'Sistema.' };
    }
    if (lower[0] === 'users' && lower[1]) {
      if (lower[1] === 'shared') return { tier: 'otro', owner: null, note: 'Carpeta compartida.' };
      const home = lower.slice(2);
      const seg2 = home[0] || '';
      if (seg2 === 'library') {
        const kind = home[1] || '';
        const app = segs[4] || '';
        if (kind === 'caches' || kind === 'logs') return { tier: 'cache', owner: vendorName(app) || null, note: 'Caché regenerable.' };
        if (kind === 'developer') {
          if (home[2] === 'xcode' && ['deriveddata', 'ios devicesupport', 'archives'].includes(home[3] || '')) return { tier: 'cache', owner: 'Xcode', note: 'Compilaciones y símbolos que Xcode regenera.' };
          if (home[2] === 'coresimulator') return { tier: 'aplicacion', owner: 'Simuladores de Xcode', note: 'Gestiónalo con xcrun simctl.' };
          return { tier: 'aplicacion', owner: 'Xcode', note: 'Herramientas de desarrollo.' };
        }
        if (['keychains', 'preferences', 'accounts', 'cookies', 'passes', 'safari', 'suggestions', 'sharedfilelist', 'autosave information'].includes(kind)) return { tier: 'sistema', owner: 'macOS', note: 'Configuración y credenciales.' };
        if (kind === 'mail' || kind === 'messages' || kind === 'photos' || kind === 'calendars' || kind === 'reminders' || kind === 'notes') return { tier: 'aplicacion', owner: kind === 'mail' ? 'Mail' : kind === 'messages' ? 'Mensajes' : 'Apple', note: 'Datos personales de una app de Apple. Bórralos desde la propia app.' };
        if (cacheHit >= 4) return { tier: 'cache', owner: vendorName(app), note: 'Caché de aplicación.' };
        return { tier: 'aplicacion', owner: vendorName(app) || 'Aplicación', note: 'Datos y configuración de una aplicación.' };
      }
      if (seg2.startsWith('.')) {
        const map = { '.docker': 'Docker', '.gradle': 'Gradle', '.m2': 'Maven', '.cargo': 'Rust', '.rustup': 'Rust', '.npm': 'npm', '.cache': 'Cachés', '.android': 'Android SDK', '.ollama': 'Ollama', '.vscode': 'Visual Studio Code', '.cursor': 'Cursor', '.ssh': 'SSH', '.aws': 'AWS CLI', '.gnupg': 'GPG', '.trash': 'Papelera' };
        const owner = map[seg2] || segs[2];
        if (seg2 === '.trash') return { tier: 'cache', owner: 'Papelera', note: 'Papelera.' };
        if (seg2 === '.cache' || cacheHit >= 3) return { tier: 'cache', owner, note: 'Caché regenerable.' };
        if (['.ssh', '.aws', '.gnupg'].includes(seg2)) return { tier: 'sistema', owner, note: 'Credenciales.' };
        return { tier: 'aplicacion', owner, note: 'Datos de una herramienta de desarrollo.' };
      }
      if (seg2 === 'applications') return { tier: 'sistema', owner: (segs[3] || '').replace(/\.app$/i, '') || 'Aplicaciones', note: 'Aplicación instalada.' };
      if (['pictures', 'imágenes', 'movies', 'películas', 'music', 'música'].includes(seg2) && /\.(photoslibrary|musiclibrary|tvlibrary|imovielibrary|aplibrary)$/i.test(home[1] || '')) return { tier: 'aplicacion', owner: 'Fotos / Música / iMovie', note: 'Biblioteca de una app de Apple: gestiónala desde la app.' };
      if (cacheHit >= 0) return { tier: 'cache', owner: null, note: 'Caché.' };
      if (home.length === 0) return { tier: 'usuario', owner: null, note: 'Carpeta de usuario.' };
      return { tier: 'usuario', owner: null, note: 'Carpeta personal.' };
    }
    if (lower[0] === 'volumes') {
      if (cacheHit >= 2) return { tier: 'cache', owner: null, note: 'Caché.' };
      return { tier: 'otro', owner: null, note: 'Disco externo.' };
    }
    if (cacheHit >= 1) return { tier: 'cache', owner: null, note: 'Caché.' };
    return { tier: 'otro', owner: null, note: '' };
  }

  // linux / other
  if (['bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys', 'usr', 'var', 'opt'].includes(lower[0])) return { tier: 'sistema', owner: 'Sistema', note: 'Sistema.' };
  if (lower[0] === 'home' && lower[1]) {
    const seg2 = lower[2] || '';
    if (seg2 === '.cache' || cacheHit >= 3) return { tier: 'cache', owner: segs[3] || null, note: 'Caché.' };
    if (seg2 === '.config' || seg2 === '.local' || seg2.startsWith('.')) return { tier: 'aplicacion', owner: segs[3] || segs[2], note: 'Datos de una aplicación.' };
    return { tier: 'usuario', owner: null, note: 'Carpeta personal.' };
  }
  if (cacheHit >= 1) return { tier: 'cache', owner: null, note: 'Caché.' };
  return { tier: 'otro', owner: null, note: '' };
}

const PERSONAL_CATEGORIES = new Set(['Imágenes', 'Videos', 'Audio', 'Documentos', 'PDF', 'Hojas de cálculo', 'Presentaciones', 'Diseño']);

/**
 * Highest confidence the app allows for a delete suggestion given the file's tier/category.
 * Returns null when the file must not be suggested at all.
 */
function maxConfidence({ tier, category, isDuplicate = false, junk = false }) {
  if (tier === 'sistema') return null;
  if (tier === 'aplicacion') return isDuplicate ? 'baja' : 'baja';
  if (PERSONAL_CATEGORIES.has(category) && !isDuplicate && !junk) return 'media';
  return 'alta';
}

const CONF_RANK = { alta: 3, media: 2, baja: 1 };
function capConfidence(conf, cap) {
  if (!cap) return null;
  return CONF_RANK[conf] > CONF_RANK[cap] ? cap : conf;
}

const TIER_LABEL = { sistema: 'sistema', aplicacion: 'aplicación', cache: 'caché', usuario: 'personal', otro: 'otro' };

module.exports = { classify, maxConfidence, capConfidence, PERSONAL_CATEGORIES, TIER_LABEL };
