// Smart engine: rewrites the colors of the page's own stylesheets (lib/css-transform.js) into override
// sheets placed right after the originals, so images stay untouched and the cascade is preserved.
//
// What cannot be rewritten (cross-origin CSS, inline style="", bgcolor/color attributes, SVG fills) is
// handled by a computed-style fallback that tags elements with data-nd-c="<id>" and one shared rule per
// distinct color pair. The fallback runs in idle time, in chunks, with parent→child inheritance taken
// into account, so typical pages need only a handful of rules.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});
  const { dom, css: CSS, color: C, page: P, settings: S } = NS;

  const SHEET_SEL = 'style, link[rel~="stylesheet" i]';
  const LEGACY_SEL = '[style], [bgcolor], [color], [text], svg [fill], svg [stroke]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BR', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'SOURCE', 'HTML', 'BODY']);
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'bgcolor', 'color', 'text', 'fill', 'stroke', 'media', 'disabled'] };
  const LIMITS = { rules: 60000, elements: 60000, syncFallback: 300 };

  /** Color of the first visible border side, or '' when the element has no border. */
  function borderColor(cs) {
    if (cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px') return cs.borderTopColor;
    if (cs.borderBottomStyle !== 'none' && cs.borderBottomWidth !== '0px') return cs.borderBottomColor;
    if (cs.borderLeftStyle !== 'none' && cs.borderLeftWidth !== '0px') return cs.borderLeftColor;
    if (cs.borderRightStyle !== 'none' && cs.borderRightWidth !== '0px') return cs.borderRightColor;
    return '';
  }

  /** Page too heavy for the dynamic engine: the content script falls back to the filter engine. */
  class TooBig extends Error {}

  class DynamicEngine {
    constructor() {
      this.kind = 'dynamic';
      this.settings = null;
      /** @type {HTMLStyleElement | null} */
      this.base = null;
      /** @type {HTMLStyleElement | null} */
      this.fallback = null;
      /** @type {Map<Element, { el: HTMLStyleElement, sig: string }>} */
      this.overrides = new Map();
      this.ctx = CSS.createContext({ maxRules: LIMITS.rules });
      /** @type {Map<string, string>} override key → class id */
      this.classes = new Map();
      /** @type {Set<Element>} */
      this.unreadable = new Set();
      this.fullScan = false;
      /** @type {Element[]} roots whose subtree must be checked (full scan) */
      this.scanRoots = [];
      /** @type {Element[]} single elements to check */
      this.single = [];
      /** @type {TreeWalker | null} */
      this.walker = null;
      this.scheduled = false;
      this.observer = null;
      this.timer = 0;
      this.failed = null;
      /** @type {WeakMap<Element, { fg: string, light: boolean }>} text color seen per element */
      this.seen = new WeakMap();
      this.verify = [];
      this.stat = { sheets: 0, rules: 0, decls: 0, sheetMs: 0, mutations: 0, mutationMs: 0, elements: 0, tagged: 0, fallbackMs: 0, unreadable: 0 };
      /** @type {WeakSet<Element>} */
      this.listened = new WeakSet();
      /** @type {Map<Element, number>} style rules per sheet node */
      this.ruleCounts = new Map();
      this.onLinkLoad = (e) => this.safe(() => this.processSheetNode(/** @type {Element} */ (e.target)));
    }

    /** Errors in our code must never break the page: report and stop the engine. */
    safe(fn) {
      try {
        return fn();
      } catch (e) {
        this.fail(e);
      }
    }

    fail(e) {
      if (this.failed) return;
      this.failed = e instanceof TooBig || e instanceof CSS.TooBig ? 'too-big' : 'error';
      if (this.onFail) this.onFail(this.failed);
    }

    baseCss(s) {
      const bg = C.formatColor(C.darken({ r: 255, g: 255, b: 255, a: 1 }, 'bg'));
      const fg = C.formatColor(C.darken({ r: 0, g: 0, b: 0, a: 1 }, 'fg'));
      const chain = S.filterChain(s, false);
      return (
        `html{background-color:${bg};color:${fg}}` +
        `html[data-nd="dynamic"]{color-scheme:dark!important}` +
        (chain.length ? `html[data-nd="dynamic"]{filter:${S.filterCss(chain)}}` : '')
      );
    }

    /** @param {any} s Settings */
    start(s) {
      this.settings = s;
      const t = performance.now();
      this.base = dom.makeStyle('base', this.baseCss(s));
      dom.prepend(this.base);
      this.fallback = dom.makeStyle('fallback', '');
      dom.append(this.fallback);
      document.documentElement.setAttribute('data-nd', 'dynamic');
      this.observer = new MutationObserver((recs) => this.safe(() => this.onMutations(recs)));
      this.observer.observe(document, OBSERVE);
      this.safe(() => this.processAllSheets());
      this.startMs = performance.now() - t;
      if (this.failed) return;
      dom.onReady(() =>
        this.safe(() => {
          if (!this.base) return;
          this.processAllSheets();
          this.enqueueLegacy(document);
          this.fixRoots();
        }),
      );
      dom.onLoad(() => this.safe(() => {
        if (!this.base) return;
        this.processAllSheets();
        this.fixRoots();
      }));
      // CSS-in-JS libraries add rules with insertRule(), which fires no mutation: poll rule counts.
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') this.safe(() => this.tick());
      }, 1000);
    }

    /** @param {any} s Settings — only the user filter (brightness/contrast/sepia) depends on settings */
    update(s) {
      this.settings = s;
      if (this.base) this.base.textContent = this.baseCss(s);
    }

    /** Disable all our CSS while `fn` measures the page. */
    suspend(fn) {
      const els = [this.base, this.fallback, ...[...this.overrides.values()].map((o) => o.el)].filter(Boolean);
      const html = document.documentElement;
      const attr = html.getAttribute('data-nd');
      for (const el of els) el.disabled = true;
      html.setAttribute('data-nd', 'measuring');
      try {
        return fn();
      } finally {
        for (const el of els) el.disabled = false;
        if (attr) html.setAttribute('data-nd', attr);
      }
    }

    // ---- stylesheets

    processAllSheets() {
      for (const node of document.querySelectorAll(SHEET_SEL)) if (!dom.isOurs(node)) this.processSheetNode(node);
    }

    /** @param {Element} node a <style> or <link rel=stylesheet> */
    processSheetNode(node) {
      if (!this.base || dom.isOurs(node) || !node.isConnected) return;
      const link = node.tagName === 'LINK';
      if (link && !this.listened.has(node)) {
        this.listened.add(node);
        node.addEventListener('load', this.onLinkLoad);
      }
      const sheet = /** @type {HTMLStyleElement} */ (node).sheet;
      if (!sheet) return;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        if (!this.unreadable.has(node)) {
          this.unreadable.add(node);
          this.stat.unreadable++;
          this.startFullScan();
        }
        return;
      }
      const sig = rules.length + ':' + (link ? /** @type {HTMLLinkElement} */ (node).href : node.textContent.length);
      const prev = this.overrides.get(node);
      if (prev && prev.sig === sig) {
        if (!prev.el.isConnected && prev.el.textContent) node.after(prev.el);
        return;
      }
      const t = performance.now();
      const unreadableBefore = this.ctx.unreadable;
      this.ctx.rules = 0;
      const text = CSS.transformSheet(rules, this.ctx);
      if (this.ctx.unreadable && !unreadableBefore) this.startFullScan();
      this.ruleCounts.set(node, this.ctx.rules);
      let total = 0;
      for (const c of this.ruleCounts.values()) total += c;
      this.stat.rules = total;
      if (total > LIMITS.rules) throw new TooBig('too many rules');
      this.stat.decls = this.ctx.decls;
      let el = prev ? prev.el : null;
      if (!text) {
        if (el) el.remove();
        this.overrides.set(node, { el: el || dom.makeStyle('o', ''), sig });
        return;
      }
      if (!el) {
        el = dom.makeStyle('o', text);
        this.stat.sheets++;
      } else if (el.textContent !== text) el.textContent = text;
      const media = node.getAttribute('media');
      if (media) el.setAttribute('media', media);
      else el.removeAttribute('media');
      el.disabled = !!sheet.disabled;
      if (el.previousSibling !== node) node.after(el);
      this.overrides.set(node, { el, sig });
      this.stat.sheetMs += performance.now() - t;
    }

    removeSheetNode(node) {
      this.ruleCounts.delete(node);
      const o = this.overrides.get(node);
      if (o) {
        o.el.remove();
        this.overrides.delete(node);
      }
      this.unreadable.delete(node);
    }

    tick() {
      if (!this.base) return;
      if (!this.base.isConnected) dom.prepend(this.base);
      if (this.fallback && !this.fallback.isConnected) dom.append(this.fallback);
      for (const [node] of this.overrides) if (!node.isConnected) this.removeSheetNode(node);
      for (const sheet of document.styleSheets) {
        const node = /** @type {Element | null} */ (sheet.ownerNode);
        if (!node || dom.isOurs(node) || this.unreadable.has(node)) continue;
        let len;
        try {
          len = sheet.cssRules.length;
        } catch {
          continue;
        }
        const prev = this.overrides.get(node);
        if (!prev || !prev.sig.startsWith(len + ':')) this.processSheetNode(node);
      }
    }

    // ---- mutations

    /** @param {MutationRecord[]} recs */
    onMutations(recs) {
      if (!this.base) return;
      const t = performance.now();
      this.stat.mutations += recs.length;
      /** @type {Set<Element>} */
      const sheets = new Set();
      for (const r of recs) {
        const target = /** @type {Element} */ (r.target);
        if (r.type === 'childList') {
          const parent = target.nodeType === 1 ? target : null;
          if (parent && parent.tagName === 'STYLE' && !dom.isOurs(parent)) sheets.add(parent);
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1 || dom.isOurs(n)) continue;
            const el = /** @type {Element} */ (n);
            if (el.tagName === 'STYLE' || el.tagName === 'LINK') sheets.add(el);
            else if (el.firstElementChild) for (const s of el.querySelectorAll(SHEET_SEL)) sheets.add(s);
            if (this.fullScan) this.scanRoots.push(el);
            else this.enqueueLegacy(el);
          }
          for (const n of r.removedNodes) if (n.nodeType === 1 && this.overrides.has(/** @type {Element} */ (n))) this.removeSheetNode(n);
        } else if (r.type === 'characterData') {
          const p = target.parentElement;
          if (p && p.tagName === 'STYLE' && !dom.isOurs(p)) sheets.add(p);
        } else if (r.type === 'attributes') {
          if (dom.isOurs(target)) continue;
          const name = r.attributeName;
          if (name === 'media' || name === 'disabled') {
            if (target.tagName === 'STYLE' || target.tagName === 'LINK') sheets.add(target);
          } else if (name === 'class') {
            if (this.fullScan && !target.hasAttribute('data-nd-c')) this.single.push(target);
          } else this.single.push(target);
        }
      }
      for (const s of sheets) {
        const o = this.overrides.get(s);
        if (o) o.sig = '';
        this.processSheetNode(s);
      }
      this.stat.mutationMs += performance.now() - t;
      // Small batches (a component, a few inline styles) are fixed before the next paint; big ones in idle time.
      if (this.single.length && this.single.length <= LIMITS.syncFallback && !this.scanRoots.length && !this.walker) this.runFallback(() => 10);
      if (this.single.length || this.scanRoots.length) this.schedule();
    }

    // ---- computed-style fallback

    startFullScan() {
      if (this.fullScan) return;
      this.fullScan = true;
      // class changes matter now: they can switch an element to other (unreadable) rules
      if (this.observer) this.observer.observe(document, { ...OBSERVE, attributeFilter: [...OBSERVE.attributeFilter, 'class'] });
      dom.onReady(() => {
        if (!this.base) return;
        if (document.getElementsByTagName('*').length > LIMITS.elements) return this.fail(new TooBig('too many elements'));
        if (document.body) this.scanRoots.push(document.body);
        this.schedule();
      });
    }

    /** Queue elements that carry their own colors (inline style, legacy attributes). */
    enqueueLegacy(rootNode) {
      if (rootNode.nodeType === 1) {
        const el = /** @type {Element} */ (rootNode);
        if (el.matches(LEGACY_SEL)) this.single.push(el);
      }
      if (rootNode.querySelectorAll && (rootNode.nodeType === 9 || /** @type {Element} */ (rootNode).firstElementChild)) {
        for (const el of rootNode.querySelectorAll(LEGACY_SEL)) this.single.push(el);
      }
      if (this.single.length) this.schedule();
    }

    /** <html>/<body> backgrounds from unreadable CSS would flash white: fix them synchronously. */
    fixRoots() {
      const items = [document.documentElement, document.body].filter(Boolean);
      for (const el of items) {
        const cs = getComputedStyle(el);
        const o = P.elementOverride({ bg: cs.backgroundColor, fg: cs.color, image: cs.backgroundImage });
        if (o) this.tag(el, o);
      }
    }

    schedule() {
      if (this.scheduled || !this.base) return;
      this.scheduled = true;
      dom.idle((d) => {
        this.scheduled = false;
        this.safe(() => this.runFallback(() => d.timeRemaining()));
        if (this.single.length || this.scanRoots.length || this.walker || this.verify.length) this.schedule();
      });
    }

    /** Next element to check, or null. Single elements first, then the full-scan walker. */
    next() {
      if (this.single.length) return this.single.shift();
      for (;;) {
        if (!this.walker) {
          const r = this.scanRoots.shift();
          if (!r) return null;
          if (!r.isConnected) continue;
          this.walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
          return r;
        }
        const n = this.walker.nextNode();
        if (n) return /** @type {Element} */ (n);
        this.walker = null;
      }
    }

    /**
     * Read phase over a chunk (computed styles, no writes), then one write phase.
     * @param {() => number} timeLeft
     */
    runFallback(timeLeft) {
      if (!this.base) return;
      const t = performance.now();
      /** @type {Array<[Element, any]>} */
      const writes = [];
      // elements whose text color was left to inheritance in the previous chunk: check they really inherit
      const verify = this.verify;
      this.verify = [];
      for (const el of verify) {
        if (!el.isConnected) continue;
        const fg = C.parseColor(getComputedStyle(el).color);
        if (fg && !C.isLightFg(fg)) writes.push([el, { fg: C.formatColor(C.darken(fg, 'fg')) }]);
      }
      let n = 0;
      for (;;) {
        if ((++n & 15) === 0 && timeLeft() < 2) break;
        const el = this.next();
        if (!el) break;
        this.stat.elements++;
        if (!el.isConnected || SKIP_TAGS.has(el.tagName) || dom.isOurs(el)) continue;
        const cs = getComputedStyle(el);
        let o;
        if (el instanceof SVGElement) {
          if (el.tagName === 'svg') continue;
          o = P.svgOverride(cs.fill);
        } else {
          o = P.elementOverride({ bg: cs.backgroundColor, fg: cs.color, image: cs.backgroundImage, border: borderColor(cs) });
          const parent = el.parentElement;
          const ps = parent && this.seen.get(parent);
          // same color as the parent and the parent is (being) fixed → the fixed color is inherited
          if (o && o.fg && ps && ps.fg === cs.color && ps.light) {
            delete o.fg;
            this.verify.push(el);
            if (!o.bg && !o.image && !o.border) o = null;
          }
          this.seen.set(el, { fg: cs.color, light: !!(o && o.fg) || !!(ps && ps.fg === cs.color && ps.light) || C.isLightFg(C.parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 }) });
        }
        if (o) writes.push([el, o]);
      }
      for (const [el, o] of writes) this.tag(el, o);
      this.stat.fallbackMs += performance.now() - t;
    }

    /** @param {Element} el @param {import('../../lib/page-analysis.js').Override} o */
    tag(el, o) {
      const key = P.overrideKey(o);
      let id = this.classes.get(key);
      if (!id) {
        id = String(this.classes.size + 1);
        this.classes.set(key, id);
        try {
          const sheet = this.fallback && this.fallback.sheet;
          if (sheet) sheet.insertRule(P.overrideRule(id, o), sheet.cssRules.length);
        } catch {
          /* rule rejected: skip this element */
          return;
        }
      }
      if (el.getAttribute('data-nd-c') !== id) {
        el.setAttribute('data-nd-c', id);
        this.stat.tagged++;
      }
    }

    stats() {
      const r = (x) => Math.round(x * 10) / 10;
      return { ...this.stat, sheetMs: r(this.stat.sheetMs), mutationMs: r(this.stat.mutationMs), fallbackMs: r(this.stat.fallbackMs), startMs: r(this.startMs || 0), classes: this.classes.size, fullScan: this.fullScan };
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      clearInterval(this.timer);
      for (const { el } of this.overrides.values()) el.remove();
      for (const node of this.overrides.keys()) if (node.tagName === 'LINK') node.removeEventListener('load', this.onLinkLoad);
      this.overrides.clear();
      this.ruleCounts.clear();
      if (this.base) this.base.remove();
      if (this.fallback) this.fallback.remove();
      this.base = this.fallback = null;
      this.single.length = this.scanRoots.length = this.verify.length = 0;
      this.walker = null;
      for (const el of document.querySelectorAll('[data-nd-c]')) el.removeAttribute('data-nd-c');
    }
  }

  NS.DynamicEngine = DynamicEngine;
  NS.DynamicEngine.TooBig = TooBig;
})(globalThis);
