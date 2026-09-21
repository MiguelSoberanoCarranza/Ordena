'use strict';

const path = require('path');

/**
 * Resolve `rel` inside `root` and make sure the result stays inside root.
 * Rejects absolute paths, `..` escapes and empty segments. Returns the absolute path.
 */
function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('Ruta vacía');
  }
  const normalizedRel = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedRel) || /^[a-zA-Z]:/.test(normalizedRel)) {
    throw new Error(`Ruta absoluta no permitida: ${rel}`);
  }
  const segments = normalizedRel.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new Error(`Ruta fuera de la carpeta raíz: ${rel}`);
  }
  const abs = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  const relCheck = path.relative(rootResolved, abs);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`Ruta fuera de la carpeta raíz: ${rel}`);
  }
  return abs;
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// Windows forbids some characters in file names; keep folder names produced by the AI safe.
function sanitizeSegment(segment) {
  return segment
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim() || 'Sin nombre';
}

function sanitizeRelPath(rel) {
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .map(sanitizeSegment)
    .join('/');
}

module.exports = { resolveInside, toRel, sanitizeSegment, sanitizeRelPath };
