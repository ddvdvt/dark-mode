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
   * @property {Map<string, Set<Role>>} varRoles   how each custom property is used (filled while reading)
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

  /*
   * The sheet is read ONCE (CSSOM access is the expensive part) into a small plan that keeps only the
   * color declarations; custom-property usage is collected on the way. The plan is then emitted as CSS
   * text, when the roles of all variables of the sheet are known.
   *
   * Plan node: [kind, a, b, c]
   *   'S' style rule      a = selector, b = decls, c = nested plan | null
   *   'D' nested decls    b = decls
   *   'G' group at-rule   a = rule (for the prelude), c = inner plan
   *   'I' @import         a = media text, c = inner plan
   *   'K' keyframes       a = ready CSS text
   * decls: flat array [prop, value, role | null (custom property), style declaration, ...]
   */

  /** @param {any} st CSSStyleDeclaration @param {Ctx} ctx @returns {any[]} */
  function readDecls(st, ctx) {
    const out = [];
    for (let j = 0, n = st.length; j < n; j++) {
      const p = st[j];
      if (isCustom(p)) {
        const v = st.getPropertyValue(p);
        if (!v) continue;
        if (v.indexOf('var(') >= 0) {
          for (const m of v.matchAll(VAR_RE)) {
            let set = ctx.varAliases.get(m[1]);
            if (!set) ctx.varAliases.set(m[1], (set = new Set()));
            set.add(p);
          }
        }
        out.push(p, v, null, st);
        continue;
      }
      const role = PROP_ROLE[p];
      if (!role) continue;
      let v = st.getPropertyValue(p);
      if (!v) {
        // written through a shorthand with var(): only learn how the variable is used
        const shs = SHORTHANDS[p];
        if (shs) for (let k = 0; k < shs.length; k++) if ((v = st.getPropertyValue(shs[k]))) break;
        if (v) noteVars(ctx, v, role);
        continue;
      }
      noteVars(ctx, v, role);
      out.push(p, v, role, st);
    }
    return out;
  }

  /** @param {any} kf CSSKeyframesRule */
  function keyframesText(kf) {
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

  const GROUPS = new Set(['CSSMediaRule', 'CSSSupportsRule', 'CSSLayerBlockRule', 'CSSContainerRule', 'CSSScopeRule', 'CSSDocumentRule']);

  /** @param {ArrayLike<any>} rules @param {Ctx} ctx @returns {any[]} */
  function readRules(rules, ctx) {
    const plan = [];
    for (let i = 0, n = rules.length; i < n; i++) {
      const rule = rules[i];
      const kind = rule.constructor.name;
      if (kind === 'CSSStyleRule') {
        if (++ctx.rules > ctx.maxRules) throw new TooBig('too many rules');
        const decls = readDecls(rule.style, ctx);
        const sub = rule.cssRules;
        const nested = sub && sub.length ? readRules(sub, ctx) : null;
        if (decls.length || (nested && nested.length)) plan.push(['S', rule.selectorText, decls, nested]);
      } else if (kind === 'CSSNestedDeclarations') {
        const decls = readDecls(rule.style, ctx);
        if (decls.length) plan.push(['D', null, decls, null]);
      } else if (kind === 'CSSImportRule') {
        const inner = readRules(rulesOf(rule.styleSheet, ctx), ctx);
        if (inner.length) plan.push(['I', rule.media && rule.media.mediaText, null, inner]);
      } else if (kind === 'CSSKeyframesRule') {
        const text = keyframesText(rule);
        if (text) plan.push(['K', text, null, null]);
      } else if (GROUPS.has(kind)) {
        const inner = readRules(rule.cssRules, ctx);
        if (inner.length) plan.push(['G', rule, null, inner]);
      }
      // @font-face, @page, @property, @namespace, @starting-style…: no colors to theme.
    }
    return plan;
  }

  /** Text before the block of an at-rule, e.g. "@container card (min-width: 400px)". */
  function prelude(rule) {
    const kind = rule.constructor.name;
    if (kind === 'CSSMediaRule') return '@media ' + rule.media.mediaText;
    if (kind === 'CSSSupportsRule') return '@supports ' + rule.conditionText;
    if (kind === 'CSSLayerBlockRule') return rule.name ? '@layer ' + rule.name : '@layer';
    const t = String(rule.cssText || '');
    const i = t.indexOf('{');
    return i > 0 ? t.slice(0, i).trim() : '';
  }

  /** @param {any[]} d decls @param {Ctx} ctx */
  function emitDecls(d, ctx) {
    let body = '';
    for (let i = 0; i < d.length; i += 4) {
      const p = d[i], v = d[i + 1];
      const role = d[i + 2] || varRole(p, ctx);
      const t = transformValue(v, role);
      if (t === v) continue;
      ctx.decls++;
      body += p + ':' + t + (d[i + 3].getPropertyPriority(p) ? ' !important;' : ';');
    }
    return body;
  }

  /** @param {any[]} plan @param {Ctx} ctx @returns {string} */
  function emit(plan, ctx) {
    let out = '';
    for (let i = 0; i < plan.length; i++) {
      const [k, a, b, c] = plan[i];
      if (k === 'S') {
        const body = emitDecls(b, ctx);
        const nested = c ? emit(c, ctx) : '';
        if (body || nested) out += a + '{' + body + nested + '}';
      } else if (k === 'D') out += emitDecls(b, ctx);
      else if (k === 'K') out += a;
      else {
        const inner = emit(c, ctx);
        if (!inner) continue;
        if (k === 'I') out += a ? '@media ' + a + '{' + inner + '}' : inner;
        else {
          const head = prelude(a);
          if (head) out += head + '{' + inner + '}';
        }
      }
    }
    return out;
  }

  /**
   * Override CSS text for one sheet's rule list: one read pass over the CSSOM, then emit.
   * @param {ArrayLike<any>} rules @param {Ctx} ctx @returns {string}
   */
  function transformSheet(rules, ctx) {
    return emit(readRules(rules, ctx), ctx);
  }

  NS.css = { PROP_ROLE, SHORTHANDS, transformValue, transformSheet, createContext, roleOf, varRole, TooBig, _valueCache: valueCache };
})(globalThis);
