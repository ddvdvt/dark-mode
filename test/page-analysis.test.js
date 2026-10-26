import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lib } from './helpers.js';

const P = Lib.page;
const { parseColor, isDarkBg, isLightFg } = Lib.color;

test('canvas color follows html, then body, then white', () => {
  assert.deepEqual(P.canvasColor('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(P.canvasColor('rgba(0, 0, 0, 0)', 'rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(P.canvasColor('rgb(1, 1, 1)', 'rgb(10, 20, 30)'), { r: 1, g: 1, b: 1, a: 1 });
});

test('effective background composites translucent layers', () => {
  const c = P.effectiveBackground(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.5)'], 'rgb(255, 255, 255)');
  assert.ok(Math.abs(c.r - 127.5) < 1);
  assert.deepEqual(P.effectiveBackground(['rgb(1, 2, 3)', 'rgb(200, 200, 200)']), { r: 1, g: 2, b: 3, a: 1 });
});

test('looksDark', () => {
  const T = 'rgba(0, 0, 0, 0)';
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: T, center: null }), false, 'plain page');
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(24, 24, 27)', center: null, text: 'rgb(230, 230, 230)' }), true);
  assert.equal(P.looksDark({ htmlBg: 'rgb(13, 17, 23)', bodyBg: T, center: [T, T], text: 'rgb(201, 209, 217)' }), true);
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: T, center: ['rgb(18, 18, 18)', T], text: 'rgb(255, 255, 255)' }), true, 'dark app shell on a transparent body');
  assert.equal(P.looksDark({ htmlBg: 'rgb(0, 0, 0)', bodyBg: T, center: ['rgb(255, 255, 255)'] }), false, 'white card in the middle');
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(0, 0, 0)', center: null, text: 'rgb(0, 0, 0)' }), false, 'dark on dark = not painted yet');
});

test('elementOverride darkens light backgrounds and dark text only', () => {
  const o = P.elementOverride({ bg: 'rgb(255, 255, 255)', fg: 'rgb(0, 0, 0)', image: 'none' });
  assert.ok(isDarkBg(parseColor(o.bg)) && isLightFg(parseColor(o.fg)));
  assert.equal(P.elementOverride({ bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(230, 230, 230)' }), null);
  assert.equal(P.elementOverride({ bg: 'rgb(30, 30, 30)', fg: 'rgb(200, 200, 200)' }), null, 'already dark element');
  // idempotent: the override itself is not overridden again
  assert.equal(P.elementOverride({ bg: o.bg, fg: o.fg }), null);
  const g = P.elementOverride({ bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(230, 230, 230)', image: 'linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))' });
  assert.match(g.image, /^linear-gradient\(rgb/);
  assert.equal(P.elementOverride({ bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(230, 230, 230)', image: 'url("a.png")' }), null);
});

test('light borders are darkened, dark ones kept', () => {
  const o = P.elementOverride({ bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(230, 230, 230)', border: 'rgb(229, 231, 235)' });
  assert.ok(Lib.color.rgbToHsl(parseColor(o.border)).l < 0.35);
  assert.equal(P.elementOverride({ bg: 'rgba(0, 0, 0, 0)', fg: 'rgb(230, 230, 230)', border: 'rgb(60, 60, 60)' }), null);
  assert.match(P.overrideRule('9', o), /border-color:rgb\([^)]*\)!important;/);
});

test('override rule and key', () => {
  const o = { bg: 'rgb(1, 1, 1)', fg: 'rgb(2, 2, 2)' };
  assert.equal(P.overrideKey(o), 'rgb(1, 1, 1)|rgb(2, 2, 2)|||');
  assert.equal(P.overrideRule('7', o), '[data-nd-c="7"]{background-color:rgb(1, 1, 1)!important;color:rgb(2, 2, 2)!important;}');
  assert.equal(P.overrideRule('8', { fill: 'rgb(3, 3, 3)' }), '[data-nd-c="8"]{fill:rgb(3, 3, 3)!important;}');
});

test('svg shapes: dark fills become light', () => {
  assert.ok(isLightFg(parseColor(P.svgOverride('rgb(0, 0, 0)').fill)));
  assert.equal(P.svgOverride('rgb(255, 255, 255)'), null);
  assert.equal(P.svgOverride('none'), null);
  assert.equal(P.svgOverride('url("#g")'), null);
});

test('photo backgrounds vs icons in filter mode', () => {
  assert.equal(P.isPhotoBackground('url("hero.jpg")', 1200, 400), true);
  assert.equal(P.isPhotoBackground('url("sprite.png")', 16, 16), false);
  assert.equal(P.isPhotoBackground('url("logo.svg")', 300, 100), false);
  assert.equal(P.isPhotoBackground('url("data:image/svg+xml;utf8,<svg/>")', 300, 300), false);
  assert.equal(P.isPhotoBackground('linear-gradient(red, blue)', 500, 500), false);
  assert.equal(P.isPhotoBackground('none', 500, 500), false);
});

test('used color scheme: CSS color-scheme, else the meta tag; "light dark" follows the system', () => {
  assert.equal(P.usedScheme('normal', '', false), 'light');
  assert.equal(P.usedScheme('normal', 'dark', false), 'dark');
  assert.equal(P.usedScheme('normal', 'dark light', false), 'light');
  assert.equal(P.usedScheme('normal', 'light dark', true), 'dark');
  assert.equal(P.usedScheme('light', 'dark', true), 'light', 'CSS wins over the meta tag');
  assert.equal(P.usedScheme('dark', '', false), 'dark');
  const T = 'rgba(0, 0, 0, 0)';
  assert.deepEqual(P.canvasColor(T, T, 'dark'), P.DARK_CANVAS);
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: T, scheme: 'dark', center: null, text: 'rgb(255, 255, 255)' }), true, 'meta color-scheme dark only');
});

test('looksDark: majority of points; media points (a black video player) do not count', () => {
  const T = 'rgba(0, 0, 0, 0)';
  const light = { chain: [T], text: 'rgb(15, 15, 15)' };
  const player = { chain: ['rgb(0, 0, 0)'], text: 'rgb(255, 255, 255)' };
  // a light page with a big black player in the middle of the viewport
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(255, 255, 255)', samples: [player, { ...player, media: true }, light, light, light] }), false);
  // a dark app shell: every point dark
  const shell = { chain: [T, 'rgb(18, 18, 18)'], text: 'rgb(232, 234, 237)' };
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: T, samples: [shell, shell, shell, { ...light, media: true }, shell] }), true);
  // a dark site with a big white photo in the middle
  assert.equal(P.looksDark({ htmlBg: 'rgb(13, 17, 23)', bodyBg: T, samples: [{ chain: [T], media: true }, { chain: [T] }, { chain: [T] }] }), true);
  // half-dark: dark header band over a light body
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(255, 255, 255)', samples: [{ chain: ['rgb(11, 12, 16)'] }, light, light, light, light] }), false);
  // only media points: decide by the canvas
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(255, 255, 255)', samples: [{ chain: [], media: true }] }), false);
});

test('svg: strokes and fills of icons become light; a white backdrop of a chart becomes dark', () => {
  const o = P.svgOverride('none', 'rgb(34, 34, 34)');
  assert.ok(isLightFg(parseColor(o.stroke)) && !o.fill);
  assert.match(P.overrideRule('3', o), /stroke:rgb\([^)]*\)!important;/);
  assert.notEqual(P.overrideKey(o), P.overrideKey({}));
  assert.equal(P.svgOverride('rgb(255, 255, 255)', 'none', 0.1), null, 'small white shape (a glyph) stays');
  const bd = P.svgOverride('rgb(255, 255, 255)', 'none', 0.9);
  assert.ok(isDarkBg(parseColor(bd.fill)), 'chart backdrop');
  const bar = P.svgOverride('rgb(78, 121, 167)', 'none', 0.9);
  assert.ok(Math.abs(Lib.color.rgbToHsl(parseColor(bar.fill)).h - Lib.color.rgbToHsl(parseColor('rgb(78, 121, 167)')).h) < 5, 'a colored shape keeps its hue');
  assert.ok(isDarkBg(parseColor(P.svgOverride('rgb(255, 243, 205)', 'none', 0.8).fill)), 'a pale backdrop of a diagram');
});

test('filter mode: textures and page wrappers are not photos', () => {
  const vh = 900;
  assert.equal(P.isPhotoBackground('url("hero.jpg")', 1000, 400, { repeat: 'no-repeat', size: 'cover', viewportHeight: vh }), true);
  assert.equal(P.isPhotoBackground('url("hero.jpg")', 1000, 900, { repeat: 'repeat', size: 'auto', viewportHeight: vh }), true, 'full-screen hero');
  assert.equal(P.isPhotoBackground('url("paper.png")', 1000, 3000, { repeat: 'repeat', size: 'auto', viewportHeight: vh }), false, 'page-sized wrapper');
  assert.equal(P.isPhotoBackground('url("noise.png")', 900, 500, { repeat: 'repeat', size: '24px 12px', viewportHeight: vh }), false, 'small tile = texture');
  assert.equal(P.isPhotoBackground('url("bg.jpg")', 1000, 700, { root: true }), false, '<body> / <html>');
});

test('filter mode: big dark sections of a light page keep their own colors', () => {
  assert.equal(P.isDarkSection('rgb(11, 12, 16)', 1, 1000, 60, 1000), true, 'dark header on a white page');
  assert.equal(P.isDarkSection('rgb(11, 12, 16)', 0.01, 1000, 60, 1000), false, 'dark inside dark');
  assert.equal(P.isDarkSection('rgb(11, 12, 16)', 1, 40, 20, 1000), false, 'small dark badge');
  assert.equal(P.isDarkSection('rgba(0, 0, 0, 0.5)', 1, 1000, 400, 1000), false, 'translucent overlay');
  assert.equal(P.isDarkSection('rgb(200, 200, 200)', 1, 1000, 400, 1000), false);
});

test('looksDark on a light canvas needs every point dark (short page with dark header, band and footer)', () => {
  const T = 'rgba(0, 0, 0, 0)';
  const band = { chain: ['rgb(31, 40, 51)'], text: 'rgb(255, 255, 255)' };
  const main = { chain: [T], text: 'rgb(51, 51, 51)' };
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(255, 255, 255)', samples: [main, band, band, band, band] }), false);
  assert.equal(P.looksDark({ htmlBg: T, bodyBg: 'rgb(255, 255, 255)', samples: [band, band, band] }), true, 'a dark wrapper covering the viewport');
  assert.equal(P.looksDark({ htmlBg: 'rgb(13, 17, 23)', bodyBg: T, samples: [main, band, band] }), true, 'dark canvas: majority');
});
