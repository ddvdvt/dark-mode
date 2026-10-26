// Service worker: keyboard shortcuts and the welcome / uninstall pages of the brand site.
// The dark theme itself is applied by the content script; nothing here touches pages.
import { brandUrls, welcomeUrlFor } from '../lib/brand.js';
import '../lib/settings.js';

const S = /** @type {any} */ (globalThis).DarkModeLib.settings;

chrome.runtime.onInstalled.addListener((details) => {
  const url = welcomeUrlFor(details && details.reason);
  if (url) chrome.tabs.create({ url }).catch(() => {});
});

// Page shown after the extension is removed (no data is sent: it is a plain static page).
try {
  chrome.runtime.setUninstallURL(brandUrls().bye).catch(() => {});
} catch {
  /* not available in this context */
}

async function toggleGlobal() {
  const r = await chrome.storage.local.get(S.STORAGE_KEY);
  const s = S.ensureSettings(r[S.STORAGE_KEY]);
  await chrome.storage.local.set({ [S.STORAGE_KEY]: { ...s, enabled: !s.enabled } });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-global') {
    toggleGlobal().catch(() => {});
  } else if (command === 'toggle-site' && tab && tab.id != null) {
    // The top frame of the tab knows its site and its current state.
    chrome.tabs.sendMessage(tab.id, { type: 'nd:toggle-site' }, { frameId: 0 }).catch(() => {
      /* no content script here (browser page, Web Store, tab opened before install) */
    });
  }
});
