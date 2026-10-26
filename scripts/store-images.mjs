// Renders the Chrome Web Store images into store/:
//   screenshot-1..4.png (1280×800), promo-small.png (440×280), promo-marquee.png (1400×560).
// The extension UI and the dark theme are real (extension loaded unpacked into the installed Chromium);
// the page is a local fictional fixture (store/fixtures/article.html) served on 127.0.0.1 as blog.example.
// Run: npm run store:images
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareExtension, launch, hideScrollbars, dataUrl, fileDataUrl, browserWindow, stage, render, promo, BRAND } from './store-kit.mjs';
import { startServers } from '../e2e/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');

const srv = await startServers();
const ext = await prepareExtension(join(ROOT, 'extension'), { base: srv.url('brand/') });
const { context, extId } = await launch(ext.extDir, ext.profile, {
  colorScheme: 'dark',
  args: [`--host-resolver-rules=MAP blog.example 127.0.0.1:${srv.port}`],
});
const ARTICLE = 'http://blog.example/altai-10-days';
const ADDRESS = 'blog.example/altai-10-days';
const TAB = 'Алтай за десять дней — Заметки…';
const icon = await fileDataUrl(join(ROOT, 'extension', 'icons', 'icon128.png'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Browser window whose viewport shows two screenshots split down the middle, with labels. */
function splitWindow(left, right, labelLeft, labelRight) {
  const win = browserWindow({ tab: TAB, address: ADDRESS, page: left, icon });
  return win.replace(
    '<div class="viewport"><img src="' + left + '" alt=""></div>',
    `<div class="viewport"><img src="${left}" alt=""><img class="right" src="${right}" alt=""><div class="divider"></div>
      <span class="lbl l">${esc(labelLeft)}</span><span class="lbl r">${esc(labelRight)}</span></div>`,
  );
}
const SPLIT_CSS = `
  .viewport img.right{position:absolute;top:0;left:0;clip-path:inset(0 0 0 50%)}
  .divider{position:absolute;top:0;bottom:0;left:50%;width:4px;margin-left:-2px;background:${BRAND.hl};box-shadow:0 0 0 2px ${BRAND.ink}}
  .lbl{position:absolute;bottom:18px;font:700 15px "Golos Text",sans-serif;padding:5px 12px;border:2px solid ${BRAND.ink};background:${BRAND.hl};color:${BRAND.ink}}
  .lbl.l{right:calc(50% + 14px)} .lbl.r{left:calc(50% + 14px)}`;

const options = await context.newPage();
await options.goto(`chrome-extension://${extId}/src/options/options.html`);
await options.waitForSelector('body[data-ready]');
const setSettings = (s) => options.evaluate((v) => chrome.storage.local.set({ settings: v }), s);

const page = await context.newPage();
await page.setViewportSize({ width: 1164, height: 591 });

async function shotArticle(settings) {
  await setSettings(settings);
  await page.goto(ARTICLE);
  await hideScrollbars(page);
  await page.waitForTimeout(600);
  return dataUrl(page);
}

async function popupShot() {
  await page.bringToFront();
  const tabId = await options.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 470 });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
  await popup.waitForSelector('body[data-ready="1"]');
  const shot = await dataUrl(popup, { fullPage: true });
  await popup.close();
  return shot;
}

try {
  await mkdir(OUT, { recursive: true });
  for (const p of context.pages()) if (p.url().includes('/brand/')) await p.close();

  // 1 — before / after
  const light = await shotArticle({ enabled: false });
  const smart = await shotArticle({ engine: 'dynamic' });
  await render(
    context,
    stage({
      eyebrow: 'Тёмный режим · любой сайт',
      caption: 'Любой сайт — в ночных цветах. <mark>Без белой вспышки</mark> при загрузке',
      body: splitWindow(light, smart, 'Было', 'Стало'),
      extraCss: SPLIT_CSS,
    }),
    join(OUT, 'screenshot-1.png'),
  );

  // 2 — popup on the dark page
  await shotArticle({ engine: 'dynamic' });
  const pop = await popupShot();
  const smart2 = await dataUrl(page);
  await render(
    context,
    stage({
      eyebrow: 'Тёмный режим · окно расширения',
      caption: 'Выключить на сайте — одна кнопка или Alt+Shift+L. <mark>Тема применяется за миллисекунды</mark>',
      body: browserWindow({ tab: TAB, address: ADDRESS, page: smart2, icon, popup: pop, popupWidth: 340 }),
    }),
    join(OUT, 'screenshot-2.png'),
  );

  // 3 — the two engines
  const fast = await shotArticle({ engine: 'filter' });
  await render(
    context,
    stage({
      eyebrow: 'Тёмный режим · два режима',
      caption: 'Умный перекрашивает стили сайта, быстрый — один фильтр. <mark>Фото остаются настоящими</mark>',
      body: splitWindow(smart, fast, 'Умный', 'Быстрый'),
      extraCss: SPLIT_CSS,
    }),
    join(OUT, 'screenshot-3.png'),
  );

  // 4 — settings page
  await setSettings({ schedule: { mode: 'time', from: '20:00', to: '07:00' }, brightness: 95, sites: { 'blog.example': { engine: 'dynamic' }, 'mail.example.com': { mode: 'off' }, 'news.example.org': { mode: 'on', engine: 'filter' } } });
  await options.setViewportSize({ width: 1164, height: 591 });
  await options.reload();
  await options.waitForSelector('body[data-ready]');
  await hideScrollbars(options);
  await options.evaluate(() => document.getElementById('scheduleTitle').closest('section').scrollIntoView());
  await options.evaluate(() => window.scrollBy(0, -12));
  const opt = await dataUrl(options);
  await render(
    context,
    stage({
      eyebrow: 'Тёмный режим · настройки',
      caption: 'Расписание, яркость и правила для сайтов. <mark>Всё хранится только у вас</mark>',
      body: browserWindow({ tab: 'Тёмный режим — настройки', page: opt, icon }),
    }),
    join(OUT, 'screenshot-4.png'),
  );

  // promo tiles
  const tile = {
    icon,
    name: 'Тёмный режим',
    eyebrow: 'Честные расширения',
    tagline: 'Тёмная тема для любых сайтов — <mark>быстро и без вспышек</mark>',
    facts: [['Цена', '0 ₽'], ['Белая вспышка', 'нет'], ['Реклама', '0'], ['Трекеры', '0'], ['Данные', 'на устройстве']],
  };
  await render(context, promo({ ...tile, size: 'small' }), join(OUT, 'promo-small.png'), 440, 280);
  await render(context, promo({ ...tile, size: 'marquee' }), join(OUT, 'promo-marquee.png'), 1400, 560);
  console.log('store images written to', OUT);
} finally {
  await context.close();
  srv.close();
  await ext.cleanup();
}
