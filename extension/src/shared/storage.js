// Settings in chrome.storage.local (pages only; the content script reads storage directly).
import '../../lib/color.js';
import '../../lib/settings.js';

/** @type {any} */
export const S = /** @type {any} */ (globalThis).DarkModeLib.settings;

/** @returns {Promise<any>} Settings */
export async function loadSettings() {
  const r = await chrome.storage.local.get(S.STORAGE_KEY);
  return S.ensureSettings(r[S.STORAGE_KEY]);
}

/**
 * Read-modify-write. `fn` gets the current settings and returns the next ones.
 * @param {(s: any) => any} fn
 */
export async function updateSettings(fn) {
  const next = S.ensureSettings(fn(await loadSettings()));
  await chrome.storage.local.set({ [S.STORAGE_KEY]: next });
  return next;
}

/** @param {(s: any) => void} cb */
export function onSettingsChange(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[S.STORAGE_KEY]) cb(S.ensureSettings(changes[S.STORAGE_KEY].newValue));
  });
}

/**
 * Save text as a file from an extension page (no "downloads" permission needed).
 * @param {string} text @param {string} filename
 */
export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
