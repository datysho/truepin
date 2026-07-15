# TruePin - Chrome Web Store submission kit

Copy-paste-ready content for the Web Store listing, plus what has to be done by
hand in the Developer Dashboard.

## Package to upload

`dist/truepin-<version>.zip`, built by `./package.sh` (strips the dev `key` so
the store owns the production id; `manifest.json` sits at the zip root).

## Listing fields

**Name:** TruePin

**Summary (132 characters max):**
Protect pinned tabs from accidental closing, and save and restore sets of pinned tabs across your devices.

**Category:** Workflow & Planning

**Language:** English (8 locales are bundled: en, ru, uk, de, fr, es, pt, zh-CN)

**Detailed description:**

TruePin keeps your pinned tabs where they belong.

One rule: a pinned tab cannot be closed by accident. Any attempt to close it is
silently undone and the tab returns to its place. To close a pinned tab, unpin
it first - deliberate, never accidental.

Features:
- Accidental-close protection for pinned tabs - closes are instantly reversed.
- Mirror pinned tabs across all your windows; pin, unpin and close stay in sync (incognito windows are left alone).
- Save named sets of pinned tabs and restore them in one click.
- Sets sync across your devices through your Chrome account.
- Autosaves: the last 10 states of your pinned set, so you can roll back - even after closing a whole window.
- Native Chrome look, light / dark / auto theme, 8 languages.

TruePin works entirely in your browser. It makes no network requests, has no
analytics and no ads, and sends nothing anywhere. Privacy policy:
https://github.com/datysho/truepin/blob/main/PRIVACY.md

**Privacy policy URL:** https://github.com/datysho/truepin/blob/main/PRIVACY.md
(resolves once the repository is public)

## Privacy practices tab

- **Single purpose:** Protect pinned tabs from being closed accidentally, and
  save and restore sets of pinned tabs.
- **Permission justifications:**
  - tabs - detect pinned tabs, notice closes, reopen them, mirror across windows.
  - scripting + host access `<all_urls>` - a pinned tab can be on any site, so
    the content script must run on all sites to protect them; no page content is
    read or transmitted.
  - storage - save settings, autosaves (local) and named sets (synced).
  - sessions - silently reopen a just-closed protected tab.
  - notifications - optionally notify when a protected tab is restored.
  - favicon - show tab icons in the popup list.
- **Remote code:** No - all code is bundled in the package.
- **Data usage:** No user data is collected or transmitted. Certify: not sold,
  not used for purposes unrelated to the single purpose, not used for
  creditworthiness or lending.

## Assets to supply in the listing

- **Screenshots:** at least 1 (up to 5), 1280x800 or 640x400. Use the redesign
  popup and options shots.
- **Store icon:** 128x128 (already in the package as icons/locked-128.png; the
  listing also asks for a 128 upload).
- **Small promo tile (optional):** 440x280.

## Submission checklist

1. Make the repository public (so the privacy-policy and LICENSE URLs resolve).
2. Upload `dist/truepin-<version>.zip`.
3. Paste the listing fields above; add screenshots.
4. Fill the Privacy practices tab (single purpose, justifications, data = none).
5. Trader/non-trader: non-trader (already declared).
6. Submit for review.

## After approval

- Copy the assigned extension id into `TP_CWS_ID` (config.js) to light up the
  rate/review button, then publish an update.
- When a PayPal.me handle is available, set `TP_PAYPAL_URL` (config.js) to light
  up the donate button.