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

  let quietDepth = 0;
  /** @type {Set<Animation> | null} animations that existed before our change */
  let quietBefore = null;

  /**
   * Keep CSS transitions out of our color changes (applying, removing or measuring the theme): pages
   * with `transition: all` would otherwise animate every element from light to dark — a visible
   * flicker. Returns the function to call after the change: it flushes styles (the browser creates the
   * transitions our change caused) and cancels exactly those, so they end at once. Nothing is added
   * to the page and no extra style recalculation is needed. Nestable.
   * @returns {() => void}
   */
  function transitionsOff() {
    if (typeof document.getAnimations !== 'function' || typeof CSSTransition === 'undefined') return () => {};
    if (quietDepth++ === 0) quietBefore = new Set(document.getAnimations());
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--quietDepth > 0) return;
      const before = quietBefore;
      quietBefore = null;
      const html = document.documentElement;
      if (!before || !html) return;
      void getComputedStyle(html).color; // style flush: transitions caused by our change are created now
      for (const a of document.getAnimations()) if (a instanceof CSSTransition && !before.has(a)) a.cancel();
    };
  }

  /**
   * Inside transitionsOff(): finish the transitions our change has caused so far, so that computed
   * styles read next are the final values, not the start of an animation (measuring a page with our
   * styles switched off would otherwise read our own dark colors back on `transition: background`).
   */
  function settleTransitions() {
    const before = quietBefore;
    const html = document.documentElement;
    if (!before || !html) return;
    void html.offsetWidth; // full style + layout update: every transition is created now
    for (const a of document.getAnimations()) if (a instanceof CSSTransition && !before.has(a)) a.cancel();
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

  NS.dom = { MARK, makeStyle, isOurs, prepend, append, idle, onReady, onLoad, transitionsOff, settleTransitions, withoutTransitions };
})(globalThis);
