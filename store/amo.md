# Firefox Add-ons (AMO) — listing and review notes (Dark Mode)

Upload `dist/dark-mode-<version>-firefox.zip` (built by `npm run zip:firefox`).
Add-on ID: `dark-mode@ddvdvt.github.io`. Minimum version: Firefox 140.0 (Android: 142.0).
The Russian listing texts can be reused from `listing.ru.md`; the UI is localized (ru, en, kk).

## Name

Dark Mode — fast dark theme for any website

## Summary (≤ 250 characters)

Dark theme for any website with no white flash and no lag. Two engines (smart recolor or fast filter), brightness, contrast, sepia, schedule and per-site rules. No network requests, no ads, no tracking. Free and open source.

## Description

Bright white pages hurt at night. This add-on recolors any website in calm night colors — immediately, before the page is first painted, so there is no white flash while it loads.

- Smart engine: recolors the site's own styles (backgrounds, text, borders, gradients, CSS variables); images and video stay as they are.
- Fast engine: a single CSS filter with almost zero load; photos, video and players get their original colors back.
- Sites that already have a night design are left alone ("Darken anyway" if you want it).
- The layout never changes, only colors. Form fields stay readable. Works inside frames.
- Turn it on or off for the current site with one button or Alt+Shift+L; a global switch; brightness, contrast and sepia.
- Schedule: always, follow the system theme, or by time. Site rules with JSON export and import.
- Interface in Russian, English and Kazakh.

Privacy: the add-on makes no network requests and has no ads, analytics or sign-up. Settings are stored only in your browser.

Limitations: Firefox's own pages (about:, addons.mozilla.org) cannot be changed. Tabs opened before installation need a reload.

## Categories

- Appearance
- Other (AMO has no "Accessibility" category)

## Tags

dark mode, dark theme, night mode, dark reader, accessibility, eye strain

## Homepage / support

- Homepage: https://ddvdvt.github.io/
- Privacy policy: https://ddvdvt.github.io/privacy/dark-mode.html (also paste the text of `PRIVACY.md` into the AMO privacy policy field)
- License: MIT

## Data collection (data_collection_permissions)

`"required": ["none"]` — the add-on collects and transmits nothing. It makes no network requests at all; settings live in `storage.local`.

## Notes for reviewers

**Source code:** not minified, not bundled, no build step, no remote code. The package is the `extension/` folder of the repository as is; only `manifest.json` is generated for Firefox by `scripts/firefox.mjs` (service worker → event page with the same file, gecko id, `minimum_chrome_version` removed). `lib/*.js` are plain scripts shared by content scripts and pages (content scripts cannot be modules).

**Permissions:**

- Content scripts on `<all_urls>` at `document_start` (`all_frames`, `match_origin_as_fallback` for about:blank/srcdoc frames) — the dark theme has to be applied on every page before its first paint, otherwise the page flashes white; `activeTab` cannot do that. The scripts only read the page's stylesheets/computed colors locally and add their own `<style>`/adopted stylesheets. Page content is never stored or sent anywhere.
- `storage` — settings and the per-site rule list in `storage.local`.
- No `host_permissions`, `tabs`, `scripting`, `webRequest`, `web_accessible_resources`.
- If the user withholds or revokes "Access your data for all websites", the popup says so and offers a button that calls `permissions.request({ origins: ['<all_urls>'] })`.

**Known linter warning:** `chrome.dom.openOrClosedShadowRoot is not supported` — the Chrome API is feature-detected; in Firefox the code uses the content-script property `element.openOrClosedShadowRoot` instead.

**How to test:**

1. Install and open any light website (e.g. https://en.wikipedia.org/wiki/Moon): it is dark from the first paint.
2. Toolbar button → "Turn off for this site" restores the original page; "Engine for this site" → "Fast" switches to the filter engine.
3. A site that is already dark (e.g. https://github.com with the dark theme) is left alone; the popup says so.
4. Options: schedule "Follow the system theme", sliders, site list export/import (JSON).

The add-on also opens a static welcome page on install and sets a static uninstall page (https://ddvdvt.github.io/); nothing is sent to them.
