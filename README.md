# TruePin

Pinned tabs, done right: a Chrome extension that makes pinned tabs impossible to close.

One rule: **a protected tab does not close**. Any close - the ✕, Cmd+W, a script, another extension - is undone instantly: the tab comes right back, pinned, with its history, with a short notification (can be turned off in the options). No dialogs. To actually close a tab, unpin it first, then close it. Reloading and navigating are free - the tab is not going anywhere, after all.

On top of the protection: pinned tabs are mirrored into every window (each window holds a copy of the set), named sets can be saved and restored from the popup, and the last 10 states are kept as autosaves. The UI is localized: en, ru, uk, de, fr, es, pt, zh.

## How it works
- A tab is protected when it is pinned and auto-protection is on, or when it carries a manual lock from the popup.
- When a protected tab closes, the service worker catches `onRemoved` and brings the tab back via `chrome.sessions` (history, scroll and form state survive); if there is no sessions entry, it re-creates the tab by URL. A manual lock is carried over to the reopened tab.
- Unpinning is the deliberate act: it removes the protection, the tab stays as a regular one, and its copies in other windows close. The fake unpin Chrome performs on its own while closing a pinned tab is filtered out by a 500 ms grace window.
- All state lives in `storage.session`: it survives service worker suspension and resets together with tab ids when the browser restarts.

## Mirroring: pinned tabs in every window
Pinned tabs form logical groups, and every group is present in every normal window:
- A new window (any normal one: Cmd+N, "open in new window", dragging a tab out) receives a copy of every pinned tab. The fill waits for the window to finish building its own tab strip (session restore) and adopts its tabs first - no duplicates.
- Reloading the extension or the browser converges without duplicates: the rebuild adopts existing pins first (exact page match, then same-origin - for SPA copies whose paths diverged) and only then creates anything.
- Pin a tab in one window - copies appear in all the others.
- Close a copy - it comes right back (the rule is the same in every window).
- Unpin - the tab stays as a regular one in that window, its copies elsewhere close.
- Copies are live, independent instances of the same page: navigating inside one does not touch its siblings. Incognito is left alone. Can be turned off in the options.

## Pinned sets (popup on the toolbar icon)
- The popup shows the current pinned tabs (with favicons), a 🔒 on each protected one, saving the set under a name, the list of sets and a collapsible list of autosaves. The lock is drawn from each tab's real protected state, so it is correct even for a discarded pin that carries no 🔒 title prefix.
- The switch at the top is contextual: on a pinned tab it toggles the protection of all pinned tabs (the global mechanism); on a regular tab it is that tab's own manual lock.
- **Restoring is a smart diff:** tabs that match by URL stay in place without reloading; missing ones open; extras close. Order follows the set. The result is mirrored into all windows.
- **Autosaves keep the last 10 states of the set.** An entry is written when the set changes structurally: a pinned tab is added, removed, or navigates to a different page; query-string/hash-only changes do not count. They are the safety net (closed a window with all your pins - bring them back) and the undo: before a set is restored, the current state goes into the autosaves.
- Named sets live in `storage.sync` - with Chrome sync enabled they travel to other machines; autosaves are local.

## Split View
- Tabs in Chrome's split view are ordinary tabs to the protection: closing a protected split member brings it right back.
- The tabs Chrome itself creates for the split gesture are ephemeral and invisible to the extension: the "Choose a tab to add to split view" picker (a real pinned tab at `chrome://tab-search.top-chrome/split_new_tab_page.html` - `kChromeUISplitViewNewTabPageURL` - that Chrome closes by itself once a tab is picked) and the blank new-tab partner. Neither is protected, mirrored or saved into sets, so building or dismissing a split never leaves phantom empty pins behind and nothing resurrects the picker after the choice. As soon as such a tab navigates to a real page, it becomes a first-class pin: protected, mirrored, snapshotted. Snapshots written by older versions that caught the picker are cleaned on read. The empty-page rule recognizes the new-tab pages of the other Chromium browsers too (Edge incl. `ntp.msn.com`, Opera, Vivaldi, Brave).
- Chrome exposes split view to extensions read-only: `tab.splitViewId` can be read and queried, but no API creates or modifies a split - not in Chrome 148 and not yet in the current Chromium source (`tabs.update` does not accept `splitViewId`; there is no splitView namespace). The honest consequences: a reopened tab returns pinned but outside its former split, mirror copies in other windows are not split, and restoring a set cannot re-create splits.
- Within that limit TruePin preserves everything it can:
  - Sets and autosaves record the split pairs (`splits`); the popup marks tabs that sit in a split and sets that carry pairs with ⧉.
  - Restoring a set never tears a live split apart: a matched tab that sits in a split is reused in place and not moved (the split wins over exact ordering).
  - Mirror copies of a split pair land adjacent in the pin strip of every window, so re-splitting them is one gesture.
  - The moment Chrome ships a write API, the stored pairs become real splits on restore.

## Closing a protected tab
- Pinned: unpin it, then close.
- Manually locked: turn off "Lock this tab" in the popup, then close.
- There is no other way - that is the point.

## Install
1. `chrome://extensions` - enable Developer mode.
2. Load unpacked - pick the `extension/` folder of this repository.
3. Done: pinned tabs are protected automatically. Settings: right-click the icon - Options.

After a `git pull` with changes, hit Reload on the extension card. If the repository folder moves, remove the extension and load it again from the new path.

## Settings
Auto-protect pinned tabs (on) - mirror across windows (on) - autosaves (on) - notification on reopen (on) - toolbar icon: color or gray matching the browser UI - language (auto-detect plus manual choice: en, ru, uk, de, fr, es, pt, zh). A manual lock lasts until the browser session ends.

## Support
TruePin is free and complete - nothing is paywalled, ever.

## Honest limits
- Closing a whole window and Cmd+Q are not undone: those are window-level acts (Cmd+Shift+T brings the window back; the pinned set is also in the autosaves and mirrored in other windows).
- With auto-protection off, pinned tabs close normally; closing a copy is then synced across windows.
- A reopened tab gets a new tab id; for pages without a `chrome.sessions` entry the re-create fallback loses the back/forward history (the page and URL survive).

## Development
- `extension/` - MV3: `background.js` (reopen-protection, mirror groups, sets and autosaves), `popup.*` (UI), `options.*`, `i18n.js` + `_locales/` (8 languages), `icons/`. No content scripts and no host permissions - the protection runs entirely from the service worker via `chrome.tabs`/`chrome.sessions`.
- Tests: `cd test && npm install && npm test` - e2e on puppeteer against a real Chrome for Testing: 26 scenarios (immortality under every close method, repeated closes, the reopen notification, free reload/navigation, the unpin-then-close path, manual lock carried over to the reopened tab, regular tabs untouched, settings, the global toggle from the popup, the state-driven popup lock (real protection, not the title prefix), snapshot diff-restore, autosave triggers, popup rendering incl. long set names, mirroring across three windows, adoption without duplicates, the ephemeral split-view partner rule, the split-view picker rule (never registered, never resurrected, poisoned autosaves sanitized on read), extension reload without duplicates (simulated; the repro test is proven to fail on the old code), mirror off, localization, a clean service worker log). `HEADFUL=1 npm test` to watch.
- `test/shot.mjs <out.png>` - a popup screenshot with real data (for UI work).
- Live diagnostics: `chrome://extensions` - service worker - console, the `__tpDiag` object (job queue and a trace of recent events).
