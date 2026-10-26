// Generates extension/icons/icon{16,32,48,128}.png — a dark indigo rounded tile with a light crescent
// moon and a small star. No dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './zip.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const TILE = [32, 30, 66];
const TILE2 = [79, 70, 200];
const MOON = [255, 214, 102];

/** Shape test in unit coordinates (0..1). Returns RGB or null (transparent). */
function shade(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // crescent: big disc minus offset disc
  const inMoon = (x - 0.47) ** 2 + (y - 0.53) ** 2 < 0.29 ** 2;
  const bite = (x - 0.62) ** 2 + (y - 0.42) ** 2 < 0.25 ** 2;
  if (inMoon && !bite) return MOON;
  // small four-point star
  const sx = Math.abs(x - 0.74), sy = Math.abs(y - 0.27);
  if (sx * sy < 0.0011 && sx < 0.09 && sy < 0.09) return MOON;
  // vertical gradient tile
  const t = y;
  return TILE.map((c, i) => Math.round(c + (TILE2[i] - c) * t * 0.55));
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a++;
          }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(join(OUT, `icon${s}.png`), png(s));
console.log('icons written to', OUT);
