'use strict';

// Extension -> human category (Spanish labels, used both in UI and AI prompts).
const CATEGORY_EXTENSIONS = {
  'Imágenes': ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd', 'ai', 'ico'],
  'Videos': ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', '3gp'],
  'Audio': ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'aiff', 'opus'],
  'Documentos': ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'tex', 'epub', 'mobi'],
  'PDF': ['pdf'],
  'Hojas de cálculo': ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods', 'numbers'],
  'Presentaciones': ['ppt', 'pptx', 'key', 'odp'],
  'Comprimidos': ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
  'Instaladores': ['dmg', 'pkg', 'exe', 'msi', 'msix', 'appx', 'appimage', 'deb', 'rpm', 'iso', 'img'],
  'Código': ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'json', 'yml', 'yaml', 'toml', 'xml'],
  'Fuentes': ['ttf', 'otf', 'woff', 'woff2'],
  'Discos virtuales': ['vmdk', 'vdi', 'vhd', 'vhdx', 'qcow2', 'ova'],
  'Diseño': ['fig', 'sketch', 'xd', 'indd', 'aep', 'prproj', 'blend', 'skp', 'dwg'],
};

const EXT_TO_CATEGORY = new Map();
for (const [category, exts] of Object.entries(CATEGORY_EXTENSIONS)) {
  for (const ext of exts) EXT_TO_CATEGORY.set(ext, category);
}

const OTHER = 'Otros';

function extensionOf(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

function categoryOf(name) {
  return EXT_TO_CATEGORY.get(extensionOf(name)) || OTHER;
}

// Names / patterns that are almost always safe to delete (temporary or cache files).
const JUNK_NAME_PATTERNS = [
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^~\$.+/,               // Office lock files
  /\.(tmp|temp)$/i,
  /\.crdownload$/i,
  /\.part$/i,
  /\.partial$/i,
  /\.download$/i,
  /\.bak$/i,
  /\.old$/i,
  /\.log$/i,
  /\.dmp$/i,
  /^\.~lock\..+#$/,        // LibreOffice lock files
  /\(\d+\)\.(zip|dmg|exe|msi|pkg)$/i, // "instalador (2).dmg" re-downloads
];

const JUNK_DIR_NAMES = new Set(['cache', 'caches', '.cache', 'tmp', 'temp', '__pycache__', '.pytest_cache', 'node_modules', '.gradle', 'DerivedData']);

function looksLikeJunk(name) {
  return JUNK_NAME_PATTERNS.some((re) => re.test(name));
}

module.exports = {
  CATEGORY_EXTENSIONS,
  OTHER,
  JUNK_DIR_NAMES,
  extensionOf,
  categoryOf,
  looksLikeJunk,
};
