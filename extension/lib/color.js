// Color math for both engines: parsing CSS colors, lightness transforms for the dynamic theme and
// the CSS filter chain used by the fast filter engine.
//
// Pure code, no chrome.* and no DOM. The file is a plain script (no import/export) so that it can be
// loaded as a content script AND imported as a side-effect module by pages and node tests.
// Everything is published on globalThis.DarkModeLib.color.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});

  /** @typedef {{ r: number, g: number, b: number, a: number }} RGBA  r,g,b 0..255, a 0..1 */
  /** @typedef {'bg' | 'fg' | 'border' | 'shadow' | 'generic'} Role */

  const NAMED_SRC =
    'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,' +
    'black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,' +
    'chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,' +
    'darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
    'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
    'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
    'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,' +
    'dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
    'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,' +
    'honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
    'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,' +
    'lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
    'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
    'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,' +
    'mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,' +
    'midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,' +
    'oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
    'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,' +
    'pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,' +
    'sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
    'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,' +
    'violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

  /** @type {Map<string, string>} */
  const NAMED = new Map(NAMED_SRC.split(',').map((p) => /** @type {[string, string]} */ (p.split(':'))));

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /** @param {string} hex without '#' @returns {RGBA | null} */
  function parseHex(hex) {
    if (!/^[0-9a-f]+$/i.test(hex)) return null;
    let h = hex;
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }

  /** Number with optional % → value; `pct` is what 100% means. */
  function num(token, pct) {
    if (token === 'none') return 0;
    if (token.endsWith('%')) return (parseFloat(token) / 100) * pct;
    return parseFloat(token);
  }

  /** Hue token → degrees. */
  function hue(token) {
    if (token === 'none') return 0;
    const v = parseFloat(token);
    if (token.endsWith('turn')) return v * 360;
    if (token.endsWith('grad')) return v * 0.9;
    if (token.endsWith('rad')) return (v * 180) / Math.PI;
    return v;
  }

  /** @param {number} l 0..1 @param {number} a @param {number} b @param {number} alpha @returns {RGBA} */
  function fromOklab(l, a, b, alpha) {
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
    const lin = [
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ];
    const enc = (x) => {
      const c = clamp(x, 0, 1);
      return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    };
    return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a: alpha };
  }

  /** Split "a b c / d" or "a, b, c, d" into tokens. */
  function args(inner) {
    return inner.trim().split(/[\s,/]+/).filter(Boolean);
  }

  /**
   * Parse a CSS color. Supports hex, rgb[a](), hsl[a](), oklch(), oklab(), named colors and transparent.
   * Returns null for anything else (currentcolor, color-mix, lab, system colors…) — callers keep those as is.
   * @param {string} input
   * @returns {RGBA | null}
   */
  function parseColor(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;
    if (s[0] === '#') return parseHex(s.slice(1));
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const named = NAMED.get(s);
    if (named) return parseHex(named);
    const m = /^([a-z]+)\(([^()]*)\)$/.exec(s);
    if (!m) return null;
    const fn = m[1];
    const t = args(m[2]);
    if (t.length < 3 || t.length > 4) return null;
    const alpha = t.length === 4 ? clamp(num(t[3], 1), 0, 1) : 1;
    if (t.some((x) => x !== 'none' && Number.isNaN(parseFloat(x)))) return null;
    if (fn === 'rgb' || fn === 'rgba') {
      const c = (x) => Math.round(clamp(num(x, 255), 0, 255));
      return { r: c(t[0]), g: c(t[1]), b: c(t[2]), a: alpha };
    }
    if (fn === 'hsl' || fn === 'hsla') {
      const sat = clamp(t[1].endsWith('%') ? parseFloat(t[1]) / 100 : parseFloat(t[1]) / 100, 0, 1);
      const lig = clamp(t[2].endsWith('%') ? parseFloat(t[2]) / 100 : parseFloat(t[2]) / 100, 0, 1);
      return { ...hslToRgb({ h: hue(t[0]), s: sat, l: lig }), a: alpha };
    }
    if (fn === 'oklch') {
      const L = clamp(num(t[0], 1), 0, 1);
      const C = Math.max(0, num(t[1], 0.4));
      const H = (hue(t[2]) * Math.PI) / 180;
      return fromOklab(L, C * Math.cos(H), C * Math.sin(H), alpha);
    }
    if (fn === 'oklab') return fromOklab(clamp(num(t[0], 1), 0, 1), num(t[1], 0.4), num(t[2], 0.4), alpha);
    return null;
  }

  /** @param {RGBA} c @returns {string} */
  function formatColor(c) {
    const r = Math.round(clamp(c.r, 0, 255));
    const g = Math.round(clamp(c.g, 0, 255));
    const b = Math.round(clamp(c.b, 0, 255));
    if (c.a >= 1) return `rgb(${r}, ${g}, ${b})`;
    return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`;
  }

  /** @param {RGBA} c @returns {{h: number, s: number, l: number}} h 0..360, s,l 0..1 */
  function rgbToHsl({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    return { h: h * 60, s, l };
  }

  /** @returns {{r: number, g: number, b: number}} */
  function hslToRgb({ h, s, l }) {
    const hh = (((h % 360) + 360) % 360) / 360;
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return { r: Math.round(f(hh + 1 / 3) * 255), g: Math.round(f(hh) * 255), b: Math.round(f(hh - 1 / 3) * 255) };
  }

  /** WCAG relative luminance 0..1. @param {RGBA} c */
  function luminance({ r, g, b }) {
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /** WCAG contrast ratio of two opaque colors. */
  function contrastRatio(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * New HSL lightness for a role. Every output range is chosen so that a transformed color is
   * recognisable as "already dark theme" by isThemedBg / isThemedFg (keeps the engines idempotent).
   * @param {number} l 0..1  @param {Role} role
   */
  function mapLightness(l, role) {
    switch (role) {
      case 'bg': // white → 0.10, mid → 0.30, black stays black
        return l > 0.5 ? 0.1 + (1 - l) * 0.4 : l * 0.6;
      case 'fg': // black → 0.90, mid → 0.60, light stays light
        return l < 0.5 ? 0.9 - l * 0.6 : 0.6 + (l - 0.5) * 0.7;
      case 'border':
        return l >= 0.5 ? 0.2 + (1 - l) * 0.2 : 0.3 + (0.5 - l) * 0.4;
      case 'shadow':
        return l > 0.5 ? 0.1 + (1 - l) * 0.4 : l;
      default: // generic: plain inversion squeezed into 0.10..0.90
        return 0.1 + (1 - l) * 0.8;
    }
  }

  /**
   * Transform a color for the dark theme, keeping hue, saturation and alpha.
   * @param {RGBA} c @param {Role} role @returns {RGBA}
   */
  function darken(c, role) {
    if (c.a === 0) return c;
    // Faint overlays of unknown purpose (e.g. rgba(0,0,0,.05) hover tints) are left alone.
    if (role === 'generic' && c.a < 0.3) return c;
    const hsl = rgbToHsl(c);
    const l = mapLightness(hsl.l, role);
    // Very saturated light backgrounds would turn into muddy dark colors: tone saturation down a bit.
    const s = role === 'bg' && hsl.l > 0.5 ? hsl.s * 0.85 : hsl.s;
    return { ...hslToRgb({ h: hsl.h, s, l }), a: c.a };
  }

  /** Background is dark enough to be left alone (original dark or already transformed). */
  function isDarkBg(c) {
    return c.a === 0 || rgbToHsl(c).l <= 0.32;
  }

  /** Text is light enough to be left alone. */
  function isLightFg(c) {
    return rgbToHsl(c).l >= 0.58;
  }

  // ---- CSS filter chain (Filter Effects spec matrices) — used to predict the canvas color in filter mode.

  /** @param {number[]} m 3×3 row-major @param {number[]} v */
  const mul = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  /**
   * Apply a CSS filter chain to an opaque color, like the browser does.
   * @param {RGBA} c
   * @param {Array<[string, number]>} chain e.g. [['invert', 1], ['hue-rotate', 180], ['brightness', 0.9]]
   * @returns {RGBA}
   */
  function applyFilterChain(c, chain) {
    let v = [c.r / 255, c.g / 255, c.b / 255];
    for (const [fn, amount] of chain) {
      if (fn === 'invert') v = v.map((x) => amount * (1 - x) + (1 - amount) * x);
      else if (fn === 'brightness') v = v.map((x) => x * amount);
      else if (fn === 'contrast') v = v.map((x) => (x - 0.5) * amount + 0.5);
      else if (fn === 'grayscale') {
        const a = 1 - clamp(amount, 0, 1);
        v = mul([0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a], v);
      } else if (fn === 'sepia') {
        const a = 1 - clamp(amount, 0, 1);
        v = mul([0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a], v);
      } else if (fn === 'hue-rotate') {
        const r = (amount * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        v = mul([
          0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
          0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
          0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
        ], v);
      }
      v = v.map((x) => clamp(x, 0, 1));
    }
    return { r: Math.round(v[0] * 255), g: Math.round(v[1] * 255), b: Math.round(v[2] * 255), a: c.a };
  }

  /**
   * Composite a (possibly translucent) color over an opaque one.
   * @param {RGBA} top @param {RGBA} bottom
   */
  function blend(top, bottom) {
    const a = top.a;
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
  }

  NS.color = {
    NAMED,
    parseColor,
    formatColor,
    rgbToHsl,
    hslToRgb,
    luminance,
    contrastRatio,
    mapLightness,
    darken,
    isDarkBg,
    isLightFg,
    applyFilterChain,
    blend,
  };
})(globalThis);
