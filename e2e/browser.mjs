// Launch the installed Chromium with a temporary copy of the extension. The copy differs from the real
// extension only in lib/brand.js BASE, pointed at the local server so the welcome tab never leaves
// 127.0.0.1. No host permissions are added: the extension needs none.
import { chromium } from 'playwright-core';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXE =
  process.env.CHROMIUM_PATH ||
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

/**
 * @param {{ brandBase: string, viewport?: { width: number, height: number }, colorScheme?: 'light' | 'dark', args?: string[] }} o
 */
export async function launchWithExtension(o) {
  if (!existsSync(EXE)) throw new Error(`Chromium not found at ${EXE}. Set CHROMIUM_PATH.`);
  const work = await mkdtemp(join(tmpdir(), 'dark-mode-e2e-'));
  const extDir = join(work, 'extension');
  await cp(join(ROOT, 'extension'), extDir, { recursive: true });
  const brandFile = join(extDir, 'lib', 'brand.js');
  const src = await readFile(brandFile, 'utf8');
  const patched = src.replace(/export const BASE = '[^']*';/, `export const BASE = '${o.brandBase}';`);
  if (patched === src) throw new Error('BASE constant not found in lib/brand.js');
  await writeFile(brandFile, patched);
  const context = await chromium.launchPersistentContext(join(work, 'profile'), {
    executablePath: EXE,
    headless: false,
    acceptDownloads: true,
    colorScheme: o.colorScheme || 'light',
    viewport: o.viewport || { width: 1000, height: 760 },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    args: [
      '--headless=new',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--renderer-process-limit=2',
      '--lang=ru',
      ...(o.args || []),
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return {
    context,
    sw,
    extId,
    extDir,
    async close() {
      await context.close().catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Write settings through an extension page (content scripts pick them up via storage.onChanged). */
export async function setSettings(page, settings) {
  await page.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}
