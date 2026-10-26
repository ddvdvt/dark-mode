// Local servers for e2e / perf / store images: fixture pages on 127.0.0.1 and a second origin
// (localhost) for the cross-origin stylesheet. Never touches the internet.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO, MOUNTAINS, LAKE } from './png.mjs';
import { heavyPage } from './heavy.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SITES = join(dirname(fileURLToPath(import.meta.url)), 'sites');
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png' };

/** Synthetic site fixtures (e2e/sites), served on both origins. */
async function serveSite(name, res) {
  const file = name.slice(6);
  if (!/^[\w.-]+$/.test(file)) throw new Error('bad');
  const body = await readFile(join(SITES, file));
  res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}
const STORE_FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'fixtures');
const IMAGES = { 'photo.png': PHOTO, 'img/mountains.png': MOUNTAINS, 'img/lake.png': LAKE };

function listen(handler) {
  const s = createServer((req, res) => handler(req, res).catch(() => {
    res.writeHead(500);
    res.end();
  }));
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

export async function startServers() {
  const other = await listen(async (req, res) => {
    const name = (req.url || '').split('?')[0].replace(/^\/+/, '');
    if (name.startsWith('sites/')) {
      await serveSite(name, res);
    } else if (IMAGES[name]) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(IMAGES[name]);
    } else if (name === 'remote.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(await readFile(join(FIX, 'remote.css')));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const otherPort = /** @type {any} */ (other.address()).port;
  const main = await listen(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const name = url.pathname.replace(/^\/+/, '') || 'basic.html';
    if (name.includes('..')) throw new Error('bad');
    if (name === 'favicon.ico') {
      res.writeHead(204);
      res.end();
    } else if (name.startsWith('brand/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>brand ${name}</title>`);
    } else if (name.startsWith('sites/')) {
      await serveSite(name, res);
    } else if (name.startsWith('x-origin/')) {
      res.writeHead(302, { location: `http://localhost:${otherPort}/${name.slice(9)}` });
      res.end();
    } else if (IMAGES[name]) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(IMAGES[name]);
    } else if (name === 'altai-10-days') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(STORE_FIX, 'article.html')));
    } else if (name.startsWith('store/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(STORE_FIX, name.slice(6))));
    } else if (name === 'heavy.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(heavyPage(Number(url.searchParams.get('n') || 5000), Number(url.searchParams.get('rules') || 3000), url.searchParams.has('xo')));
    } else if (name === 'slow.html') {
      // head first, body 1.5 s later: the browser paints in between — that is when a white flash would show
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><html><head><meta charset="utf-8"><title>slow</title><style>body{background:#fff;color:#000}</style></head>');
      await new Promise((r) => setTimeout(r, 1500));
      res.end('<body><p id="late">Loaded late</p></body></html>');
    } else {
      const body = await readFile(join(FIX, name));
      const type = name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    }
  });
  const port = /** @type {any} */ (main.address()).port;
  return {
    port,
    url: (p) => `http://127.0.0.1:${port}/${p}`,
    close: () => {
      main.close();
      other.close();
    },
  };
}
