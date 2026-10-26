// Fast engine: one CSS filter on <html> (invert + hue-rotate keeps hues), media shown in original
// colors by inverting them back. All the work is done by the compositor; the only JavaScript is an
// idle-time scan that finds large CSS background photos.
//
// Runs in the top frame only: iframes are painted inside the inverted page and get inverted with it.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});
  const { dom, settings: S, color: C, page: P } = NS;

  const REINVERT = 'invert(1) hue-rotate(180deg)';
  // Embedded players and maps keep their real colors.
  const MEDIA_FRAMES = [
    'youtube.com/embed', 'youtube-nocookie.com', 'player.vimeo.com', 'rutube.ru/play', 'rutube.ru/embed',
    'vk.com/video_ext', 'vkvideo.ru/video_ext', 'dzen.ru/embed', 'player.twitch.tv', 'google.com/maps',
    'yandex.ru/map-widget', 'yandex.kz/map-widget', '2gis.', 'coub.com/embed',
  ];
  const MEDIA = [
    'img:not([src*=".svg"]):not([src^="data:image/svg"])',
    'video', 'canvas', 'embed', 'object', 'svg image', 'input[type="image"]',
    '[data-nd-img]',
    ...MEDIA_FRAMES.map((s) => `iframe[src*="${s}"]`),
  ].join(',');
  // :where() keeps the media selector at zero specificity, so media inside a re-inverted block (NESTED,
  // one attribute more) reliably wins and is not inverted twice.
  const NESTED = '[data-nd-img] :where(img,video,canvas,svg image,[data-nd-img])';
  const SCAN_LIMIT = 30000;

  class FilterEngine {
    constructor() {
      this.kind = 'filter';
      /** @type {HTMLStyleElement | null} */
      this.style = null;
      /** @type {MutationObserver | null} */
      this.observer = null;
      this.canvas = C.parseColor('#fff');
      this.settings = null;
      /** @type {Element[]} subtrees to scan */
      this.queue = [];
      /** @type {Element[]} single elements whose class / style changed (lazy backgrounds) */
      this.singles = [];
      /** @type {WeakMap<Element, number>} luminance of what is painted behind an element's content */
      this.lum = new WeakMap();
      /** @type {TreeWalker | null} */
      this.walker = null;
      this.scheduled = false;
      this.scanned = 0;
      this.marked = 0;
      this.onFullscreen = () => this.syncFullscreen();
    }

    /** @param {any} s Settings */
    css(s) {
      const chain = S.filterChain(s);
      // The root background is filtered too, so it keeps the page's own (light) canvas color.
      // It must be explicit: the browser's default white canvas is not filtered.
      const canvas = C.formatColor(this.canvas);
      // Screen only: printing uses the page's own colors.
      return (
        '@media screen{' +
        `html[data-nd="filter"]{filter:${S.filterCss(chain)}!important;background-color:${canvas}!important;background-image:none!important}` +
        `html[data-nd="filter"] :where(${MEDIA}){filter:${REINVERT}!important}` +
        `html[data-nd="filter"] ${NESTED}{filter:none!important}` +
        '}'
      );
    }

    /** @param {any} s Settings */
    start(s) {
      this.settings = s;
      this.style = dom.makeStyle('filter', this.css(s));
      dom.append(this.style);
      document.documentElement.setAttribute('data-nd', 'filter');
      document.addEventListener('fullscreenchange', this.onFullscreen);
      dom.onReady(() => {
        if (!this.style) return;
        this.observer = new MutationObserver((recs) => this.onMutations(recs));
        // class / style changes too: lazy thumbnails get their background image that way
        this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        // inline background photos are known at once: re-invert them before the first paint
        const marks = [];
        for (const el of document.querySelectorAll('[style*="url("]')) if (this.check(el, this.lumBehind(el)) === 'img') marks.push(el);
        for (const el of marks) el.setAttribute('data-nd-img', '');
        this.marked += marks.length;
        if (document.body) this.enqueue(document.body);
      });
    }

    /** @param {any} s Settings */
    update(s) {
      this.settings = s;
      if (this.style) this.style.textContent = this.css(s);
    }

    /**
     * Learn the page's own canvas color (measured with the filter off) so the area outside <body>
     * is inverted exactly like the page.
     * @param {{ htmlBg: string, bodyBg: string }} m
     */
    setCanvas(m) {
      const c = P.canvasColor(m.htmlBg, m.bodyBg, m.scheme);
      if (C.formatColor(c) === C.formatColor(this.canvas)) return;
      this.canvas = c;
      if (this.settings) this.update(this.settings);
    }

    syncFullscreen() {
      // Top-layer (fullscreen) content must not be inverted.
      const html = document.documentElement;
      if (!this.style) return;
      html.setAttribute('data-nd', document.fullscreenElement ? 'filter-fullscreen' : 'filter');
    }

    /** Disable our CSS while `fn` measures the page. */
    suspend(fn) {
      if (!this.style) return fn();
      this.style.disabled = true;
      try {
        return fn();
      } finally {
        this.style.disabled = false;
      }
    }

    /** @param {MutationRecord[]} recs */
    onMutations(recs) {
      for (const r of recs) {
        if (r.type === 'attributes') {
          if (!dom.isOurs(r.target)) this.singles.push(/** @type {Element} */ (r.target));
        } else for (const n of r.addedNodes) if (n.nodeType === 1 && !dom.isOurs(n)) this.queue.push(/** @type {Element} */ (n));
      }
      if (this.queue.length || this.singles.length) this.schedule();
      if (this.style && !this.style.isConnected) dom.append(this.style);
    }

    /** @param {Element} el */
    enqueue(el) {
      this.queue.push(el);
      this.schedule();
    }

    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      dom.idle((d) => this.work(d));
    }

    /** Idle-time scan for large background photos, chunked by the idle deadline. */
    /** Luminance painted behind the content of `el`'s parent (walks up until an opaque background). */
    lumBehind(el) {
      let lum = C.luminance(this.canvas);
      for (let p = el.parentElement, d = 0; p && d < 30; p = p.parentElement, d++) {
        const known = this.lum.get(p);
        if (known !== undefined) {
          lum = known;
          break;
        }
        const c = C.parseColor(getComputedStyle(p).backgroundColor);
        if (c && c.a >= 0.95) {
          lum = C.luminance(c);
          break;
        }
      }
      return lum;
    }

    /**
     * What an element needs: 'img' = show in its own colors (photo background, dark section), or null.
     * Also records the luminance behind its content for its children.
     * @param {Element} el @param {number} parentLum
     */
    check(el, parentLum) {
      const tag = el.tagName;
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'svg' || tag === 'CANVAS' || tag === 'IFRAME') return null;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const c = C.parseColor(bg);
      this.lum.set(el, c && c.a >= 0.95 ? C.luminance(c) : parentLum);
      const bi = cs.backgroundImage;
      const rootish = el === document.body || el === document.documentElement;
      const hasUrl = bi !== 'none' && bi.indexOf('url(') >= 0;
      if (!hasUrl && (!c || c.a < 0.95 || rootish)) return null;
      const r = el.getBoundingClientRect();
      if (hasUrl && P.isPhotoBackground(bi, r.width, r.height, { repeat: cs.backgroundRepeat, size: cs.backgroundSize, viewportHeight: innerHeight, root: rootish })) return 'img';
      if (!rootish && P.isDarkSection(bg, parentLum, r.width, r.height, innerWidth)) return 'img';
      return null;
    }

    /** Idle-time scan for large background photos and dark sections, chunked by the idle deadline. */
    work(deadline) {
      this.scheduled = false;
      if (!this.style) return;
      const marks = [];
      const unmarks = [];
      let n = 0;
      // single elements whose class / style changed (lazy backgrounds, toggled themes)
      while (this.singles.length) {
        if ((++n & 31) === 0 && deadline.timeRemaining() < 2) break;
        const el = /** @type {Element} */ (this.singles.shift());
        if (!el.isConnected) continue;
        const want = this.check(el, this.lumBehind(el)) === 'img';
        if (want !== el.hasAttribute('data-nd-img')) (want ? marks : unmarks).push(el);
      }
      while (this.scanned < SCAN_LIMIT) {
        if ((++n & 31) === 0 && deadline.timeRemaining() < 2) break;
        /** @type {Element | null} */
        let el;
        if (!this.walker) {
          const rootEl = this.queue.shift();
          if (!rootEl) break;
          if (!rootEl.isConnected) continue;
          this.walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
          el = rootEl;
        } else {
          el = /** @type {Element | null} */ (this.walker.nextNode());
          if (!el) {
            this.walker = null;
            continue;
          }
        }
        this.scanned++;
        if (el.hasAttribute('data-nd-img')) continue;
        const parent = el.parentElement;
        const pl = parent ? this.lum.get(parent) : undefined;
        if (this.check(el, pl === undefined ? this.lumBehind(el) : pl) === 'img') marks.push(el);
      }
      for (const el of marks) el.setAttribute('data-nd-img', '');
      for (const el of unmarks) el.removeAttribute('data-nd-img');
      this.marked += marks.length;
      if (this.scanned >= SCAN_LIMIT) {
        this.queue.length = 0;
        this.walker = null;
      }
      if (this.walker || this.queue.length || this.singles.length) this.schedule();
    }

    stats() {
      return { scanned: this.scanned, photos: this.marked };
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      document.removeEventListener('fullscreenchange', this.onFullscreen);
      if (this.style) this.style.remove();
      this.style = null;
      this.queue.length = 0;
      this.walker = null;
      for (const el of document.querySelectorAll('[data-nd-img]')) el.removeAttribute('data-nd-img');
    }
  }

  NS.FilterEngine = FilterEngine;
})(globalThis);
