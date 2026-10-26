// In-page measurements for e2e/sites.mjs. `analyze` is serialized by Playwright and runs in the page
// (or a frame), so it must be self-contained: no imports, no closures over module scope.
//
// It returns plain data; all decisions (thresholds, comparisons between runs) are made in sites.mjs.

/**
 * @param {{ maxText?: number }} [opts]
 */
export function analyze(opts = {}) {
  const MAX_TEXT = opts.maxText || 400;
  const W = innerWidth, H = innerHeight;

  // ---- colors: let the browser parse any CSS color syntax by painting it on a 1×1 canvas
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  /** @returns {number[]} [r, g, b, a] */
  function rgba(str) {
    if (!str || str === 'none') return [0, 0, 0, 0];
    let v = cache.get(str);
    if (v) return v;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = 'rgba(0, 0, 0, 0)';
    cx.fillStyle = str;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    v = [d[0], d[1], d[2], d[3] / 255];
    cache.set(str, v);
    return v;
  }
  const over = (top, bottom) => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  function hsl(c) {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  // ---- the root filter of the fast engine, applied in JS to predict what is painted
  const rootFilter = getComputedStyle(document.documentElement).filter;
  const chain = [];
  if (rootFilter && rootFilter !== 'none') {
    for (const m of rootFilter.matchAll(/([a-z-]+)\(([^)]*)\)/g)) chain.push([m[1], parseFloat(m[2]) * (m[2].endsWith('%') ? 0.01 : 1)]);
  }
  const mul = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  function filtered(c) {
    if (!chain.length) return c;
    let v = [c[0] / 255, c[1] / 255, c[2] / 255];
    for (const [fn, amount] of chain) {
      if (fn === 'invert') v = v.map((x) => amount * (1 - x) + (1 - amount) * x);
      else if (fn === 'brightness') v = v.map((x) => x * amount);
      else if (fn === 'contrast') v = v.map((x) => (x - 0.5) * amount + 0.5);
      else if (fn === 'hue-rotate') {
        const r = (amount * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
        v = mul([0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
          0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
          0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072], v);
      }
      v = v.map((x) => Math.min(1, Math.max(0, x)));
    }
    return [v[0] * 255, v[1] * 255, v[2] * 255, c[3]];
  }
  /** Is the element shown in original colors by a filter of its own (or an ancestor's) under the root filter? */
  const reinvertCache = new Map();
  function reinverted(el) {
    if (!chain.length) return false;
    const path = [];
    let r = false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null)) {
      if (reinvertCache.has(e)) {
        r = reinvertCache.get(e);
        break;
      }
      path.push(e);
      if (getComputedStyle(e).filter.includes('invert')) {
        r = true;
        break;
      }
    }
    for (const e of path) reinvertCache.set(e, r);
    return r;
  }
  const paint = (el, c) => (reinverted(el) ? c : filtered(c));

  // ---- element helpers
  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'image', 'PICTURE']);
  const ours = (el) => el.hasAttribute && el.hasAttribute('data-nd-s');
  const parentOf = (el) => el.parentElement || (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
  function skipped(el) {
    for (let e = el; e; e = parentOf(e)) if (e.hasAttribute && e.hasAttribute('data-nd-skip')) return true;
    return false;
  }
  function keyOf(el) {
    const parts = [];
    for (let e = el; e; ) {
      const p = e.parentElement;
      if (!p) {
        const r = e.getRootNode();
        if (r instanceof ShadowRoot) {
          parts.push(e.tagName + '#' + [...r.children].filter((x) => x.tagName === e.tagName && !ours(x)).indexOf(e) + '>>');
          e = r.host;
          continue;
        }
        parts.push(e.tagName);
        break;
      }
      parts.push(e.tagName + ':' + [...p.children].filter((x) => x.tagName === e.tagName && !ours(x)).indexOf(e));
      e = p;
    }
    return parts.reverse().join('/');
  }
  const htmlCs = getComputedStyle(document.documentElement);
  const bodyCs = document.body ? getComputedStyle(document.body) : null;
  // what the canvas is painted with: <html> background, else <body> background, else the Canvas
  // system color of the root's used color scheme (CSS color-scheme, else <meta name=color-scheme>)
  let canvasColor = rgba(htmlCs.backgroundColor);
  if (canvasColor[3] === 0 && bodyCs) canvasColor = rgba(bodyCs.backgroundColor);
  const meta = document.querySelector('meta[name="color-scheme"]');
  const schemes = (htmlCs.colorScheme && htmlCs.colorScheme !== 'normal' ? htmlCs.colorScheme : (meta && meta.content) || '').split(/[\s,]+/);
  const darkScheme = schemes.includes('dark') && (!schemes.includes('light') || matchMedia('(prefers-color-scheme: dark)').matches);
  const systemCanvas = darkScheme ? [18, 18, 18, 1] : [255, 255, 255, 1];
  canvasColor = canvasColor[3] === 0 ? systemCanvas : canvasColor[3] < 1 ? over(canvasColor, systemCanvas) : canvasColor;
  const paintedCanvas = filtered(canvasColor);

  const urlBg = (cs) => cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url(');
  function gradientAverage(img) {
    const colors = [...img.matchAll(/(?:rgba?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi)].map((m) => rgba(m[0]));
    if (!colors.length) return null;
    const s = [0, 0, 0, 0];
    for (const c of colors) for (let i = 0; i < 4; i++) s[i] += c[i] / colors.length;
    return s;
  }

  /**
   * What is painted under the point, from `start` down: composited background layers.
   * @returns {{ color: number[] | null, image: boolean }}
   */
  function backdrop(x, y, start, rootNode) {
    const els = (rootNode && rootNode.elementsFromPoint ? rootNode : document).elementsFromPoint(x, y);
    let i = start ? els.indexOf(start) : 0;
    if (i < 0) i = 0;
    const layers = [];
    let image = false;
    for (let j = i; j < els.length; j++) {
      const el = els[j];
      if (MEDIA.has(el.tagName)) {
        image = true;
        break;
      }
      const cs = getComputedStyle(el);
      if (el instanceof SVGElement && el.tagName !== 'svg') {
        if (el.tagName === 'text' || el.tagName === 'tspan') continue;
        const f = rgba(cs.fill);
        if (f[3] > 0) {
          layers.push(paint(el, [...f.slice(0, 3), f[3] * parseFloat(cs.fillOpacity || '1')]));
          if (layers.at(-1)[3] >= 1) break;
        }
        continue;
      }
      if (el === document.documentElement) break;
      if (el === document.body && rgba(htmlCs.backgroundColor)[3] === 0) break; // propagated to the canvas
      if (urlBg(cs)) {
        image = true;
        break;
      }
      if (cs.backgroundImage !== 'none') {
        const g = gradientAverage(cs.backgroundImage);
        if (g && g[3] > 0) layers.push(paint(el, g));
      }
      const bg = rgba(cs.backgroundColor);
      if (bg[3] > 0) {
        layers.push(paint(el, bg));
        if (bg[3] >= 1) break;
      }
    }
    if (image) return { color: null, image: true };
    let c = paintedCanvas;
    for (let k = layers.length - 1; k >= 0; k--) c = over(layers[k], c);
    return { color: c, image: false };
  }

  // ---- walk the document and open shadow roots
  const elements = [];
  const textEls = new Map();
  (function walk(root) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) {
        if (!n.data.trim()) continue;
        const p = n.parentElement;
        if (p && !textEls.has(p)) textEls.set(p, n);
        continue;
      }
      const el = /** @type {Element} */ (n);
      if (ours(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') continue;
      elements.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  })(document);

  const visibleRect = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  const texts = [];
  for (const el of [...textEls.keys(), ...elements.filter((e) => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.tagName))]) {
    if (texts.length >= MAX_TEXT) break;
    if (el.closest('select, option, noscript, title') && el.tagName !== 'SELECT') continue;
    if (skipped(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    if (el.tagName === 'INPUT' && /^(checkbox|radio|range|color|hidden|image|file)$/.test(el.type)) continue;
    let rect;
    const node = textEls.get(el);
    if (node && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rect = [...range.getClientRects()].find(visibleRect);
    } else rect = el.getBoundingClientRect();
    if (!rect || !visibleRect(rect)) continue;
    let opacity = 1;
    for (let e = el; e; e = parentOf(e)) opacity *= parseFloat(getComputedStyle(e).opacity);
    if (opacity < 0.4) continue;
    const isSvg = el instanceof SVGElement;
    const fg0 = rgba(isSvg ? cs.fill : cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
    if (fg0[3] < 0.1) continue;
    const x = Math.min(W - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 6)));
    const y = Math.min(H - 1, Math.max(0, rect.top + rect.height / 2));
    const b = backdrop(x, y, el, el.getRootNode());
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.6 && parseInt(cs.fontWeight, 10) >= 700);
    const out = { key: keyOf(el), text: (node ? node.data : el.value || el.tagName).trim().slice(0, 40), large, onImage: b.image || el.closest('[data-nd-onimage]') != null };
    if (b.color) {
      const fg = over(paint(el, fg0), b.color);
      out.ratio = Math.round(ratio(fg, b.color) * 100) / 100;
      out.fg = fg.map(Math.round);
      out.bg = b.color.map(Math.round);
    }
    texts.push(out);
  }

  // ---- icons drawn with color (mask icons use background-color, SVG icons use fill / currentColor)
  const icons = [];
  for (const el of elements.filter((e) => e.hasAttribute('data-nd-icon'))) {
    const r = el.getBoundingClientRect();
    if (!visibleRect(r)) continue;
    const cs = getComputedStyle(el);
    const mask = cs.webkitMaskImage && cs.webkitMaskImage !== 'none';
    const own = rgba(el instanceof SVGElement ? (el.querySelector('path') ? getComputedStyle(el.querySelector('path')).fill : cs.fill) : mask ? cs.backgroundColor : cs.color);
    const b = backdrop(r.left + r.width / 2, r.top + r.height / 2, el.parentElement || el, el.getRootNode());
    if (b.color) icons.push({ key: keyOf(el), ratio: Math.round(ratio(over(paint(el, own), b.color), b.color) * 100) / 100 });
  }

  // ---- brand colors whose hue must survive
  const hues = [];
  for (const el of elements.filter((e) => e.hasAttribute('data-nd-hue'))) {
    const cs = getComputedStyle(el);
    let c;
    if (el instanceof SVGElement) {
      const p = el.querySelector('path, circle, rect');
      c = rgba(p ? getComputedStyle(p).fill : cs.fill);
    } else {
      c = rgba(cs.backgroundColor);
      if (c[3] === 0) c = rgba(cs.color);
    }
    hues.push({ key: keyOf(el), hsl: hsl(paint(el, c)).map((v, i) => (i ? Math.round(v * 100) / 100 : Math.round(v))) });
  }

  // ---- points of the page background (not media, not glyphs) for a pixel check
  const grid = [];
  for (let gy = 0; gy < 10; gy++) {
    for (let gx = 0; gx < 12; gx++) {
      const x = Math.round((gx + 0.5) * (W / 12)), y = Math.round((gy + 0.5) * (H / 10));
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      // media if an image / photo is what shows through before any opaque background
      let media = false;
      for (const e of document.elementsFromPoint(x, y)) {
        if (e.hasAttribute('data-nd-light-ok') || e.hasAttribute('data-nd-skip')) {
          media = true;
          break;
        }
        if (MEDIA.has(e.tagName)) {
          media = true;
          break;
        }
        const cs = getComputedStyle(e);
        if (urlBg(cs)) {
          media = true;
          break;
        }
        if (rgba(cs.backgroundColor)[3] >= 1) break;
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.tagName === 'SELECT') continue;
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue; // might be a glyph pixel
      if (el instanceof SVGElement) continue;
      grid.push({ x, y, media, key: keyOf(el) });
    }
  }

  // ---- media: points that hit the media element itself
  const media = [];
  for (const el of elements) {
    if (media.length >= 40) break;
    const isMedia = (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS') && !skipped(el);
    const isBg = !isMedia && urlBg(getComputedStyle(el)) && !skipped(el) && !el.hasAttribute('data-nd-texture');
    if (!isMedia && !isBg) continue;
    const r = el.getBoundingClientRect();
    if (!visibleRect(r) || r.width < 24 || r.height < 24) continue;
    const pts = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.3, 0.7], [0.7, 0.75]]) {
      const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (document.elementFromPoint(x, y) === el) pts.push([x, y]);
    }
    if (pts.length) media.push({ key: keyOf(el), kind: isBg ? 'background' : el.tagName.toLowerCase(), points: pts });
  }

  // ---- layout and color snapshot (for "layout unchanged" and "turning off restores the page")
  const rects = {};
  const styles = {};
  const PROPS = ['color', 'background-color', 'background-image', 'border-top-color', 'border-left-color', 'outline-color', 'box-shadow', 'text-shadow', 'fill', 'stroke', 'filter', 'color-scheme', 'caret-color', 'text-decoration-color'];
  let count = 0;
  for (const el of elements) {
    if (count++ > 3000) break;
    if (el.closest('[data-nd-live]')) continue;
    const k = keyOf(el);
    const r = el.getBoundingClientRect();
    rects[k] = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',');
    const cs = getComputedStyle(el);
    styles[k] = PROPS.map((p) => cs.getPropertyValue(p)).join('|');
  }
  for (const pseudo of ['::before', '::after']) {
    for (const el of elements.slice(0, 1500)) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content && cs.content !== 'none' && !el.closest('[data-nd-live]')) styles[keyOf(el) + pseudo] = PROPS.map((p) => cs.getPropertyValue(p)).join('|');
    }
  }
  // repeating background textures behind content: the fast engine must invert them with the page
  const textures = elements.filter((e) => e.hasAttribute('data-nd-texture')).map((e) => ({ key: keyOf(e), filter: getComputedStyle(e).filter }));
  return {
    nd: document.documentElement.getAttribute('data-nd'),
    textures,
    canvas: paintedCanvas.map(Math.round),
    texts,
    icons,
    hues,
    grid,
    media,
    rects,
    styles,
    leftovers: document.querySelectorAll('[data-nd-s], [data-nd-c], [data-nd-img]').length,
  };
}
