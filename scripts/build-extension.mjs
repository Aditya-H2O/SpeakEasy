// Builds the shared half of the Chrome extension from web/.
//
//   node scripts/build-extension.mjs
//
// The extension's side panel IS the web app: same markup, same app.js, same
// voice detection. Only the wiring differs (extension/config.js, the manifest,
// the service worker, the permission page), and those are hand-written and
// live in extension/ directly. Everything this script writes is generated --
// edit web/ and re-run it, never the copies. `npm test` fails if they drift.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const EXT = path.join(ROOT, 'extension');

const BANNER = '/* GENERATED from web/ by scripts/build-extension.mjs -- edit the original. */\n';

export function sidepanelHtml() {
  const src = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const out = src
    .replace('<script src="app.js"></script>', '<script src="config.js"></script>\n    <script src="app.js"></script>')
    .replaceAll('href="./"', 'href="sidepanel.html"')
    .replace('<a class="home" href="/">', '<a class="home" href="https://aditya-h.com/" target="_blank" rel="noopener">');
  if (!out.includes('config.js') || out.includes('href="./"')) throw new Error('web/index.html changed shape; update build-extension.mjs');
  return '<!-- GENERATED from web/index.html by scripts/build-extension.mjs -- edit the original. -->\n' + out;
}

export const COPIED = ['app.js', 'style.css', 'vad-worklet.js'];
export const copied = (name) => BANNER + fs.readFileSync(path.join(WEB, name), 'utf8');

// ---- icons: the same mark as web/icon.svg, rasterised without dependencies --

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Coverage of the 32x32 design at a point: rounded square plus four bars.
const BARS = [[7, 13, 6], [12, 9, 14], [17, 6, 20], [22, 11, 10]]; // x, y, h; w = 3, r = 1.5
function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

export function iconPng(size) {
  const SS = 4; // supersampling per axis
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0, bar = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / size) * 32;
        const y = ((py + (sy + 0.5) / SS) / size) * 32;
        if (!inRoundRect(x, y, 0, 0, 32, 32, 8)) continue;
        bg++;
        if (BARS.some(([bx, by, h]) => inRoundRect(x, y, bx, by, 3, h, 1.5))) bar++;
      }
      const n = SS * SS;
      const a = bg / n, w = bg ? bar / bg : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(0xe8 + (255 - 0xe8) * w);
      raw[o + 1] = Math.round(0x61 + (255 - 0x61) * w);
      raw[o + 2] = Math.round(0x3c + (255 - 0x3c) * w);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export const ICON_SIZES = [16, 32, 48, 128];

// ---- main ---------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(EXT, 'sidepanel.html'), sidepanelHtml());
  for (const name of COPIED) fs.writeFileSync(path.join(EXT, name), copied(name));
  fs.copyFileSync(path.join(WEB, 'icon.svg'), path.join(EXT, 'icon.svg'));
  fs.mkdirSync(path.join(EXT, 'icons'), { recursive: true });
  for (const s of ICON_SIZES) fs.writeFileSync(path.join(EXT, 'icons', `icon-${s}.png`), iconPng(s));
  console.log('extension/ rebuilt from web/');
}
