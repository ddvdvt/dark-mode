// Performance measurement on a generated heavy page (5 000 elements, 3 000 CSS rules, +1 000 elements
// added after load). For each mode — extension off, fast (filter), smart (dynamic), smart with a
// cross-origin stylesheet (worst case: every element checked) — loads the page RUNS times and reports
// medians: time for the content script to apply the theme, engine work, long tasks and total blocking
// time (sum of long-task time over 50 ms) during load and while the feed grows.
// Run: npm run perf   (writes e2e/perf-results.json and prints a Markdown table)
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServers } from './server.mjs';
import { launchWithExtension, setSettings, ROOT } from './browser.mjs';

const RUNS = Number(process.env.RUNS || 5);
const srv = await startServers();
const b = await launchWithExtension({ brandBase: srv.url('brand/'), viewport: { width: 1280, height: 800 } });
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

const MODES = [
  { name: 'off', label: 'Extension off (baseline)', settings: { enabled: false }, url: 'heavy.html' },
  { name: 'filter', label: 'Fast (filter)', settings: { engine: 'filter' }, url: 'heavy.html' },
  { name: 'dynamic', label: 'Smart (dynamic)', settings: { engine: 'dynamic' }, url: 'heavy.html' },
  { name: 'off-xo', label: 'Off, page with cross-origin CSS (baseline)', settings: { enabled: false }, url: 'heavy.html?xo=1' },
  { name: 'dynamic-xo', label: 'Smart + cross-origin CSS (full scan)', settings: { engine: 'dynamic' }, url: 'heavy.html?xo=1' },
];

const results = {};
try {
  for (const p of b.context.pages()) if (p.url().includes('/brand/')) await p.close();
  const ext = await b.context.newPage();
  await ext.goto(`chrome-extension://${b.extId}/src/options/options.html`);
  for (const mode of MODES) {
    await setSettings(ext, mode.settings);
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await b.context.newPage();
      await page.addInitScript(() => {
        // page world: collect long tasks (they include content-script work on the main thread)
        window.__lt = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]);
        }).observe({ type: 'longtask', buffered: true });
      });
      await page.goto(srv.url(mode.url), { waitUntil: 'load' });
      await page.waitForFunction(() => window.__feedDone, null, { timeout: 20000 });
      await page.waitForTimeout(1500); // let idle work finish
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        const load = nav.loadEventEnd;
        const lt = window.__lt;
        const tbt = (list) => list.reduce((s, [, d]) => s + Math.max(0, d - 50), 0);
        const during = lt.filter(([t]) => t <= load);
        const after = lt.filter(([t]) => t > load);
        return {
          dcl: nav.domContentLoadedEventEnd,
          load,
          fcp: fcp ? fcp.startTime : null,
          longTasksLoad: during.length,
          tbtLoad: tbt(during),
          longTasksFeed: after.length,
          tbtFeed: tbt(after),
          maxTask: lt.reduce((m, [, d]) => Math.max(m, d), 0),
          elements: document.getElementsByTagName('*').length,
          nd: document.documentElement.getAttribute('data-nd'),
        };
      });
      await page.bringToFront();
      const tabId = await ext.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const st = await ext.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'nd:status' }, { frameId: 0 }), tabId);
      runs.push({ ...m, appliedMs: st.appliedMs, startedAt: st.startedAt, stats: st.stats });
      await page.close();
    }
    const pick = (f) => r1(median(runs.map(f).filter((x) => x != null)));
    results[mode.name] = {
      label: mode.label,
      runs: RUNS,
      mode: runs[0].nd,
      elements: runs[0].elements,
      appliedMs: pick((r) => r.appliedMs),
      sheetMs: pick((r) => r.stats && r.stats.sheetMs),
      fallbackMs: pick((r) => r.stats && r.stats.fallbackMs),
      mutationMs: pick((r) => r.stats && r.stats.mutationMs),
      rules: runs[0].stats && runs[0].stats.rules,
      tagged: runs[0].stats && runs[0].stats.tagged,
      fcp: pick((r) => r.fcp),
      dcl: pick((r) => r.dcl),
      load: pick((r) => r.load),
      longTasksLoad: pick((r) => r.longTasksLoad),
      tbtLoad: pick((r) => r.tbtLoad),
      longTasksFeed: pick((r) => r.longTasksFeed),
      tbtFeed: pick((r) => r.tbtFeed),
      maxTask: pick((r) => r.maxTask),
    };
    console.log(mode.name, JSON.stringify(results[mode.name]));
  }
  await writeFile(join(ROOT, 'e2e', 'perf-results.json'), JSON.stringify({ date: new Date().toISOString(), chromium: b.context.browser()?.version() || 'chromium-1228', results }, null, 2) + '\n');
  const rows = Object.values(results).map((r) => `| ${r.label} | ${r.appliedMs ?? '—'} | ${r.sheetMs ?? '—'} | ${r.fallbackMs ?? '—'} | ${r.mutationMs ?? '—'} | ${r.fcp} | ${r.load} | ${r.longTasksLoad} / ${r.tbtLoad} | ${r.longTasksFeed} / ${r.tbtFeed} | ${r.maxTask} |`);
  console.log('\n| Mode | Theme applied, ms | Stylesheets, ms | Fallback, ms | Mutations, ms | FCP, ms | load, ms | Long tasks / TBT during load, ms | Long tasks / TBT while +1000 elements, ms | Longest task, ms |\n|---|---|---|---|---|---|---|---|---|---|\n' + rows.join('\n'));
} finally {
  await b.close();
  srv.close();
}
