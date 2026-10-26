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

  NS.dom = { MARK, makeStyle, isOurs, prepend, append, idle, onReady, onLoad };
})(globalThis);
