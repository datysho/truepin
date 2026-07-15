# TruePin - Privacy Policy

_Last updated: 14 July 2026_

TruePin is a browser extension that protects pinned tabs from being closed and
lets you save and restore sets of pinned tabs. Short version: everything stays
in your browser and your own Chrome account. Nothing is sent to the developer
or to any third party.

## What TruePin stores

- **Your settings** (auto-protect, mirror, notifications, icon style, theme,
  language) - in Chrome extension storage.
- **Autosaves** - the last 10 states of your pinned set, stored locally on your
  device (`chrome.storage.local`).
- **Named sets you save** - the addresses (URLs) of the pinned tabs in each set,
  stored in Chrome sync storage (`chrome.storage.sync`) so Chrome can carry them
  across the devices where you are signed in with Chrome Sync enabled.

That is the complete list. TruePin does not store passwords, form input,
browsing history, or the contents of any page.

## What TruePin does NOT do

- It does not send any data to the developer or to any external server.
- It makes no network requests. There are no analytics, no tracking, no
  advertising, and no third-party services.
- It does not sell or share your data with anyone. Your synced sets travel only
  through your own Google account's Chrome Sync, under Google's terms - the
  developer never sees them.

## Permissions and why they are needed

- **Tabs** - to detect pinned tabs, notice when one is closed, reopen it, and
  mirror pinned tabs across your windows.
- **Scripting / access to all sites (`<all_urls>`)** - a pinned tab can be on
  any website, so TruePin must be able to act on all sites to protect them. It
  only needs to know whether a tab is pinned and its address; it does not read
  page content and sends nothing anywhere.
- **Storage** - to save your settings, autosaves, and named sets as described.
- **Sessions** - to silently reopen a protected tab that was just closed.
- **Notifications** - to optionally tell you when a protected tab was brought
  back.
- **Favicon** - to show tab icons in the extension popup.

## Your control

Your data lives in your browser. Remove a saved set from the popup at any time,
or remove everything by uninstalling the extension (synced sets are also cleared
from your Chrome account when removed).

## Contact

Questions or requests: open an issue at
https://github.com/datysho/truepin/issues.
