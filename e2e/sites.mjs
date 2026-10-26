// Site-pattern corpus: every fixture in e2e/sites/ (synthetic pages that reproduce the DOM/CSS patterns
// of real site types) is loaded in both engines and checked with measurable properties:
//   - the page background is dark (pixels of the screenshot), already-dark pages are left alone;
//   - visible text keeps WCAG contrast (4.5, 3 for large text; never worse than the page itself had);
//     icons ≥ 3; brand colors keep their hue;
//   - images / video / canvas / CSS photos keep their pixels (smart) or are re-inverted (fast);
//   - element boxes are identical with the theme on and off;
//   - no console errors; long tasks bounded on mutating pages; fixture-specific checks (window.__ndCheck);
//   - turning the theme off restores every computed color exactly; @media print is never dark.
// Run: npm run test:sites   (SITES=wiki,github MODES=dynamic to narrow it down)
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServers } from './server.mjs';
import { launchWithExtension, setSettings, ROOT } from './browser.mjs';
import { analyze } from './analyze.mjs';

const SITES_DIR = join(ROOT, 'e2e', 'sites');
const ONLY = process.env.SITES ? process.env.SITES.split(',') : null;
const MODES = (process.env.MODES || 'dynamic,filter').split(',');
const VIEWPORT = { width: 1000, height: 900 };

/** Problems that are known limitations (documented in the README), by fixture and engine. */
const KNOWN = /** @type {Record<string, Record<string, RegExp[]>>} */ ({});

const fixtures = [];
for (const f of (await readdir(SITES_DIR)).sort()) {
  if (!f.endsWith('.html')) continue;
  const name = f.slice(0, -5);
  if (ONLY && !ONLY.includes(name)) continue;
  const text = await readFile(join(SITES_DIR, f), 'utf8');
  const m = /<meta name="nd-test" content='([^']*)'>/.exec(text);
  if (m) fixtures.push({ name, file: f, meta: JSON.parse(m[1]), async: text.includes('__done') });
}

const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const hueDiff = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startServers();
const b = await launchWithExtension({ brandBase: srv.url('brand/'), viewport: VIEWPORT });
const { context, extId } = b;
await context.addInitScript(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* not supported in this frame */
  }
});
for (const p of context.pages()) if (p.url().includes('/brand/')) await p.close();
const ext = await context.newPage();
await ext.goto(`chrome-extension://${extId}/src/options/options.html`);

/** Pixels of a screenshot at points, decoded by the extension page. */
async function pixels(buf, pts) {
  return ext.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return pts.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data));
    },
    { b64: buf.toString('base64'), pts },
  );
}

async function status(page) {
  await page.bringToFront();
  const id = await ext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  return ext.evaluate((tid) => chrome.tabs.sendMessage(tid, { type: 'nd:status' }, { frameId: 0 }).catch(() => null), id);
}

async function settle(page, ms, fx) {
  await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 15000 });
  if (fx.async) await page.waitForFunction(() => window.__done === true, null, { timeout: 5000 }).catch(() => {});
  await sleep(ms);
  await page.evaluate(() => new Promise((r) => requestIdleCallback(() => r(), { timeout: 500 })));
}

/** Total blocking time (sum of long-task time over 50 ms) and the longest task within the next `ms`. */
async function blocking(page, ms) {
  return page.evaluate(async (ms) => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    const lt = (window.__lt || []).filter(([t]) => t >= t0);
    return { tbt: Math.round(lt.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)), max: Math.round(lt.reduce((m, [, d]) => Math.max(m, d), 0)) };
  }, ms);
}

/**
 * @param {{ name: string, file: string, meta: any }} fx @param {string} mode
 * @returns {Promise<string[]>} problems
 */
async function runFixture(fx, mode) {
  const problems = [];
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const url = srv.url('sites/' + fx.file);
  try {
    // ---- reference: the page without the theme
    await setSettings(ext, { enabled: false });
    await page.goto(url, { waitUntil: 'load' });
    await settle(page, 600, fx);
    const off = await page.evaluate(analyze);
    const offShot = await page.screenshot();
    const offPerf = fx.meta.perf ? await blocking(page, 2000) : null;

    // ---- the page loaded with the theme on
    await setSettings(ext, { engine: mode });
    await page.reload({ waitUntil: 'load' });
    await settle(page, 1800, fx);
    const st = await status(page);
    const on = await page.evaluate(analyze);
    const onShot = await page.screenshot();
    const extra = await page.evaluate((m) => (window.__ndCheck ? window.__ndCheck(m) : []), mode);
    problems.push(...extra);

    if (fx.meta.expect === 'already-dark') {
      if (!st || st.state !== 'already-dark') problems.push(`expected "already dark", state is ${st && st.state}`);
      if (on.leftovers) problems.push(`${on.leftovers} leftover nodes of the theme`);
    } else {
      const want = fx.meta.huge && st && st.forcedFilter ? 'filter' : mode;
      if (!st || st.state !== 'on' || on.nd !== want) problems.push(`theme not on: state ${st && st.state}, data-nd ${on.nd}`);
    }

    // background pixels: median of 5 pixels around each point, so thin borders and rules don't count
    const bgPts = on.grid.filter((g) => !g.media);
    const offBgPts = off.grid.filter((g) => !g.media);
    const around = (g) => [[g.x, g.y], [g.x - 3, g.y - 3], [g.x + 3, g.y - 3], [g.x - 3, g.y + 3], [g.x + 3, g.y + 3]].map(([x, y]) => [Math.max(0, Math.min(VIEWPORT.width - 1, x)), Math.max(0, Math.min(VIEWPORT.height - 1, y))]);
    if (bgPts.length) {
      const px = await pixels(onShot, bgPts.flatMap(around));
      const lums = bgPts.map((_, i) => px.slice(i * 5, i * 5 + 5).map(lum).sort((x, y) => x - y)[2]);
      const light = bgPts.filter((_, i) => lums[i] > 0.4);
      if (fx.meta.expect !== 'already-dark' && light.length) problems.push(`${light.length}/${bgPts.length} light background points, e.g. ${light.slice(0, 3).map((g) => `${g.key} (${g.x},${g.y})`).join('; ')}`);
      const med = [...lums].sort((x, y) => x - y)[Math.floor(lums.length / 2)];
      if (med > 0.12) problems.push(`page background is not dark: median luminance ${med.toFixed(2)}`);
    }
    if (fx.meta.expect === 'already-dark' && offBgPts.length) {
      const a = await pixels(offShot, offBgPts.map((g) => [g.x, g.y]));
      const z = await pixels(onShot, offBgPts.map((g) => [g.x, g.y]));
      const changed = a.filter((p, i) => Math.max(...p.slice(0, 3).map((v, k) => Math.abs(v - z[i][k]))) > 6).length;
      if (changed) problems.push(`already-dark page changed: ${changed} background points differ`);
    }

    if (fx.meta.expect !== 'already-dark') {
      // text contrast, never worse than the page itself
      const offText = new Map(off.texts.map((t) => [t.key + '|' + t.text, t]));
      const bad = [];
      for (const t of on.texts) {
        if (t.onImage || t.ratio == null) continue;
        const o = offText.get(t.key + '|' + t.text);
        if (!o || o.onImage) continue;
        const need = Math.min(t.large ? 3 : 4.5, (o.ratio ?? 21) - 0.3);
        if (t.ratio < need) bad.push(`"${t.text}" ${t.ratio} < ${need.toFixed(1)} (fg ${t.fg.slice(0, 3)} on ${t.bg.slice(0, 3)})`);
      }
      if (bad.length) problems.push(`${bad.length} low-contrast texts: ${bad.slice(0, 4).join('; ')}`);
      for (const i of on.icons) if (i.ratio < 3) problems.push(`icon ${i.key} contrast ${i.ratio} < 3`);
      const offHue = new Map(off.hues.map((h) => [h.key, h.hsl]));
      for (const h of on.hues) {
        const o = offHue.get(h.key);
        if (!o || o[1] < 0.25) continue;
        if (hueDiff(o[0], h.hsl[0]) > 30 || h.hsl[1] < 0.12) problems.push(`brand color lost: ${h.key} hsl(${o}) → hsl(${h.hsl})`);
      }
    }

    // media pixels
    const offMedia = new Map(off.media.map((m) => [m.key, m]));
    for (const m of on.media) {
      if (!offMedia.has(m.key)) continue;
      const a = await pixels(offShot, m.points);
      const z = await pixels(onShot, m.points);
      const diffs = a.map((p, i) => Math.max(...p.slice(0, 3).map((v, k) => Math.abs(v - z[i][k]))));
      const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      const limit = mode === 'filter' && fx.meta.expect !== 'already-dark' ? 48 : 12;
      if (mean > limit) problems.push(`${m.kind} ${m.key} changed: mean pixel difference ${Math.round(mean)} > ${limit}`);
    }

    for (const t of on.textures) if (t.filter !== 'none') problems.push(`texture ${t.key} shown in original colors (filter ${t.filter}): the content on it is light`);

    // layout
    const moved = Object.keys(off.rects).filter((k) => k in on.rects && on.rects[k] !== off.rects[k]);
    if (moved.length) problems.push(`${moved.length} element boxes moved, e.g. ${moved.slice(0, 3).map((k) => `${k}: ${off.rects[k]} → ${on.rects[k]}`).join('; ')}`);

    if (offPerf) {
      const onPerf = await blocking(page, 2000);
      if (onPerf.tbt > Math.max(150, offPerf.tbt * 2 + 100) || onPerf.max > 300) problems.push(`main thread blocked: TBT ${onPerf.tbt} ms (off ${offPerf.tbt}), longest task ${onPerf.max} ms`);
    }

    if (fx.meta.print) {
      await page.emulateMedia({ media: 'print' });
      const pr = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { color: cs.color, bg: cs.backgroundColor, filter: getComputedStyle(document.documentElement).filter };
      });
      await page.emulateMedia({ media: 'screen' });
      const fg = (/\d+/g.exec(pr.color) && pr.color.match(/\d+/g).map(Number)) || [0, 0, 0];
      if (lum(fg) > 0.3) problems.push(`print: text is light (${pr.color})`);
      if (pr.filter !== 'none') problems.push(`print: page filtered (${pr.filter})`);
      const bg = pr.bg.match(/[\d.]+/g).map(Number);
      if ((bg[3] ?? 1) > 0 && lum(bg) < 0.5) problems.push(`print: dark page background (${pr.bg})`);
    }

    if (fx.meta.frames && mode === 'dynamic') {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const label = f.name() || f.url();
        const r = await f.evaluate(analyze).catch((e) => ({ error: String(e) }));
        if (r.error) {
          problems.push(`frame ${label}: ${r.error}`);
          continue;
        }
        if (r.nd !== 'dynamic') problems.push(`frame ${label}: theme not on (data-nd ${r.nd})`);
        const bad = r.texts.filter((t) => t.ratio != null && t.ratio < 4.5);
        if (bad.length) problems.push(`frame ${label}: ${bad.length} low-contrast texts, e.g. "${bad[0].text}" ${bad[0].ratio}`);
        if (lum(r.canvas) > 0.1) problems.push(`frame ${label}: light canvas ${r.canvas}`);
      }
    }

    // ---- turning the theme off restores the page exactly
    await setSettings(ext, { enabled: false });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-nd') === 'off', null, { timeout: 3000 }).catch(() => {});
    await sleep(300);
    const back = await page.evaluate(analyze);
    if (back.leftovers) problems.push(`after turning off: ${back.leftovers} leftover nodes`);
    const diff = Object.keys(off.styles).filter((k) => k in back.styles && back.styles[k] !== off.styles[k]);
    if (diff.length) problems.push(`after turning off: ${diff.length} elements keep changed colors, e.g. ${diff.slice(0, 2).map((k) => `${k}: ${off.styles[k]} → ${back.styles[k]}`).join('; ')}`);

    if (fx.meta.darkSystem && mode === 'dynamic') {
      await setSettings(ext, { engine: mode });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload({ waitUntil: 'load' });
      await settle(page, 1800, fx);
      const s2 = await status(page);
      if (!s2 || s2.state !== fx.meta.darkSystem) problems.push(`with a dark system theme: expected ${fx.meta.darkSystem}, state is ${s2 && s2.state}`);
      await page.emulateMedia({ colorScheme: 'light' });
    }
    problems.push(...errors);
  } catch (e) {
    problems.push(`crashed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e}`);
  } finally {
    await page.close().catch(() => {});
  }
  return problems;
}

let failed = 0;
let known = 0;
let passed = 0;
const t0 = Date.now();
try {
  for (const mode of MODES) {
    for (const fx of fixtures) {
      const t = Date.now();
      const all = await runFixture(fx, mode);
      const allow = (KNOWN[fx.name] && KNOWN[fx.name][mode]) || [];
      const real = all.filter((p) => !allow.some((re) => re.test(p)));
      known += all.length - real.length;
      const label = `${mode.padEnd(7)} ${fx.name}`;
      if (real.length) {
        failed++;
        console.log(`not ok - ${label} (${Date.now() - t} ms)`);
        for (const p of real) console.log(`    ${p}`);
      } else {
        passed++;
        console.log(`ok - ${label} (${Date.now() - t} ms)${all.length ? ` [${all.length} known limitation(s)]` : ''}`);
      }
    }
  }
} finally {
  await b.close();
  srv.close();
}
console.log(`\n${passed} passed, ${failed} failed, ${known} known limitations, ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
