# Chrome Web Store listing — English

**Language:** English (en). The default listing language is Russian (`listing.ru.md`); the UI texts come from `extension/_locales` (Kazakh is there too).

## Title (from the manifest, 43 of 75 characters)

Dark Mode — fast dark theme for any website

Fallback if the title is considered too generic: "Night Screen — flash-free dark theme for websites".

## Short description (from the manifest, 114 of 132 characters)

Dark theme for any website with no white flash and no lag. Two engines, brightness, schedule, per-site list. Free.

## Category

Accessibility (fallback: Productivity)

## Detailed description

Bright white pages hurt at night. This extension recolors any website in calm night colors — immediately, before the page is first painted, so there is no white flash while it loads.

Fast

• The page's stylesheets are recolored once on load; new content is handled in small chunks while the browser is idle. Scrolling and typing stay smooth.
• The popup shows how long it took to apply the theme — usually a few milliseconds.
• For very heavy pages there is the "Fast" engine: a single CSS filter with almost zero load.

Two engines

• "Smart" recolors the site's own styles: backgrounds, text, borders, gradients, CSS variables. Images and video stay as they are.
• "Fast" inverts the page with a filter and gives photos, video and embedded players their original colors back.
• The engine can be chosen per site.

Careful

• Sites that already have a night design are left alone ("Darken anyway" if you want it).
• The layout never changes: only colors do. Form fields stay readable.
• Works inside frames on the page too.

Your way

• Turn it on or off for the current site with one button or Alt+Shift+L.
• A global switch, brightness, contrast and sepia.
• Schedule: always, follow the system, or by time (e.g. 20:00 to 07:00).
• A list of site rules with JSON export and import.
• Interface in Russian, English and Kazakh.

Privacy

The extension makes no network requests and has no ads, analytics or sign-up. Settings are stored only in your browser. Access to all sites is needed for exactly one thing: to recolor a page before it appears on screen.

Limitations

Browser pages and the extension store cannot be changed. Tabs opened before installation need a reload. In the "Fast" engine color emoji and some icons look inverted.

Free forever and open source (MIT).
