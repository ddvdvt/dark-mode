// E2E smoke test: the unpacked extension in the installed Chromium on local fixture pages only.
// Checks both engines, the "already dark" detection, no white flash, no layout changes, iframes,
// dynamic content, popup controls, schedule, options (site list, export/import) and console errors.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServers } from './server.mjs';
import { launchWithExtension, setSettings } from './browser.mjs';

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

/** Poll until fn() is truthy. */
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const lum = (s) => {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s);
  if (!m) return NaN;
  const f = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
};

const srv = await startServers();
const brandBase = srv.url('brand/');
const b = await launchWithExtension({ brandBase });
const { context, extId } = b;
const errors = [];
context.on('page', (p) => {
  p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`);
  });
});

const css = (page, sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const nd = (page) => page.evaluate(() => document.documentElement.getAttribute('data-nd'));

let exitCode = 0;
try {
  await step('fresh install opens the welcome page of the brand site', async () => {
    const welcome = `${brandBase}welcome/dark-mode.html`;
    const page = await until(() => context.pages().find((p) => p.url() === welcome), 10000, 'welcome tab');
    await page.close();
  });

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/options/options.html`);
  await ext.waitForSelector('body[data-ready]');
  // Without the "tabs" permission tab URLs are hidden, so find a tab by activating its page.
  /** @type {Map<string, any>} */
  const pagesByUrl = new Map();
  const tabIdOf = async (url) => {
    const p = pagesByUrl.get(url);
    await p.bringToFront();
    const id = await ext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
    assert.ok(id, 'tab id');
    return id;
  };
  const status = async (url) => ext.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'nd:status' }, { frameId: 0 }), await tabIdOf(url));

  const BASIC = srv.url('basic.html');
  const page = await context.newPage();
  await page.goto(BASIC);
  pagesByUrl.set(BASIC, page);
  await until(async () => (await nd(page)) === 'dynamic', 3000, 'dynamic engine');

  const LAYOUT_SEL = ['#title', '#lead', '#card', '#warn', '#inline', '#remote', '#table', '#name', '#photo', '#hero', '#frame', 'header'];
  const rects = () => page.evaluate((sels) => sels.map((s) => JSON.stringify(document.querySelector(s).getBoundingClientRect())), LAYOUT_SEL);

  await step('smart engine: page colors rewritten, text readable, images untouched', async () => {
    assert.ok(lum(await css(page, 'body', 'background-color')) < 0.03, 'body background is dark');
    assert.ok(lum(await css(page, '#title', 'color')) > 0.5, 'heading is light');
    assert.ok(lum(await css(page, '#link', 'color')) > 0.3, 'link is light');
    assert.ok(lum(await css(page, '#warn', 'background-color')) < 0.1, 'yellow note became dark');
    assert.ok(lum(await css(page, '#card', 'border-top-color')) < 0.1, 'light border became dark');
    assert.match(await css(page, '#card', 'background-image'), /linear-gradient\(rgb\(\d/, 'gradient rewritten');
    assert.equal(await css(page, '#photo', 'filter'), 'none', 'photo untouched');
    assert.equal(await css(page, 'html', 'color-scheme'), 'dark', 'native controls use the dark scheme');
  });

  await step('smart engine: inline styles, legacy attributes, cross-origin CSS and SVG via the fallback', async () => {
    await until(async () => lum(await css(page, '#remote', 'background-color')) < 0.05, 3000, 'cross-origin block');
    assert.ok(lum(await css(page, '#remote', 'color')) > 0.5, 'cross-origin text light');
    assert.ok(lum(await css(page, '#remote', 'border-top-color')) < 0.1, 'cross-origin border dark');
    assert.ok(lum(await css(page, '#inline', 'background-color')) < 0.05, 'inline style background');
    assert.ok(lum(await css(page, '#inline', 'color')) > 0.5, 'inline style text');
    assert.ok(lum(await css(page, '#legacy', 'background-color')) < 0.05, 'bgcolor attribute');
    assert.ok(lum(await css(page, '#table font', 'color')) > 0.2, '<font color>');
    assert.ok(lum(await css(page, '#iconPath', 'fill')) > 0.5, 'svg fill attribute');
  });

  await step('form controls stay readable', async () => {
    for (const sel of ['#name', '#text', '#sel']) {
      const bg = lum(await css(page, sel, 'background-color'));
      const fg = lum(await css(page, sel, 'color'));
      assert.ok((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) > 4.5, `${sel} contrast`);
    }
  });

  await step('same-origin iframe is darkened too', async () => {
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
    assert.ok(frame);
    await until(() => frame.evaluate(() => document.documentElement.getAttribute('data-nd') === 'dynamic'), 3000, 'frame engine');
    assert.ok(lum(await frame.$eval('body', (el) => getComputedStyle(el).backgroundColor)) < 0.05);
  });

  await step('popup shows the site, engine and timing', async () => {
    const st = await status(BASIC);
    assert.equal(st.host, '127.0.0.1');
    assert.equal(st.state, 'on');
    assert.equal(st.engine, 'dynamic');
    assert.ok(st.appliedMs >= 0 && st.appliedMs < 200, `applied in ${st.appliedMs} ms`);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${await tabIdOf(BASIC)}`);
    await popup.waitForSelector('body[data-ready="1"]');
    assert.equal(await popup.textContent('#host'), '127.0.0.1');
    assert.match(await popup.textContent('#status'), /Умный/);
    assert.equal(await popup.textContent('#siteToggle'), 'Выключить на этом сайте');
    assert.match(await popup.textContent('#shortcut'), /Alt\+Shift\+L/);
    await popup.close();
  });

  const smartRects = await rects();

  await step('turning the site off from the popup restores the page completely', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${await tabIdOf(BASIC)}`);
    await popup.waitForSelector('body[data-ready="1"]');
    await popup.click('#siteToggle');
    await until(async () => (await nd(page)) === 'off', 3000, 'off');
    assert.equal(await css(page, 'body', 'background-color'), 'rgb(255, 255, 255)');
    assert.equal(await page.$$eval('[data-nd-s], [data-nd-c], [data-nd-img]', (l) => l.length), 0, 'no leftovers');
    const s = await ext.evaluate(() => chrome.storage.local.get('settings'));
    assert.deepEqual(s.settings.sites, { '127.0.0.1': { mode: 'off' } });
    await until(async () => (await popup.textContent('#status')).includes('Выключено на этом сайте'), 3000, 'popup status');
    await popup.close();
  });

  await step('no layout changes: element boxes are identical with the theme on and off', async () => {
    const offRects = await rects();
    assert.deepEqual(smartRects, offRects);
  });

  await step('keyboard command handler toggles the site back on', async () => {
    const cmds = await ext.evaluate(() => chrome.commands.getAll());
    assert.equal(cmds.find((c) => c.name === 'toggle-site').shortcut, 'Alt+Shift+L');
    const id = await tabIdOf(BASIC);
    // the service worker sends exactly this message when the shortcut is pressed
    await ext.evaluate((tid) => chrome.tabs.sendMessage(tid, { type: 'nd:toggle-site' }, { frameId: 0 }), id);
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'back on');
    const s = await ext.evaluate(() => chrome.storage.local.get('settings'));
    assert.deepEqual(s.settings.sites, {});
  });

  await step('fast engine: one filter on <html>, media re-inverted, frame not double-inverted', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${await tabIdOf(BASIC)}`);
    await popup.waitForSelector('body[data-ready="1"]');
    await popup.selectOption('#siteEngine', 'filter');
    await until(async () => (await nd(page)) === 'filter', 3000, 'filter engine');
    await popup.close();
    assert.match(await css(page, 'html', 'filter'), /^invert\(1\) hue-rotate\(180deg\)/);
    assert.match(await css(page, '#photo', 'filter'), /^invert\(1\) hue-rotate\(180deg\)/);
    await until(() => page.$eval('#hero', (el) => el.hasAttribute('data-nd-img')), 3000, 'background photo detected');
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
    assert.equal(await frame.evaluate(() => document.documentElement.getAttribute('data-nd')), 'off');
    assert.deepEqual(await rects(), smartRects, 'layout unchanged in filter mode too');
    // pixels: the page background is dark, the photo keeps its orange sky
    const shot = await page.screenshot();
    const px = await ext.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return [Array.from(x.getImageData(60, 300, 1, 1).data), Array.from(x.getImageData(140, 600, 1, 1).data)];
    }, shot.toString('base64'));
    const box = await page.$eval('#photo', (el) => el.getBoundingClientRect().toJSON());
    assert.ok(px[0][0] < 40 && px[0][1] < 40 && px[0][2] < 40, `background pixel ${px[0]}`);
    if (box.top < 600 && box.bottom > 600) assert.ok(px[1][0] > 180 && px[1][2] < 120, `photo pixel ${px[1]}`);
  });

  await step('sliders: brightness and sepia reach the page', async () => {
    await setSettings(ext, { ...(await ext.evaluate(async () => (await chrome.storage.local.get('settings')).settings)), brightness: 80, sepia: 20 });
    await until(async () => /brightness\(0\.8\) sepia\(0\.2\)/.test(await css(page, 'html', 'filter')), 3000, 'filter with sliders');
    await setSettings(ext, {});
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'defaults');
    assert.equal(await css(page, 'html', 'filter'), 'none');
  });

  await step('dynamic content: new styles, inline styles and CSSOM rules are themed', async () => {
    const dyn = await context.newPage();
    await dyn.goto(srv.url('dynamic.html'));
    await until(async () => (await nd(dyn)) === 'dynamic', 3000, 'engine');
    await dyn.evaluate(() => window.addStyled());
    // processed synchronously in the mutation callback: dark before the next frame
    assert.ok(lum(await css(dyn, '#late', 'background-color')) < 0.05, 'late <style>');
    await dyn.evaluate(() => window.addItems(50));
    await until(async () => lum(await dyn.$eval('.item', (el) => getComputedStyle(el).backgroundColor)) < 0.05, 1000, 'inline styled items');
    await dyn.evaluate(() => window.addCssom());
    await until(async () => lum(await css(dyn, '#cssom', 'background-color')) < 0.05, 3000, 'insertRule()');
    await dyn.close();
  });

  await step('already dark sites are left alone', async () => {
    const DARK = srv.url('dark.html');
    const dark = await context.newPage();
    await dark.goto(DARK);
    pagesByUrl.set(DARK, dark);
    await until(async () => (await status(DARK)).state === 'already-dark', 4000, 'detection');
    assert.equal(await nd(dark), 'off');
    assert.equal(await css(dark, 'html', 'background-color'), 'rgb(13, 17, 23)');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${await tabIdOf(DARK)}`);
    await popup.waitForSelector('body[data-ready="1"]');
    assert.match(await popup.textContent('#status'), /уже тёмный/);
    assert.equal(await popup.textContent('#siteToggle'), 'Всё равно затемнить');
    await popup.close();
    await dark.close();
  });

  await step('no white flash: a slowly loading page is dark before its body arrives', async () => {
    const slow = await context.newPage();
    await slow.goto(srv.url('slow.html'), { waitUntil: 'commit' });
    await slow.waitForTimeout(700); // the server holds the <body> for 1.5 s
    const shot = await slow.screenshot();
    const px = await ext.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return Array.from(x.getImageData(500, 400, 1, 1).data);
    }, shot.toString('base64'));
    assert.ok(px[0] < 40 && px[1] < 40 && px[2] < 40, `pixel while loading: ${px}`);
    await slow.waitForSelector('#late');
    assert.ok(lum(await css(slow, 'body', 'background-color')) < 0.05);
    await slow.close();
  });

  await step('schedule and global switch', async () => {
    const now = new Date();
    const hh = (h) => String((h + 24) % 24).padStart(2, '0') + ':00';
    // a window that does not contain the current hour
    await setSettings(ext, { schedule: { mode: 'time', from: hh(now.getHours() + 2), to: hh(now.getHours() + 3) } });
    await until(async () => (await nd(page)) === 'off', 3000, 'off by schedule');
    assert.equal((await status(BASIC)).state, 'schedule');
    await setSettings(ext, { schedule: { mode: 'system' } });
    await until(async () => (await status(BASIC)).state === 'schedule', 3000, 'system light → off');
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'system dark → on');
    await page.emulateMedia({ colorScheme: 'light' });
    await setSettings(ext, {});
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${await tabIdOf(BASIC)}`);
    await popup.waitForSelector('body[data-ready="1"]');
    await popup.click('#global');
    await until(async () => (await nd(page)) === 'off', 3000, 'global off');
    assert.equal(await popup.getAttribute('#global', 'aria-checked'), 'false');
    await popup.click('#global');
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'global on');
    await popup.close();
  });

  await step('options: add a site, export and import the list as JSON', async () => {
    await ext.reload();
    await ext.waitForSelector('body[data-ready]');
    await ext.fill('#addHost', 'https://WWW.Example.com/some/page');
    await ext.click('#addForm button[type="submit"]');
    await ext.waitForSelector('#sites tr');
    assert.equal(await ext.textContent('#sites tr td'), 'example.com');
    await ext.fill('#addHost', 'not a host');
    await ext.click('#addForm button[type="submit"]');
    assert.ok(await ext.isVisible('#addError'));
    const [dl] = await Promise.all([ext.waitForEvent('download'), ext.click('#export')]);
    const exported = JSON.parse(await readFile(await dl.path(), 'utf8'));
    assert.equal(exported.app, 'dark-mode');
    assert.deepEqual(exported.sites, { 'example.com': { mode: 'off' } });
    const dir = await mkdtemp(join(tmpdir(), 'dm-import-'));
    const file = join(dir, 'sites.json');
    await writeFile(file, JSON.stringify({ ...exported, sites: { 'news.example.org': { mode: 'on', engine: 'filter' }, 'bad host': { mode: 'off' } } }));
    await ext.setInputFiles('#importFile', file);
    await until(async () => (await ext.textContent('#ioMsg')).includes('добавлено 1'), 3000, 'import message');
    assert.equal(await ext.$$eval('#sites tr', (l) => l.length), 2);
    ext.once('dialog', (d) => d.accept());
    await ext.click('#clearSites');
    await until(async () => (await ext.$$eval('#sites tr', (l) => l.length)) === 0, 3000, 'cleared');
    assert.ok(await ext.isVisible('#sitesEmpty'));
  });

  await step('no errors in extension pages and fixture pages', async () => {
    assert.deepEqual(errors, []);
  });

  console.log(`\n${passed} passed`);
} catch (e) {
  exitCode = 1;
  console.error('not ok -', e && e.stack ? e.stack : e);
} finally {
  await b.close();
  srv.close();
}
process.exit(exitCode);
