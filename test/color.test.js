import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lib } from './helpers.js';

const { parseColor, formatColor, darken, rgbToHsl, hslToRgb, luminance, applyFilterChain, isDarkBg, isLightFg, contrastRatio } = Lib.color;
const rgb = (r, g, b, a = 1) => ({ r, g, b, a });

test('parses hex, rgb, hsl, named, transparent', () => {
  assert.deepEqual(parseColor('#fff'), rgb(255, 255, 255));
  assert.deepEqual(parseColor('#FFFFFF'), rgb(255, 255, 255));
  assert.deepEqual(parseColor('#0008'), rgb(0, 0, 0, 0.533));
  assert.deepEqual(parseColor('#11223380'), rgb(17, 34, 51, 0.502));
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), rgb(1, 2, 3));
  assert.deepEqual(parseColor('rgba(1,2,3,.5)'), rgb(1, 2, 3, 0.5));
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), rgb(10, 20, 30, 0.5));
  assert.deepEqual(parseColor('rgb(100%, 0%, 50%)'), rgb(255, 0, 128));
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), rgb(255, 0, 0));
  assert.deepEqual(parseColor('hsla(120deg 100% 25% / .3)'), rgb(0, 128, 0, 0.3));
  assert.deepEqual(parseColor('hsl(0.5turn 100% 50%)'), rgb(0, 255, 255));
  assert.deepEqual(parseColor('White'), rgb(255, 255, 255));
  assert.deepEqual(parseColor('rebeccapurple'), rgb(102, 51, 153));
  assert.deepEqual(parseColor('transparent'), rgb(0, 0, 0, 0));
});

test('parses oklch / oklab (Tailwind 4 palettes)', () => {
  assert.deepEqual(parseColor('oklch(1 0 0)'), rgb(255, 255, 255));
  assert.deepEqual(parseColor('oklch(0% 0 0)'), rgb(0, 0, 0));
  const blue = parseColor('oklch(0.623 0.214 259.815)'); // tailwind 4 blue-500, sRGB fallback #2b7fff
  assert.ok(Math.abs(blue.r - 0x2b) <= 3 && Math.abs(blue.g - 0x7f) <= 3 && Math.abs(blue.b - 0xff) <= 3, JSON.stringify(blue));
  assert.deepEqual(parseColor('oklab(1 0 0 / 0.5)'), rgb(255, 255, 255, 0.5));
});

test('rejects what it does not understand', () => {
  for (const s of ['', 'currentcolor', 'inherit', 'var(--x)', 'color-mix(in srgb, red, blue)', '#ggg', '#12345', 'rgb(a,b,c)', 'lab(50% 0 0)', 'none', null]) {
    assert.equal(parseColor(/** @type {any} */ (s)), null, String(s));
  }
});

test('format round-trip', () => {
  assert.equal(formatColor(rgb(1, 2, 3)), 'rgb(1, 2, 3)');
  assert.equal(formatColor(rgb(1, 2, 3, 0.25)), 'rgba(1, 2, 3, 0.25)');
  assert.equal(formatColor(rgb(300, -5, 2.6)), 'rgb(255, 0, 3)');
});

test('hsl conversions are inverse', () => {
  for (const c of [rgb(255, 0, 0), rgb(18, 52, 86), rgb(200, 200, 200), rgb(0, 0, 0), rgb(250, 128, 114)]) {
    const back = hslToRgb(rgbToHsl(c));
    assert.ok(Math.abs(back.r - c.r) <= 1 && Math.abs(back.g - c.g) <= 1 && Math.abs(back.b - c.b) <= 1);
  }
});

test('darken: white background → dark, black text → light, hue kept', () => {
  const bg = darken(rgb(255, 255, 255), 'bg');
  assert.ok(luminance(bg) < 0.02, formatColor(bg));
  const fg = darken(rgb(0, 0, 0), 'fg');
  assert.ok(luminance(fg) > 0.7, formatColor(fg));
  assert.ok(contrastRatio(bg, fg) > 12, 'default text on default background is very readable');
  const lightBlue = darken(parseColor('#e8f0fe'), 'bg');
  assert.ok(lightBlue.b > lightBlue.r, 'still bluish');
  assert.ok(isDarkBg(lightBlue));
  const link = darken(parseColor('#0645ad'), 'fg');
  assert.ok(link.b > link.r && isLightFg(link), formatColor(link));
  assert.deepEqual(darken(rgb(0, 0, 0, 0), 'bg'), rgb(0, 0, 0, 0));
  assert.equal(darken(rgb(255, 255, 255, 0.4), 'bg').a, 0.4);
});

test('darken output is stable: transformed colors are recognised as already dark/light', () => {
  for (let v = 0; v <= 255; v += 15) {
    for (const c of [rgb(v, v, v), rgb(v, 255 - v, 128), rgb(255, v, 0)]) {
      assert.ok(isDarkBg(darken(c, 'bg')), `bg ${formatColor(c)}`);
      assert.ok(isLightFg(darken(c, 'fg')), `fg ${formatColor(c)}`);
    }
  }
});

test('already dark backgrounds stay dark, light text stays light', () => {
  const darkBg = parseColor('#202124');
  assert.ok(luminance(darken(darkBg, 'bg')) <= luminance(darkBg) + 0.001);
  const lightText = parseColor('#eeeeee');
  assert.ok(luminance(darken(lightText, 'fg')) > 0.6);
});

test('generic role inverts, but keeps faint overlays', () => {
  assert.ok(luminance(darken(rgb(255, 255, 255), 'generic')) < 0.02);
  assert.ok(luminance(darken(rgb(0, 0, 0), 'generic')) > 0.7);
  assert.deepEqual(darken(rgb(0, 0, 0, 0.05), 'generic'), rgb(0, 0, 0, 0.05));
});

test('filter chain: invert + hue-rotate turns white into black and keeps hue family', () => {
  const chain = [['invert', 1], ['hue-rotate', 180]];
  assert.deepEqual(applyFilterChain(rgb(255, 255, 255), chain), rgb(0, 0, 0));
  assert.deepEqual(applyFilterChain(rgb(0, 0, 0), chain), rgb(255, 255, 255));
  const red = applyFilterChain(rgb(255, 0, 0), chain);
  assert.ok(red.r > red.g && red.r > red.b, JSON.stringify(red));
  // applied twice (re-inverted images) = identity
  const twice = applyFilterChain(applyFilterChain(rgb(40, 120, 200), chain), chain);
  assert.ok(Math.abs(twice.r - 40) <= 3 && Math.abs(twice.g - 120) <= 3 && Math.abs(twice.b - 200) <= 3, JSON.stringify(twice));
  assert.deepEqual(applyFilterChain(rgb(0, 0, 0), [['brightness', 0.5]]), rgb(0, 0, 0));
  assert.deepEqual(applyFilterChain(rgb(255, 255, 255), [['brightness', 0.5]]), rgb(128, 128, 128));
  assert.deepEqual(applyFilterChain(rgb(255, 255, 255), [['contrast', 0.5]]), rgb(191, 191, 191));
  const sep = applyFilterChain(rgb(128, 128, 128), [['sepia', 1]]);
  assert.ok(sep.r > sep.g && sep.g > sep.b);
});
