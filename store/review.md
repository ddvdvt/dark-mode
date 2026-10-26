# Chrome Web Store — Privacy practices & review notes (Dark Mode)

Copy each block into the matching field of the CWS developer dashboard.
`BASE` = the brand site address from `extension/lib/brand.js` (currently `https://ddvdvt.github.io/`).

## Single purpose

Dark Mode applies a dark color theme to the web pages the user visits, with controls for when and where it is applied (global and per-site switches, brightness/contrast/sepia, a schedule) — and nothing else.

## Permission justifications

**storage**
`chrome.storage.local` keeps the user's settings on the device: the global switch, the default engine, brightness/contrast/sepia, the schedule and the per-site list (sites the user turned off, or forced on). Nothing is synced or sent anywhere.

**Content script on all sites (`content_scripts.matches: ["<all_urls>"]`, `run_at: document_start`)**
A dark theme is only useful if it works on every page the user opens, and it must be applied before the page is first painted — otherwise every page flashes white before turning dark, which is the main complaint about dark-theme extensions. This cannot be done with `activeTab` (it requires a click on every page and comes after the page has already painted). The content script:
- adds one small CSS rule before the first paint (`src/content/preload.css`: a dark canvas that switches itself off as soon as the script has read the settings);
- reads the page's own stylesheets and computed colors **locally** and adds `<style>` elements with dark colors (or one CSS filter in the "Fast" mode);
- never reads form fields, never sends page content anywhere and makes no network requests;
- answers the extension's own popup with the current state of the tab (site name, whether the theme is on, which engine, time to apply).

All logic is in the package (`lib/*.js`, `src/content/*.js`). The extension declares **no host permissions**, no `tabs`, no `scripting`, no `webRequest`, and no `web_accessible_resources`.

**Host permissions**
None requested (`host_permissions` is absent). The content-script match pattern above is the only site access.

## Remote code

No, I am not using remote code. All JavaScript and CSS is packaged with the extension; there are no remote scripts or styles, no `eval` / `new Function`, and the default extension CSP is used.

## Data usage

What user data do you plan to collect from users now or in the future? — **None of the listed types.**
(The extension processes page styles locally to recolor them; nothing about the pages is stored or transmitted. The only stored data are the user's own settings, including host names the user explicitly added to the per-site list; they stay in `chrome.storage.local`.)

Certifications (all three checked):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

`BASE` + `privacy/dark-mode.html` → `https://ddvdvt.github.io/privacy/dark-mode.html`

## Notes for the reviewer (test instructions)

No account or setup is needed.

1. Install, then open any regular website with a light design (for example `https://en.wikipedia.org/wiki/Moon`). The page is dark from the first frame — no white flash.
2. Click the extension icon. The popup shows the site, "Dark theme is on, engine: Smart" and the time it took to apply (a few milliseconds). Pages opened **before** installation need a reload (the popup offers a "Reload the page" button).
3. In the popup:
   - "Turn off for this site" restores the original page instantly; press it again to turn it back on.
   - "Engine for this site" → "Fast" switches to the CSS-filter engine (images and video keep their real colors).
   - Brightness / Contrast / Sepia sliders change the theme live.
   - The switch in the header turns the extension off everywhere.
4. Keyboard shortcut **Alt+Shift+L** toggles the current site (can be changed at `chrome://extensions/shortcuts`).
5. Open a site that already has its own dark design: the extension leaves it alone and the popup says "This site is already dark"; "Darken anyway" overrides it.
6. The settings page (link in the popup) has the default engine, the schedule (always / follow the system / by time), the per-site list with JSON export and import.

Browser pages (`chrome://`, the Chrome Web Store) cannot be changed by extensions; the popup says so.

After installation the extension opens one static welcome page (`BASE/welcome/dark-mode.html`); the uninstall URL is a static page (`BASE/bye/dark-mode.html`). No data or identifiers are added to these URLs.
