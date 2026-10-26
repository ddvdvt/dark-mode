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

  /** Linear-light sRGB (0..1, clipped to the gamut) → RGBA. */
  function fromLinear(r, g, b, alpha) {
    const enc = (x) => {
      const c = clamp(x, 0, 1);
      return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    };
    return { r: enc(r), g: enc(g), b: enc(b), a: alpha };
  }

  /** sRGB channel 0..1 → linear light. */
  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

  /** @param {number} l 0..1 @param {number} a @param {number} b @param {number} alpha @returns {RGBA} */
  function fromOklab(l, a, b, alpha) {
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
    return fromLinear(
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
      alpha,
    );
  }

  /** RGBA → OKLab [L, a, b] (for color-mix in oklab / oklch). */
  function toOklab(c) {
    const r = toLin(c.r / 255), g = toLin(c.g / 255), b = toLin(c.b / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  /** CIE XYZ (D65) → RGBA. */
  function fromXyz65(x, y, z, alpha) {
    return fromLinear(
      3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z,
      -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
      0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
      alpha,
    );
  }

  /** CIE XYZ (D50) → RGBA (Bradford adaptation to D65). */
  function fromXyz50(x, y, z, alpha) {
    return fromXyz65(
      0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z,
      -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z,
      0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z,
      alpha,
    );
  }

  /** CIE Lab (D50 white, L 0..100) → RGBA. */
  function fromLab(L, a, b, alpha) {
    const e = 216 / 24389, k = 24389 / 27;
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
    const yr = L > k * e ? fy ** 3 : L / k;
    const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
    return fromXyz50((xr * 0.3457) / 0.3585, yr, (zr * (1 - 0.3457 - 0.3585)) / 0.3585, alpha);
  }

  /** color(<space> c1 c2 c3 [/ a]) for the predefined RGB / XYZ spaces. */
  function fromColorFn(t, alpha) {
    const space = t[0];
    const v = t.slice(1, 4).map((x) => num(x, 1));
    if (space === 'srgb') return fromLinear(toLin(v[0]), toLin(v[1]), toLin(v[2]), alpha);
    if (space === 'srgb-linear') return fromLinear(v[0], v[1], v[2], alpha);
    if (space === 'display-p3') {
      const [r, g, b] = v.map(toLin);
      return fromXyz65(
        0.4865709486482162 * r + 0.26566769316909306 * g + 0.1982172852343625 * b,
        0.2289745640697488 * r + 0.6917385218365064 * g + 0.079286914093745 * b,
        0.04511338185890264 * g + 1.043944368900976 * b,
        alpha,
      );
    }
    if (space === 'xyz' || space === 'xyz-d65') return fromXyz65(v[0], v[1], v[2], alpha);
    if (space === 'xyz-d50') return fromXyz50(v[0], v[1], v[2], alpha);
    return null; // a98-rgb, prophoto-rgb, rec2020: rare on the web, kept as is
  }

  /** Split a function body at top-level commas: "in srgb, rgb(1,2,3) 20%, red" → 3 parts. */
  function splitTop(s) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 40) depth++;
      else if (ch === 41) depth--;
      else if (ch === 44 && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out;
  }

  /** color-mix(in <space>, <color> [p%], <color> [p%]) → RGBA, mixed in OKLab or sRGB (premultiplied). */
  function parseMix(inner) {
    const parts = splitTop(inner);
    if (parts.length !== 3 || !parts[0].startsWith('in ')) return null;
    const item = (str) => {
      const m = /^(?:([\d.]+)%\s+)?(.*?)(?:\s+([\d.]+)%)?$/.exec(str);
      const c = m && parseColor(m[2]);
      return c ? { c, p: m[1] != null ? parseFloat(m[1]) : m[3] != null ? parseFloat(m[3]) : null } : null;
    };
    const A = item(parts[1]), B = item(parts[2]);
    if (!A || !B) return null;
    let p1 = A.p, p2 = B.p;
    if (p1 == null && p2 == null) p1 = p2 = 50;
    else if (p1 == null) p1 = 100 - p2;
    else if (p2 == null) p2 = 100 - p1;
    const sum = p1 + p2;
    if (!(sum > 0)) return null;
    const a1 = A.c.a * (p1 / sum), a2 = B.c.a * (p2 / sum);
    const alpha = Math.round((a1 + a2) * Math.min(1, sum / 100) * 1000) / 1000;
    const tot = a1 + a2;
    if (tot === 0) return { r: 0, g: 0, b: 0, a: 0 };
    if (/okl(?:ab|ch)/.test(parts[0])) {
      const x = toOklab(A.c), y = toOklab(B.c);
      return fromOklab((x[0] * a1 + y[0] * a2) / tot, (x[1] * a1 + y[1] * a2) / tot, (x[2] * a1 + y[2] * a2) / tot, alpha);
    }
    const ch = (k) => Math.round((A.c[k] * a1 + B.c[k] * a2) / tot);
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: alpha };
  }

  /** CSS system colors follow the used color-scheme by themselves: they are never rewritten. */
  const SYSTEM_COLORS = new Set(
    'canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext'.split(' '),
  );

  /** @param {string} s */
  const isSystemColor = (s) => SYSTEM_COLORS.has(String(s).trim().toLowerCase());

  /** Split "a b c / d" or "a, b, c, d" into tokens. */
  function args(inner) {
    return inner.trim().split(/[\s,/]+/).filter(Boolean);
  }

  /**
   * Parse a CSS color: hex (3/4/6/8 digits), rgb[a](), hsl[a](), hwb(), lab(), lch(), oklab(), oklch(),
   * color(srgb | srgb-linear | display-p3 | xyz…), color-mix(), light-dark() (its light value), named
   * colors and transparent. Returns null for what cannot be resolved without the page (currentcolor,
   * system colors, var(), calc(), relative colors "from …") — callers keep those as is.
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
    const open = s.indexOf('(');
    if (open <= 0 || s.charCodeAt(s.length - 1) !== 41 || !/^[a-z-]+$/.test(s.slice(0, open))) return null;
    const fn = s.slice(0, open);
    const inner = s.slice(open + 1, -1);
    if (fn === 'color-mix') return parseMix(inner);
    if (fn === 'light-dark') {
      const p = splitTop(inner);
      return p.length === 2 ? parseColor(p[0]) : null;
    }
    if (inner.indexOf('(') >= 0 || /\bfrom\b/.test(inner)) return null; // var(), calc(), relative color syntax
    const t = args(inner);
    if (fn === 'color') {
      if (t.length < 4 || t.length > 5 || t.slice(1).some((x) => x !== 'none' && Number.isNaN(parseFloat(x)))) return null;
      return fromColorFn(t, t.length === 5 ? clamp(num(t[4], 1), 0, 1) : 1);
    }
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
    if (fn === 'lab') return fromLab(clamp(num(t[0], 100), 0, 100), num(t[1], 125), num(t[2], 125), alpha);
    if (fn === 'lch') {
      const C = Math.max(0, num(t[1], 150));
      const H = (hue(t[2]) * Math.PI) / 180;
      return fromLab(clamp(num(t[0], 100), 0, 100), C * Math.cos(H), C * Math.sin(H), alpha);
    }
    if (fn === 'hwb') {
      const w = clamp(num(t[1], 100) / 100, 0, 1);
      const bl = clamp(num(t[2], 100) / 100, 0, 1);
      if (w + bl >= 1) {
        const v = Math.round((w / (w + bl)) * 255);
        return { r: v, g: v, b: v, a: alpha };
      }
      const pure = hslToRgb({ h: hue(t[0]), s: 1, l: 0.5 });
      const f = (v) => Math.round(((v / 255) * (1 - w - bl) + w) * 255);
      return { r: f(pure.r), g: f(pure.g), b: f(pure.b), a: alpha };
    }
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
    return { r: Math.round(hue2rgb(p, q, hh + 1 / 3) * 255), g: Math.round(hue2rgb(p, q, hh) * 255), b: Math.round(hue2rgb(p, q, hh - 1 / 3) * 255) };
  }

  function hue2rgb(p, q, t) {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  }

  /** Linear light of an 8-bit channel (WCAG formula), precomputed. */
  const LIN = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    LIN[v] = x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }
  const linOf = (v) => {
    const i = Math.round(v);
    if (i >= 0 && i <= 255 && i === v) return LIN[i];
    const x = clamp(v, 0, 255) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };

  /** WCAG relative luminance 0..1. @param {RGBA} c */
  function luminance({ r, g, b }) {
    return 0.2126 * linOf(r) + 0.7152 * linOf(g) + 0.0722 * linOf(b);
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
    let l = mapLightness(hsl.l, role);
    // Very saturated light backgrounds would turn into muddy dark colors: tone saturation down a bit.
    const s = role === 'bg' && hsl.l > 0.5 ? hsl.s * 0.85 : hsl.s;
    let out = null;
    // HSL lightness is not perceived lightness: a yellow at l = 0.3 is as bright as a gray at 0.5, a
    // blue at l = 0.63 as dark as a gray at 0.4. A saturated background must not end up brighter, and
    // saturated text not darker, than the gray of the same target lightness, or contrast is lost
    // (yellow buttons with light text, blue links on a dark page). Hue and saturation are kept.
    // (Backgrounds mapped very dark — most former white and pastel surfaces — are left out: light text
    // on them keeps a contrast above 10:1 either way, and they are the bulk of a stylesheet.)
    if (s > 0.05 && ((role === 'bg' && l > 0.16) || role === 'fg')) {
      // For a fixed hue and saturation every HSL channel is linear in l on each side of 0.5 (black at
      // 0, the color at 0.5, white at 1): luminance at any l comes from the color at 0.5 alone.
      const mid = hslToRgb({ h: hsl.h, s, l: 0.5 });
      const target = linF(l * 255);
      const cur = lumAtL(mid, l);
      if (role === 'bg' ? cur > target : cur < target) {
        let lo = role === 'bg' ? 0 : l, hi = role === 'bg' ? l : 0.92;
        for (let i = 0; i < 5; i++) {
          const m = (lo + hi) / 2;
          if (lumAtL(mid, m) > target) hi = m;
          else lo = m;
        }
        l = role === 'bg' ? lo : hi;
      }
    }
    out = hslToRgb({ h: hsl.h, s, l });
    return { r: out.r, g: out.g, b: out.b, a: c.a };
  }

  /** Linear light of a fractional 8-bit channel value (table + interpolation). */
  function linF(v) {
    if (v <= 0) return 0;
    if (v >= 255) return 1;
    const i = v | 0;
    return LIN[i] + (LIN[i + 1] - LIN[i]) * (v - i);
  }

  /** Luminance of the color with hue/saturation of `mid` (its value at l = 0.5) at lightness l. */
  function lumAtL(mid, l) {
    let r, g, b;
    if (l <= 0.5) {
      const k = l * 2;
      r = mid.r * k;
      g = mid.g * k;
      b = mid.b * k;
    } else {
      const k = (l - 0.5) * 2;
      r = mid.r + (255 - mid.r) * k;
      g = mid.g + (255 - mid.g) * k;
      b = mid.b + (255 - mid.b) * k;
    }
    return 0.2126 * linF(r) + 0.7152 * linF(g) + 0.0722 * linF(b);
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
    SYSTEM_COLORS,
    isSystemColor,
    splitTop,
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
