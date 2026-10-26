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

  /**
   * Canvas color as the browser paints it: <html> background, else <body> background, else white.
   * @param {string} htmlBg @param {string} bodyBg
   */
  function canvasColor(htmlBg, bodyBg) {
    const h = C.parseColor(htmlBg);
    if (h && h.a > 0) return C.blend(h, WHITE);
    const b = C.parseColor(bodyBg);
    if (b && b.a > 0) return C.blend(b, WHITE);
    return WHITE;
  }

  /** Relative luminance below which a background counts as dark (≈ #5a5a5a). */
  const DARK_LUMINANCE = 0.1;

  /**
   * Is the page already dark? Looks at the canvas and at what is visible in the middle of the
   * viewport (app shells often paint their dark background on a wrapper, not on <body>).
   * @param {{ htmlBg: string, bodyBg: string, center: string[] | null, text?: string }} m
   */
  function looksDark(m) {
    const canvas = canvasColor(m.htmlBg, m.bodyBg);
    const bg = m.center && m.center.length ? effectiveBackground(m.center, C.formatColor(canvas)) : canvas;
    if (C.luminance(bg) >= DARK_LUMINANCE) return false;
    const fg = m.text ? C.parseColor(m.text) : null;
    // dark background with dark text is a light theme that has not painted yet — don't trust it
    return !fg || fg.a === 0 || C.contrastRatio(C.blend(fg, bg), bg) >= 3 || C.luminance(fg) > 0.2;
  }

  /**
   * @typedef {{ bg?: string, fg?: string, image?: string }} Override
   */

  /**
   * Fallback of the dynamic engine for an element styled by something the stylesheet pass could not
   * rewrite (cross-origin CSS, inline style, legacy bgcolor/color attributes). Returns null when the
   * element already fits the dark theme — transformed colors are never transformed again.
   * @param {{ bg: string, fg: string, image?: string }} cs computed values
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
    return o.bg || o.fg || o.image ? o : null;
  }

  /** Stable cache key of an override. @param {Override} o */
  function overrideKey(o) {
    return (o.bg || '') + '|' + (o.fg || '') + '|' + (o.image || '');
  }

  /**
   * CSS rule for an override class. !important: these elements are styled by rules we cannot rewrite.
   * @param {string} id @param {Override} o
   */
  function overrideRule(id, o) {
    let body = '';
    if (o.bg) body += `background-color:${o.bg}!important;`;
    if (o.image) body += `background-image:${o.image}!important;`;
    if (o.fg) body += `color:${o.fg}!important;fill:${o.fg};`;
    return `[data-nd-c="${id}"]{${body}}`;
  }

  /**
   * Filter engine: should an element with a CSS background image be shown in original colors?
   * Large boxes are photos / banners; small ones are usually icons and sprites, which look right inverted.
   * @param {string} image computed background-image
   * @param {number} w @param {number} h rendered size in CSS px
   */
  function isPhotoBackground(image, w, h) {
    if (!image || image === 'none' || image.indexOf('url(') < 0) return false;
    if (/url\(["']?data:image\/svg|\.svg(?:[?#"')]|$)/i.test(image)) return false;
    return w >= 64 && h >= 48 && w * h >= 8000;
  }

  NS.page = { effectiveBackground, canvasColor, looksDark, elementOverride, overrideKey, overrideRule, isPhotoBackground, DARK_LUMINANCE };
})(globalThis);
