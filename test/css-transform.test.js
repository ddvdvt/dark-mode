import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lib, CSSStyleRule, CSSMediaRule, CSSSupportsRule, CSSLayerBlockRule, CSSContainerRule, CSSKeyframesRule, CSSKeyframeRule, CSSImportRule, CSSFontFaceRule, CSSNestedDeclarations } from './helpers.js';

const { transformValue, transformSheet, createContext, TooBig } = Lib.css;
const { parseColor, isDarkBg, isLightFg } = Lib.color;

test('transformValue rewrites every color token, keeps the rest', () => {
  const v = transformValue('linear-gradient(#fff, rgba(255, 255, 255, 0.5)) , url(white.png)', 'bg');
  assert.match(v, /^linear-gradient\(rgb\(\d+, \d+, \d+\), rgba\(\d+, \d+, \d+, 0\.5\)\) , url\(white\.png\)$/);
  assert.equal(transformValue('var(--white)', 'bg'), 'var(--white)');
  assert.equal(transformValue('currentcolor', 'fg'), 'currentcolor');
  assert.equal(transformValue('inherit', 'fg'), 'inherit');
  assert.equal(transformValue('transparent', 'bg'), 'transparent');
  assert.equal(transformValue('url(#grad)', 'fg'), 'url(#grad)');
  assert.equal(transformValue('none', 'bg'), 'none');
  const shadow = transformValue('0 1px 2px rgba(0, 0, 0, 0.2), inset 0 0 0 1px white', 'shadow');
  assert.match(shadow, /^0 1px 2px rgba\(0, 0, 0, 0\.2\), inset 0 0 0 1px rgb\(\d+, \d+, \d+\)$/);
  const text = transformValue('black', 'fg');
  assert.ok(isLightFg(parseColor(text)), text);
  assert.equal(transformValue('black', 'fg'), text, 'cached result is identical');
});

test('style rules: only color declarations, priority kept, selector kept', () => {
  const rules = [
    new CSSStyleRule('body', [['margin', '0'], ['background-color', '#fff'], ['color', '#222', true]]),
    new CSSStyleRule('.layout', [['display', 'grid'], ['width', '100px']]),
    new CSSStyleRule('a:hover', [['color', 'rgb(0, 0, 238)'], ['text-decoration-color', 'red']]),
  ];
  const ctx = createContext();
  const css = transformSheet(rules, ctx);
  assert.ok(!css.includes('.layout'), 'rules without colors are skipped');
  assert.ok(!css.includes('margin') && !css.includes('grid'), 'layout untouched');
  const body = /^body\{background-color:(rgb\([^)]*\));color:(rgb\([^)]*\)) !important;\}/.exec(css);
  assert.ok(body, css);
  assert.ok(isDarkBg(parseColor(body[1])));
  assert.ok(isLightFg(parseColor(body[2])));
  assert.match(css, /a:hover\{color:rgb\([^)]*\);text-decoration-color:rgb\([^)]*\);\}/);
  assert.equal(ctx.rules, 3);
  assert.equal(ctx.decls, 4);
});

test('at-rules are mirrored: @media, @supports, @layer, @container, nesting, @import', () => {
  const imported = { cssRules: [new CSSStyleRule('.imp', [['color', 'black']])] };
  const rules = [
    new CSSImportRule(imported, 'print'),
    new CSSMediaRule('(max-width: 600px)', [new CSSStyleRule('.m', [['background-color', 'white']])]),
    new CSSSupportsRule('(display: grid)', [new CSSStyleRule('.s', [['border-top-color', '#ccc']])]),
    new CSSLayerBlockRule('base', [new CSSStyleRule('.l', [['outline-color', 'black']])]),
    new CSSContainerRule('@container card (min-width: 400px) { .c { color: black } }', [new CSSStyleRule('.c', [['color', 'black']])]),
    new CSSStyleRule('.card', [['color', 'black']], [new CSSStyleRule('& .title', [['background-color', 'white']]), new CSSNestedDeclarations([['border-left-color', 'white']])]),
    new CSSMediaRule('screen', [new CSSStyleRule('.nocolor', [['padding', '1px']])]),
    new CSSFontFaceRule(),
  ];
  const css = transformSheet(rules, createContext());
  assert.match(css, /^@media print\{\.imp\{color:/);
  assert.match(css, /@media \(max-width: 600px\)\{\.m\{background-color:/);
  assert.match(css, /@supports \(display: grid\)\{\.s\{border-top-color:/);
  assert.match(css, /@layer base\{\.l\{outline-color:/);
  assert.match(css, /@container card \(min-width: 400px\)\{\.c\{color:/);
  assert.match(css, /\.card\{color:rgb\([^)]*\);& \.title\{background-color:rgb\([^)]*\);\}border-left-color:rgb\([^)]*\);\}/);
  assert.ok(!css.includes('screen'), 'empty groups are dropped');
  assert.ok(!css.includes('font-face'));
});

test('keyframes are re-emitted whole when they animate colors', () => {
  const kf = new CSSKeyframesRule('flash', [new CSSKeyframeRule('0%', [['opacity', '0'], ['background-color', 'white']]), new CSSKeyframeRule('100%', [['opacity', '1']])]);
  const plain = new CSSKeyframesRule('spin', [new CSSKeyframeRule('to', [['transform', 'rotate(1turn)']])]);
  const css = transformSheet([kf, plain], createContext());
  assert.match(css, /^@keyframes flash\{0%\{opacity:0;background-color:rgb\([^)]*\);\}100%\{opacity:1;\}\}$/);
});

test('custom properties get a role from how they are used', () => {
  const rules = [
    new CSSStyleRule(':root', [['--bg', '#ffffff'], ['--text', '#111111'], ['--accent', '#ffffff'], ['--line', '#dddddd'], ['--surface', 'var(--bg)'], ['--gap', '8px']]),
    new CSSStyleRule('body', [['background', 'var(--surface)'], ['background-color', ''], ['color', 'var(--text)']]),
    new CSSStyleRule('.btn', [['color', 'var(--accent)'], ['background-color', 'var(--accent)']]),
    new CSSStyleRule('hr', [['border-top-color', ''], ['border-top', '1px solid var(--line)']]),
  ];
  const css = transformSheet(rules, createContext());
  const val = (name) => new RegExp(`${name}:(rgb\\([^)]*\\))`).exec(css)?.[1];
  assert.ok(isDarkBg(parseColor(val('--bg'))), 'bg var used through an alias in background shorthand');
  assert.ok(isLightFg(parseColor(val('--text'))), 'text var');
  assert.ok(isDarkBg(parseColor(val('--accent'))), 'mixed use → generic inversion');
  assert.ok(val('--line'), 'border var transformed');
  assert.ok(!css.includes('--gap'), 'non-color variable untouched');
  assert.ok(!css.includes('--surface'), 'var() aliases are not rewritten');
});

test('unreadable @import is reported, huge sheets abort', () => {
  const ctx = createContext();
  const locked = {
    get cssRules() {
      throw new Error('SecurityError');
    },
  };
  transformSheet([new CSSImportRule(locked)], ctx);
  assert.equal(ctx.unreadable, true);
  const many = Array.from({ length: 50 }, (_, i) => new CSSStyleRule(`.r${i}`, [['color', 'red']]));
  assert.throws(() => transformSheet(many, createContext({ maxRules: 10 })), TooBig);
});

const { readSheet, emitSheet, planUsesVars, transformChannels, aliasName } = Lib.css;
const { contrastRatio } = Lib.color;
const decl = (css, name) => new RegExp(`(?:^|[;{])${name.replace(/[-]/g, '\\-')}:([^;]*);`).exec(css)?.[1];

test('values: shorthands, gradients, shadows, strings, var() fallbacks, every color syntax', () => {
  const bg = (v) => transformValue(v, 'bg');
  assert.match(bg('#fff url("a.png") no-repeat 0 0 / cover'), /^rgb\(\d+, \d+, \d+\) url\("a\.png"\) no-repeat 0 0 \/ cover$/);
  assert.match(bg('linear-gradient(to right, #fff 0%, rgb(255 255 255 / 0) 100%), url(x.jpg)'), /^linear-gradient\(to right, rgb\(\d+, \d+, \d+\) 0%, rgba\(\d+, \d+, \d+, 0\) 100%\), url\(x\.jpg\)$/);
  assert.match(transformValue('1px solid #ddd', 'border'), /^1px solid rgb\(\d+, \d+, \d+\)$/);
  assert.match(transformValue('2px dashed lightgray', 'border'), /^2px dashed rgb\(/);
  assert.match(transformValue('0 1px 0 #fff, inset 0 -1px 0 rgba(0,0,0,.1)', 'shadow'), /^0 1px 0 rgb\(\d+, \d+, \d+\), inset 0 -1px 0 rgba\(0, 0, 0, 0\.1\)$/);
  assert.equal(transformValue('"white" counter(x)', 'fg'), '"white" counter(x)', 'strings are not colors');
  assert.equal(transformValue("'black'", 'fg'), "'black'");
  assert.match(transformValue('var(--x, #333)', 'fg'), /^var\(--x, rgb\(\d+, \d+, \d+\)\)$/);
  for (const v of ['currentColor', 'Canvas', 'CanvasText', 'LinkText', 'inherit', 'unset', 'none', 'auto', 'transparent']) assert.equal(transformValue(v, 'fg'), v);
  for (const v of ['hwb(0 100% 0%)', 'lab(100 0 0)', 'lch(100 0 0)', 'color(srgb 1 1 1)', 'color(display-p3 1 1 1)', 'oklch(100% 0 0)', 'oklab(1 0 0)', 'hsl(0 0% 100%)', 'rgb(100% 100% 100%)', '#ffff', '#ffffffff', 'WHITE']) {
    const t = bg(v);
    assert.ok(isDarkBg(parseColor(t)), `${v} → ${t}`);
  }
  // color-mix() / light-dark(): every color inside is transformed for the role
  const mix = bg('color-mix(in oklab, #fff 80%, transparent)');
  assert.match(mix, /^color-mix\(in oklab, rgb\(\d+, \d+, \d+\) 80%, transparent\)$/);
  assert.ok(isDarkBg(parseColor(mix)));
  const ld = transformValue('light-dark(#000, #fff)', 'fg');
  assert.match(ld, /^light-dark\(rgb\(\d+, \d+, \d+\), rgb\(\d+, \d+, \d+\)\)$/);
  assert.ok(isLightFg(parseColor(transformValue('#24292f', 'fg'))), 'fill / stroke / caret / decoration colors are text-like');
});

test('Tailwind 3: literal channels with a var() alpha keep the variable', () => {
  const t = transformValue('rgb(255 255 255 / var(--tw-bg-opacity))', 'bg');
  const m = /^rgb\((\d+) (\d+) (\d+) \/ var\(--tw-bg-opacity\)\)$/.exec(t);
  assert.ok(m, t);
  assert.ok(isDarkBg({ r: +m[1], g: +m[2], b: +m[3], a: 1 }));
  const fg = transformValue('rgb(17 24 39 / var(--tw-text-opacity, 1))', 'fg');
  assert.match(fg, /^rgb\(\d+ \d+ \d+ \/ var\(--tw-text-opacity, 1\)\)$/);
  assert.ok(isLightFg(parseColor(fg.replace(/ \/ var\([^)]*\)/, ''))));
  assert.match(transformValue('rgba(0, 0, 0, var(--x))', 'shadow'), /^rgb\(0 0 0 \/ var\(--x\)\)$/);
  assert.equal(transformValue('rgb(var(--c) / 0.5)', 'bg'), 'rgb(var(--c) / 0.5)', 'channels in a variable are left to the variable');
  assert.equal(transformValue('rgba(var(--bs-primary-rgb), var(--bs-bg-opacity))', 'bg'), 'rgba(var(--bs-primary-rgb), var(--bs-bg-opacity))');
});

test('channel variables: hsl(var(--x)) and rgba(var(--x-rgb), a) keep their format', () => {
  assert.match(transformChannels('0 0% 100%', 'hsl', 'bg'), /^[\d.]+ [\d.]+% [\d.]+%$/);
  assert.match(transformChannels('255, 255, 255', 'rgb', 'bg'), /^\d+, \d+, \d+$/);
  assert.match(transformChannels('13 110 253', 'rgb', 'fg'), /^\d+ \d+ \d+$/);
  assert.equal(transformChannels('not a color', 'hsl', 'bg'), 'not a color');
  const rules = [
    new CSSStyleRule(':root', [['--background', '0 0% 100%'], ['--foreground', '222.2 84% 4.9%'], ['--primary-rgb', '13, 110, 253']]),
    new CSSStyleRule('body', [['background-color', 'hsl(var(--background))'], ['color', 'hsl(var(--foreground) / .9)']]),
    new CSSStyleRule('.bg-primary', [['background-color', 'rgba(var(--primary-rgb), var(--bs-bg-opacity))']]),
  ];
  const css = transformSheet(rules, createContext());
  const bgv = decl(css, '--background'), fgv = decl(css, '--foreground'), pr = decl(css, '--primary-rgb');
  assert.ok(isDarkBg(parseColor(`hsl(${bgv})`)), bgv);
  assert.ok(isLightFg(parseColor(`hsl(${fgv})`)), fgv);
  assert.ok(isDarkBg(parseColor(`rgb(${pr})`)), pr);
  assert.match(pr, /^\d+, \d+, \d+$/, 'commas kept');
});

test('variables used as both text and background get one alias per role', () => {
  // Tailwind 4: --color-white is both .text-white and .bg-white
  const rules = [
    new CSSStyleRule(':root', [['--color-white', '#fff'], ['--color-blue-600', 'oklch(54.6% .245 262.881)'], ['--on-accent', 'var(--color-white)'], ['--white-rgb', '255, 255, 255']]),
    new CSSStyleRule('.bg-white', [['background-color', 'var(--color-white)']]),
    new CSSStyleRule('.text-white', [['color', 'var(--color-white)']]),
    new CSSStyleRule('.bg-blue', [['background-color', 'var(--color-blue-600)']]),
    new CSSStyleRule('.text-blue', [['color', 'var(--color-blue-600)']]),
    new CSSStyleRule('.btn', [['color', 'var(--on-accent)'], ['border-top-color', 'var(--x, var(--color-blue-600))']]),
    new CSSStyleRule('.a', [['color', 'rgba(var(--white-rgb), .75)']]),
    new CSSStyleRule('.b', [['background-color', 'rgba(var(--white-rgb), 1)']]),
  ];
  const css = transformSheet(rules, createContext());
  const fgWhite = parseColor(decl(css, aliasName('--color-white', 'fg')));
  const bgWhite = parseColor(decl(css, aliasName('--color-white', 'bg')));
  assert.ok(isLightFg(fgWhite) && isDarkBg(bgWhite), css);
  assert.match(css, /\.text-white\{color:var\(--nd-fg-color-white, var\(--color-white\)\);\}/);
  assert.match(css, /\.bg-white\{background-color:var\(--nd-bg-color-white, var\(--color-white\)\);\}/);
  const blueBg = parseColor(decl(css, '--nd-bg-color-blue-600')), blueFg = parseColor(decl(css, '--nd-fg-color-blue-600'));
  assert.ok(contrastRatio(fgWhite, blueBg) >= 4.5, 'white text on the blue button');
  assert.ok(contrastRatio(blueFg, parseColor('rgb(26, 26, 26)')) >= 4.5, 'blue text on the page');
  // an alias chain: --on-accent is used for text only, its value points to the text alias
  assert.match(css, /--on-accent:var\(--nd-fg-color-white, var\(--color-white\)\);/);
  assert.match(css, /\.btn\{border-top-color:var\(--x, var\(--nd-border-color-blue-600, var\(--color-blue-600\)\)\);\}/);
  assert.match(decl(css, '--nd-fg-white-rgb'), /^\d+, \d+, \d+$/, 'channel variable aliases keep the format');
  assert.match(css, /\.a\{color:rgba\(var\(--nd-fg-white-rgb, var\(--white-rgb\)\), \.75\);\}/);
});

test('roles learnt from a later sheet re-emit an earlier one (design tokens in their own file)', () => {
  const ctx = createContext();
  const tokens = readSheet([new CSSStyleRule(':root', [['--fg-on-emphasis', '#ffffff'], ['--bg-emphasis', '#0969da']])], ctx);
  assert.equal(planUsesVars(tokens), true);
  const v0 = ctx.version;
  const before = emitSheet(tokens, ctx);
  assert.ok(isDarkBg(parseColor(decl(before, '--fg-on-emphasis'))), 'unknown role → generic inversion');
  readSheet([new CSSStyleRule('.btn', [['color', 'var(--fg-on-emphasis)'], ['background-color', 'var(--bg-emphasis)']])], ctx);
  assert.ok(ctx.version > v0, 'new knowledge bumps the version');
  const after = emitSheet(tokens, ctx);
  assert.ok(isLightFg(parseColor(decl(after, '--fg-on-emphasis'))), after);
  assert.ok(isDarkBg(parseColor(decl(after, '--bg-emphasis'))), after);
  assert.equal(planUsesVars(readSheet([new CSSStyleRule('p', [['color', 'red']])], ctx)), false);
});

test('CSS mask icons: the background color is the glyph color', () => {
  const css = transformSheet([
    new CSSStyleRule('.icon', [['mask-image', 'url(i.svg)'], ['background-color', '#202122']]),
    new CSSStyleRule('.icon2', [['-webkit-mask-image', 'url(i.svg)'], ['background-color', 'var(--icon-color)']]),
    new CSSStyleRule(':root', [['--icon-color', '#202122']]),
    new CSSStyleRule('.box', [['mask-image', 'none'], ['background-color', '#fff']]),
  ], createContext());
  assert.ok(isLightFg(parseColor(/\.icon\{background-color:(rgb\([^)]*\))/.exec(css)[1])), css);
  assert.ok(isLightFg(parseColor(decl(css, '--icon-color'))), 'a variable used for a mask icon is foreground');
  assert.ok(isDarkBg(parseColor(/\.box\{background-color:(rgb\([^)]*\))/.exec(css)[1])));
});

test('print keeps the page colors: output wrapped in @media screen, @namespace in front', () => {
  const rules = [{ constructor: { name: 'CSSNamespaceRule' }, cssText: '@namespace svg url(http://www.w3.org/2000/svg);' }, new CSSStyleRule('svg|a', [['fill', 'black']])];
  const css = transformSheet(rules, createContext(), { screen: true });
  assert.match(css, /^@namespace svg url\(http:\/\/www\.w3\.org\/2000\/svg\);@media screen\{svg\|a\{fill:rgb\([^)]*\);\}\}$/);
  assert.equal(transformSheet([new CSSStyleRule('.x', [['padding', '0']])], createContext(), { screen: true }), '');
});

test('style rules are read from the CSSOM once (CSS-in-JS sheets grow by insertRule)', () => {
  let reads = 0;
  const rule = new CSSStyleRule('.css-1', [['color', 'black']]);
  const style = rule.style;
  rule.style = new Proxy(style, { get: (t, k) => (k === 'length' && reads++, Reflect.get(t, k)) });
  const ctx = createContext();
  const a = transformSheet([rule], ctx);
  const b = transformSheet([rule, new CSSStyleRule('.css-2', [['background-color', 'white']])], ctx);
  assert.equal(reads, 1);
  assert.ok(b.startsWith(a));
  assert.equal(ctx.rules, 3);
});

// Real CSSOM iterates longhands only; a shorthand is reachable through getPropertyValue().
function withShorthand(rule, shorthands) {
  const st = rule.style;
  const get = st.getPropertyValue.bind(st);
  st.getPropertyValue = (p) => (p in shorthands ? shorthands[p] : get(p));
  return rule;
}

test('background: var(--x) shorthand: a mixed color variable still gets its background alias', () => {
  const rules = [
    new CSSStyleRule(':root', [['--brand', '#e30613', true], ['--hero', 'url(h.jpg) center / cover']]),
    withShorthand(new CSSStyleRule('.buy', [['background-color', ''], ['background-image', '']]), { background: 'var(--brand)' }),
    new CSSStyleRule('a:hover', [['color', 'var(--brand)']]),
    withShorthand(new CSSStyleRule('.hero', [['background-color', '']]), { background: 'var(--hero)' }),
    new CSSStyleRule('.hero-title', [['color', 'var(--hero)']]),
  ];
  const css = transformSheet(rules, createContext());
  assert.match(css, /\.buy\{background-color:var\(--nd-bg-brand, var\(--brand\)\);\}/);
  assert.match(css, /--brand:[^;]* !important;/, 'priority of the definition kept');
  assert.ok(isDarkBg(parseColor(/--nd-bg-brand:(rgb\([^)]*\))/.exec(css)[1])));
  assert.ok(!css.includes('.hero{'), 'a variable holding an image is never split into a longhand');
});
