// Content script entry (every frame, document_start): reads the settings, decides whether this page
// should be dark, runs one of the two engines, leaves already-dark sites alone and answers the popup.
// Everything is wrapped so that a failure can never break the page.
(function () {
  'use strict';
  const L = globalThis.DarkModeLib;
  if (!L || L.started) return; // idempotent: injected once per frame
  L.started = true;

  // Only HTML documents (not SVG/XML files, not image or plain-text viewers styled by the browser).
  // The <html> element is always looked up again: document.open() (about:blank frames written by a
  // script) replaces it.
  if (!(document.documentElement instanceof HTMLHtmlElement)) return;
  const html = () => document.documentElement;
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'PICTURE', 'svg']);

  const S = L.settings;
  const isTop = window === window.top;
  const t0 = performance.now();

  /** The site a frame belongs to = the site of the tab (top frame), so per-site rules cover iframes too. */
  function frameHost() {
    try {
      if (!isTop && location.ancestorOrigins && location.ancestorOrigins.length) {
        return S.siteKey(location.ancestorOrigins[location.ancestorOrigins.length - 1]);
      }
    } catch {
      /* ignore */
    }
    if (location.protocol === 'file:') return 'file';
    return S.siteKey(location.href);
  }

  const host = frameHost();
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  /** @type {any} */
  let settings = null;
  /** @type {any} current engine */
  let engine = null;
  let state = 'loading';
  let detectedDark = false;
  let forceFilter = false; // dynamic engine gave up on this page (too big / error)
  let appliedAt = 0;
  let scheduleTimer = 0;
  let checksArmed = false;

  function setAttr(v) {
    const root = html();
    if (root && root.getAttribute('data-nd') !== v) root.setAttribute('data-nd', v);
  }

  /** May the page animate color changes? (Unknown → yes.) */
  function mayTransition() {
    return !engine || !engine.mayTransition || engine.mayTransition();
  }

  function stopEngine() {
    if (!engine) return;
    try {
      L.dom.withoutTransitions(() => engine.stop(), mayTransition);
    } catch {
      /* ignore */
    }
    engine = null;
  }

  function startEngine(kind) {
    const E = kind === 'filter' ? L.FilterEngine : L.DynamicEngine;
    engine = new E();
    engine.onFail = () => {
      // The smart engine cannot handle this page (too big / unexpected error): use the fast one.
      forceFilter = true;
      stopEngine();
      evaluate();
    };
    L.dom.withoutTransitions(() => engine.start(settings), mayTransition);
    if (!appliedAt) appliedAt = performance.now();
  }

  function evaluate() {
    try {
      const now = new Date();
      const d = S.decide(settings, host, { minutes: now.getHours() * 60 + now.getMinutes(), systemDark: darkQuery.matches });
      armSchedule();
      if (!d.on) {
        stopEngine();
        setAttr('off');
        state = d.reason;
        return;
      }
      if (detectedDark && !d.force) {
        stopEngine();
        setAttr('off');
        state = 'already-dark';
        return;
      }
      const kind = forceFilter ? 'filter' : d.engine;
      if (kind === 'filter' && !isTop) {
        // the top frame's filter already inverts this frame
        stopEngine();
        setAttr('off');
        state = 'parent-filter';
        return;
      }
      if (engine && engine.kind === kind) engine.update(settings);
      else {
        stopEngine();
        startEngine(kind);
      }
      state = 'on';
      if (!d.force) armDarkChecks();
    } catch {
      stopEngine();
      setAttr('off');
      state = 'error';
    }
  }

  function armSchedule() {
    clearTimeout(scheduleTimer);
    const ms = S.msUntilScheduleChange(settings.schedule, new Date());
    if (ms != null) scheduleTimer = setTimeout(evaluate, Math.min(ms + 1000, 2 ** 31 - 1));
  }

  // ---- "already dark" detection

  /** Colors of the page with our styles off: canvas, color scheme and a 3×3 grid of viewport points. */
  function measure() {
    const body = document.body;
    const root = html();
    const cs = (el) => getComputedStyle(el);
    const rcs = cs(root);
    const meta = document.querySelector('meta[name="color-scheme" i]');
    const m = {
      htmlBg: rcs.backgroundColor,
      bodyBg: body ? cs(body).backgroundColor : 'rgba(0, 0, 0, 0)',
      scheme: L.page.usedScheme(rcs.colorScheme, meta ? meta.getAttribute('content') || '' : '', darkQuery.matches),
      text: body ? cs(body).color : '',
      samples: /** @type {any[]} */ ([]),
    };
    const W = innerWidth, H = innerHeight;
    if (W > 0 && H > 0) {
      for (let i = 0; i < 9; i++) {
        let el = document.elementFromPoint(W * ((i % 3) * 2 + 1) / 6, H * (Math.floor(i / 3) * 2 + 1) / 6);
        if (!el) continue;
        const s = { chain: /** @type {string[]} */ ([]), text: cs(el).color, media: false };
        // up to the first opaque background; a photo / video / canvas on the way says nothing about the theme
        for (; el && el !== body && el !== root; el = el.parentElement) {
          if (MEDIA_TAGS.has(el.tagName)) {
            s.media = true;
            break;
          }
          const c = cs(el);
          if (c.backgroundImage.indexOf('url(') >= 0) {
            s.media = true;
            break;
          }
          s.chain.push(c.backgroundColor);
          const bg = L.color.parseColor(c.backgroundColor);
          if (bg && bg.a >= 1) break;
        }
        m.samples.push(s);
      }
    }
    return m;
  }

  function checkDark() {
    try {
      if (!engine || detectedDark || !document.body) return;
      const quiet = mayTransition();
      const m = L.dom.withoutTransitions(
        () =>
          engine.suspend(() => {
            if (quiet) L.dom.settleTransitions(); // read final colors, not the start of a transition
            return measure();
          }),
        () => quiet,
      );
      if (engine.setCanvas) engine.setCanvas(m);
      if (L.page.looksDark(m)) {
        detectedDark = true;
        evaluate();
      }
    } catch {
      /* measuring is best effort */
    }
  }

  function armDarkChecks() {
    if (checksArmed) return;
    checksArmed = true;
    L.dom.onReady(checkDark);
    L.dom.onLoad(() => {
      checkDark();
      // single-page apps often paint their own theme a moment after load
      setTimeout(checkDark, 1500);
    });
  }

  // ---- settings and messages

  function onSettings(raw) {
    settings = S.ensureSettings(raw);
    evaluate();
  }

  chrome.storage.local
    .get(S.STORAGE_KEY)
    .then((r) => onSettings(r[S.STORAGE_KEY]))
    .catch(() => onSettings(undefined));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[S.STORAGE_KEY]) onSettings(changes[S.STORAGE_KEY].newValue);
  });

  darkQuery.addEventListener('change', () => settings && evaluate());

  if (isTop) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'nd:status') {
        reply({
          host,
          state,
          engine: engine ? engine.kind : null,
          forcedFilter: forceFilter,
          appliedMs: appliedAt ? Math.round((appliedAt - t0) * 10) / 10 : null,
          startedAt: Math.round(t0),
          stats: engine && engine.stats ? engine.stats() : null,
        });
      } else if (msg.type === 'nd:toggle-site' && settings) {
        const next = S.toggleSite(settings, host, state);
        chrome.storage.local.set({ [S.STORAGE_KEY]: next }).then(() => reply({ ok: true }), () => reply({ ok: false }));
        return true;
      }
    });
  }
})();
