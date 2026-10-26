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


  // Color tokens inside a value. Strings and url() are matched only to be skipped. rgb()/hsl() may hold
  // one level of var() (Tailwind 3: rgb(255 255 255 / var(--tw-bg-opacity)), Bootstrap: rgba(var(--x-rgb), .5)).
  const TOKEN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)|#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\((?:[^()]|var\([^()]*\))*\)|\b(?:hwb|lab|lch|oklch|oklab|color)\([^()]*\)|(?<![\w-])[a-z]{3,20}(?![\w(-])/gi;

  /** "H S% L%" / "R, G, B" — a custom property that holds only the channels of a color. */
  const CHANNELS_RE = /^\s*(-?[\d.]+(?:deg|turn|g?rad)?)(\s*,\s*|\s+)(-?[\d.]+%?)\s*,?\s*(-?[\d.]+%?)\s*$/i;

  /** @type {Map<string, string>} */
  const valueCache = new Map();
  const CACHE_MAX = 20000;

  /** @param {string} s */
  const isCustom = (s) => s.charCodeAt(0) === 45 && s.charCodeAt(1) === 45;
  const r1 = (x) => Math.round(x * 10) / 10;

  /** rgb()/hsl() with literal channels and a var() alpha: transform the channels, keep the alpha. */
  function alphaVar(tok, role) {
    const open = tok.indexOf('(');
    const fn = tok.slice(0, open).toLowerCase().replace(/a$/, '');
    const inner = tok.slice(open + 1, -1);
    let ch, alpha;
    const slash = inner.lastIndexOf('/');
    if (slash >= 0) {
      ch = inner.slice(0, slash);
      alpha = inner.slice(slash + 1).trim();
    } else {
      const parts = C.splitTop(inner);
      if (parts.length !== 4) return tok;
      ch = parts.slice(0, 3).join(' ');
      alpha = parts[3];
    }
    if (ch.indexOf('var(') >= 0) return tok; // channels in a variable: handled where the variable is defined
    const c = C.parseColor(fn + '(' + ch + ')');
    if (!c) return tok;
    const d = C.darken(c, role);
    return `rgb(${d.r} ${d.g} ${d.b} / ${alpha})`;
  }

  /**
   * Replace every color inside a CSS value (gradients, shadows, shorthands) with its dark-theme
   * version. url(...), strings and keywords like currentcolor/inherit/system colors are untouched. Cached.
   * @param {string} value @param {Role} role @returns {string}
   */
  function transformValue(value, role) {
    const key = role + '|' + value;
    const hit = valueCache.get(key);
    if (hit !== undefined) return hit;
    const out = value.replace(TOKEN_RE, (tok) => {
      const c0 = tok.charCodeAt(0);
      if (c0 === 34 || c0 === 39) return tok;
      if ((c0 === 117 || c0 === 85) && /^url\(/i.test(tok)) return tok;
      if (tok.indexOf('var(') >= 0) return alphaVar(tok, role);
      const c = C.parseColor(tok);
      if (!c || (c.a === 0 && tok.toLowerCase() === 'transparent')) return tok;
      return C.formatColor(C.darken(c, role));
    });
    if (valueCache.size >= CACHE_MAX) valueCache.clear();
    valueCache.set(key, out);
    return out;
  }

  /**
   * A custom property holding bare channels ("222.2 84% 4.9%", "13, 110, 253"), used as hsl(var(--x))
   * or rgba(var(--x), a): transform it as a color, keep the channel format.
   * @param {string} value @param {'rgb' | 'hsl'} fn @param {Role} role
   */
  function transformChannels(value, fn, role) {
    const m = CHANNELS_RE.exec(value);
    if (!m) return value;
    const sep = m[2].indexOf(',') >= 0 ? ', ' : ' ';
    const c = C.parseColor(`${fn}(${m[1]} ${m[3]} ${m[4]})`);
    if (!c) return value;
    const d = C.darken(c, role);
    if (fn === 'hsl') {
      const h = C.rgbToHsl(d);
      return `${r1(h.h)}${sep}${r1(h.s * 100)}%${sep}${r1(h.l * 100)}%`;
    }
    return `${d.r}${sep}${d.g}${sep}${d.b}`;
  }

  /** @param {string} prop @returns {Role | undefined} */
  const roleOf = (prop) => PROP_ROLE[prop];

  /**
   * @typedef {object} Ctx
   * @property {Map<string, Set<Role>>} varRoles   how each custom property is used (filled while reading)
   * @property {Map<string, Set<string>>} varAliases --a: var(--b) → b is used like a
   * @property {Map<string, 'rgb' | 'hsl'>} varChannels custom properties used as rgb(var(--x)) / hsl(var(--x))
   * @property {Set<string>} varDefs custom properties defined in readable stylesheets
   * @property {Set<string>} varNonColor custom properties with a definition that is not a plain color
   * @property {number} version   bumped whenever what is known about variables changes
   * @property {WeakMap<object, any>} ruleCache plan node per CSSStyleRule (CSSOM reads are the expensive part)
   * @property {number} rules     style rules visited
   * @property {number} decls     declarations rewritten
   * @property {number} maxRules  abort with TooBig above this
   * @property {boolean} unreadable  an @import could not be read (cross-origin)
   */

  /** @param {Partial<Ctx>} [o] @returns {Ctx} */
  function createContext(o = {}) {
    return {
      varRoles: new Map(),
      varAliases: new Map(),
      varChannels: new Map(),
      varDefs: new Set(),
      varNonColor: new Set(),
      version: 0,
      ruleCache: new WeakMap(),
      rules: 0,
      decls: 0,
      maxRules: 100000,
      unreadable: false,
      ...o,
    };
  }

  class TooBig extends Error {}

  const VAR_RE = /var\(\s*(--[\w-]+)/g;
  const SINGLE_VAR_RE = /^\s*var\(\s*(--[\w-]+)\s*\)\s*$/;
  const CHANNEL_USE_RE = /\b(rgba?|hsla?)\(\s*var\(\s*(--[\w-]+)/gi;

  /** @param {Map<string, Set<any>>} map */
  function addTo(ctx, map, key, value) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    if (!set.has(value)) {
      set.add(value);
      ctx.version++;
    }
  }

  /** @param {Ctx} ctx @param {string} value @param {Role} role */
  function noteVars(ctx, value, role) {
    if (value.indexOf('var(') < 0) return;
    for (const m of value.matchAll(VAR_RE)) addTo(ctx, ctx.varRoles, m[1], role);
    for (const m of value.matchAll(CHANNEL_USE_RE)) {
      if (!ctx.varChannels.has(m[2])) {
        ctx.varChannels.set(m[2], /** @type {'rgb' | 'hsl'} */ (m[1].toLowerCase().slice(0, 3)));
        ctx.version++;
      }
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

  /** Every role a custom property is used in; aliases inherit roles of the variables using them. */
  function varRoleSet(name, ctx, depth) {
    const own = ctx.varRoles.get(name);
    const users = depth < 4 ? ctx.varAliases.get(name) : null;
    if (!users) return own || new Set();
    const set = new Set(own || []);
    for (const user of users) for (const r of varRoleSet(user, ctx, depth + 1)) set.add(r);
    return set;
  }

  /** Used in more than one role (text and background…): gets one alias per role. */
  function isMixedSet(set) {
    let n = 0;
    for (const r of set) if (r !== 'generic') n++;
    return n > 1 && !(n === 2 && set.has('bg') && set.has('shadow'));
  }

  /** Role of a custom property from its usage. */
  function varRole(name, ctx) {
    const set = varRoleSet(name, ctx, 0);
    if (set.size === 1) return /** @type {Role} */ ([...set][0]);
    if (set.size === 2 && set.has('bg') && set.has('shadow')) return 'bg';
    return 'generic';
  }

  const isMixed = (name, ctx) => ctx.varDefs.has(name) && isMixedSet(varRoleSet(name, ctx, 0));
  /** --color-white → --nd-fg-color-white */
  const aliasName = (name, role) => '--nd-' + role + name.slice(1);
  const ROLES = /** @type {Role[]} */ (['bg', 'fg', 'border', 'shadow']);

  /**
   * In a value used with `role`, point var(--x) of mixed-role variables to the alias of that role:
   * var(--x, f) → var(--nd-<role>-x, var(--x, f)) (the original stays as the fallback).
   */
  function rewriteRefs(value, role, ctx) {
    if (role === 'generic' || value.indexOf('var(') < 0) return value;
    let out = '';
    let i = 0;
    for (;;) {
      const j = value.indexOf('var(', i);
      if (j < 0) return out + value.slice(i);
      const m = /^var\(\s*(--[\w-]+)/.exec(value.slice(j));
      if (!m || !isMixed(m[1], ctx)) {
        out += value.slice(i, j + 4);
        i = j + 4;
        continue;
      }
      let depth = 0, k = j;
      for (; k < value.length; k++) {
        const ch = value.charCodeAt(k);
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) break;
      }
      if (k >= value.length) return out + value.slice(i);
      const head = j + m[0].length; // "var(--x" — only the fallback part can hold more references
      out += value.slice(i, j) + 'var(' + aliasName(m[1], role) + ', ' + value.slice(j, head) + rewriteRefs(value.slice(head, k + 1), role, ctx) + ')';
      i = k + 1;
    }
  }

  /** Value of a custom property for a role (channel variables keep their format). */
  function transformVar(name, value, role, ctx) {
    const v = rewriteRefs(value, role, ctx);
    const fn = ctx.varChannels.get(name);
    return fn && CHANNELS_RE.test(v) ? transformChannels(v, fn, role) : transformValue(v, role);
  }

  /*
   * The sheet is read ONCE (CSSOM access is the expensive part) into a small plan that keeps only the
   * color declarations; custom-property usage is collected on the way. The plan is then emitted as CSS
   * text, when the roles of all variables of the sheet are known — and emitted again when later sheets
   * reveal more about the variables (ctx.version).
   *
   * Plan node: [kind, a, b, c]
   *   'S' style rule      a = selector, b = decls, c = nested plan | null
   *   'D' nested decls    b = decls
   *   'G' group at-rule   a = rule (for the prelude), c = inner plan
   *   'I' @import         a = media text, c = inner plan
   *   'K' keyframes       a = ready CSS text
   *   'N' @namespace      a = CSS text
   * decls: flat array [prop, value, role | null (custom property), style declaration, ...]
   */

  const MASKED = new Set(['background-color', 'background-image']);

  /** @param {any} st CSSStyleDeclaration @param {Ctx} ctx @returns {any[]} */
  function readDecls(st, ctx) {
    const out = [];
    let masked = null;
    for (let j = 0, n = st.length; j < n; j++) {
      const p = st[j];
      if (isCustom(p)) {
        const v = st.getPropertyValue(p);
        if (!v) continue;
        if (!ctx.varDefs.has(p)) {
          ctx.varDefs.add(p);
          ctx.version++;
        }
        if (!ctx.varNonColor.has(p) && !C.parseColor(v) && !CHANNELS_RE.test(v) && !SINGLE_VAR_RE.test(v)) ctx.varNonColor.add(p);
        if (v.indexOf('var(') >= 0) {
          for (const m of v.matchAll(VAR_RE)) addTo(ctx, ctx.varAliases, m[1], p);
          for (const m of v.matchAll(CHANNEL_USE_RE)) if (!ctx.varChannels.has(m[2])) (ctx.varChannels.set(m[2], /** @type {any} */ (m[1].toLowerCase().slice(0, 3))), ctx.version++);
        }
        out.push(p, v, null, st);
        continue;
      }
      let role = PROP_ROLE[p];
      if (!role) continue;
      if (MASKED.has(p)) {
        // an icon drawn with a CSS mask: its "background" is the glyph color, i.e. foreground
        if (masked === null) {
          const mi = st.getPropertyValue('mask-image') || st.getPropertyValue('-webkit-mask-image');
          masked = !!mi && mi !== 'none' && mi !== 'initial';
        }
        if (masked) role = 'fg';
      }
      let v = st.getPropertyValue(p);
      if (!v) {
        // written through a shorthand with var(): only learn how the variable is used
        const shs = SHORTHANDS[p];
        if (shs) for (let k = 0; k < shs.length; k++) if ((v = st.getPropertyValue(shs[k]))) break;
        if (v) {
          noteVars(ctx, v, role);
          // `background: var(--x)`: a single variable through a shorthand. Kept (role marked with ~) so
          // that a variable used both as text and background can still be pointed at its alias.
          if (p.endsWith('-color') && SINGLE_VAR_RE.test(v)) out.push(p, v.trim(), '~' + role, st);
        }
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

  const GROUPS = new Set(['CSSMediaRule', 'CSSSupportsRule', 'CSSLayerBlockRule', 'CSSContainerRule', 'CSSScopeRule', 'CSSDocumentRule', 'CSSStartingStyleRule']);

  /** @param {ArrayLike<any>} rules @param {Ctx} ctx @returns {any[]} */
  function readRules(rules, ctx) {
    const plan = [];
    for (let i = 0, n = rules.length; i < n; i++) {
      const rule = rules[i];
      const kind = rule.constructor.name;
      if (kind === 'CSSStyleRule') {
        if (++ctx.rules > ctx.maxRules) throw new TooBig('too many rules');
        let node = ctx.ruleCache.get(rule);
        if (node === undefined) {
          const decls = readDecls(rule.style, ctx);
          const sub = rule.cssRules;
          const nested = sub && sub.length ? readRules(sub, ctx) : null;
          node = decls.length || (nested && nested.length) ? ['S', rule.selectorText, decls, nested] : null;
          ctx.ruleCache.set(rule, node);
        }
        if (node) plan.push(node);
      } else if (kind === 'CSSNestedDeclarations') {
        const decls = readDecls(rule.style, ctx);
        if (decls.length) plan.push(['D', null, decls, null]);
      } else if (kind === 'CSSImportRule') {
        const inner = readRules(rulesOf(rule.styleSheet, ctx), ctx);
        if (inner.length) plan.push(['I', rule.media && rule.media.mediaText, null, inner]);
      } else if (kind === 'CSSKeyframesRule') {
        const text = keyframesText(rule);
        if (text) plan.push(['K', text, null, null]);
      } else if (kind === 'CSSNamespaceRule') {
        plan.push(['N', rule.cssText, null, null]);
      } else if (GROUPS.has(kind)) {
        const inner = readRules(rule.cssRules, ctx);
        if (inner.length) plan.push(['G', rule, null, inner]);
      }
      // @font-face, @page, @property, @layer statements…: no colors to theme.
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
      let role = d[i + 2];
      const imp = d[i + 3].getPropertyPriority(p) ? ' !important;' : ';';
      if (role && role.charCodeAt(0) === 126) {
        // through a shorthand: the longhand alone is safe only for a variable that holds a plain color
        const name = /** @type {RegExpExecArray} */ (SINGLE_VAR_RE.exec(v))[1];
        if (ctx.varNonColor.has(name) || !isMixed(name, ctx)) continue;
        role = role.slice(1);
      }
      if (role) {
        const t = transformValue(rewriteRefs(v, role, ctx), role);
        if (t === v) continue;
        ctx.decls++;
        body += p + ':' + t + imp;
        continue;
      }
      // custom property: one value, or one alias per role when it is used both as text and background
      const set = varRoleSet(p, ctx, 0);
      if (isMixedSet(set)) {
        const g = transformVar(p, v, 'generic', ctx);
        if (g !== v) body += p + ':' + g + imp;
        for (const r of ROLES) if (set.has(r)) body += aliasName(p, r) + ':' + transformVar(p, v, r, ctx) + imp;
        ctx.decls++;
        continue;
      }
      const t = transformVar(p, v, varRole(p, ctx), ctx);
      if (t === v) continue;
      ctx.decls++;
      body += p + ':' + t + imp;
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
      else if (k === 'N') continue;
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
   * Read a sheet's rule list into a plan (one pass over the CSSOM).
   * @param {ArrayLike<any>} rules @param {Ctx} ctx
   */
  function readSheet(rules, ctx) {
    return readRules(rules, ctx);
  }

  /**
   * Override CSS text for a plan. With `screen`, everything is wrapped in @media screen so that printing
   * uses the page's own colors (@namespace rules, which may not be nested, stay in front).
   * @param {any[]} plan @param {Ctx} ctx @param {{ screen?: boolean }} [opts]
   */
  function emitSheet(plan, ctx, opts = {}) {
    const body = emit(plan, ctx);
    if (!body || !opts.screen) return body;
    let ns = '';
    for (const n of plan) if (n[0] === 'N') ns += n[1];
    return ns + '@media screen{' + body + '}';
  }

  /** Does the plan define or use custom properties (its output depends on ctx.version)? */
  function planUsesVars(plan) {
    for (const [k, , b, c] of plan) {
      if (b) for (let i = 0; i < b.length; i += 4) if (b[i + 2] === null || b[i + 1].indexOf('var(') >= 0) return true;
      if (c && planUsesVars(c)) return true;
    }
    return false;
  }

  /**
   * Override CSS text for one sheet's rule list: one read pass over the CSSOM, then emit.
   * @param {ArrayLike<any>} rules @param {Ctx} ctx @param {{ screen?: boolean }} [opts] @returns {string}
   */
  function transformSheet(rules, ctx, opts) {
    return emitSheet(readSheet(rules, ctx), ctx, opts);
  }

  NS.css = {
    PROP_ROLE,
    SHORTHANDS,
    transformValue,
    transformChannels,
    transformSheet,
    readSheet,
    emitSheet,
    planUsesVars,
    createContext,
    roleOf,
    varRole,
    aliasName,
    TooBig,
    _valueCache: valueCache,
  };
})(globalThis);
