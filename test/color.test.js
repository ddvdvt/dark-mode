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
  for (const s of ['', 'currentcolor', 'currentColor', 'inherit', 'var(--x)', 'rgb(var(--x))', 'rgb(from red r g b / 50%)', 'color-mix(in srgb, var(--a), blue)', 'calc(1px)', '#ggg', '#12345', 'rgb(a,b,c)', 'Canvas', 'CanvasText', 'none', 'color(rec2020 1 0 0)', 'url(#a)', null]) {
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

const near = (c, r, g, b, a = 1, tol = 2) =>
  c && Math.abs(c.r - r) <= tol && Math.abs(c.g - g) <= tol && Math.abs(c.b - b) <= tol && Math.abs(c.a - a) < 0.01;

test('parses every CSS color syntax that sites use', () => {
  assert.ok(near(parseColor('rgb(0 0 0 / .5)'), 0, 0, 0, 0.5));
  assert.ok(near(parseColor('rgb(255 255 255 / 0.9)'), 255, 255, 255, 0.9));
  assert.ok(near(parseColor('RGBA(13, 110, 253, 1)'), 13, 110, 253));
  assert.ok(near(parseColor('rgb(none 128 255)'), 0, 128, 255));
  assert.ok(near(parseColor('#81_8b98'.replace('_', '')), 0x81, 0x8b, 0x98));
  assert.ok(near(parseColor('#818b981f'), 0x81, 0x8b, 0x98, 0.122));
  assert.ok(near(parseColor('#d1d9e0b3'), 0xd1, 0xd9, 0xe0, 0.702));
  assert.ok(near(parseColor('hsl(210deg 40% 98%)'), 247, 250, 252));
  assert.ok(near(parseColor('hsl(222.2 84% 4.9%)'), 2, 8, 23));
  assert.ok(near(parseColor('hsl(120, 100%, 25%, 0.3)'), 0, 128, 0, 0.3));
  assert.ok(near(parseColor('hwb(0 0% 0%)'), 255, 0, 0));
  assert.ok(near(parseColor('hwb(120 20% 20%)'), 51, 204, 51));
  assert.ok(near(parseColor('hwb(0 60% 60%)'), 128, 128, 128));
  // CIE Lab / LCH (D50), reference values from the CSS Color 4 spec examples
  assert.ok(near(parseColor('lab(100 0 0)'), 255, 255, 255));
  assert.ok(near(parseColor('lab(0% 0 0)'), 0, 0, 0));
  assert.ok(near(parseColor('lab(54.29 80.82 69.88)'), 255, 0, 0, 1, 4), JSON.stringify(parseColor('lab(54.29 80.82 69.88)')));
  assert.ok(near(parseColor('lch(54.29 106.84 40.85)'), 255, 0, 0, 1, 4));
  assert.ok(near(parseColor('lch(50% 0 0 / 50%)'), 119, 119, 119, 0.5, 2));
  // color() spaces
  assert.ok(near(parseColor('color(srgb 1 0.5 0)'), 255, 128, 0));
  assert.ok(near(parseColor('color(srgb 100% 50% 0% / 0.25)'), 255, 128, 0, 0.25));
  assert.ok(near(parseColor('color(srgb-linear 1 1 1)'), 255, 255, 255));
  assert.ok(near(parseColor('color(display-p3 1 1 1)'), 255, 255, 255));
  assert.ok(near(parseColor('color(display-p3 0.5 0.5 0.5)'), 128, 128, 128));
  assert.ok(near(parseColor('color(xyz-d65 0.9505 1 1.089)'), 255, 255, 255));
  assert.ok(near(parseColor('color(xyz-d50 0.9642 1 0.8249)'), 255, 255, 255));
});

test('color-mix() and light-dark()', () => {
  assert.ok(near(parseColor('color-mix(in srgb, red, blue)'), 128, 0, 128, 1, 1));
  assert.ok(near(parseColor('color-mix(in srgb, white 20%, black)'), 51, 51, 51, 1, 1));
  assert.ok(near(parseColor('color-mix(in srgb, 25% white, black)'), 64, 64, 64, 1, 1));
  // Tailwind 4 alpha: color-mix(in oklab, <color> 50%, transparent) keeps the color, halves alpha
  assert.ok(near(parseColor('color-mix(in oklab, #000 50%, transparent)'), 0, 0, 0, 0.5));
  assert.ok(near(parseColor('color-mix(in oklab, oklch(100% 0 0) 80%, transparent)'), 255, 255, 255, 0.8));
  assert.ok(near(parseColor('color-mix(in oklch, #fff, #000)'), 99, 99, 99, 1, 3));
  assert.ok(near(parseColor('color-mix(in srgb, red 30%, blue 30%)'), 128, 0, 128, 0.6, 1), 'percentages under 100% scale alpha');
  assert.ok(near(parseColor('light-dark(#fff, #000)'), 255, 255, 255));
  assert.ok(near(parseColor('light-dark(rgb(1 2 3), hsl(0 0% 0%))'), 1, 2, 3));
  assert.equal(parseColor('light-dark(#fff)'), null);
  assert.equal(parseColor('color-mix(in srgb, red)'), null);
});

test('system colors and currentColor are recognised and never parsed', () => {
  assert.equal(Lib.color.isSystemColor('Canvas'), true);
  assert.equal(Lib.color.isSystemColor('canvastext'), true);
  assert.equal(Lib.color.isSystemColor('LinkText'), true);
  assert.equal(Lib.color.isSystemColor('white'), false);
  assert.deepEqual(Lib.color.splitTop('in srgb, rgb(1, 2, 3) 20%, red'), ['in srgb', 'rgb(1, 2, 3) 20%', 'red']);
});

test('darken matches perceived lightness: saturated colors keep hue and contrast', () => {
  const text = darken(rgb(0, 0, 0), 'fg');
  for (const hex of ['#ffc107', '#ffdd2d', '#ffe600', '#0d6efd', '#e30613', '#2aabee', '#21a038', '#ff0000', '#fff3cd', '#d1e7dd', '#00ff00']) {
    const c = parseColor(hex);
    const bg = darken(c, 'bg');
    assert.ok(contrastRatio(text, bg) >= 6.5, `${hex} → ${formatColor(bg)}: default text contrast ${contrastRatio(text, bg).toFixed(2)}`);
    assert.ok(contrastRatio(rgb(255, 255, 255), bg) >= 4.5, `${hex}: white text on it`);
    const h0 = rgbToHsl(c).h, h1 = rgbToHsl(bg).h;
    assert.ok(Math.min(Math.abs(h0 - h1), 360 - Math.abs(h0 - h1)) < 8, `${hex} keeps its hue`);
    assert.ok(isDarkBg(bg));
  }
  const page = darken(rgb(255, 255, 255), 'bg');
  for (const hex of ['#0969da', '#0000ee', '#cf222e', '#006699', '#8250df', '#1a0dab', '#0645ad']) {
    const fg = darken(parseColor(hex), 'fg');
    assert.ok(contrastRatio(fg, page) >= 4.5, `${hex} → ${formatColor(fg)} on the page: ${contrastRatio(fg, page).toFixed(2)}`);
    assert.ok(isLightFg(fg), `${hex} is recognised as transformed`);
  }
});
