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
