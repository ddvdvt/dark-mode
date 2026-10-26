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

test('override rule and key', () => {
  const o = { bg: 'rgb(1, 1, 1)', fg: 'rgb(2, 2, 2)' };
  assert.equal(P.overrideKey(o), 'rgb(1, 1, 1)|rgb(2, 2, 2)|');
  assert.equal(P.overrideRule('7', o), '[data-nd-c="7"]{background-color:rgb(1, 1, 1)!important;color:rgb(2, 2, 2)!important;fill:rgb(2, 2, 2);}');
});

test('photo backgrounds vs icons in filter mode', () => {
  assert.equal(P.isPhotoBackground('url("hero.jpg")', 1200, 400), true);
  assert.equal(P.isPhotoBackground('url("sprite.png")', 16, 16), false);
  assert.equal(P.isPhotoBackground('url("logo.svg")', 300, 100), false);
  assert.equal(P.isPhotoBackground('url("data:image/svg+xml;utf8,<svg/>")', 300, 300), false);
  assert.equal(P.isPhotoBackground('linear-gradient(red, blue)', 500, 500), false);
  assert.equal(P.isPhotoBackground('none', 500, 500), false);
});
