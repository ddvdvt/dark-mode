// Smart engine: rewrites the colors of the page's own stylesheets (lib/css-transform.js) into override
// sheets placed right after the originals, so images stay untouched and the cascade is preserved.
// Shadow DOM is covered too: <style> inside shadow roots gets an override next to it, and every
// adopted stylesheet (document.adoptedStyleSheets, shadowRoot.adoptedStyleSheets) gets an adopted
// override right after it.
//
// What cannot be rewritten (cross-origin CSS, inline style="", bgcolor/color attributes, SVG fills) is
// handled by a computed-style fallback that tags elements with data-nd-c="<id>" and one shared rule per
// distinct color pair. The fallback runs in idle time, in chunks, with parent→child inheritance taken
// into account, so typical pages need only a handful of rules.
//
// Everything the engine adds is screen-only: printing uses the page's own colors.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});
  const { dom, css: CSS, color: C, page: P, settings: S } = NS;

  const SHEET_SEL = 'style, link[rel~="stylesheet" i]';
  const LEGACY_SEL = '[style], [bgcolor], [color], [text], svg [fill], svg [stroke]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BR', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'SOURCE', 'HTML', 'BODY']);
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'bgcolor', 'color', 'text', 'fill', 'stroke', 'media', 'disabled', 'rel'] };
  // restores: how often an override removed or displaced by the page is put back before it is parked
  const LIMITS = { rules: 60000, elements: 60000, syncFallback: 300, restores: 10, pendingHosts: 2000 };
  // Overrides are screen-only: media="screen" on the element, or (when the source sheet has its own
  // media list, which the override must keep) @media screen around the text.
  const WRAP = { screen: true };
  const PLAIN = { screen: false };
  /** Inline declarations that an inline !important would keep from our rules. */
  const INLINE = /** @type {Array<[string, 'bg' | 'fg' | 'image']>} */ ([['background-color', 'bg'], ['color', 'fg'], ['background-image', 'image']]);

  /** Color of the first visible border side, or '' when the element has no border. */
  function borderColor(cs) {
    if (cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px') return cs.borderTopColor;
    if (cs.borderBottomStyle !== 'none' && cs.borderBottomWidth !== '0px') return cs.borderBottomColor;
    if (cs.borderLeftStyle !== 'none' && cs.borderLeftWidth !== '0px') return cs.borderLeftColor;
    if (cs.borderRightStyle !== 'none' && cs.borderRightWidth !== '0px') return cs.borderRightColor;
    return '';
  }

  // Closed shadow roots are reachable for content scripts (no permission needed): Chrome has
  // chrome.dom.openOrClosedShadowRoot(el), Firefox the content-script-only property el.openOrClosedShadowRoot.
  const domApi = typeof chrome !== 'undefined' && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function' ? chrome.dom : null;
  const ffShadow = !domApi && typeof Element !== 'undefined' && 'openOrClosedShadowRoot' in Element.prototype;
  /** @param {Element} el @returns {ShadowRoot | null} */
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if ((!domApi && !ffShadow) || el.localName.indexOf('-') < 0) return null;
    try {
      const sr = domApi ? domApi.openOrClosedShadowRoot(/** @type {HTMLElement} */ (el)) : /** @type {any} */ (el).openOrClosedShadowRoot;
      return /** @type {ShadowRoot | null} */ (sr || null);
    } catch {
      return null;
    }
  }

  /**
   * Override for a ::before / ::after pseudo-element, or null. Its text color is left alone when it
   * is only inherited from the element (the element's override is inherited then).
   */
  function pseudoOverride(el, which, elColor) {
    const ps = getComputedStyle(el, which);
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal') return null;
    const o = P.elementOverride({ bg: ps.backgroundColor, fg: ps.color, image: ps.backgroundImage, border: borderColor(ps) });
    if (o && o.fg && ps.color === elColor) {
      delete o.fg;
      if (!o.bg && !o.image && !o.border) return null;
    }
    return o;
  }

  /** Legacy color attribute value ("#006699", "006699", "red") → color, or null. */
  function legacyColor(v) {
    if (!v) return null;
    const s = v.trim();
    return C.parseColor(/^[0-9a-f]{6}$/i.test(s) ? '#' + s : s);
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
      /** Fallback rules for shadow trees (document rules do not reach inside them). */
      /** @type {CSSStyleSheet | null} */
      this.shadowFallback = null;
      /** @type {Map<Element, { el: HTMLStyleElement, sig: string, plan: any[] | null, vars: boolean, version: number, restores: number, wrap: boolean }>} */
      this.overrides = new Map();
      /** adopted stylesheet → its adopted override */
      /** @type {Map<CSSStyleSheet, { sheet: CSSStyleSheet, sig: number, plan: any[], vars: boolean, version: number, text: string, wrap: boolean }>} */
      this.adopted = new Map();
      /** @type {WeakSet<CSSStyleSheet>} */
      this.ownSheets = new WeakSet();
      /** @type {Set<ShadowRoot>} */
      this.roots = new Set();
      /** custom elements without a shadow root yet (upgraded later) */
      /** @type {Map<Element, number>} host → ticks left */
      this.pendingHosts = new Map();
      this.ctx = CSS.createContext({ maxRules: LIMITS.rules, cacheRules: false });
      this.emitted = 0; // ctx.version the overrides were emitted with
      /** @type {Map<string, string>} override key → class id */
      this.classes = new Map();
      /** @type {Set<Element>} */
      this.unreadable = new Set();
      this.fullScan = false;
      /** @type {Array<Element | ShadowRoot>} roots whose subtree must be checked (full scan) */
      this.scanRoots = [];
      /** @type {Element[]} single elements to check */
      this.single = [];
      /** @type {Set<Element>} elements whose own attributes changed (their old override may be stale) */
      this.dirty = new Set();
      /** @type {TreeWalker | null} */
      this.walker = null;
      this.scheduled = false;
      this.observer = null;
      this.timer = 0;
      this.failed = null;
      /** @type {WeakMap<Element, { fg: string, light: boolean }>} text color seen per element */
      this.seen = new WeakMap();
      this.verify = [];
      /** inline !important declarations we replaced: element → [prop, original value, our value][] */
      /** @type {Map<HTMLElement, Array<[string, string, string]>>} */
      this.inline = new Map();
      this.links = '';
      this.stat = { sheets: 0, rules: 0, decls: 0, sheetMs: 0, mutations: 0, mutationMs: 0, elements: 0, tagged: 0, fallbackMs: 0, unreadable: 0, shadowRoots: 0, adopted: 0, restored: 0 };
      /** @type {WeakSet<Element>} */
      this.listened = new WeakSet();
      /** @type {Map<object, number>} style rules per sheet node / adopted sheet */
      this.ruleCounts = new Map();
      this.onLinkLoad = (e) =>
        this.safe(() => {
          this.processSheetNode(/** @type {Element} */ (e.target));
          this.refreshVars();
        });
      this.html = null;
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
        (chain.length ? `html[data-nd="dynamic"]{filter:${S.filterCss(chain)}}` : '') +
        this.links
      );
    }

    /** @param {any} s Settings */
    start(s) {
      this.settings = s;
      const t = performance.now();
      this.html = document.documentElement;
      this.base = dom.makeStyle('base', this.baseCss(s));
      this.base.media = 'screen';
      dom.prepend(this.base);
      this.fallback = dom.makeStyle('fallback', '');
      this.fallback.media = 'screen';
      dom.append(this.fallback);
      try {
        this.shadowFallback = new CSSStyleSheet({ media: 'screen' });
        this.ownSheets.add(this.shadowFallback);
      } catch {
        this.shadowFallback = null;
      }
      this.html.setAttribute('data-nd', 'dynamic');
      this.observer = new MutationObserver((recs) => this.safe(() => this.onMutations(recs)));
      this.observer.observe(document, OBSERVE);
      this.safe(() => this.processAllSheets());
      this.startMs = performance.now() - t;
      if (this.failed) return;
      dom.onReady(() => this.safe(() => this.onReady()));
      dom.onLoad(() =>
        this.safe(() => {
          if (!this.base) return;
          this.processAllSheets();
          this.fixRoots();
          this.scanShadows(document);
        }),
      );
      // CSS-in-JS libraries add rules with insertRule(), which fires no mutation: they are checked on
      // every DOM change (rules are inserted right before the components render), and polled here.
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') this.safe(() => this.tick());
      }, 1000);
    }

    onReady() {
      if (!this.base) return;
      this.processAllSheets();
      this.enqueueLegacy(document);
      this.fixRoots();
      this.scanShadows(document);
      this.linkColors();
    }

    /** <body link vlink alink>: legacy link colors are presentational hints below every author rule. */
    linkColors() {
      const body = document.body;
      let css = '';
      if (body) {
        for (const [attr, sel] of [['link', ':link'], ['vlink', ':visited'], ['alink', ':active']]) {
          const c = legacyColor(body.getAttribute(attr));
          if (c && !C.isLightFg(c)) css += `:where(body[${attr}] ${sel}){color:${C.formatColor(C.darken(c, 'fg'))}}`;
        }
      }
      if (css !== this.links) {
        this.links = css;
        if (this.base) this.base.textContent = this.baseCss(this.settings);
      }
    }

    /** @param {any} s Settings — only the user filter (brightness/contrast/sepia) depends on settings */
    update(s) {
      this.settings = s;
      if (this.base) this.base.textContent = this.baseCss(s);
    }

    /** Every stylesheet object of ours (for suspend). */
    ownStyles() {
      return [this.base, this.fallback, ...[...this.overrides.values()].map((o) => o.el)].filter(Boolean);
    }

    /** Disable all our CSS while `fn` measures the page. */
    suspend(fn) {
      const els = this.ownStyles();
      const sheets = [this.shadowFallback, ...[...this.adopted.values()].map((a) => a.sheet)].filter(Boolean);
      const html = document.documentElement;
      const attr = html.getAttribute('data-nd');
      for (const el of els) el.disabled = true;
      for (const sh of sheets) sh.disabled = true;
      html.setAttribute('data-nd', 'measuring');
      try {
        return fn();
      } finally {
        for (const el of els) el.disabled = false;
        for (const sh of sheets) sh.disabled = false;
        if (attr) html.setAttribute('data-nd', attr);
        else html.removeAttribute('data-nd');
      }
    }

    // ---- stylesheets

    processAllSheets() {
      for (const node of document.querySelectorAll(SHEET_SEL)) if (!dom.isOurs(node)) this.processSheetNode(node);
      for (const r of this.roots) for (const node of r.querySelectorAll(SHEET_SEL)) if (!dom.isOurs(node)) this.processSheetNode(node);
      this.syncAdopted(document);
      for (const r of this.roots) this.syncAdopted(r);
      this.refreshVars();
    }

    /** Keep the rule total under the limit of the smart engine. */
    countRules(key, n) {
      this.ruleCounts.set(key, n);
      let total = 0;
      for (const c of this.ruleCounts.values()) total += c;
      this.stat.rules = total;
      if (total > LIMITS.rules) throw new TooBig('too many rules');
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
        if (prev.el.textContent && (!prev.el.isConnected || prev.el.previousSibling !== node)) this.place(node, prev);
        return;
      }
      const t = performance.now();
      const unreadableBefore = this.ctx.unreadable;
      this.ctx.rules = 0;
      // first read: plain; a sheet read again (it grows: CSS-in-JS) keeps per-rule plans for the next time
      const plan = CSS.readSheet(rules, this.ctx, { cache: !!prev });
      const media = node.getAttribute('media');
      const text = CSS.emitSheet(plan, this.ctx, media ? WRAP : PLAIN);
      if (this.ctx.unreadable && !unreadableBefore) this.startFullScan();
      this.countRules(node, this.ctx.rules);
      this.stat.decls = this.ctx.decls;
      const entry = prev || { el: dom.makeStyle('o', ''), sig, plan, vars: false, version: 0, restores: 0, wrap: false };
      entry.wrap = !!media;
      entry.sig = sig;
      entry.plan = plan;
      entry.vars = CSS.planUsesVars(plan);
      entry.version = this.ctx.version;
      this.overrides.set(node, entry);
      const el = entry.el;
      if (!text) {
        el.remove();
        el.textContent = '';
        return;
      }
      if (!prev) this.stat.sheets++;
      if (el.textContent !== text) el.textContent = text;
      el.setAttribute('media', media || 'screen');
      el.disabled = !!sheet.disabled;
      if (el.previousSibling !== node) node.after(el);
      this.stat.sheetMs += performance.now() - t;
    }

    /** Put an override back right after its source (pages that rebuild <head>), with a budget. */
    place(node, o) {
      if (o.restores < LIMITS.restores) {
        o.restores++;
        this.stat.restored++;
        node.after(o.el);
      } else if (o.el.parentNode !== document.documentElement) {
        // the page keeps removing it: park it at the end of <html>, out of the page's way
        document.documentElement.insertBefore(o.el, this.fallback && this.fallback.parentNode === document.documentElement ? this.fallback : null);
      }
    }

    /** Restore our nodes the page removed or displaced. */
    repair() {
      if (!this.base) return;
      if (document.documentElement !== this.html) return this.reattach();
      if (!this.base.isConnected) dom.prepend(this.base);
      if (this.fallback && !this.fallback.isConnected) dom.append(this.fallback);
      for (const [node, o] of this.overrides) {
        if (!o.el.textContent || !node.isConnected) continue;
        if (o.el.isConnected && (o.el.previousSibling === node || o.restores >= LIMITS.restores)) continue;
        this.place(node, o);
      }
    }

    /** document.open() replaced the whole document (about:blank frames written by a script). */
    reattach() {
      this.html = document.documentElement;
      if (!this.html) return;
      this.html.setAttribute('data-nd', 'dynamic');
      dom.prepend(this.base);
      dom.append(this.fallback);
      this.processAllSheets();
      dom.onReady(() => this.safe(() => this.onReady()));
    }

    /** Re-emit overrides that depend on custom properties when more is known about them. */
    refreshVars() {
      const v = this.ctx.version;
      if (v === this.emitted) return;
      this.emitted = v;
      for (const [node, o] of this.overrides) {
        if (!o.vars || o.version === v || !o.plan) continue;
        o.version = v;
        const text = CSS.emitSheet(o.plan, this.ctx, o.wrap ? WRAP : PLAIN);
        if (text === o.el.textContent) continue;
        o.el.textContent = text;
        if (text && !o.el.isConnected && node.isConnected) node.after(o.el);
        else if (!text) o.el.remove();
      }
      for (const a of this.adopted.values()) {
        if (!a.vars || a.version === v) continue;
        a.version = v;
        const text = CSS.emitSheet(a.plan, this.ctx, a.wrap ? WRAP : PLAIN);
        if (text !== a.text) {
          a.text = text;
          a.sheet.replaceSync(text);
        }
      }
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

    /** Sheets whose rule count changed without a DOM mutation (insertRule / deleteRule / replaceSync). */
    checkSheets() {
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

    tick() {
      if (!this.base) return;
      this.repair();
      for (const [node] of this.overrides) if (!node.isConnected) this.removeSheetNode(node);
      this.checkSheets();
      for (const r of this.roots) {
        if (!r.host.isConnected) {
          this.roots.delete(r);
          continue;
        }
        for (const node of r.querySelectorAll(SHEET_SEL)) if (!dom.isOurs(node)) this.processSheetNode(node);
        this.syncAdopted(r);
      }
      this.syncAdopted(document);
      for (const [el, left] of this.pendingHosts) {
        const sr = el.isConnected ? shadowOf(el) : null;
        if (sr || left <= 1 || !el.isConnected) this.pendingHosts.delete(el);
        else this.pendingHosts.set(el, left - 1);
        if (sr && !this.roots.has(sr)) this.addRoot(sr);
      }
      this.refreshVars();
    }

    // ---- shadow DOM and adopted stylesheets

    /** Find shadow roots in a subtree (document, element or shadow root). */
    scanShadows(rootNode) {
      if (!this.base) return;
      const start = rootNode.nodeType === 1 ? /** @type {Element} */ (rootNode) : null;
      if (start) this.checkHost(start);
      if (!start && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
      if (start && !start.firstElementChild) return;
      const tw = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) this.checkHost(/** @type {Element} */ (n));
    }

    /** @param {Element} el */
    checkHost(el) {
      const sr = shadowOf(el);
      if (sr) {
        if (!this.roots.has(sr)) this.addRoot(sr);
      } else if (el.localName.indexOf('-') > 0 && this.pendingHosts.size < LIMITS.pendingHosts && !this.pendingHosts.has(el)) {
        // a custom element may attach its shadow root later (lazy definitions): look again for a few seconds
        // (customElements is not available in the isolated world of a content script)
        this.pendingHosts.set(el, 5);
      }
    }

    /** @param {ShadowRoot} sr */
    addRoot(sr) {
      this.roots.add(sr);
      this.stat.shadowRoots++;
      if (this.observer) this.observer.observe(sr, this.fullScan ? { ...OBSERVE, attributeFilter: [...OBSERVE.attributeFilter, 'class'] } : OBSERVE);
      for (const node of sr.querySelectorAll(SHEET_SEL)) if (!dom.isOurs(node)) this.processSheetNode(node);
      this.syncAdopted(sr);
      this.enqueueLegacy(sr);
      if (this.fullScan) this.scanRoots.push(sr);
      this.scanShadows(sr);
      this.refreshVars();
    }

    /** Adopted override for one adopted stylesheet (shared by every root that adopts the sheet). */
    adoptedOverride(sheet) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        return null;
      }
      let a = this.adopted.get(sheet);
      if (a && a.sig === rules.length) return a.text ? a.sheet : null;
      this.ctx.rules = 0;
      const plan = CSS.readSheet(rules, this.ctx, { cache: !!a });
      const media = sheet.media && sheet.media.mediaText;
      const text = CSS.emitSheet(plan, this.ctx, media ? WRAP : PLAIN);
      this.countRules(sheet, this.ctx.rules);
      if (!a) {
        a = { sheet: new CSSStyleSheet({ media: media || 'screen' }), sig: 0, plan, vars: false, version: 0, text: '', wrap: !!media };
        this.ownSheets.add(a.sheet);
        this.adopted.set(sheet, a);
        this.stat.adopted++;
      }
      a.sig = rules.length;
      a.plan = plan;
      a.vars = CSS.planUsesVars(plan);
      a.version = this.ctx.version;
      if (text !== a.text) {
        a.text = text;
        a.sheet.replaceSync(text);
      }
      a.sheet.disabled = !!sheet.disabled;
      return text ? a.sheet : null;
    }

    /** Put an adopted override right after each adopted sheet of a document / shadow root. */
    syncAdopted(owner) {
      let list;
      try {
        list = owner.adoptedStyleSheets;
      } catch {
        return;
      }
      if (!list || (!list.length && owner === document)) return;
      const out = [];
      for (const sheet of list) {
        if (this.ownSheets.has(sheet)) continue;
        out.push(sheet);
        const o = this.adoptedOverride(sheet);
        if (o) out.push(o);
      }
      if (owner !== document && this.shadowFallback) out.push(this.shadowFallback);
      if (out.length === list.length && out.every((x, i) => x === list[i])) return;
      try {
        owner.adoptedStyleSheets = out;
      } catch {
        /* a frozen or foreign list: leave it */
      }
    }

    /** Remove our adopted sheets from a document / shadow root. */
    unadopt(owner) {
      try {
        const list = owner.adoptedStyleSheets;
        if (list && list.some((s) => this.ownSheets.has(s))) owner.adoptedStyleSheets = list.filter((s) => !this.ownSheets.has(s));
      } catch {
        /* ignore */
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
      /** @type {Set<Element> | null} */
      let added = null;
      let lost = false;
      for (const r of recs) {
        const target = /** @type {Element} */ (r.target);
        if (r.type === 'childList') {
          const parent = target.nodeType === 1 ? target : null;
          if (parent && parent.tagName === 'STYLE' && !dom.isOurs(parent)) sheets.add(parent);
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1 || dom.isOurs(n)) continue;
            const el = /** @type {Element} */ (n);
            if (el.tagName === 'STYLE' || el.tagName === 'LINK') sheets.add(el);
            (added || (added = new Set())).add(el);
          }
          for (const n of r.removedNodes) {
            if (n.nodeType !== 1) continue;
            if (dom.isOurs(n)) lost = true;
            else if (this.overrides.has(/** @type {Element} */ (n))) this.removeSheetNode(n);
            else if (n === this.html) lost = true;
          }
        } else if (r.type === 'characterData') {
          const p = target.parentElement;
          if (p && p.tagName === 'STYLE' && !dom.isOurs(p)) sheets.add(p);
        } else if (r.type === 'attributes') {
          if (dom.isOurs(target)) continue;
          const name = r.attributeName;
          if (name === 'media' || name === 'disabled' || name === 'rel') {
            if (target.tagName === 'STYLE' || target.tagName === 'LINK') sheets.add(target);
          } else if (name === 'class') {
            if (this.fullScan) {
              this.single.push(target);
              this.dirty.add(target);
            }
          } else {
            this.single.push(target);
            this.dirty.add(target);
          }
        }
      }
      if (added) {
        // While a page is parsed, an element and all its descendants arrive in the same batch: walk only
        // the topmost added elements (their subtrees cover the rest), not every subtree again.
        for (const el of added) {
          let top = true;
          for (let p = el.parentNode; p; p = p.parentNode) {
            if (added.has(/** @type {Element} */ (p))) {
              top = false;
              break;
            }
          }
          if (!top || !el.isConnected) continue;
          if (el.firstElementChild) for (const s of el.querySelectorAll(SHEET_SEL)) sheets.add(s);
          if (this.fullScan) this.scanRoots.push(el);
          else this.enqueueLegacy(el);
          this.scanShadows(el);
        }
      }
      for (const s of sheets) {
        const o = this.overrides.get(s);
        if (o) o.sig = '';
        this.processSheetNode(s);
      }
      // components render right after their CSS-in-JS rules were inserted: catch those rules now
      if (added) this.checkSheets();
      if (lost || sheets.size) this.repair();
      this.refreshVars();
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
      const opts = { ...OBSERVE, attributeFilter: [...OBSERVE.attributeFilter, 'class'] };
      if (this.observer) {
        this.observer.observe(document, opts);
        for (const r of this.roots) this.observer.observe(r, opts);
      }
      dom.onReady(() => {
        if (!this.base) return;
        if (document.getElementsByTagName('*').length > LIMITS.elements) return this.fail(new TooBig('too many elements'));
        if (document.body) this.scanRoots.push(document.body);
        for (const r of this.roots) this.scanRoots.push(r);
        this.schedule();
      });
    }

    /** Queue elements that carry their own colors (inline style, legacy attributes). */
    enqueueLegacy(rootNode) {
      if (rootNode.nodeType === 1) {
        const el = /** @type {Element} */ (rootNode);
        if (el.matches(LEGACY_SEL)) this.single.push(el);
      }
      if (rootNode.querySelectorAll && (rootNode.nodeType !== 1 || /** @type {Element} */ (rootNode).firstElementChild)) {
        for (const el of rootNode.querySelectorAll(LEGACY_SEL)) this.single.push(el);
      }
      if (this.single.length) this.schedule();
    }

    /** <html>/<body> backgrounds from unreadable CSS would flash white: fix them synchronously. */
    fixRoots() {
      const items = [document.documentElement, document.body].filter(Boolean);
      for (const el of items) {
        if (el.hasAttribute('data-nd-c')) continue;
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
          if (r.nodeType === 1 ? !r.isConnected : !(/** @type {ShadowRoot} */ (r).host.isConnected)) continue;
          this.walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
          if (r.nodeType === 1) return /** @type {Element} */ (r);
          continue;
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
      let animated = false;
      // Elements tagged earlier whose inline style / attributes changed: the old override would pin
      // stale colors. They are untagged and measured again (with transitions off: no flicker).
      let restore = null;
      const stale = [];
      for (const el of this.dirty) if (el.hasAttribute('data-nd-c')) stale.push(el);
      this.dirty.clear();
      if (stale.length) {
        restore = dom.transitionsOff();
        for (const el of stale) {
          el.removeAttribute('data-nd-c');
          this.unInline(/** @type {HTMLElement} */ (el));
        }
      }
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
          // already themed (a shape we lightened would look like a light backdrop now)
          if (el.tagName === 'svg' || el.hasAttribute('data-nd-c')) continue;
          let coverage = 0;
          const f = C.parseColor(cs.fill);
          if (f && f.a > 0 && C.isLightFg(f) && el instanceof SVGGeometryElement && el.ownerSVGElement) {
            const r = el.getBoundingClientRect(), s = el.ownerSVGElement.getBoundingClientRect();
            if (s.width && s.height) coverage = (r.width * r.height) / (s.width * s.height);
          }
          o = P.svgOverride(cs.fill, cs.stroke, coverage);
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
          // ::before / ::after styled by unreadable CSS (fades, badges): only a full scan has to look
          if (this.fullScan && !el.hasAttribute('data-nd-c')) {
            const before = pseudoOverride(el, '::before', cs.color), after = pseudoOverride(el, '::after', cs.color);
            if (before || after) {
              o = o || {};
              if (before) o.before = before;
              if (after) o.after = after;
            }
          }
        }
        if (o) {
          writes.push([el, o]);
          if (!animated && cs.transitionDuration !== '0s') animated = true;
        }
      }
      if (animated && !restore) restore = dom.transitionsOff();
      let inlined = false;
      for (const [el, o] of writes) if (this.tag(el, o)) inlined = true;
      if (restore) restore();
      if (inlined && this.observer) {
        // our own inline writes must not come back as page mutations
        const recs = this.observer.takeRecords().filter((r) => !(r.type === 'attributes' && r.attributeName === 'style' && this.inline.has(/** @type {HTMLElement} */ (r.target))));
        if (recs.length) queueMicrotask(() => this.safe(() => this.onMutations(recs)));
      }
      this.stat.fallbackMs += performance.now() - t;
    }

    /**
     * @param {Element} el @param {import('../../lib/page-analysis.js').Override} o
     * @returns {boolean} an inline !important declaration was replaced
     */
    tag(el, o) {
      const key = P.overrideKey(o);
      let id = this.classes.get(key);
      if (!id) {
        id = String(this.classes.size + 1);
        try {
          const sheet = this.fallback && this.fallback.sheet;
          for (const rule of P.overrideRules(id, o)) {
            if (sheet) sheet.insertRule(rule, sheet.cssRules.length);
            if (this.shadowFallback) this.shadowFallback.insertRule(rule, this.shadowFallback.cssRules.length);
          }
        } catch {
          /* rule rejected: skip this element */
          return false;
        }
        this.classes.set(key, id);
      }
      if (el.getAttribute('data-nd-c') !== id) {
        el.setAttribute('data-nd-c', id);
        this.stat.tagged++;
      }
      return this.inlineImportant(/** @type {HTMLElement} */ (el), o);
    }

    /** style="color: x !important" beats every stylesheet: replace those few declarations inline. */
    inlineImportant(el, o) {
      const st = el.style;
      if (!st || !st.length) return false;
      let changed = false;
      for (const [prop, k] of INLINE) {
        const v = o[k];
        if (!v || st.getPropertyPriority(prop) !== 'important') continue;
        const cur = st.getPropertyValue(prop);
        if (cur === v) continue;
        let saved = this.inline.get(el);
        if (!saved) this.inline.set(el, (saved = []));
        if (!saved.some((x) => x[0] === prop)) saved.push([prop, cur, v]);
        else saved.find((x) => x[0] === prop)[2] = v;
        st.setProperty(prop, v, 'important');
        changed = true;
      }
      return changed;
    }

    /** Put back inline declarations we replaced (if the page did not change them since). */
    unInline(el) {
      const saved = this.inline.get(el);
      if (!saved) return;
      this.inline.delete(el);
      for (const [prop, orig, ours] of saved) if (el.style.getPropertyValue(prop) === ours) el.style.setProperty(prop, orig, 'important');
    }

    /** Transitions anywhere in the page CSS we know of (unreadable CSS or inline styles: assume yes). */
    mayTransition() {
      return this.ctx.transitions || this.unreadable.size > 0 || this.ctx.unreadable || this.fullScan;
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
      this.unadopt(document);
      for (const r of this.roots) this.unadopt(r);
      for (const el of [...this.inline.keys()]) this.unInline(el);
      if (this.base) this.base.remove();
      if (this.fallback) this.fallback.remove();
      this.base = this.fallback = null;
      this.single.length = this.scanRoots.length = this.verify.length = 0;
      this.dirty.clear();
      this.walker = null;
      for (const el of document.querySelectorAll('[data-nd-c]')) el.removeAttribute('data-nd-c');
      for (const r of this.roots) for (const el of r.querySelectorAll('[data-nd-c]')) el.removeAttribute('data-nd-c');
      this.roots.clear();
      this.pendingHosts.clear();
      this.adopted.clear();
    }
  }

  NS.DynamicEngine = DynamicEngine;
  NS.DynamicEngine.TooBig = TooBig;
})(globalThis);
