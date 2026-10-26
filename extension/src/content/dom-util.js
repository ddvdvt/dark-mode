// Small DOM helpers shared by the engines (content script, isolated world).
(function (root) {
  'use strict';
  const NS = (root.DarkModeLib = root.DarkModeLib || {});

  /** Attribute that marks every node created by the extension. */
  const MARK = 'data-nd-s';

  /**
   * Create one of our <style> elements.
   * @param {string} role short name, e.g. "base", "filter", "fallback", "o" (override)
   * @param {string} text
   */
  function makeStyle(role, text) {
    const el = document.createElement('style');
    el.setAttribute(MARK, role);
    el.textContent = text;
    return el;
  }

  /** @param {Node | null} n */
  const isOurs = (n) => !!n && n.nodeType === 1 && /** @type {Element} */ (n).hasAttribute(MARK);

  /** Put a style first in <html> (lowest priority among author styles). */
  function prepend(el) {
    const html = document.documentElement;
    if (html.firstChild !== el) html.insertBefore(el, html.firstChild);
  }

  /** Put a style last in <html> (after <body>: wins on equal specificity). */
  function append(el) {
    const html = document.documentElement;
    if (html.lastChild !== el) html.appendChild(el);
  }

  /**
   * requestIdleCallback with a fallback; the callback gets a deadline.
   * @param {(d: { timeRemaining: () => number, didTimeout?: boolean }) => void} cb
   * @param {number} [timeout]
   */
  function idle(cb, timeout = 500) {
    if (typeof requestIdleCallback === 'function') return requestIdleCallback(cb, { timeout });
    const start = performance.now();
    return setTimeout(() => cb({ timeRemaining: () => Math.max(0, 12 - (performance.now() - start)) }), 1);
  }

  /** Run `fn` once the DOM is parsed (immediately if it already is). */
  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  /** Run `fn` after window load (immediately if already loaded). */
  function onLoad(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  }

  let noTransitionDepth = 0;
  /** @type {HTMLStyleElement | null} */
  let noTransitionEl = null;

  /**
   * Switch CSS transitions off while we change colors (applying, removing or measuring the theme):
   * pages with `transition: all` would otherwise animate every element from light to dark — a
   * visible flicker. Returns the function that switches them back on; before doing so it flushes the
   * style change, so the restored transitions never see a color change. Nestable.
   * @returns {() => void}
   */
  function transitionsOff() {
    const html = document.documentElement;
    if (!html) return () => {};
    if (noTransitionDepth++ === 0) {
      noTransitionEl = makeStyle('nt', '*,*::before,*::after{transition:none!important}');
      html.appendChild(noTransitionEl);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--noTransitionDepth > 0) return;
      const el = noTransitionEl;
      noTransitionEl = null;
      if (!el) return;
      void (document.documentElement && document.documentElement.offsetWidth); // flush styles while transitions are off
      el.remove();
    };
  }

  /** Run `fn` with transitions off (see transitionsOff). */
  function withoutTransitions(fn) {
    const restore = transitionsOff();
    try {
      return fn();
    } finally {
      restore();
    }
  }

  NS.dom = { MARK, makeStyle, isOurs, prepend, append, idle, onReady, onLoad, transitionsOff, withoutTransitions };
})(globalThis);
