// Tiny PNG encoder for test images (a colorful "photo" gradient). No dependencies.
import { deflateSync } from 'node:zlib';
import { crc32 } from '../scripts/zip.mjs';

/**
 * @param {number} w @param {number} h
 * @param {(x: number, y: number) => [number, number, number]} pixel
 */
export function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Sunset-like photo: orange sky over a green field — strong, recognisable colors. */
export const PHOTO = png(240, 120, (x, y) => (y < 70 ? [240, 140 + Math.round(y), 40] : [40, 150 + Math.round((x / 240) * 60), 60]));

/** Mountains at sunset: gradient sky, sun, two mountain ridges, a river. */
export const MOUNTAINS = png(900, 340, (x, y) => {
  const t = y / 340;
  const ridge1 = 170 + 60 * Math.sin(x / 90) + 30 * Math.sin(x / 37);
  const ridge2 = 220 + 40 * Math.sin(x / 140 + 1) + 18 * Math.sin(x / 23);
  if ((x - 640) ** 2 + (y - 150) ** 2 < 42 ** 2 && y < ridge1) return [255, 214, 120];
  if (y > 285) return [70 + Math.round(40 * Math.sin(x / 15 + y)), 110, 160];
  if (y > ridge2) return [38, 70, 52];
  if (y > ridge1) return [92, 84, 120];
  return [Math.round(250 - 40 * t), Math.round(150 + 40 * t), Math.round(110 + 80 * t)];
});

/** A lake at dawn. */
export const LAKE = png(300, 120, (x, y) => {
  const hill = 55 + 12 * Math.sin(x / 30);
  if (y > 70) return [60, 120 + Math.round(y / 3), 170];
  if (y > hill) return [45, 95, 60];
  return [255 - Math.round(y), 200 - Math.round(y / 2), 170 + Math.round(y / 2)];
});
