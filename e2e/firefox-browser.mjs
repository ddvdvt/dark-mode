// Launch the installed Firefox with the Firefox build of the extension (scripts/firefox.mjs) in a
// temporary profile. The copy differs from the real build only in lib/brand.js BASE (pointed at the
// local server so the welcome tab never leaves 127.0.0.1) and the harness's error collector.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeUnpacked } from '../scripts/firefox.mjs';
import { startFirefox } from './firefox-harness.mjs';

/** @param {{ brandBase: string }} o */
export async function launchFirefoxWithExtension(o) {
  const work = await mkdtemp(join(tmpdir(), 'dark-mode-ff-'));
  const extDir = writeUnpacked(join(work, 'extension'));
  const brandFile = join(extDir, 'lib', 'brand.js');
  const src = await readFile(brandFile, 'utf8');
  const patched = src.replace(/export const BASE = '[^']*';/, `export const BASE = '${o.brandBase}';`);
  if (patched === src) throw new Error('BASE constant not found in lib/brand.js');
  await writeFile(brandFile, patched);
  const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
  const ff = await startFirefox({ extDir, addonId: manifest.browser_specific_settings.gecko.id, prefs: { 'intl.locale.requested': 'ru', 'intl.accept_languages': 'ru-RU, ru' } });
  return {
    ff,
    manifest,
    async close() {
      await ff.close();
      await rm(work, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Write settings through an extension page (content scripts pick them up via storage.onChanged). */
export async function setSettings(page, settings) {
  await page.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

/** Pixels of a PNG screenshot at points, decoded in an extension page. */
export async function pixels(ext, buf, pts) {
  return ext.evaluate(
    async (b64, pts) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return pts.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data));
    },
    Buffer.from(buf).toString('base64'),
    pts,
  );
}
