// Settings model: defaults and validation, per-site rules, schedule, the "should this page be dark?"
// decision, the CSS filter chain and JSON export/import of the site list.
//
// Pure code (no chrome.*, no DOM). Plain script published on globalThis.DarkModeLib.settings so that
// content scripts, pages and node tests share it.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});

  /** @typedef {'filter' | 'dynamic'} Engine */
  /** @typedef {{ mode?: 'on' | 'off', engine?: Engine }} SiteRule */
  /** @typedef {{ mode: 'always' | 'system' | 'time', from: string, to: string }} Schedule */
  /**
   * @typedef {object} Settings
   * @property {boolean} enabled     global switch
   * @property {Engine} engine       default engine
   * @property {number} brightness   50..150 (%)
   * @property {number} contrast     50..150 (%)
   * @property {number} sepia        0..100 (%)
   * @property {Schedule} schedule
   * @property {boolean} detectDark  leave sites that are already dark alone
   * @property {Record<string, SiteRule>} sites  key: host without "www."
   */

  const STORAGE_KEY = 'settings';
  const ENGINES = ['filter', 'dynamic'];
  const SCHEDULES = ['always', 'system', 'time'];
  const LIMITS = { brightness: [50, 150], contrast: [50, 150], sepia: [0, 100] };

  /** @returns {Settings} */
  function defaults() {
    return {
      enabled: true,
      engine: 'dynamic',
      brightness: 100,
      contrast: 100,
      sepia: 0,
      schedule: { mode: 'always', from: '20:00', to: '07:00' },
      detectDark: true,
      sites: {},
    };
  }

  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /** "HH:MM" → minutes since midnight, or null. */
  function parseTime(s) {
    const m = TIME_RE.exec(String(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function num(v, [lo, hi], dflt) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /**
   * Host name normalisation used as the per-site key: lower case, no "www.", no port for http(s).
   * Accepts a URL or a bare host typed by the user. Returns '' when it is not a web host.
   * @param {string} input
   */
  function siteKey(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return '';
    if (s.startsWith('file:')) return 'file';
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
    let host;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      host = u.hostname;
    } catch {
      return '';
    }
    host = host.replace(/^www\./, '').replace(/\.$/, '');
    if (!host || !/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/.test(host)) return '';
    return host;
  }

  /** @param {any} r @returns {SiteRule | null} */
  function cleanRule(r) {
    if (!r || typeof r !== 'object') return null;
    /** @type {SiteRule} */
    const out = {};
    if (r.mode === 'on' || r.mode === 'off') out.mode = r.mode;
    if (ENGINES.includes(r.engine)) out.engine = r.engine;
    return out.mode || out.engine ? out : null;
  }

  /**
   * Validate anything read from storage into a complete Settings object.
   * @param {any} raw @returns {Settings}
   */
  function ensureSettings(raw) {
    const d = defaults();
    if (!raw || typeof raw !== 'object') return d;
    const sch = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
    /** @type {Record<string, SiteRule>} */
    const sites = {};
    if (raw.sites && typeof raw.sites === 'object') {
      for (const [k, v] of Object.entries(raw.sites)) {
        const key = k === 'file' ? 'file' : siteKey(k);
        const rule = cleanRule(v);
        if (key && rule) sites[key] = rule;
      }
    }
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
      engine: ENGINES.includes(raw.engine) ? raw.engine : d.engine,
      brightness: num(raw.brightness, LIMITS.brightness, d.brightness),
      contrast: num(raw.contrast, LIMITS.contrast, d.contrast),
      sepia: num(raw.sepia, LIMITS.sepia, d.sepia),
      schedule: {
        mode: SCHEDULES.includes(sch.mode) ? sch.mode : d.schedule.mode,
        from: parseTime(sch.from) != null ? sch.from : d.schedule.from,
        to: parseTime(sch.to) != null ? sch.to : d.schedule.to,
      },
      detectDark: typeof raw.detectDark === 'boolean' ? raw.detectDark : d.detectDark,
      sites,
    };
  }

  /**
   * The rule for a host: exact match first, then parent domains (a rule for example.com also covers
   * mail.example.com unless that subdomain has its own rule).
   * @param {Settings} s @param {string} host
   * @returns {{ key: string, rule: SiteRule } | null}
   */
  function ruleFor(s, host) {
    let h = host === 'file' ? 'file' : siteKey(host);
    while (h) {
      if (s.sites[h]) return { key: h, rule: s.sites[h] };
      const i = h.indexOf('.');
      if (i < 0) break;
      h = h.slice(i + 1);
      if (h.indexOf('.') < 0) break; // never match a bare TLD
    }
    return null;
  }

  /**
   * Is the schedule "dark now"?
   * @param {Schedule} sch @param {number} minutes minutes since local midnight @param {boolean} systemDark
   */
  function scheduleActive(sch, minutes, systemDark) {
    if (sch.mode === 'system') return !!systemDark;
    if (sch.mode !== 'time') return true;
    const from = parseTime(sch.from), to = parseTime(sch.to);
    if (from == null || to == null || from === to) return true;
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  }

  /**
   * Milliseconds until the time schedule flips, or null when it never flips by itself.
   * @param {Schedule} sch @param {Date} now
   */
  function msUntilScheduleChange(sch, now) {
    if (sch.mode !== 'time') return null;
    const from = parseTime(sch.from), to = parseTime(sch.to);
    if (from == null || to == null || from === to) return null;
    const cur = now.getHours() * 60 + now.getMinutes();
    const next = (t) => ((t - cur + 1440) % 1440 || 1440);
    const mins = Math.min(next(from), next(to));
    return mins * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
  }

  /**
   * @typedef {object} Decision
   * @property {boolean} on
   * @property {Engine} engine
   * @property {'global-off' | 'site-off' | 'schedule' | 'on'} reason
   * @property {boolean} force   skip the "already dark" check
   */

  /**
   * Should a page on `host` be dark right now?
   * @param {Settings} s @param {string} host @param {{ minutes: number, systemDark: boolean }} env
   * @returns {Decision}
   */
  function decide(s, host, env) {
    const found = ruleFor(s, host);
    const rule = found ? found.rule : {};
    const engine = rule.engine || s.engine;
    const base = { engine, force: rule.mode === 'on' || !s.detectDark };
    if (!s.enabled) return { ...base, on: false, reason: 'global-off' };
    if (rule.mode === 'off') return { ...base, on: false, reason: 'site-off' };
    if (!scheduleActive(s.schedule, env.minutes, env.systemDark)) return { ...base, on: false, reason: 'schedule' };
    return { ...base, on: true, reason: 'on' };
  }

  /** @param {Settings} s @param {string} key @param {SiteRule | null} rule */
  function withRule(s, key, rule) {
    const sites = { ...s.sites };
    const clean = cleanRule(rule);
    if (clean) sites[key] = clean;
    else delete sites[key];
    return { ...s, sites };
  }

  /**
   * Flip the site switch from the popup / keyboard shortcut.
   * @param {Settings} s @param {string} host
   * @param {'on' | 'site-off' | 'already-dark' | string} status what the page shows now
   * @returns {Settings}
   */
  function toggleSite(s, host, status) {
    const key = host === 'file' ? 'file' : siteKey(host);
    if (!key) return s;
    const found = s.sites[key] || {};
    if (status === 'on') return withRule(s, key, { ...found, mode: 'off' });
    if (status === 'already-dark') return withRule(s, key, { ...found, mode: 'on' });
    // switched off by the user: drop the "off" mark; if a parent domain rule also says off, force on
    const rest = { ...found };
    delete rest.mode;
    const next = withRule(s, key, rest);
    const inherited = ruleFor(next, key);
    return inherited && inherited.rule.mode === 'off' ? withRule(s, key, { ...found, mode: 'on' }) : next;
  }

  /** @param {Settings} s @param {string} host @param {Engine | null} engine null = use the default */
  function setSiteEngine(s, host, engine) {
    const key = host === 'file' ? 'file' : siteKey(host);
    if (!key) return s;
    const rule = { ...(s.sites[key] || {}) };
    if (engine && ENGINES.includes(engine)) rule.engine = engine;
    else delete rule.engine;
    return withRule(s, key, rule);
  }

  /**
   * CSS filter chain for the fast engine (invert + hue-rotate keeps hues, then the user's sliders).
   * @param {Settings} s @param {boolean} [invert]
   * @returns {Array<[string, number]>}
   */
  function filterChain(s, invert = true) {
    /** @type {Array<[string, number]>} */
    const chain = invert ? [['invert', 1], ['hue-rotate', 180]] : [];
    if (s.brightness !== 100) chain.push(['brightness', s.brightness / 100]);
    if (s.contrast !== 100) chain.push(['contrast', s.contrast / 100]);
    if (s.sepia !== 0) chain.push(['sepia', s.sepia / 100]);
    return chain;
  }

  /** @param {Array<[string, number]>} chain @returns {string} e.g. "invert(1) hue-rotate(180deg)" */
  function filterCss(chain) {
    return chain.map(([fn, v]) => (fn === 'hue-rotate' ? `${fn}(${v}deg)` : `${fn}(${Math.round(v * 1000) / 1000})`)).join(' ');
  }

  const EXPORT_APP = 'dark-mode';

  /** @param {Settings} s @param {Date} [now] @returns {string} */
  function exportSites(s, now = new Date()) {
    const sites = Object.fromEntries(Object.keys(s.sites).sort().map((k) => [k, s.sites[k]]));
    return JSON.stringify({ app: EXPORT_APP, kind: 'sites', version: 1, exported: now.toISOString(), sites }, null, 2);
  }

  /**
   * Merge a site list from JSON (our export or a bare { host: rule } object). Imported rules replace
   * existing ones for the same host; other hosts are kept.
   * @param {Settings} s @param {string} text
   * @returns {{ settings: Settings, added: number, updated: number, skipped: number }}
   */
  function importSites(s, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('bad-json');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad-format');
    if (data.app !== undefined && data.app !== EXPORT_APP) throw new Error('bad-format');
    const src = data.app === EXPORT_APP ? data.sites : data;
    if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('bad-format');
    const sites = { ...s.sites };
    let added = 0, updated = 0, skipped = 0;
    for (const [k, v] of Object.entries(src)) {
      const key = k === 'file' ? 'file' : siteKey(k);
      const rule = cleanRule(v);
      if (!key || !rule) {
        skipped++;
        continue;
      }
      if (sites[key]) updated++;
      else added++;
      sites[key] = rule;
    }
    return { settings: { ...s, sites }, added, updated, skipped };
  }

  NS.settings = {
    STORAGE_KEY,
    LIMITS,
    defaults,
    ensureSettings,
    parseTime,
    siteKey,
    ruleFor,
    scheduleActive,
    msUntilScheduleChange,
    decide,
    toggleSite,
    setSiteEngine,
    filterChain,
    filterCss,
    exportSites,
    importSites,
  };
})(globalThis);
