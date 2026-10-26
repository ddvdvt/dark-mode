// Dynamic theme: turns a page stylesheet (CSSOM) into an "override" stylesheet that repeats only the
// color declarations with dark-theme colors. The override is inserted right after the original sheet,
// so selectors, specificity, !important, @media/@supports/@layer and source order all stay the same —
// the page layout is never touched.
//
// Pure code over CSSOM-like objects (duck-typed by constructor name), testable in node.
// Plain script: published on globalThis.DarkModeLib.css. Requires lib/color.js loaded first.
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});
  const C = NS.color;

  /** @typedef {import('./color.js')} _ */
  /** @typedef {'bg' | 'fg' | 'border' | 'shadow' | 'generic'} Role */

  /** Longhand property → role. Custom properties (--*) are handled separately. */
  const PROP_ROLE = /** @type {Record<string, Role>} */ ({
    'background-color': 'bg',
    'background-image': 'bg',
    'background': 'bg',
    '-webkit-tap-highlight-color': 'bg',
    color: 'fg',
    '-webkit-text-fill-color': 'fg',
    '-webkit-text-stroke-color': 'fg',
    'caret-color': 'fg',
    'text-decoration-color': 'fg',
    'text-emphasis-color': 'fg',
    fill: 'fg',
    stroke: 'fg',
    'border-color': 'border',
    'border-top-color': 'border',
    'border-right-color': 'border',
    'border-bottom-color': 'border',
    'border-left-color': 'border',
    'border-block-start-color': 'border',
    'border-block-end-color': 'border',
    'border-inline-start-color': 'border',
    'border-inline-end-color': 'border',
    'outline-color': 'border',
    'column-rule-color': 'border',
    'box-shadow': 'shadow',
    'text-shadow': 'shadow',
    'scrollbar-color': 'generic',
  });

  /** Where a longhand may hide when it was written through a shorthand with var(). */
  const SHORTHANDS = /** @type {Record<string, string[]>} */ ({
    'background-color': ['background'],
    'background-image': ['background'],
    'border-top-color': ['border-top', 'border-color', 'border'],
    'border-right-color': ['border-right', 'border-color', 'border'],
    'border-bottom-color': ['border-bottom', 'border-color', 'border'],
    'border-left-color': ['border-left', 'border-color', 'border'],
    'outline-color': ['outline'],
    'text-decoration-color': ['text-decoration'],
    'column-rule-color': ['column-rule'],
  });

  const TOKEN_RE = /url\([^)]*\)|#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)|(?<![\w-])[a-zA-Z]{3,20}(?![\w(-])/g;

  /** @type {Map<string, string>} */
  const valueCache = new Map();
  const CACHE_MAX = 20000;

  /** @param {string} s */
  const isCustom = (s) => s.charCodeAt(0) === 45 && s.charCodeAt(1) === 45;

  /**
   * Replace every color inside a CSS value (gradients, shadows, shorthands) with its dark-theme
   * version. url(...) and keywords like currentcolor/inherit are untouched. Cached.
   * @param {string} value @param {Role} role @returns {string}
   */
  function transformValue(value, role) {
    const key = role + '|' + value;
    const hit = valueCache.get(key);
    if (hit !== undefined) return hit;
    const out = value.replace(TOKEN_RE, (tok) => {
      if (tok.charCodeAt(0) === 117 && tok.startsWith('url(')) return tok;
      const c = C.parseColor(tok);
      if (!c || (c.a === 0 && tok.toLowerCase() === 'transparent')) return tok;
      return C.formatColor(C.darken(c, role));
    });
    if (valueCache.size >= CACHE_MAX) valueCache.clear();
    valueCache.set(key, out);
    return out;
  }

  /** @param {string} prop @returns {Role | undefined} */
  const roleOf = (prop) => PROP_ROLE[prop];

  /**
   * @typedef {object} Ctx
   * @property {Map<string, Set<Role>>} varRoles   how each custom property is used (filled by collectVarUsage)
   * @property {Map<string, Set<string>>} varAliases --a: var(--b) → b is used like a
   * @property {number} rules     style rules visited
   * @property {number} decls     declarations rewritten
   * @property {number} maxRules  abort with TooBig above this
   * @property {boolean} unreadable  an @import could not be read (cross-origin)
   */

  /** @param {Partial<Ctx>} [o] @returns {Ctx} */
  function createContext(o = {}) {
    return { varRoles: new Map(), varAliases: new Map(), rules: 0, decls: 0, maxRules: 100000, unreadable: false, ...o };
  }

  class TooBig extends Error {}

  const VAR_RE = /var\(\s*(--[\w-]+)/g;

  /** @param {Ctx} ctx @param {string} value @param {Role} role */
  function noteVars(ctx, value, role) {
    if (value.indexOf('var(') < 0) return;
    for (const m of value.matchAll(VAR_RE)) {
      let set = ctx.varRoles.get(m[1]);
      if (!set) ctx.varRoles.set(m[1], (set = new Set()));
      set.add(role);
    }
  }

  /** @returns {any[]} */
  function rulesOf(x, ctx) {
    try {
      return x && x.cssRules ? x.cssRules : [];
    } catch {
      ctx.unreadable = true;
      return [];
    }
  }

  /**
   * Pass 1: learn how custom properties are used (as backgrounds, text colors, borders…).
   * @param {ArrayLike<any>} rules @param {Ctx} ctx
   */
  function collectVarUsage(rules, ctx) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const st = rule.style;
      if (st && rule.constructor.name !== 'CSSKeyframeRule') {
        for (let j = 0; j < st.length; j++) {
          const p = st[j];
          if (isCustom(p)) {
            const v = st.getPropertyValue(p);
            if (v.indexOf('var(') >= 0) {
              for (const m of v.matchAll(VAR_RE)) {
                let set = ctx.varAliases.get(m[1]);
                if (!set) ctx.varAliases.set(m[1], (set = new Set()));
                set.add(p);
              }
            }
            continue;
          }
          const role = PROP_ROLE[p];
          if (!role) continue;
          let v = st.getPropertyValue(p);
          if (!v) for (const sh of SHORTHANDS[p] || []) if ((v = st.getPropertyValue(sh))) break;
          if (v) noteVars(ctx, v, role);
        }
      }
      if (rule.styleSheet) collectVarUsage(rulesOf(rule.styleSheet, ctx), ctx);
      else if (rule.cssRules && rule.cssRules.length) collectVarUsage(rule.cssRules, ctx);
    }
  }

  /** Role of a custom property from its usage; aliases inherit roles of the variables using them. */
  function varRole(name, ctx) {
    const set = varRoleSet(name, ctx, 0);
    if (set.size === 1) return /** @type {Role} */ ([...set][0]);
    if (set.size === 2 && set.has('bg') && set.has('shadow')) return 'bg';
    return 'generic';
  }
  function varRoleSet(name, ctx, depth) {
    const set = new Set(ctx.varRoles.get(name) || []);
    if (depth < 4) for (const user of ctx.varAliases.get(name) || []) for (const r of varRoleSet(user, ctx, depth + 1)) set.add(r);
    return set;
  }

  /** Declarations of one style block → "prop:value;" text with dark colors (only changed ones). */
  function transformDecls(st, ctx) {
    let body = '';
    for (let j = 0; j < st.length; j++) {
      const p = st[j];
      let role;
      if (isCustom(p)) role = varRole(p, ctx);
      else if (!(role = PROP_ROLE[p])) continue;
      const v = st.getPropertyValue(p);
      if (!v) continue;
      const t = transformValue(v, role);
      if (t === v) continue;
      ctx.decls++;
      body += p + ':' + t + (st.getPropertyPriority(p) ? ' !important;' : ';');
    }
    return body;
  }

  /** Text before the block of an at-rule, e.g. "@container card (min-width: 400px)". */
  function prelude(rule) {
    const t = String(rule.cssText || '');
    const i = t.indexOf('{');
    return i > 0 ? t.slice(0, i).trim() : '';
  }

  /** @param {any} kf CSSKeyframesRule */
  function transformKeyframes(kf, ctx) {
    let changed = false;
    let out = '';
    const list = kf.cssRules || [];
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const st = k.style;
      let body = '';
      for (let j = 0; j < st.length; j++) {
        const p = st[j];
        const v = st.getPropertyValue(p);
        const role = PROP_ROLE[p];
        const t = role ? transformValue(v, role) : v;
        if (t !== v) changed = true;
        body += p + ':' + t + ';';
      }
      out += k.keyText + '{' + body + '}';
    }
    return changed ? '@keyframes ' + kf.name + '{' + out + '}' : '';
  }

  /**
   * Pass 2: build the override CSS text for a list of rules.
   * @param {ArrayLike<any>} rules @param {Ctx} ctx @returns {string}
   */
  function transformRules(rules, ctx) {
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const kind = rule.constructor.name;
      if (kind === 'CSSStyleRule') {
        if (++ctx.rules > ctx.maxRules) throw new TooBig('too many rules');
        const body = transformDecls(rule.style, ctx);
        const nested = rule.cssRules && rule.cssRules.length ? transformRules(rule.cssRules, ctx) : '';
        if (body || nested) out += rule.selectorText + '{' + body + nested + '}';
      } else if (kind === 'CSSNestedDeclarations') {
        out += transformDecls(rule.style, ctx);
      } else if (kind === 'CSSImportRule') {
        const inner = transformRules(rulesOf(rule.styleSheet, ctx), ctx);
        const media = rule.media && rule.media.mediaText;
        if (inner) out += media ? '@media ' + media + '{' + inner + '}' : inner;
      } else if (kind === 'CSSKeyframesRule') {
        out += transformKeyframes(rule, ctx);
      } else if (kind === 'CSSMediaRule' || kind === 'CSSSupportsRule' || kind === 'CSSLayerBlockRule' || kind === 'CSSContainerRule' || kind === 'CSSScopeRule' || kind === 'CSSDocumentRule') {
        const inner = transformRules(rule.cssRules, ctx);
        if (!inner) continue;
        let head;
        if (kind === 'CSSMediaRule') head = '@media ' + rule.media.mediaText;
        else if (kind === 'CSSSupportsRule') head = '@supports ' + rule.conditionText;
        else if (kind === 'CSSLayerBlockRule') head = rule.name ? '@layer ' + rule.name : '@layer';
        else head = prelude(rule);
        if (head) out += head + '{' + inner + '}';
      }
      // @font-face, @page, @property, @namespace, @starting-style…: no colors to theme.
    }
    return out;
  }

  /**
   * Whole pipeline for one sheet's rule list.
   * @param {ArrayLike<any>} rules @param {Ctx} ctx @returns {string}
   */
  function transformSheet(rules, ctx) {
    collectVarUsage(rules, ctx);
    return transformRules(rules, ctx);
  }

  NS.css = { PROP_ROLE, SHORTHANDS, transformValue, transformRules, transformSheet, collectVarUsage, createContext, roleOf, varRole, TooBig, _valueCache: valueCache };
})(globalThis);
