// Developer helper (not a test): screenshots of a fixture in each mode. node e2e/look.mjs <outDir> [page]
import { startServers } from './server.mjs';
import { launchWithExtension, setSettings } from './browser.mjs';
import { join } from 'node:path';
const out = process.argv[2];
const pageName = process.argv[3] || 'basic.html';
const srv = await startServers();
const b = await launchWithExtension({ brandBase: srv.url('brand/') });
try {
  const opt = await b.context.newPage();
  await opt.goto(`chrome-extension://${b.extId}/src/options/options.html`);
  for (const mode of ['off', 'dynamic', 'filter']) {
    await setSettings(opt, mode === 'off' ? { enabled: false } : { engine: mode });
    const p = await b.context.newPage();
    await p.goto(srv.url(pageName));
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(out, `${pageName}-${mode}.png`) });
    const errs = [];
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    console.log(mode, await p.evaluate(() => document.documentElement.getAttribute('data-nd')), errs);
    await p.close();
  }
} finally {
  await b.close();
  srv.close();
}
