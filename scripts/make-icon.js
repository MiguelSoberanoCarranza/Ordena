'use strict';
// Generates build/icon.png (1024x1024) without external dependencies.
// electron-builder converts it to .icns (macOS) and .ico (Windows) at build time.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const px = Buffer.alloc(SIZE * SIZE * 4);

function put(x, y, r, g, b, a = 255) {
  const i = (y * SIZE + x) * 4;
  // simple alpha blend over existing pixel
  const ia = a / 255;
  px[i] = Math.round(r * ia + px[i] * (1 - ia));
  px[i + 1] = Math.round(g * ia + px[i + 1] * (1 - ia));
  px[i + 2] = Math.round(b * ia + px[i + 2] * (1 - ia));
  px[i + 3] = Math.min(255, px[i + 3] + a);
}

function roundedRect(x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - 1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - 1 - radius));
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius + 0.5) continue;
      const a = d > radius - 0.5 ? Math.round((radius + 0.5 - d) * 255) : 255;
      const c = typeof color === 'function' ? color(x, y) : color;
      put(x, y, c[0], c[1], c[2], Math.min(a, c[3] ?? 255));
    }
  }
}

// Background: rounded square with a blue→violet gradient.
roundedRect(0, 0, SIZE, SIZE, 224, (x, y) => {
  const t = (x + y) / (2 * SIZE);
  return [Math.round(59 + (124 - 59) * t), Math.round(108 + (92 - 108) * t), Math.round(246 + (255 - 246) * t)];
});
// Folder body.
roundedRect(192, 336, 640, 440, 48, [255, 255, 255, 235]);
// Folder tab.
roundedRect(192, 272, 260, 120, 40, [255, 255, 255, 235]);
// Three "sorted" lines inside the folder.
roundedRect(288, 456, 448, 44, 22, [59, 108, 246]);
roundedRect(288, 556, 340, 44, 22, [59, 108, 246, 200]);
roundedRect(288, 656, 220, 44, 22, [59, 108, 246, 150]);

function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n += 1) { c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes)`);
