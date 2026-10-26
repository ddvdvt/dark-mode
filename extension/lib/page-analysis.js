// Decisions the content script makes from computed styles: "is this page already dark?", the
// per-element fallback override of the dynamic engine and the image heuristics of the filter engine.
//
// Pure code over plain strings/numbers (the content script reads getComputedStyle and passes values in).
// Plain script published on globalThis.DarkModeLib.page. Requires lib/color.js loaded first.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});
  const C = NS.color;

  const WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /**
   * Visible background behind an element: background colors from the element up to <html>
   * (innermost first) composited over the canvas color.
   * @param {string[]} chain computed background-color values, innermost first
   * @param {string} [canvas] color of the canvas (default white)
   */
  function effectiveBackground(chain, canvas) {
    let out = (canvas && C.parseColor(canvas)) || WHITE;
    if (out.a < 1) out = C.blend(out, WHITE);
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = C.parseColor(chain[i]);
      if (c && c.a > 0) out = C.blend(c, out);
    }
    return out;
  }

  /** Canvas of a page in the dark color scheme (Chrome's dark Canvas system color). */
  const DARK_CANVAS = { r: 18, g: 18, b: 18, a: 1 };

  /**
   * Which color scheme the browser uses for the page's canvas and default text: the computed
   * color-scheme of <html>, else <meta name="color-scheme">; "light dark" follows the system.
   * @param {string} computed getComputedStyle(html).colorScheme @param {string} meta @param {boolean} systemDark
   * @returns {'light' | 'dark'}
   */
  function usedScheme(computed, meta, systemDark) {
    const src = computed && computed !== 'normal' ? computed : meta || '';
    const list = src.toLowerCase().split(/[\s,]+/);
    const dark = list.includes('dark'), light = list.includes('light');
    return dark && (!light || systemDark) ? 'dark' : 'light';
  }

  /**
   * Canvas color as the browser paints it: <html> background, else <body> background, else the
   * Canvas color of the used scheme (white, or dark for <meta name="color-scheme" content="dark">).
   * @param {string} htmlBg @param {string} bodyBg @param {'light' | 'dark'} [scheme]
   */
  function canvasColor(htmlBg, bodyBg, scheme) {
    const base = scheme === 'dark' ? DARK_CANVAS : WHITE;
    const h = C.parseColor(htmlBg);
    if (h && h.a > 0) return C.blend(h, base);
    const b = C.parseColor(bodyBg);
    if (b && b.a > 0) return C.blend(b, base);
    return base;
  }

  /** Relative luminance below which a background counts as dark (≈ #5a5a5a). */
  const DARK_LUMINANCE = 0.1;

  /** One sample: dark background under readable (light) text. */
  function darkAt(bg, text) {
    if (C.luminance(bg) >= DARK_LUMINANCE) return false;
    const fg = text ? C.parseColor(text) : null;
    // dark background with dark text is a light theme that has not painted yet — don't trust it
    return !fg || fg.a === 0 || C.contrastRatio(C.blend(fg, bg), bg) >= 3 || C.luminance(fg) > 0.2;
  }

  /**
   * @typedef {{ chain: string[], text?: string, media?: boolean }} Sample
   *   chain: computed background colors from the element at a point up to <body>, innermost first;
   *   media: the point shows a photo / video / canvas — it says nothing about the theme
   */

  /**
   * Is the page already dark? Looks at the canvas and at several points of the viewport (app shells
   * often paint their dark background on a wrapper, not on <body>). Points on media are ignored, so a
   * light page with a big black video player in the middle is not mistaken for a dark site. On a dark
   * canvas a majority of the points must be dark; on a light canvas all of them (a dark app shell
   * covers the whole viewport, while a light site with dark header, band and footer does not).
   * @param {{ htmlBg: string, bodyBg: string, scheme?: 'light' | 'dark', samples?: Sample[], center?: string[] | null, text?: string }} m
   */
  function looksDark(m) {
    const canvas = canvasColor(m.htmlBg, m.bodyBg, m.scheme);
    const samples = (m.samples || (m.center ? [{ chain: m.center, text: m.text }] : [])).filter((s) => !s.media);
    if (!samples.length) return darkAt(canvas, m.text);
    const cf = C.formatColor(canvas);
    let dark = 0;
    for (const s of samples) if (darkAt(s.chain.length ? effectiveBackground(s.chain, cf) : canvas, s.text || m.text)) dark++;
    return C.luminance(canvas) < DARK_LUMINANCE ? dark * 2 > samples.length : dark === samples.length;
  }

  /**
   * @typedef {{ bg?: string, fg?: string, image?: string, fill?: string, border?: string }} Override
   */

  /**
   * Fallback of the dynamic engine for an element styled by something the stylesheet pass could not
   * rewrite (cross-origin CSS, inline style, legacy bgcolor/color attributes). Returns null when the
   * element already fits the dark theme — transformed colors are never transformed again.
   * @param {{ bg: string, fg: string, image?: string, border?: string }} cs computed values
   *   border: color of the first visible border side, if any
   * @returns {Override | null}
   */
  function elementOverride(cs) {
    /** @type {Override} */
    const o = {};
    const bg = C.parseColor(cs.bg);
    if (bg && bg.a > 0 && !C.isDarkBg(bg)) o.bg = C.formatColor(C.darken(bg, 'bg'));
    const fg = C.parseColor(cs.fg);
    if (fg && fg.a > 0 && !C.isLightFg(fg)) o.fg = C.formatColor(C.darken(fg, 'fg'));
    if (cs.image && cs.image !== 'none' && cs.image.indexOf('gradient') >= 0) {
      const t = NS.css.transformValue(cs.image, 'bg');
      if (t !== cs.image) o.image = t;
    }
    const bd = cs.border ? C.parseColor(cs.border) : null;
    if (bd && bd.a > 0 && C.rgbToHsl(bd).l > 0.5) o.border = C.formatColor(C.darken(bd, 'border'));
    return o.bg || o.fg || o.image || o.border ? o : null;
  }

  /**
   * Shapes inside inline SVG: dark fills and strokes become light, like text (icons, formulas, labels).
   * A light shape that covers most of its <svg> is the backdrop of a chart or diagram: it becomes dark,
   * like a background, so the labels drawn on it stay readable.
   * @param {string} fill computed fill @param {string} [stroke] computed stroke
   * @param {number} [coverage] share of the owner <svg> box covered by the shape, 0..1
   * @returns {Override | null}
   */
  function svgOverride(fill, stroke, coverage = 0) {
    /** @type {Override} */
    const o = {};
    const f = C.parseColor(fill);
    if (f && f.a > 0) {
      if (!C.isLightFg(f)) o.fill = C.formatColor(C.darken(f, 'fg'));
      else if (coverage >= 0.5 && !C.isDarkBg(f)) o.fill = C.formatColor(C.darken(f, 'bg'));
    }
    const s = stroke ? C.parseColor(stroke) : null;
    if (s && s.a > 0 && !C.isLightFg(s)) o.stroke = C.formatColor(C.darken(s, 'fg'));
    return o.fill || o.stroke ? o : null;
  }

  /** Stable cache key of an override. @param {Override} o */
  function overrideKey(o) {
    return (o.bg || '') + '|' + (o.fg || '') + '|' + (o.image || '') + '|' + (o.fill || '') + '|' + (o.border || '') + (o.stroke ? '|' + o.stroke : '');
  }

  /**
   * CSS rule for an override class. !important: these elements are styled by rules we cannot rewrite.
   * @param {string} id @param {Override} o
   */
  function overrideRule(id, o) {
    let body = '';
    if (o.bg) body += `background-color:${o.bg}!important;`;
    if (o.image) body += `background-image:${o.image}!important;`;
    if (o.fg) body += `color:${o.fg}!important;`;
    if (o.fill) body += `fill:${o.fill}!important;`;
    if (o.stroke) body += `stroke:${o.stroke}!important;`;
    if (o.border) body += `border-color:${o.border}!important;`;
    return `[data-nd-c="${id}"]{${body}}`;
  }

  /**
   * Filter engine: should an element with a CSS background image be shown in original colors?
   * Large boxes are photos / banners; small ones are usually icons and sprites, which look right inverted.
   * Not photos either: a small tile repeated as a texture behind content, and page-sized wrappers
   * (<body>, a site container taller than the screen) — re-inverting those would turn the whole page
   * light again.
   * @param {string} image computed background-image
   * @param {number} w @param {number} h rendered size in CSS px
   * @param {{ repeat?: string, size?: string, viewportHeight?: number, root?: boolean }} [o]
   *   repeat / size: computed background-repeat / background-size
   */
  function isPhotoBackground(image, w, h, o = {}) {
    if (!image || image === 'none' || image.indexOf('url(') < 0) return false;
    if (/url\(["']?data:image\/svg|\.svg(?:[?#"')]|$)/i.test(image)) return false;
    if (o.root) return false;
    if (o.viewportHeight && h > o.viewportHeight * 1.5) return false;
    if (o.repeat && o.repeat.indexOf('no-repeat') < 0 && o.repeat.indexOf('round') < 0 && o.size) {
      // a tile repeated in both directions with an explicit small size is a texture
      const px = o.size.match(/[\d.]+px/g);
      if (px && px.length && px.every((v) => parseFloat(v) <= 96)) return false;
    }
    return w >= 64 && h >= 48 && w * h >= 8000;
  }

  /**
   * Filter engine: a large section painted dark by the page itself (a dark header, footer or band on a
   * light page) would turn light under the inverting filter. It is shown in its own colors instead.
   * @param {string} bg computed background-color @param {number} parentLum luminance behind it (0..1)
   * @param {number} w @param {number} h @param {number} viewportWidth
   */
  function isDarkSection(bg, parentLum, w, h, viewportWidth) {
    const c = C.parseColor(bg);
    if (!c || c.a < 0.95) return false;
    if (C.luminance(c) >= 0.05 || parentLum < 0.3) return false;
    return w >= viewportWidth * 0.3 && h >= 40 && w * h >= 30000;
  }

  NS.page = { effectiveBackground, usedScheme, canvasColor, looksDark, elementOverride, svgOverride, overrideKey, overrideRule, isPhotoBackground, isDarkSection, DARK_LUMINANCE, DARK_CANVAS };
})(globalThis);
