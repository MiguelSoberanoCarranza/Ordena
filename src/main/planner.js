'use strict';

// Builds prompts for MiniMax and turns its JSON answers into validated, safe plans.

const path = require('path');
const { formatBytes } = require('./scanner');
const { sanitizeRelPath } = require('./paths');

const MAX_LISTED_FILES = 350;
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.svn', '.hg', '__pycache__', '.venv', 'venv']);

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function isProtected(rel) {
  return rel.split('/').some((s) => PROTECTED_SEGMENTS.has(s));
}

/** Choose which files to show the model: everything if small, otherwise root files first, then largest. */
function sampleFiles(files, limit = MAX_LISTED_FILES) {
  const eligible = files.filter((f) => !isProtected(f.rel));
  if (eligible.length <= limit) return { listed: eligible, omitted: 0 };
  const rootFirst = eligible.filter((f) => f.dir === '').sort((a, b) => b.size - a.size);
  const rest = eligible.filter((f) => f.dir !== '').sort((a, b) => b.size - a.size);
  const listed = [...rootFirst, ...rest].slice(0, limit);
  return { listed, omitted: eligible.length - listed.length };
}

function fileLine(f) {
  return `${f.rel}\t${formatBytes(f.size)}\t${fmtDate(f.mtimeMs)}\t${f.category}`;
}

function describeFolder(summary) {
  const cats = summary.categories.slice(0, 10).map((c) => `${c.category}: ${c.count} archivos, ${formatBytes(c.bytes)}`).join('; ');
  const dirs = summary.totalDirs - 1;
  return `Carpeta: ${path.basename(summary.root) || summary.root}\n` +
    `Total: ${summary.totalFiles} archivos, ${dirs} subcarpetas, ${formatBytes(summary.totalSize)}. ` +
    `${summary.rootFiles} archivos están sueltos en la raíz.\n` +
    `Por categoría: ${cats}`;
}

const ORGANIZE_SYSTEM = `Eres "Ordena", un asistente experto en organizar carpetas personales en Windows y macOS.
Recibes un inventario de archivos (ruta relativa, tamaño, fecha de modificación, categoría) y propones una estructura clara.
Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni markdown, con esta forma exacta:
{
  "summary": "explicación breve (2-3 frases) de la estructura propuesta",
  "folders": [{"path": "Carpeta/Subcarpeta", "description": "qué contiene"}],
  "rules": [{"name": "nombre corto", "extensions": ["pdf"], "namePattern": "regex opcional o null", "olderThanDays": null, "destination": "Carpeta/Subcarpeta"}],
  "moves": [{"from": "ruta/relativa/actual.ext", "to": "Carpeta/Nueva/actual.ext", "reason": "por qué"}]
}
Reglas obligatorias:
- Usa solo rutas RELATIVAS a la carpeta analizada, con "/" como separador. Nunca uses ".." ni rutas absolutas.
- No cambies la extensión de los archivos. Puedes renombrar un archivo solo si su nombre es claramente ilegible (p. ej. "IMG_2931 (3) copia.jpg"), conservando la extensión.
- Los "moves" son para archivos concretos del inventario. Las "rules" sirven para clasificar por extensión o patrón los archivos sueltos que no aparecen en la lista.
- No muevas archivos que ya estén bien ubicados dentro de una subcarpeta con sentido (proyectos, carpetas de aplicaciones, repositorios de código, carpetas con package.json, .git, etc.).
- Nunca sugieras mover archivos dentro de carpetas llamadas node_modules, .git u otras de sistema.
- Prefiere pocas carpetas con nombres claros en español (p. ej. "Documentos/Facturas", "Imágenes/2024", "Instaladores") en lugar de muchas carpetas minúsculas.
- Agrupa por tipo y, cuando ayude, por año o proyecto detectable en el nombre.
- Máximo 150 "moves" y 25 "rules".`;

function buildOrganizeMessages(summary, files, { instructions = '' } = {}) {
  const { listed, omitted } = sampleFiles(files);
  const lines = listed.map(fileLine).join('\n');
  const existingDirs = summary.totalDirs > 1 ? `Subcarpetas existentes (primer nivel): ${
    [...new Set(files.map((f) => f.dir.split('/')[0]).filter(Boolean))].slice(0, 40).join(', ') || 'ninguna'
  }` : 'No hay subcarpetas.';
  const user = `${describeFolder(summary)}\n${existingDirs}\n\n` +
    `Inventario (ruta\ttamaño\tfecha\tcategoría)${omitted ? ` — se omitieron ${omitted} archivos, cúbrelos con "rules"` : ''}:\n${lines}\n\n` +
    (instructions.trim() ? `Instrucciones adicionales del usuario: ${instructions.trim()}\n\n` : '') +
    'Genera el plan JSON.';
  return [
    { role: 'system', content: ORGANIZE_SYSTEM },
    { role: 'user', content: user },
  ];
}

const CLEANUP_SYSTEM = `Eres "Ordena", un asistente que ayuda a liberar espacio en disco de forma segura.
Recibes candidatos detectados automáticamente: archivos más grandes, archivos grandes sin usar, archivos temporales/basura y grupos de duplicados.
Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, con esta forma:
{
  "summary": "resumen breve del potencial de ahorro y estrategia",
  "suggestions": [{"path": "ruta/relativa", "reason": "por qué se puede eliminar", "confidence": "alta|media|baja", "kind": "duplicado|temporal|instalador|grande_sin_uso|otro"}],
  "tips": ["consejo general breve"]
}
Reglas:
- Solo puedes sugerir rutas que aparezcan en los candidatos. Usa rutas relativas exactas, tal como se muestran.
- En grupos de duplicados conserva UNA copia (la de ruta más corta o mejor ubicada) y sugiere eliminar el resto.
- Confianza "alta": temporales, caches, duplicados exactos, instaladores (.dmg/.exe/.msi/.pkg) descargados hace tiempo, descargas repetidas "(1)", "(2)".
- Confianza "media": archivos comprimidos ya extraídos, archivos grandes sin modificar en más de un año.
- Confianza "baja": documentos personales, fotos, videos únicos. Nunca sugieras eliminar fotos o videos personales salvo que sean duplicados exactos.
- Los archivos se envían a la Papelera, no se borran definitivamente, pero sé prudente igualmente.
- Máximo 200 sugerencias. Ordena de mayor a menor ahorro.`;

function buildCleanupMessages(summary, duplicates, { instructions = '', isProtected: extra = null } = {}) {
  const now = Date.now();
  const blocked = (rel) => isProtected(rel) || (extra ? extra(rel) : false);
  summary = { ...summary, largest: summary.largest.filter((f) => !blocked(f.rel)), oldLarge: summary.oldLarge.filter((f) => !blocked(f.rel)), junk: summary.junk.filter((f) => !blocked(f.rel)) };
  summary.junkBytes = summary.junk.reduce((a, f) => a + f.size, 0);
  duplicates = duplicates ? { ...duplicates, groups: duplicates.groups.filter((g) => !g.files.some((f) => blocked(f.rel))) } : duplicates;
  const ageDays = (f) => Math.round((now - f.mtimeMs) / 86400000);
  const line = (f) => `${f.rel}\t${formatBytes(f.size)}\t${ageDays(f)} días`;
  const sections = [];
  sections.push(`Archivos más grandes:\n${summary.largest.slice(0, 40).map(line).join('\n') || '(ninguno)'}`);
  sections.push(`Grandes y sin modificar en +180 días:\n${summary.oldLarge.slice(0, 40).map(line).join('\n') || '(ninguno)'}`);
  sections.push(`Temporales / basura detectados (${summary.junk.length}, ${formatBytes(summary.junkBytes)}):\n${summary.junk.slice(0, 80).map(line).join('\n') || '(ninguno)'}`);
  const dupGroups = (duplicates?.groups || []).slice(0, 40);
  const dupText = dupGroups.map((g, i) => `Grupo ${i + 1} (${formatBytes(g.size)} c/u):\n` + g.files.map((f) => `  ${f.rel}\t${ageDays(f)} días`).join('\n')).join('\n');
  sections.push(`Duplicados exactos (${duplicates?.groups?.length || 0} grupos, ${formatBytes(duplicates?.wastedBytes || 0)} recuperables):\n${dupText || '(ninguno)'}`);
  const user = `${describeFolder(summary)}\n\n${sections.join('\n\n')}\n\n` +
    (instructions.trim() ? `Instrucciones adicionales del usuario: ${instructions.trim()}\n\n` : '') +
    'Genera las sugerencias JSON.';
  return [
    { role: 'system', content: CLEANUP_SYSTEM },
    { role: 'user', content: user },
  ];
}

const CHAT_SYSTEM = `Eres "Ordena", un asistente amable que ayuda a entender y organizar una carpeta del usuario y a liberar espacio.
Responde en español, de forma concreta y breve. Usa los datos del análisis que se te proporcionan; si no tienes el dato, dilo.
No inventes rutas. Si el usuario quiere mover o borrar archivos, explícale que use las secciones "Organizar" o "Liberar espacio" de la app para revisarlo y aplicarlo.`;

function buildChatMessages(summary, duplicates, history) {
  const context = summary
    ? `${describeFolder(summary)}\n\nArchivos más grandes:\n${summary.largest.slice(0, 20).map(fileLine).join('\n')}\n\n` +
      `Temporales detectados: ${summary.junk.length} (${formatBytes(summary.junkBytes)}). Carpetas vacías: ${summary.emptyDirs.length}. ` +
      `Duplicados: ${duplicates ? `${duplicates.groups.length} grupos, ${formatBytes(duplicates.wastedBytes)} recuperables` : 'aún no analizados'}.\n` +
      `Espacio por antigüedad: ${Object.entries(summary.ageBuckets).map(([k, v]) => `${k}: ${formatBytes(v)}`).join(', ')}.\n` +
      (summary.topDirs?.length ? `Subcarpetas que más ocupan: ${summary.topDirs.slice(0, 15).map((d) => `${d.name} ${formatBytes(d.size)}`).join(', ')}.` : '')
    : 'Todavía no se ha analizado ninguna carpeta.';
  return [
    { role: 'system', content: `${CHAT_SYSTEM}\n\nContexto del análisis actual:\n${context}` },
    ...history.slice(-20).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) })),
  ];
}

const EXPLAIN_SYSTEM = `Eres "Ordena", un experto en administración de Windows y macOS que explica a un usuario no técnico qué ocupa espacio en su disco.
Recibes una lista de carpetas o archivos con su tamaño y, cuando la hay, una pista de la base de conocimiento de la app.
Responde ÚNICAMENTE con un objeto JSON válido con esta forma:
{
  "summary": "2-4 frases: qué es lo que más pesa y cuál sería la estrategia más efectiva para liberar espacio en este disco",
  "items": [{"path": "ruta tal como aparece", "what": "qué es, en una frase clara", "delete": "sí|parcial|no", "move": "sí|parcial|no", "how": "cómo reducirlo o moverlo a otro disco, con pasos concretos (menús, comandos)", "risk": "bajo|medio|alto"}],
  "plan": ["paso 1 concreto y ordenado por impacto", "paso 2", "..."]
}
Reglas:
- Usa las rutas EXACTAS que se te dan. Cubre todos los elementos de la lista.
- "delete" = si se puede borrar sin romper nada (parcial = solo parte de su contenido). "move" = si se puede llevar a otro disco (mediante la opción nativa del programa, cambiando su ubicación, o moviéndola y dejando un enlace/junction).
- Sé honesto: carpetas del sistema (Windows, Program Files, System, Library del sistema) NO se mueven; di cómo reducirlas si se puede.
- Para carpetas de usuario (Documentos, Vídeos, Descargas, bibliotecas de juegos, máquinas virtuales, Docker, fototecas, copias de seguridad) explica cómo moverlas a otro disco correctamente.
- Habla en español, claro y breve. Nada de markdown fuera del JSON.`;

function buildExplainMessages(rootAbs, items, { platform = process.platform, drives = [] } = {}) {
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  const lines = items.map((it) => {
    const hint = it.hint ? ` | pista: ${it.hint.what} (borrar: ${it.hint.del}, mover: ${it.hint.move})` : '';
    return `${it.path}\t${formatBytes(it.size)}\t${it.isDir ? `carpeta, ${it.fileCount} archivos` : 'archivo'}\t${it.kind}${hint}`;
  }).join('\n');
  const driveText = drives.length ? `Discos del equipo: ${drives.map((d) => `${d.name} (${d.path}) ${formatBytes(d.free)} libres de ${formatBytes(d.total)}`).join('; ')}.` : '';
  const user = `Sistema: ${osName}. Carpeta analizada: ${rootAbs}.\n${driveText}\n\nElementos (ruta\ttamaño\ttipo\tclase | pista):\n${lines}\n\nGenera el JSON.`;
  return [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: user },
  ];
}

function buildExplainResult(aiJson, items) {
  const allowed = new Set(items.map((i) => i.path));
  const norm = (v, ok, def) => (ok.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : def);
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(aiJson?.items) ? aiJson.items : []) {
    if (!it || typeof it.path !== 'string' || !allowed.has(it.path) || seen.has(it.path)) continue;
    seen.add(it.path);
    out.push({
      path: it.path,
      what: String(it.what || ''),
      delete: norm(it.delete, ['sí', 'si', 'parcial', 'no'], 'no').replace('si', 'sí'),
      move: norm(it.move, ['sí', 'si', 'parcial', 'no'], 'no').replace('si', 'sí'),
      how: String(it.how || ''),
      risk: norm(it.risk, ['bajo', 'medio', 'alto'], 'medio'),
    });
  }
  return {
    summary: String(aiJson?.summary || ''),
    items: out,
    plan: (Array.isArray(aiJson?.plan) ? aiJson.plan : []).map(String).slice(0, 12),
  };
}

function compileRule(rule) {
  const exts = Array.isArray(rule.extensions) ? rule.extensions.map((e) => String(e).toLowerCase().replace(/^\./, '')) : [];
  let pattern = null;
  if (rule.namePattern && typeof rule.namePattern === 'string') {
    try {
      pattern = new RegExp(rule.namePattern, 'i');
    } catch {
      pattern = null;
    }
  }
  const olderThanDays = Number.isFinite(rule.olderThanDays) ? rule.olderThanDays : null;
  const destination = sanitizeRelPath(String(rule.destination || ''));
  if (!destination || (exts.length === 0 && !pattern)) return null;
  return { name: String(rule.name || destination), extensions: exts, pattern, olderThanDays, destination };
}

/**
 * Validate the model's answer against the real inventory and expand rules into concrete moves.
 * @returns {{summary:string, folders:Array, moves:Array<{from:string,to:string,reason:string,source:'ai'|'rule',size:number}>, rejected:Array}}
 */
function buildOrganizePlan(aiJson, scan, { applyRulesToSubfolders = false, now = Date.now() } = {}) {
  const byRel = fileLookup(scan);
  const existingDirs = new Set(scan.dirs.map((d) => d.rel));
  const moves = [];
  const rejected = [];
  const taken = new Set();       // destinations already claimed in this plan
  const moved = new Set();       // sources already planned

  const addMove = (from, to, reason, source) => {
    const file = byRel.get(from);
    if (!file) return rejected.push({ from, to, reason: 'El archivo no existe en el análisis' });
    if (isProtected(from)) return rejected.push({ from, to, reason: 'Carpeta protegida' });
    if (moved.has(from)) return rejected.push({ from, to, reason: 'Ya tiene un movimiento planificado' });
    const rawTo = String(to || '').replace(/\\/g, '/');
    if (/^\/|^[a-zA-Z]:|(^|\/)\.\.(\/|$)/.test(rawTo)) return rejected.push({ from, to, reason: 'Destino fuera de la carpeta' });
    let dest = sanitizeRelPath(rawTo);
    if (!dest) return rejected.push({ from, to, reason: 'Destino vacío' });
    // A destination without extension is a folder: keep the original file name inside it.
    const destExt = path.posix.extname(dest).toLowerCase().replace(/^\./, '');
    if (destExt === '' || String(to).endsWith('/')) dest = path.posix.join(dest, file.name);
    else if (destExt !== file.ext) return rejected.push({ from, to, reason: 'No se permite cambiar la extensión' });
    if (dest === from) return rejected.push({ from, to, reason: 'Ya está en su sitio' });
    if (isProtected(dest)) return rejected.push({ from, to, reason: 'Destino en carpeta protegida' });
    let finalDest = dest;
    let n = 1;
    while (taken.has(finalDest) || byRel.has(finalDest)) {
      const ext = path.posix.extname(dest);
      finalDest = `${dest.slice(0, dest.length - ext.length)} (${n})${ext}`;
      n += 1;
    }
    taken.add(finalDest);
    moved.add(from);
    moves.push({ from, to: finalDest, reason: String(reason || ''), source, size: file.size, createsFolder: !existingDirs.has(path.posix.dirname(finalDest)) });
    return null;
  };

  for (const m of Array.isArray(aiJson?.moves) ? aiJson.moves : []) {
    if (!m || typeof m.from !== 'string') continue;
    addMove(m.from.replace(/\\/g, '/').replace(/^\.\//, ''), m.to, m.reason, 'ai');
  }

  const rules = (Array.isArray(aiJson?.rules) ? aiJson.rules : []).map(compileRule).filter(Boolean);
  if (rules.length > 0) {
    for (const f of scan.files) {
      if (moved.has(f.rel) || f.junk) continue;
      if (!applyRulesToSubfolders && f.dir !== '') continue;
      for (const r of rules) {
        const extOk = r.extensions.length === 0 || r.extensions.includes(f.ext);
        const patOk = !r.pattern || r.pattern.test(f.name);
        const ageOk = r.olderThanDays == null || (now - f.mtimeMs) / 86400000 >= r.olderThanDays;
        if (extOk && patOk && ageOk) {
          if (f.dir === r.destination) break; // already there
          addMove(f.rel, path.posix.join(r.destination, f.name), `Regla: ${r.name}`, 'rule');
          break;
        }
      }
    }
  }

  const folders = (Array.isArray(aiJson?.folders) ? aiJson.folders : [])
    .map((d) => ({ path: sanitizeRelPath(String(d?.path || '')), description: String(d?.description || '') }))
    .filter((d) => d.path);

  return {
    summary: String(aiJson?.summary || ''),
    folders,
    rules: rules.map((r) => ({ name: r.name, extensions: r.extensions, destination: r.destination })),
    moves,
    rejected,
    totalBytes: moves.reduce((s, m) => s + m.size, 0),
  };
}

function fileLookup(scan) {
  const byRel = new Map();
  for (const f of [...(scan.stats?.largest || []), ...(scan.stats?.junk || []), ...scan.files]) byRel.set(f.rel, f);
  return byRel;
}

function buildCleanupPlan(aiJson, scan, duplicates, { isProtected: extra = null } = {}) {
  const byRel = fileLookup(scan);
  const seen = new Set();
  const suggestions = [];
  const rejected = [];
  const blocked = (rel) => isProtected(rel) || (extra ? extra(rel) : false);
  const keepers = new Set((duplicates?.groups || []).map((g) => g.files[0].rel));
  const allowedConf = new Set(['alta', 'media', 'baja']);

  for (const s of Array.isArray(aiJson?.suggestions) ? aiJson.suggestions : []) {
    if (!s || typeof s.path !== 'string') continue;
    const rel = s.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const file = byRel.get(rel);
    if (!file) { rejected.push({ path: rel, reason: 'No existe en el análisis' }); continue; }
    if (seen.has(rel)) continue;
    if (blocked(rel)) { rejected.push({ path: rel, reason: 'Carpeta protegida' }); continue; }
    seen.add(rel);
    const confidence = allowedConf.has(String(s.confidence).toLowerCase()) ? String(s.confidence).toLowerCase() : 'baja';
    suggestions.push({
      path: rel,
      size: file.size,
      mtimeMs: file.mtimeMs,
      category: file.category,
      reason: String(s.reason || ''),
      confidence,
      kind: String(s.kind || 'otro'),
      duplicateKeeper: keepers.has(rel),
    });
  }
  // Ensure every duplicate group has all-but-one copy present even if the AI missed it.
  for (const g of duplicates?.groups || []) {
    if (g.files.some((f) => blocked(f.rel))) continue;
    for (const f of g.files.slice(1)) {
      if (seen.has(f.rel)) continue;
      seen.add(f.rel);
      suggestions.push({
        path: f.rel, size: f.size, mtimeMs: f.mtimeMs, category: f.category,
        reason: `Copia idéntica de "${g.files[0].rel}"`, confidence: 'alta', kind: 'duplicado', duplicateKeeper: false,
      });
    }
  }
  suggestions.sort((a, b) => b.size - a.size);
  return {
    summary: String(aiJson?.summary || ''),
    tips: (Array.isArray(aiJson?.tips) ? aiJson.tips : []).map(String).slice(0, 10),
    suggestions,
    rejected,
    totalBytes: suggestions.reduce((s, x) => s + x.size, 0),
    emptyDirs: scan.dirs.filter((d) => d.empty && d.rel !== '' && !blocked(d.rel)).map((d) => d.rel).slice(0, 5000),
  };
}

module.exports = {
  buildExplainMessages,
  buildExplainResult,
  buildOrganizeMessages,
  buildCleanupMessages,
  buildChatMessages,
  buildOrganizePlan,
  buildCleanupPlan,
  sampleFiles,
  isProtected,
};
