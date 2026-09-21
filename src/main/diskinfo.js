'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Knowledge base of well-known heavy folders: what they are, whether they can be deleted or moved,
 * and how. Matched against the path relative to the drive root (Windows) or absolute (macOS),
 * case-insensitively; `{user}` matches any user name.
 */
const KNOWN = [
  // ---- Windows: system ----
  { os: 'win32', match: /^Windows$/i, kind: 'sistema', what: 'El sistema operativo Windows.', del: 'no', move: 'no', how: 'No se puede mover. Para reducirlo: Liberador de espacio → Limpiar archivos del sistema, y `DISM /Online /Cleanup-Image /StartComponentCleanup` para WinSxS.' },
  { os: 'win32', match: /^Windows\/WinSxS$/i, kind: 'sistema', what: 'Almacén de componentes de Windows (versiones de DLL para actualizaciones).', del: 'no', move: 'no', how: 'Ejecuta como administrador: `DISM /Online /Cleanup-Image /StartComponentCleanup /ResetBase`.' },
  { os: 'win32', match: /^Windows\/SoftwareDistribution$/i, kind: 'caché', what: 'Descargas de Windows Update ya aplicadas.', del: 'parcial', move: 'no', how: 'Detén el servicio Windows Update y borra el contenido de la subcarpeta Download, o usa el Liberador de espacio.' },
  { os: 'win32', match: /^Windows\/Installer$/i, kind: 'sistema', what: 'Cachés de instaladores MSI; necesarios para desinstalar o reparar programas.', del: 'no', move: 'no', how: 'No borrar a mano. Herramientas como PatchCleaner eliminan solo los huérfanos.' },
  { os: 'win32', match: /^Windows\/Temp$/i, kind: 'temporal', what: 'Temporales del sistema.', del: 'sí', move: 'no', how: 'Se puede vaciar con el Liberador de espacio o Configuración → Sistema → Almacenamiento → Archivos temporales.' },
  { os: 'win32', match: /^hiberfil\.sys$/i, kind: 'sistema', what: 'Archivo de hibernación (≈ 40-75 % de la RAM).', del: 'parcial', move: 'no', how: 'Si no usas hibernación: `powercfg -h off` como administrador lo elimina.' },
  { os: 'win32', match: /^pagefile\.sys$/i, kind: 'sistema', what: 'Memoria virtual (archivo de paginación).', del: 'no', move: 'sí', how: 'Se puede pasar a otro disco en Propiedades del sistema → Opciones avanzadas → Rendimiento → Memoria virtual.' },
  { os: 'win32', match: /^swapfile\.sys$/i, kind: 'sistema', what: 'Intercambio para apps de la Tienda.', del: 'no', move: 'no', how: 'Déjalo.' },
  { os: 'win32', match: /^\$Recycle\.Bin$/i, kind: 'papelera', what: 'La Papelera de reciclaje.', del: 'sí', move: 'no', how: 'Vacía la Papelera para recuperar este espacio.' },
  { os: 'win32', match: /^System Volume Information$/i, kind: 'sistema', what: 'Puntos de restauración e índices del sistema.', del: 'parcial', move: 'no', how: 'Reduce el espacio de Restaurar sistema en Protección del sistema → Configurar.' },
  { os: 'win32', match: /^Windows\.old$/i, kind: 'caché', what: 'Copia de la instalación anterior de Windows.', del: 'sí', move: 'no', how: 'Configuración → Sistema → Almacenamiento → Archivos temporales → Instalación anterior de Windows.' },
  { os: 'win32', match: /^Program Files( \(x86\))?$/i, kind: 'aplicaciones', what: 'Programas instalados.', del: 'parcial', move: 'no', how: 'Desinstala lo que no uses desde Configuración → Aplicaciones. Para pasar apps a otro disco, desinstala y reinstala eligiendo el otro disco; muchas apps de la Tienda se pueden mover desde Configuración → Aplicaciones → Mover.' },
  { os: 'win32', match: /^ProgramData$/i, kind: 'aplicaciones', what: 'Datos compartidos de programas (actualizadores, cachés, antivirus).', del: 'parcial', move: 'no', how: 'Revisa subcarpetas grandes: ProgramData/Package Cache y ProgramData/Microsoft/Windows/WER suelen ser seguros de limpiar.' },
  { os: 'win32', match: /^ProgramData\/Package Cache$/i, kind: 'caché', what: 'Instaladores de Visual Studio y runtimes de Microsoft.', del: 'parcial', move: 'sí', how: 'Se puede mover a otro disco y dejar un enlace (junction). Borrarlo puede impedir reparar Visual Studio.' },
  { os: 'win32', match: /^Program Files( \(x86\))?\/Steam\/steamapps$/i, kind: 'juegos', what: 'Biblioteca de juegos de Steam.', del: 'parcial', move: 'sí', how: 'Steam → Ajustes → Almacenamiento → añade una biblioteca en el otro disco y usa "Mover" por juego.' },
  { os: 'win32', match: /^Program Files\/Epic Games$/i, kind: 'juegos', what: 'Juegos de Epic Games.', del: 'parcial', move: 'sí', how: 'Mueve la carpeta del juego al otro disco y usa "Instalar" en Epic apuntando a la nueva ruta; detecta los archivos.' },
  { os: 'win32', match: /^Program Files\/WindowsApps$/i, kind: 'aplicaciones', what: 'Apps de Microsoft Store.', del: 'no', move: 'sí', how: 'Configuración → Aplicaciones → selecciona la app → Mover.' },
  // ---- Windows: user profile ----
  { os: 'win32', match: /^Users$/i, kind: 'usuario', what: 'Perfiles de todos los usuarios.', del: 'parcial', move: 'parcial', how: 'Explora dentro: Descargas, Documentos, Vídeos, AppData y OneDrive son lo que suele pesar.' },
  { os: 'win32', match: /^Users\/[^/]+\/(Downloads|Descargas)$/i, kind: 'usuario', what: 'Descargas.', del: 'parcial', move: 'sí', how: 'Clic derecho → Propiedades → Ubicación → Mover, o usa "Mover a otro disco" aquí (deja un enlace).' },
  { os: 'win32', match: /^Users\/[^/]+\/(Documents|Documentos|Pictures|Imágenes|Videos|Vídeos|Music|Música|Desktop|Escritorio)$/i, kind: 'usuario', what: 'Carpeta personal.', del: 'parcial', move: 'sí', how: 'Clic derecho → Propiedades → Ubicación → Mover cambia la carpeta de sitio de forma nativa. También puedes usar "Mover a otro disco".' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData$/i, kind: 'aplicaciones', what: 'Datos y cachés de tus programas.', del: 'parcial', move: 'parcial', how: 'No la muevas entera. Mira dentro: Local/Temp, cachés de navegadores, Docker, Android SDK, Discord, Spotify…' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/Temp$/i, kind: 'temporal', what: 'Temporales de tus programas.', del: 'sí', move: 'no', how: 'Puedes vaciarla (cierra los programas primero).' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/(Google|Microsoft\/Edge|Mozilla|BraveSoftware)$/i, kind: 'caché', what: 'Perfil y caché del navegador.', del: 'parcial', move: 'no', how: 'Borra la caché desde el propio navegador (Historial → Borrar datos → Imágenes y archivos en caché).' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/Docker$/i, kind: 'desarrollo', what: 'Discos virtuales de Docker Desktop / WSL (ext4.vhdx).', del: 'parcial', move: 'sí', how: 'Docker Desktop → Settings → Resources → Disk image location permite moverlo. `docker system prune -a` libera imágenes sin uso.' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/Packages$/i, kind: 'aplicaciones', what: 'Datos de apps de la Tienda y WSL.', del: 'parcial', move: 'no', how: 'Las distribuciones WSL (CanonicalGroupLimited…) se pueden exportar e importar en otro disco con `wsl --export` / `wsl --import`.' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/Android$/i, kind: 'desarrollo', what: 'Android SDK, emuladores e imágenes de sistema.', del: 'parcial', move: 'sí', how: 'Cambia la ruta del SDK en Android Studio y elimina imágenes de sistema/AVD que no uses.' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Local\/(npm-cache|pip|Yarn|NuGet)/i, kind: 'caché', what: 'Caché de un gestor de paquetes.', del: 'sí', move: 'no', how: 'Se regenera solo: `npm cache clean --force`, `pip cache purge`, `yarn cache clean`, `dotnet nuget locals all --clear`.' },
  { os: 'win32', match: /^Users\/[^/]+\/AppData\/Roaming\/Microsoft\/Outlook$/i, kind: 'aplicaciones', what: 'Buzones de Outlook (.ost/.pst).', del: 'no', move: 'parcial', how: 'Reduce el rango de sincronización en la cuenta de Outlook; los .pst se pueden mover y volver a abrir.' },
  { os: 'win32', match: /^Users\/[^/]+\/OneDrive/i, kind: 'nube', what: 'Archivos sincronizados con OneDrive.', del: 'parcial', move: 'sí', how: 'Activa "Archivos a petición" y marca carpetas como "Liberar espacio" para que vivan solo en la nube. La carpeta OneDrive se puede desvincular y volver a configurar en otro disco.' },
  { os: 'win32', match: /^Users\/[^/]+\/Apple\/MobileSync$/i, kind: 'copias', what: 'Copias de seguridad de iPhone/iPad.', del: 'parcial', move: 'sí', how: 'Borra copias antiguas desde iTunes/Apple Devices → Preferencias → Dispositivos. Se puede mover con un enlace (junction).' },
  { os: 'win32', match: /node_modules$/i, kind: 'desarrollo', what: 'Dependencias de un proyecto JavaScript.', del: 'sí', move: 'no', how: 'Se regenera con `npm install`. Bórrala en proyectos que no estés usando.' },
  // ---- macOS ----
  { os: 'darwin', match: /^System$/i, kind: 'sistema', what: 'macOS (volumen del sistema, sellado).', del: 'no', move: 'no', how: 'No se puede tocar.' },
  { os: 'darwin', match: /^Library$/i, kind: 'sistema', what: 'Biblioteca del sistema compartida por todos los usuarios.', del: 'parcial', move: 'no', how: 'Revisa Library/Caches y Library/Updates.' },
  { os: 'darwin', match: /^Applications$/i, kind: 'aplicaciones', what: 'Aplicaciones instaladas.', del: 'parcial', move: 'no', how: 'Elimina las que no uses (arrástralas a la Papelera o usa AppCleaner). Las apps deben estar en el disco de arranque.' },
  { os: 'darwin', match: /^private\/var\/vm$/i, kind: 'sistema', what: 'Memoria de intercambio y archivo de reposo.', del: 'no', move: 'no', how: 'Se gestiona solo.' },
  { os: 'darwin', match: /^Users$/i, kind: 'usuario', what: 'Carpetas de los usuarios.', del: 'parcial', move: 'parcial', how: 'Casi todo lo que puedes liberar está aquí dentro.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library$/i, kind: 'aplicaciones', what: 'Datos, cachés y soportes de tus apps (oculta en Finder).', del: 'parcial', move: 'parcial', how: 'Mira dentro: Caches, Developer, Application Support, Containers, Mail.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Caches$/i, kind: 'caché', what: 'Cachés de aplicaciones.', del: 'sí', move: 'no', how: 'Se pueden borrar con las apps cerradas; se regeneran solas.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Developer\/Xcode\/DerivedData$/i, kind: 'desarrollo', what: 'Compilaciones intermedias de Xcode.', del: 'sí', move: 'sí', how: 'Bórrala sin miedo; Xcode la regenera. La ruta se cambia en Xcode → Settings → Locations.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Developer\/Xcode\/iOS DeviceSupport$/i, kind: 'desarrollo', what: 'Símbolos de versiones de iOS que has conectado.', del: 'sí', move: 'no', how: 'Borra las versiones de iOS que ya no depures.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Developer\/CoreSimulator$/i, kind: 'desarrollo', what: 'Simuladores de iOS y sus runtimes.', del: 'parcial', move: 'no', how: '`xcrun simctl delete unavailable` y elimina runtimes antiguos en Xcode → Settings → Platforms.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Application Support\/MobileSync$/i, kind: 'copias', what: 'Copias de seguridad de iPhone/iPad.', del: 'parcial', move: 'sí', how: 'Elimina copias antiguas desde Finder → dispositivo → Gestionar copias. Se puede mover a otro disco dejando un enlace simbólico.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Containers\/com\.docker\.docker$/i, kind: 'desarrollo', what: 'Disco virtual de Docker Desktop (Docker.raw).', del: 'parcial', move: 'sí', how: 'Docker Desktop → Settings → Resources → Disk image location. `docker system prune -a` libera espacio.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Mail$/i, kind: 'aplicaciones', what: 'Correo descargado por Mail.', del: 'no', move: 'no', how: 'En Mail → Ajustes → Cuentas desactiva "Descargar adjuntos" o limita los mensajes sincronizados.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Messages$/i, kind: 'aplicaciones', what: 'Adjuntos de iMessage.', del: 'parcial', move: 'no', how: 'Mensajes → Ajustes → Conservar mensajes: 1 año, o borra conversaciones grandes.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Pictures\/[^/]+\.photoslibrary$/i, kind: 'usuario', what: 'Fototeca de Fotos.', del: 'no', move: 'sí', how: 'Cópiala a un disco externo con formato APFS, ábrela con Fotos manteniendo Opción y márcala como Fototeca del sistema. También puedes activar "Optimizar almacenamiento" en iCloud.' },
  { os: 'darwin', match: /^Users\/[^/]+\/(Movies|Películas|Music|Música|Downloads|Descargas|Documents|Documentos|Desktop|Escritorio|Pictures|Imágenes)$/i, kind: 'usuario', what: 'Carpeta personal.', del: 'parcial', move: 'sí', how: 'Usa "Mover a otro disco" aquí; se deja un enlace simbólico para que todo siga funcionando.' },
  { os: 'darwin', match: /^Users\/[^/]+\/Library\/Caches\/Homebrew$/i, kind: 'caché', what: 'Descargas de Homebrew.', del: 'sí', move: 'no', how: '`brew cleanup --prune=all`.' },
  { os: 'darwin', match: /node_modules$/i, kind: 'desarrollo', what: 'Dependencias de un proyecto JavaScript.', del: 'sí', move: 'no', how: 'Se regenera con `npm install`. Bórrala en proyectos que no uses.' },
  { os: 'darwin', match: /^\.Trashes$|^Users\/[^/]+\/\.Trash$/i, kind: 'papelera', what: 'La Papelera.', del: 'sí', move: 'no', how: 'Vacía la Papelera.' },
];

/** Paths that Ordena will never move or trash, whatever the scan root. */
const PROTECTED_ABS_PATTERNS = {
  win32: [/^[a-z]:\\(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|recovery|perflogs)(\\|$)/i, /^[a-z]:\\(hiberfil|pagefile|swapfile)\.sys$/i, /^[a-z]:\\users\\[^\\]+\\(ntuser\.dat|appdata\\local\\microsoft\\windows)(\\|$)/i, /^[a-z]:\\users\\(default|public|all users|default user)(\\|$)/i],
  darwin: [/^\/(system|library|private|usr|bin|sbin|etc|var|cores|opt\/homebrew\/cellar|applications)(\/|$)/i, /^\/users\/[^/]+\/library\/(keychains|preferences|containers|group containers|application support\/(com\.apple|addressbook|calendars))(\/|$)/i, /^\/users\/[^/]+\/library$/i],
  linux: [/^\/(bin|boot|dev|etc|lib|lib32|lib64|proc|root|run|sbin|snap|srv|sys|usr|var)(\/|$)/i],
};

function relToVolume(abs, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const parsed = P.parse(abs);
  return P.relative(parsed.root, abs).split(P.sep).join('/');
}

/** Returns the knowledge-base hint for an absolute path (or null). */
function describePath(abs, platform = process.platform) {
  const rel = relToVolume(abs, platform);
  for (const k of KNOWN) {
    if (k.os !== platform) continue;
    if (k.match.test(rel)) return { kind: k.kind, what: k.what, del: k.del, move: k.move, how: k.how };
  }
  return null;
}

function isProtectedAbs(abs, platform = process.platform) {
  const norm = platform === 'win32' ? abs.replace(/\//g, '\\') : abs;
  return (PROTECTED_ABS_PATTERNS[platform] || []).some((re) => re.test(norm));
}

/** Coarse kind for a folder without a knowledge-base entry. */
function guessKind(abs, platform = process.platform) {
  const rel = relToVolume(abs, platform).toLowerCase();
  const name = rel.split('/').pop() || '';
  if (platform === 'win32' && /^(windows|programdata)(\/|$)/.test(rel)) return 'sistema';
  if (platform === 'win32' && /^program files/.test(rel)) return 'aplicaciones';
  if (platform === 'darwin' && /^(system|library|private|usr|bin|sbin)(\/|$)/.test(rel)) return 'sistema';
  if (platform === 'darwin' && /^applications(\/|$)/.test(rel)) return 'aplicaciones';
  if (/^(cache|caches|\.cache|tmp|temp|\$recycle\.bin)$/.test(name)) return 'caché';
  if (/^(node_modules|\.gradle|\.m2|deriveddata|\.cargo|\.rustup|\.npm|\.nuget|__pycache__|\.venv|venv)$/.test(name)) return 'desarrollo';
  if (/^(steam|steamapps|epic games|riot games|games|juegos)$/.test(name)) return 'juegos';
  if (/^users\//.test(rel) || /^(home|users)$/.test(rel.split('/')[0] || '')) return 'usuario';
  return 'otro';
}

async function statfsSafe(p) {
  try {
    const s = await fsp.statfs(p);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/** List mounted drives / volumes with free space. */
async function listDrives() {
  const drives = [];
  if (isWin) {
    for (let c = 65; c <= 90; c += 1) {
      const root = `${String.fromCharCode(c)}:\\`;
      const fsInfo = await statfsSafe(root);
      if (!fsInfo || fsInfo.total === 0) continue;
      drives.push({ path: root, name: `Disco ${String.fromCharCode(c)}:`, ...fsInfo, system: root.toLowerCase().startsWith(process.env.SystemDrive?.toLowerCase() || 'c:') });
    }
  } else if (isMac) {
    const rootInfo = await statfsSafe('/');
    if (rootInfo) drives.push({ path: '/', name: 'Macintosh HD', ...rootInfo, system: true });
    try {
      for (const name of await fsp.readdir('/Volumes')) {
        const p = path.join('/Volumes', name);
        try {
          const lst = await fsp.lstat(p);
          if (lst.isSymbolicLink()) continue; // "/Volumes/Macintosh HD" -> /
          const info = await statfsSafe(p);
          if (info && info.total > 0 && info.total !== rootInfo?.total) drives.push({ path: p, name, ...info, system: false });
        } catch { /* skip */ }
      }
    } catch { /* no /Volumes */ }
  } else {
    const rootInfo = await statfsSafe('/');
    if (rootInfo) drives.push({ path: '/', name: 'Sistema (/)', ...rootInfo, system: true });
    for (const base of ['/media', '/mnt', `/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`]) {
      try {
        for (const name of await fsp.readdir(base)) {
          const p = path.join(base, name);
          const info = await statfsSafe(p);
          if (info && info.total > 0 && info.total !== rootInfo?.total) drives.push({ path: p, name, ...info, system: false });
        }
      } catch { /* skip */ }
    }
  }
  return drives.map((d) => ({ ...d, used: d.total - d.free, usedPct: d.total ? Math.round(((d.total - d.free) / d.total) * 100) : 0 }));
}

module.exports = { describePath, isProtectedAbs, guessKind, listDrives, statfsSafe, KNOWN };
