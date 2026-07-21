# TruePin - Chrome Web Store submission kit

Copy-paste-ready content for the Web Store listing, plus what has to be done by
hand in the Developer Dashboard.

## Package to upload

`dist/truepin-<version>.zip`, built by `./package.sh` (strips the dev `key` so
the store owns the production id; `manifest.json` sits at the zip root).

## Listing fields

**Name:** TruePin

**Summary (132 characters max):**
Protect pinned tabs from accidental closing, lock any tab, and save and restore sets of pinned tabs across your devices.

**Category:** Workflow & Planning

**Language:** English (8 locales are bundled: en, ru, uk, de, fr, es, pt, zh-CN)

**Detailed description:**

TruePin keeps your pinned tabs where they belong.

One rule: a pinned tab cannot be closed by accident. Any attempt to close it is
silently undone and the tab returns to its place. To close a pinned tab, unpin
it first - deliberate, never accidental.

Features:
- Accidental-close protection for pinned tabs - closes are instantly reversed.
- Lock any regular tab too - per-tab protection until you close Chrome.
- Protected tabs keep their page: a typed address or a link to another site opens in a tab next to it (each behavior has its own toggle).
- Mirror pinned tabs across all your windows; pin, unpin and close stay in sync (incognito windows are left alone).
- Save named sets of pinned tabs and restore them in one click.
- Sets sync across your devices through your Chrome account.
- Autosaves: the last 10 states of your pinned set, so you can roll back - even after closing a whole window.
- Native Chrome look, light / dark / auto theme, 8 languages.

TruePin works entirely in your browser. It makes no network requests, has no
analytics and no ads, and sends nothing anywhere. Privacy policy:
https://github.com/datysho/truepin/blob/main/PRIVACY.md

**Privacy policy URL:** https://github.com/datysho/truepin/blob/main/PRIVACY.md

## Privacy practices tab

- **Single purpose:** Protect pinned tabs from being closed accidentally, and
  save and restore sets of pinned tabs.
- **Permission justifications:**
  - tabs - detect pinned tabs, notice closes, reopen them, mirror across windows.
  - storage - save settings, autosaves (local) and named sets (synced).
  - sessions - silently reopen a just-closed protected tab.
  - webNavigation - notice address-bar or cross-site navigation in a protected
    tab so it opens in a new tab instead; processed locally.
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

## What's new in 3.15.1 (update submission)

User-visible, for the version notes if the form asks:
- New "Pin this tab" switch in the popup - pin or unpin the tab you are on
  without leaving it. The popup shows two switches for the current tab: "Pin
  this tab" and "Lock this tab" ("Lock this tab" is greyed for a pinned tab, and
  greyed shows its real protected state - on when the pin is protected). The
  global "Protect pinned tabs" toggle stays in Settings.
- The popup has a slim custom scrollbar that stays out of the way and fades in
  only while you point at the list; it also reserves its lane, so the content no
  longer shifts sideways the moment the bar appears.
- The popup's switches now open already in their correct position instead of
  animating into it.

## What's new in 3.12.1

User-visible, for the version notes if the form asks:
- Fixed: the toolbar icon could stay colored after disabling and re-enabling
  the extension while the settings still read "monochrome"; the icon now
  reapplies your chosen style on every start.
- Fixed: a protected tab in a live Google Meet call no longer forks into
  duplicate tabs when the call reconnects - in-page redirects stay in place.

## What's new in 3.12.0

User-visible, for the version notes if the form asks:
- Export/import: Options can write settings and named sets to a JSON file
  and read them back; sets merge by name, never deleting ones the file does
  not mention. No secrets exist in TruePin, so the file is clean.
- A locked tab you place into a tab group yourself now stays there - the
  "Always keep at the front" pull resumes when it leaves the group.
- Plays in concert with TrueTabs when both are installed: TruePin announces
  which tabs are locked to the front, TrueTabs reserves that stretch of the
  strip (pinned, then locked, then groups). Either works alone, unchanged.
- Updates from the Web Store now apply silently at a quiet moment; settings
  survive every version.
- Post-publish TODO carried by the release checklist: when TrueTabs gets its
  own Web Store id, add it to FAMILY_IDS in background.js (the dev-key id
  already works for unpacked installs).

## After approval

Done post-publish (16.07.2026): the assigned id `fkgkfmhkdgpeopigpbgohoblocpjakcf`
is in `TP_CWS_ID` and the PayPal Donate URL is in `TP_PAYPAL_URL` - the rate and
donate buttons in the popup footer are live. The donation itself stays out of
this listing on purpose: the ask lives after the value (popup footer, README,
GitHub Sponsor button), never on the storefront.