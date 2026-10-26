// Packs extension/ into dist/dark-mode-<version>.zip for the Chrome Web Store (no dependencies),
// then re-opens the archive and verifies it: manifest at the root, locales present, forward slashes,
// no tests / node_modules / dotfiles, CRCs match, every file the manifest references is inside.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, readZip, crc32 } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') continue; // no dotfiles in the store package
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ name: relative(ext, p).split(sep).join('/'), data: new Uint8Array(readFileSync(p)) });
  }
})(ext);
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `dark-mode-${manifest.version}.zip`);
writeFileSync(out, createZip(files));

// ---- verify what was written
const entries = readZip(new Uint8Array(readFileSync(out)));
const names = new Set(entries.map((e) => e.name));
const fail = (msg) => {
  console.error('ZIP CHECK FAILED:', msg);
  process.exit(1);
};
if (!names.has('manifest.json')) fail('manifest.json is not at the root');
for (const e of entries) {
  if (e.name.includes('\\')) fail(`backslash in ${e.name}`);
  if (/(^|\/)\./.test(e.name)) fail(`dotfile ${e.name}`);
  if (/(^|\/)(node_modules|test|e2e|scripts|store|dist)\//.test(e.name)) fail(`dev file ${e.name}`);
  if (crc32(e.data) !== e.crc) fail(`CRC mismatch in ${e.name}`);
}
for (const l of ['ru', 'en', 'kk']) if (!names.has(`_locales/${l}/messages.json`)) fail(`locale ${l} missing`);
const referenced = [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
];
for (const f of referenced) if (!names.has(f)) fail(`manifest references missing file ${f}`);
const size = statSync(out).size;
console.log(`${entries.length} files, ${(size / 1024).toFixed(1)} KB -> ${out} (verified)`);
