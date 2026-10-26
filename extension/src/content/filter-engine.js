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
    '[data-nd-img]', '[style*="url("]',
    ...MEDIA_FRAMES.map((s) => `iframe[src*="${s}"]`),
  ].join(',');
  const NESTED = ':is([data-nd-img],[style*="url("]) :is(img,video,canvas,svg image,[data-nd-img],[style*="url("])';
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
      /** @type {Element[]} */
      this.queue = [];
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
      return (
        `html[data-nd="filter"]{filter:${S.filterCss(chain)}!important;background-color:${canvas}!important;background-image:none!important}` +
        `html[data-nd="filter"] :is(${MEDIA}){filter:${REINVERT}!important}` +
        `html[data-nd="filter"] ${NESTED}{filter:none!important}`
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
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
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
      const c = P.canvasColor(m.htmlBg, m.bodyBg);
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
      for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && !dom.isOurs(n)) this.queue.push(/** @type {Element} */ (n));
      if (this.queue.length) this.schedule();
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
    work(deadline) {
      this.scheduled = false;
      if (!this.style) return;
      const marks = [];
      let n = 0;
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
        const tag = el.tagName;
        if (tag === 'IMG' || tag === 'VIDEO' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'svg' || el.hasAttribute('data-nd-img')) continue;
        const bi = getComputedStyle(el).backgroundImage;
        if (bi === 'none' || bi.indexOf('url(') < 0) continue;
        const r = el.getBoundingClientRect();
        if (P.isPhotoBackground(bi, r.width, r.height)) marks.push(el);
      }
      for (const el of marks) el.setAttribute('data-nd-img', '');
      this.marked += marks.length;
      if (this.scanned >= SCAN_LIMIT) {
        this.queue.length = 0;
        this.walker = null;
      } else if (this.walker || this.queue.length) this.schedule();
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
