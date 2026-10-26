// E2E smoke test in real Firefox: the Firefox build in a temporary profile, local fixture pages only.
// Same checks as e2e/smoke.mjs (both engines, already-dark detection, no white flash, no layout
// changes, iframes, dynamic content, popup controls, schedule, options) plus the Firefox-only case
// "access to websites withheld by the user" (MV3 host permissions are revocable in Firefox).
// Popups cannot be opened from the toolbar in automation: popup.html is opened as a tab with ?tabId=.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startServers } from './server.mjs';
import { launchFirefoxWithExtension, setSettings, pixels } from './firefox-browser.mjs';

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy. */
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
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
const b = await launchFirefoxWithExtension({ brandBase });
const { ff, manifest } = b;
const VIEWPORT = { width: 1000, height: 760 };

const css = (page, sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const nd = (page) => page.evaluate(() => document.documentElement.getAttribute('data-nd'));
const text = (page, sel) => page.$eval(sel, (el) => el.textContent);
const visible = (page, sel) => page.$eval(sel, (el) => !!el.offsetParent || el.getClientRects().length > 0).catch(() => false);
async function newPage(url) {
  const p = await ff.browser.newPage();
  await p.setViewport(VIEWPORT);
  if (url) await p.goto(url, { waitUntil: 'load' });
  return p;
}

let exitCode = 0;
try {
  await step('fresh install opens the welcome page of the brand site', async () => {
    const page = await ff.findPage((u) => u === `${brandBase}welcome/dark-mode.html`, 15000);
    assert.ok(page, 'welcome tab');
    await page.close();
  });

  const ext = await ff.open(manifest.options_ui.page);
  await ff.waitFor(ext, () => document.body.dataset.ready);
  /** @type {Map<string, any>} */
  const pagesByUrl = new Map();
  // Without the "tabs" permission tab URLs are hidden, so find a tab by activating its page.
  const tabIdOf = async (url) => {
    await pagesByUrl.get(url).bringToFront();
    await sleep(100);
    const id = await ext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
    assert.ok(id, 'tab id');
    return id;
  };
  const status = async (url) => ext.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'nd:status' }, { frameId: 0 }), await tabIdOf(url));
  const openPopup = async (url) => {
    const popup = await ff.open(`${manifest.action.default_popup}?tabId=${await tabIdOf(url)}`);
    await ff.waitFor(popup, () => document.body.dataset.ready === '1');
    return popup;
  };

  const BASIC = srv.url('basic.html');
  const page = await newPage(BASIC);
  pagesByUrl.set(BASIC, page);
  await until(async () => (await nd(page)) === 'dynamic', 3000, 'dynamic engine');

  const LAYOUT_SEL = ['#title', '#lead', '#card', '#warn', '#inline', '#remote', '#table', '#name', '#photo', '#hero', '#frame', 'header'];
  const rects = () => page.evaluate((sels) => sels.map((s) => JSON.stringify(document.querySelector(s).getBoundingClientRect())), LAYOUT_SEL);

  await step('Firefox build loads: content scripts at document_start, extension has access to websites', async () => {
    assert.equal(await ext.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), true);
    assert.equal(await css(page, 'html', 'color-scheme'), 'dark');
  });

  await step('smart engine: page colors rewritten, text readable, images untouched', async () => {
    assert.ok(lum(await css(page, 'body', 'background-color')) < 0.03, 'body background is dark');
    assert.ok(lum(await css(page, '#title', 'color')) > 0.5, 'heading is light');
    assert.ok(lum(await css(page, '#link', 'color')) > 0.3, 'link is light');
    assert.ok(lum(await css(page, '#warn', 'background-color')) < 0.1, 'yellow note became dark');
    assert.ok(lum(await css(page, '#card', 'border-top-color')) < 0.1, 'light border became dark');
    assert.match(await css(page, '#card', 'background-image'), /linear-gradient\(rgb\(\d/, 'gradient rewritten');
    assert.equal(await css(page, '#photo', 'filter'), 'none', 'photo untouched');
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
    const popup = await openPopup(BASIC);
    assert.equal(await text(popup, '#host'), '127.0.0.1');
    assert.match(await text(popup, '#status'), /Умный|Smart/);
    assert.match(await text(popup, '#siteToggle'), /Выключить на этом сайте|Turn off for this site/);
    assert.match(await text(popup, '#shortcut'), /Alt\+Shift\+L/);
    assert.equal(await visible(popup, '#access'), false);
    await popup.close();
  });

  const smartRects = await rects();

  await step('turning the site off from the popup restores the page completely', async () => {
    const popup = await openPopup(BASIC);
    await popup.click('#siteToggle');
    await until(async () => (await nd(page)) === 'off', 3000, 'off');
    assert.equal(await css(page, 'body', 'background-color'), 'rgb(255, 255, 255)');
    assert.equal(await page.$$eval('[data-nd-s], [data-nd-c], [data-nd-img]', (l) => l.length), 0, 'no leftovers');
    const s = await ext.evaluate(() => chrome.storage.local.get('settings'));
    assert.deepEqual(s.settings.sites, { '127.0.0.1': { mode: 'off' } });
    await until(async () => /Выключено на этом сайте|Turned off for this site/.test(await text(popup, '#status')), 3000, 'popup status');
    await popup.close();
  });

  await step('no layout changes: element boxes are identical with the theme on and off', async () => {
    assert.deepEqual(smartRects, await rects());
  });

  await step('keyboard command: Alt+Shift+L registered; the handler toggles the site back on', async () => {
    const cmds = await ext.evaluate(() => chrome.commands.getAll());
    assert.equal(cmds.find((c) => c.name === 'toggle-site').shortcut, 'Alt+Shift+L');
    const id = await tabIdOf(BASIC);
    // the background sends exactly this message when the shortcut is pressed
    await ext.evaluate((tid) => chrome.tabs.sendMessage(tid, { type: 'nd:toggle-site' }, { frameId: 0 }), id);
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'back on');
    const s = await ext.evaluate(() => chrome.storage.local.get('settings'));
    assert.deepEqual(s.settings.sites, {});
  });

  await step('fast engine: one filter on <html>, media re-inverted, frame not double-inverted', async () => {
    const popup = await openPopup(BASIC);
    await popup.select('#siteEngine', 'filter');
    await until(async () => (await nd(page)) === 'filter', 3000, 'filter engine');
    await popup.close();
    assert.match(await css(page, 'html', 'filter'), /^invert\(1\) hue-rotate\(180deg\)/);
    assert.match(await css(page, '#photo', 'filter'), /^invert\(1\) hue-rotate\(180deg\)/);
    await until(() => page.$eval('#hero', (el) => el.hasAttribute('data-nd-img')), 3000, 'background photo detected');
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
    assert.equal(await frame.evaluate(() => document.documentElement.getAttribute('data-nd')), 'off');
    assert.deepEqual(await rects(), smartRects, 'layout unchanged in filter mode too');
    await page.bringToFront();
    await page.evaluate(() => window.scrollTo(0, 0));
    const shot = await page.screenshot();
    const px = await pixels(ext, shot, [[60, 300], [140, 600]]);
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
    const dyn = await newPage(srv.url('dynamic.html'));
    await until(async () => (await nd(dyn)) === 'dynamic', 3000, 'engine');
    await dyn.evaluate(() => window.addStyled());
    assert.ok(lum(await css(dyn, '#late', 'background-color')) < 0.05, 'late <style>');
    await dyn.evaluate(() => window.addItems(50));
    await until(async () => lum(await dyn.$eval('.item', (el) => getComputedStyle(el).backgroundColor)) < 0.05, 1000, 'inline styled items');
    await dyn.evaluate(() => window.addCssom());
    await until(async () => lum(await css(dyn, '#cssom', 'background-color')) < 0.05, 3000, 'insertRule()');
    await dyn.close();
  });

  await step('already dark sites are left alone', async () => {
    const DARK = srv.url('dark.html');
    const dark = await newPage(DARK);
    pagesByUrl.set(DARK, dark);
    await until(async () => (await status(DARK)).state === 'already-dark', 4000, 'detection');
    assert.equal(await nd(dark), 'off');
    assert.equal(await css(dark, 'html', 'background-color'), 'rgb(13, 17, 23)');
    const popup = await openPopup(DARK);
    assert.match(await text(popup, '#status'), /уже тёмный|already dark/);
    assert.match(await text(popup, '#siteToggle'), /Всё равно затемнить|Darken anyway/);
    await popup.close();
    await dark.close();
  });

  await step('no white flash: a slowly loading page is dark before its body arrives (preload.css at document_start)', async () => {
    const slow = await newPage();
    slow.goto(srv.url('slow.html')).catch(() => {});
    await sleep(700); // the server holds the <body> for 1.5 s
    const shot = await slow.screenshot();
    const [px] = await pixels(ext, shot, [[500, 400]]);
    assert.ok(px[0] < 40 && px[1] < 40 && px[2] < 40, `pixel while loading: ${px}`);
    await ff.waitFor(slow, () => !!document.getElementById('late'));
    assert.ok(lum(await css(slow, 'body', 'background-color')) < 0.05);
    await slow.close();
  });

  await step('schedule and global switch', async () => {
    const now = new Date();
    const hh = (h) => String((h + 24) % 24).padStart(2, '0') + ':00';
    await setSettings(ext, { schedule: { mode: 'time', from: hh(now.getHours() + 2), to: hh(now.getHours() + 3) } });
    await until(async () => (await nd(page)) === 'off', 3000, 'off by schedule');
    assert.equal((await status(BASIC)).state, 'schedule');
    await setSettings(ext, { schedule: { mode: 'system' } });
    await until(async () => (await status(BASIC)).state === 'schedule', 3000, 'system light → off');
    await ff.setColorScheme('dark');
    await page.reload({ waitUntil: 'load' });
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'system dark → on');
    await ff.setColorScheme('light');
    await page.reload({ waitUntil: 'load' });
    await setSettings(ext, {});
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'defaults');
    const popup = await openPopup(BASIC);
    await popup.click('#global');
    await until(async () => (await nd(page)) === 'off', 3000, 'global off');
    assert.equal(await popup.$eval('#global', (el) => el.getAttribute('aria-checked')), 'false');
    await popup.click('#global');
    await until(async () => (await nd(page)) === 'dynamic', 3000, 'global on');
    await popup.close();
  });

  await step('options: add a site, export and import the list as JSON', async () => {
    await ff.navigate(ext, `${ff.base}${manifest.options_ui.page}`);
    await ff.waitFor(ext, () => document.body.dataset.ready);
    const fill = async (sel, value) => {
      await ext.$eval(sel, (el) => (el.value = ''));
      await ext.type(sel, value);
    };
    await fill('#addHost', 'https://WWW.Example.com/some/page');
    await ext.click('#addForm button[type="submit"]');
    await ff.waitFor(ext, () => !!document.querySelector('#sites tr'));
    assert.equal(await text(ext, '#sites tr td'), 'example.com');
    await fill('#addHost', 'not a host');
    await ext.click('#addForm button[type="submit"]');
    assert.ok(await visible(ext, '#addError'));
    const before = new Set(await readdir(ff.downloads));
    await ext.click('#export');
    // the file appears first empty (still being written): wait until it parses
    const exported = await until(async () => {
      const f = (await readdir(ff.downloads)).find((x) => !before.has(x) && x.endsWith('.json'));
      return f ? JSON.parse(await readFile(join(ff.downloads, f), 'utf8')) : null;
    }, 5000, 'export download');
    assert.equal(exported.app, 'dark-mode');
    assert.deepEqual(exported.sites, { 'example.com': { mode: 'off' } });
    // input.setFiles is not available on extension pages over BiDi: hand the file to the input via DataTransfer
    const json = JSON.stringify({ ...exported, sites: { 'news.example.org': { mode: 'on', engine: 'filter' }, 'bad host': { mode: 'off' } } });
    await ext.$eval('#importFile', (input, json) => {
      const dt = new DataTransfer();
      dt.items.add(new File([json], 'sites.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, json);
    await until(async () => /добавлено 1|1 added/.test(await text(ext, '#ioMsg')), 3000, 'import message');
    assert.equal(await ext.$$eval('#sites tr', (l) => l.length), 2);
    // user prompts of extension pages cannot be answered over BiDi: accept the confirm() in the page
    await ext.evaluate(() => (window.confirm = () => true));
    await ext.click('#clearSites');
    await until(async () => (await ext.$$eval('#sites tr', (l) => l.length)) === 0, 3000, 'cleared');
    assert.ok(await visible(ext, '#sitesEmpty'));
  });

  await step('options: "Change shortcuts" opens the Firefox shortcut manager (about:addons)', async () => {
    await ext.click('#editShortcuts');
    const addons = await ff.findPage((u) => u.startsWith('about:addons'), 5000);
    assert.ok(addons, 'about:addons opened');
    await addons.close();
  });

  await step('Firefox: access to websites withheld → the popup explains it and offers "Allow"; nothing breaks', async () => {
    // the user revokes "Access your data for all websites" (about:addons → Permissions)
    assert.equal(await ext.evaluate(() => chrome.permissions.remove({ origins: ['<all_urls>'] })), true);
    await page.reload({ waitUntil: 'load' });
    await sleep(500);
    assert.equal(await nd(page), null, 'no content script without access');
    assert.equal(await css(page, 'body', 'background-color'), 'rgb(255, 255, 255)');
    const popup = await openPopup(BASIC);
    assert.equal(await visible(popup, '#access'), true, 'access message shown');
    assert.equal(await visible(popup, '#restricted'), false);
    assert.match(await text(popup, '#access'), /нет доступа к сайтам|no access to websites/);
    // a real click: Firefox accepts the request and shows its own prompt (browser UI, not automatable);
    // a request without user input would be rejected at once and show "not granted"
    await popup.click('#grantAccess');
    await sleep(1500);
    assert.equal(await text(popup, '#accessMsg'), '', 'request pending on the Firefox prompt (not rejected)');
    await popup.close();
  });

  await step('no errors in the background, extension pages and content scripts', async () => {
    assert.deepEqual(await ff.errors(), []);
  });

  console.log(`\n${passed} passed`);
} catch (e) {
  exitCode = 1;
  console.error('not ok -', e && e.stack ? e.stack : e);
  console.error('collected errors:', await ff.errors().catch(() => []));
} finally {
  await b.close();
  srv.close();
}
process.exit(exitCode);
