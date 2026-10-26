// Release checks: brand-site links, manifest fields required by the Chrome Web Store, locales,
// permissions actually used by the code, content-script layout, shortcut conflicts, no remote code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, SLUG, brandUrls, welcomeUrlFor } from '../extension/lib/brand.js';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const LOCALES = readdirSync(join(EXT, '_locales'));

/** @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(EXT);
const code = files.filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');

/** Which code proves that a permission is used. */
const USAGE = {
  storage: /chrome\.storage\.local\./,
};

test('brand URLs are built from one BASE', () => {
  assert.equal(SLUG, 'dark-mode');
  assert.match(BASE, /^https:\/\/.+\/$/);
  const u = brandUrls();
  assert.equal(u.welcome, `${BASE}welcome/dark-mode.html`);
  assert.equal(u.bye, `${BASE}bye/dark-mode.html`);
  assert.equal(u.privacy, `${BASE}privacy/dark-mode.html`);
  assert.equal(u.other, `${BASE}#dark-mode`);
});

test('welcome page opens only on a fresh install', () => {
  assert.equal(welcomeUrlFor('install'), `${BASE}welcome/dark-mode.html`);
  for (const r of ['update', 'chrome_update', 'shared_module_update', undefined]) assert.equal(welcomeUrlFor(r), null);
});

test('service worker wires the welcome and uninstall pages', () => {
  const sw = read(manifest.background.service_worker);
  assert.match(sw, /from '\.\.\/lib\/brand\.js'/);
  assert.match(sw, /welcomeUrlFor\(details/);
  assert.match(sw, /setUninstallURL\(brandUrls\(\)\.bye\)/);
});

test('"other extensions" links go to the brand site, no placeholders left', () => {
  const pages = files.filter((x) => x.endsWith('.html'));
  assert.ok(pages.length >= 2);
  for (const f of pages) {
    const html = readFileSync(f, 'utf8');
    assert.ok(!html.includes('https://github.com/'), `${f} still links to the github.com placeholder`);
    const links = [...html.matchAll(/<a [^>]*data-i18n="otherExtensions"[^>]*>/g)];
    assert.equal(links.length, 1, `${f}: one "other extensions" link`);
    assert.match(links[0][0], /data-brand-link="other"/, f);
  }
});

test('manifest: CWS fields', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.homepage_url, BASE, 'homepage_url must equal BASE from lib/brand.js');
  assert.equal(manifest.default_locale, 'ru');
  assert.equal(manifest.content_security_policy, undefined, 'default CSP');
  for (const size of ['16', '32', '48', '128']) {
    const png = readFileSync(join(EXT, manifest.icons[size]));
    assert.equal(png.readUInt32BE(16), Number(size), `icon ${size} width`);
    assert.equal(png.readUInt32BE(20), Number(size), `icon ${size} height`);
  }
});

test('manifest: minimal permissions, each used; no host permissions, no network', () => {
  assert.deepEqual([...manifest.permissions].sort(), Object.keys(USAGE).sort());
  for (const p of manifest.permissions) assert.match(code, USAGE[p], `permission ${p} unused`);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing exposed to web pages');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(code), 'no network APIs in the code');
});

test('content scripts: all sites at document_start, files exist, classic scripts only', () => {
  const [pre, main] = manifest.content_scripts;
  assert.deepEqual(pre.matches, ['<all_urls>']);
  assert.equal(pre.run_at, 'document_start');
  assert.deepEqual(pre.css, ['src/content/preload.css']);
  assert.equal(pre.all_frames, false, 'preload only in the top frame (iframes are inverted by the parent filter)');
  assert.deepEqual(main.matches, ['<all_urls>']);
  assert.equal(main.run_at, 'document_start');
  assert.equal(main.all_frames, true);
  assert.equal(main.js.at(-1), 'src/content/content.js', 'entry point loads last');
  for (const f of [...main.js, ...pre.css]) {
    assert.ok(existsSync(join(EXT, f)), f);
    if (f.endsWith('.js')) assert.ok(!/^\s*(import|export)\s/m.test(read(f)), `${f} must be a classic script`);
  }
  // the preload rule must turn itself off once the content script decides
  assert.match(read(pre.css[0]), /html:not\(\[data-nd\]\)/);
});

test('keyboard shortcuts do not clash with Chrome', () => {
  // Chrome's own Alt+Shift shortcuts (support.google.com/chrome/answer/157179) and common Ctrl ones
  const reserved = ['Alt+Shift+I', 'Alt+Shift+T', 'Alt+Shift+A', 'Alt+Shift+N', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+D', 'Ctrl+Shift+B', 'Ctrl+Shift+J', 'Ctrl+Shift+I', 'Ctrl+Shift+Delete'];
  const keys = Object.values(manifest.commands).flatMap((c) => Object.values(c.suggested_key || {}));
  assert.ok(keys.length >= 1);
  for (const k of keys) assert.ok(!reserved.includes(k), `${k} is used by Chrome`);
  assert.ok(Object.keys(manifest.commands).length <= 4);
});

test('locales: ru, en and kk complete, CWS length limits', () => {
  assert.deepEqual(LOCALES.sort(), ['en', 'kk', 'ru']);
  const all = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
  const keys = Object.keys(all.ru).sort();
  const used = new Set([...code.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z0-9_]+)"/g), ...code.matchAll(/\bt\('([A-Za-z0-9_]+)'[,)]/g)].map((m) => m[1]));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  for (const k of used) assert.ok(all.ru[k], `ru: used key ${k} missing`);
  for (const k of keys) assert.ok(used.has(k), `unused locale key ${k}`);
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(all[l]).sort(), keys, `${l} keys`);
    assert.ok([...all[l].extName.message].length <= 75, `${l} name too long`);
    assert.ok([...all[l].extShortName.message].length <= 12, `${l} short_name too long`);
    assert.ok([...all[l].extDescription.message].length <= 132, `${l} description too long`);
    for (const k of keys) {
      const placeholders = (s) => (s.match(/\$\d/g) || []).sort().join();
      assert.equal(placeholders(all[l][k].message), placeholders(all.ru[k].message), `${l}.${k} placeholders`);
    }
  }
});

test('no remote code, eval or debug leftovers', () => {
  for (const f of files.filter((x) => /\.(js|html|css)$/.test(x))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/<script[^>]+src="https?:/.test(src), `${f}: remote script`);
    assert.ok(!/@import\s+url\(["']?https?:|<link[^>]+href="https?:/.test(src), `${f}: remote stylesheet`);
    assert.ok(!/\beval\(|new Function\(|debugger;|\.innerHTML\s*=/.test(src), `${f}: eval/debugger/innerHTML`);
    assert.ok(!/console\.(log|debug)\(/.test(src), `${f}: console.log`);
    assert.ok(!/\b(TODO|FIXME)\b/.test(src) || f.endsWith('brand.js'), `${f}: TODO left`);
  }
});
