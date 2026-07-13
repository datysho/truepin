// TruePin - service worker.
//
// Protection model, per tab:
//   protected = manual override (popup switch), otherwise
//               settings.autoLockPinned && tab.pinned
//
// Two layers of defense:
//   1. The content script arms a beforeunload confirmation dialog
//      ("Leave site?"). Chrome only shows it after the user has interacted
//      with the page (sticky user activation).
//   2. If a protected tab closes WITHOUT that dialog having been possible
//      (page never interacted with, page discarded by memory saver,
//      chrome:// pages where content scripts cannot run), the tab is
//      reopened via chrome.sessions. Closing the same URL again within the
//      cooldown is treated as deliberate and allowed through.
//
// On top of protection:
//   - Follow mode: opening a genuinely new empty window moves the pinned
//     tabs from the previously focused window into it.
//   - Snapshots: named sets of pinned tabs (storage.sync) plus a rolling
//     auto-snapshot (storage.local) as a safety net / undo. Restoring is a
//     diff: matching tabs are reused in place (no reload), missing ones are
//     created, extras are closed (guarded from the restore net).
//
// All per-tab state lives in chrome.storage.session: it survives service
// worker suspension and resets together with tab ids on browser restart.

const DEFAULTS = {
  autoLockPinned: true,
  showIcon: true,
  restoreClosed: true,
  restoreCooldownSec: 15,
  followNewWindow: true,
  autoSnapshot: true,
};

const SCRIPTABLE = /^(https?|file|ftp):/i;
const RESTORE_MARKS_TTL_MS = 10 * 60 * 1000;
// Chrome unpins a pinned tab moments before closing it, firing onUpdated
// {pinned:false} and only then onRemoved. Within this window an unpin does
// not yet count as "the user removed protection".
const CLOSE_UNPIN_GRACE_MS = 500;
// A window is "genuinely new" (Cmd+N) while its only tab is an empty page.
const NEW_TAB_URLS = /^(chrome:\/\/newtab|chrome:\/\/new-tab-page|about:blank)/i;
const SNAP_PREFIX = "snap:";
const AUTO_SNAP_KEY = "autoSnapshot";
const SELF_CLOSED_TTL_MS = 60 * 1000;
const AUTO_SNAP_DEBOUNCE_MS = 1500;

// --- serialized state mutations ----------------------------------------
// storage.session reads/writes are read-modify-write; a single queue keeps
// concurrent events (hello vs onUpdated vs onRemoved) from interleaving.
let queueTail = Promise.resolve();
// Diagnostics, readable from the SW console: chrome://extensions -> service worker.
globalThis.__tpDiag = { queued: 0, finished: 0, last: "", trace: [] };
function traceDiag(entry) {
  globalThis.__tpDiag.trace.push(entry);
  if (globalThis.__tpDiag.trace.length > 30) globalThis.__tpDiag.trace.shift();
}
function enqueue(job, label = "job") {
  globalThis.__tpDiag.queued++;
  const run = queueTail.then(() => {
    globalThis.__tpDiag.last = `${label} started`;
    return job();
  });
  queueTail = run.then(
    () => {
      globalThis.__tpDiag.finished++;
      globalThis.__tpDiag.last = `${label} finished`;
    },
    (err) => {
      globalThis.__tpDiag.finished++;
      globalThis.__tpDiag.last = `${label} failed: ${err && err.message}`;
      console.warn("[truepin]", err);
    },
  );
  return run;
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

const stateKey = (tabId) => `t${tabId}`;

// A restoring/navigating tab often has no committed url yet, only pendingUrl.
const tabUrl = (tab) => (tab && (tab.url || tab.pendingUrl)) || "";

async function getTabState(tabId) {
  const record = await chrome.storage.session.get(stateKey(tabId));
  return record[stateKey(tabId)] || null;
}

function newTabState(tab) {
  return {
    manual: null,
    activated: false,
    protected: false,
    pinned: !!(tab && tab.pinned),
    url: tabUrl(tab),
    unpinnedAt: null,
  };
}

async function putTabState(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
}

async function dropTabState(tabId) {
  await chrome.storage.session.remove(stateKey(tabId));
}

// --- applying state to the browser --------------------------------------
function computeProtected(state, settings) {
  if (state.manual === true || state.manual === false) return state.manual;
  return settings.autoLockPinned && state.pinned;
}

function applyToTab(tabId, state, settings) {
  // Push to the content script; harmless when none is running yet
  // (chrome:// pages, tab still loading) - the script pulls on start anyway.
  chrome.tabs
    .sendMessage(
      tabId,
      { type: "apply", locked: state.protected, showIcon: settings.showIcon },
      { frameId: 0 },
    )
    .catch(() => {});
  // Keep protected pages alive: a page discarded by the memory saver loses
  // its beforeunload handler and would close silently.
  chrome.tabs.update(tabId, { autoDiscardable: !state.protected }).catch(() => {});
  updateAction(tabId, state.protected);
}

function updateAction(tabId, isProtected) {
  const variant = isProtected ? "locked" : "unlocked";
  chrome.action
    .setIcon({
      tabId,
      path: {
        16: `icons/${variant}-16.png`,
        32: `icons/${variant}-32.png`,
        48: `icons/${variant}-48.png`,
        128: `icons/${variant}-128.png`,
      },
    })
    .catch(() => {});
  chrome.action
    .setTitle({
      tabId,
      title: isProtected ? "TruePin: вкладка защищена" : "TruePin: без защиты",
    })
    .catch(() => {});
}

async function refreshTab(tab, settings) {
  const state = (await getTabState(tab.id)) || newTabState(tab);
  state.pinned = !!tab.pinned;
  if (tabUrl(tab)) state.url = tabUrl(tab);
  state.protected = computeProtected(state, settings);
  await putTabState(tab.id, state);
  applyToTab(tab.id, state, settings);
  return state;
}

// --- bootstrap -----------------------------------------------------------
// On install/update the declared content scripts are NOT injected into tabs
// that are already open. Inject programmatically into everything scriptable.
async function bootstrapAll(injectScripts) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) continue;
    await refreshTab(tab, settings);
    if (injectScripts && SCRIPTABLE.test(tab.url || "") && !tab.discarded) {
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"],
          injectImmediately: true,
        })
        .catch(() => {}); // restricted or unloaded pages
    }
  }
}

chrome.runtime.onInstalled.addListener(() => enqueue(() => bootstrapAll(true), "installed"));
chrome.runtime.onStartup.addListener(() => enqueue(() => bootstrapAll(false), "startup"));

// Settings changed (options page) - recompute every tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  enqueue(() => bootstrapAll(false), "settings-changed");
});

// --- self-closed markers ------------------------------------------------
// Tabs the extension closes itself (snapshot restore) must not be brought
// back by the restore net.
async function markSelfClosed(tabIds) {
  const { selfClosed = {} } = await chrome.storage.session.get("selfClosed");
  const now = Date.now();
  for (const [id, ts] of Object.entries(selfClosed)) {
    if (now - ts > SELF_CLOSED_TTL_MS) delete selfClosed[id];
  }
  for (const id of tabIds) selfClosed[id] = now;
  await chrome.storage.session.set({ selfClosed });
}

async function wasSelfClosed(tabId) {
  const { selfClosed = {} } = await chrome.storage.session.get("selfClosed");
  if (!(tabId in selfClosed)) return false;
  delete selfClosed[tabId];
  await chrome.storage.session.set({ selfClosed });
  return true;
}

// --- messages (content scripts + popup UI) --------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.type !== "string") return;

  if (request.type.startsWith("ui:")) {
    enqueue(() => handleUi(request).then(sendResponse), request.type);
    return true;
  }

  if (!sender.tab || sender.tab.id === undefined || sender.tab.id < 0) return;
  const tab = sender.tab;

  if (request.type === "hello") {
    enqueue(async () => {
      const settings = await getSettings();
      const state = (await getTabState(tab.id)) || newTabState(tab);
      if (request.top) {
        // A fresh top-level document: its activation state starts over.
        state.activated = !!request.hasBeenActive;
      } else if (request.hasBeenActive) {
        state.activated = true;
      }
      state.pinned = !!tab.pinned;
      if (tabUrl(tab)) state.url = tabUrl(tab);
      state.protected = computeProtected(state, settings);
      await putTabState(tab.id, state);
      if (request.top) {
        chrome.tabs.update(tab.id, { autoDiscardable: !state.protected }).catch(() => {});
        updateAction(tab.id, state.protected);
      }
      sendResponse({ locked: state.protected, showIcon: settings.showIcon });
    }, "hello");
    return true; // async sendResponse
  }

  if (request.type === "activated") {
    // The page received real user input: from now on Chrome will show the
    // beforeunload dialog, so a close of this tab is a confirmed close.
    enqueue(async () => {
      const state = await getTabState(tab.id);
      if (state && !state.activated) {
        state.activated = true;
        await putTabState(tab.id, state);
      }
      sendResponse({});
    }, "activated");
    return true;
  }
});

// --- tab lifecycle ---------------------------------------------------------
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  enqueue(async () => {
    const settings = await getSettings();
    await refreshTab(tab, settings);
    if (tab.pinned) scheduleAutoSnapshot();
  }, "created");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const relevant =
    changeInfo.pinned !== undefined ||
    changeInfo.status === "loading" ||
    changeInfo.discarded !== undefined ||
    changeInfo.url !== undefined;
  if (!relevant) return;
  enqueue(async () => {
    traceDiag(`updated tab=${tabId} change=${JSON.stringify(changeInfo)}`);
    const settings = await getSettings();
    const state = (await getTabState(tabId)) || newTabState(tab);
    if (changeInfo.status === "loading" || changeInfo.discarded === true) {
      // New document, or the document was dropped from memory: whatever
      // activation the old document had is gone with it.
      state.activated = false;
    }
    state.pinned = !!tab.pinned;
    if (tabUrl(tab)) state.url = tabUrl(tab);
    const wasProtected = state.protected;
    state.protected = computeProtected(state, settings);
    if (wasProtected && !state.protected && changeInfo.pinned === false) {
      // Might be Chrome's own unpin-on-close; remember when it happened.
      state.unpinnedAt = Date.now();
    } else if (state.protected) {
      state.unpinnedAt = null;
    }
    await putTabState(tabId, state);
    applyToTab(tabId, state, settings);
    if (changeInfo.pinned !== undefined || (changeInfo.url && tab.pinned)) {
      scheduleAutoSnapshot();
    }
  }, "updated");
});

// Prerender/instant pages swap tab ids; carry the state over.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const state = await getTabState(removedTabId);
    await dropTabState(removedTabId);
    if (state) await putTabState(addedTabId, state);
  }, "replaced");
});

// --- the restore net --------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  enqueue(async () => {
    const state = await getTabState(tabId);
    await dropTabState(tabId);
    traceDiag(`removed tab=${tabId} winClosing=${removeInfo.isWindowClosing} state=${JSON.stringify(state)}`);
    if (!state) return;
    if (state.pinned || state.protected) scheduleAutoSnapshot();
    // Closed by the extension itself (snapshot restore): never bring back.
    if (await wasSelfClosed(tabId)) return;
    // A protection drop caused by an unpin milliseconds ago is Chrome's own
    // unpin-on-close, not a user decision - the tab still counts as protected.
    const closeUnpinGrace =
      !state.protected &&
      state.unpinnedAt &&
      Date.now() - state.unpinnedAt < CLOSE_UNPIN_GRACE_MS;
    if (!state.protected && !closeUnpinGrace) return;
    // Whole window closing is a deliberate act; Cmd+Shift+T brings it back
    // (and the auto-snapshot keeps the pinned set restorable from the popup).
    if (removeInfo.isWindowClosing) return;
    // The page had user activation, so Chrome showed the confirmation
    // dialog and the user chose to leave. Respect that.
    if (state.activated) return;

    const settings = await getSettings();
    if (!settings.restoreClosed) return;

    const url = state.url || "";
    const now = Date.now();
    const { recentRestores = {} } = await chrome.storage.session.get("recentRestores");
    for (const [markedUrl, ts] of Object.entries(recentRestores)) {
      if (now - ts > RESTORE_MARKS_TTL_MS) delete recentRestores[markedUrl];
    }
    if (recentRestores[url] && now - recentRestores[url] < settings.restoreCooldownSec * 1000) {
      // Closed again right after a restore: deliberate, let it go.
      await chrome.storage.session.set({ recentRestores });
      return;
    }
    recentRestores[url] = now;
    await chrome.storage.session.set({ recentRestores });
    await restoreTab(url, settings);
  }, "removed");
});

async function restoreTab(url, settings) {
  // The closed tab can take a moment to appear in the sessions list.
  for (let attempt = 0; attempt < 10; attempt++) {
    let sessions = [];
    try {
      sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    } catch {
      return;
    }
    const match = sessions.find((s) => s.tab && s.tab.sessionId && s.tab.url === url);
    if (match) {
      try {
        await chrome.sessions.restore(match.tab.sessionId);
      } catch {
        return;
      }
      notifyRestored(settings);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function notifyRestored(settings) {
  chrome.notifications
    .create({
      type: "basic",
      iconUrl: "icons/locked-128.png",
      title: "TruePin: вкладка восстановлена",
      message:
        "Защищённая вкладка была закрыта без подтверждения - вернул её на место. " +
        `Закрыть насовсем: закрой её ещё раз в течение ${settings.restoreCooldownSec} с, ` +
        "сними закрепление или выключи замок в попапе расширения.",
    })
    .catch(() => {});
}

// --- manual lock toggle ------------------------------------------------------
async function toggleTab(tab) {
  const settings = await getSettings();
  const state = (await getTabState(tab.id)) || newTabState(tab);
  state.pinned = !!tab.pinned;
  if (tabUrl(tab)) state.url = tabUrl(tab);
  state.manual = !computeProtected(state, settings);
  state.protected = state.manual;
  state.unpinnedAt = null; // an explicit toggle is always a user decision
  await putTabState(tab.id, state);
  applyToTab(tab.id, state, settings);
  return state;
}

// Exposed for the e2e suite (reachable from extension contexts only).
globalThis.truePinToggle = async (tabId) => {
  const tab = await chrome.tabs.get(tabId);
  return enqueue(() => toggleTab(tab), "toggle-test");
};
globalThis.__tpUiCall = (request) => enqueue(() => handleUi(request), `${request.type}-test`);

// --- window focus tracking ---------------------------------------------------
async function rememberFocus(windowId) {
  const { focusStack = [] } = await chrome.storage.session.get("focusStack");
  const next = [windowId, ...focusStack.filter((id) => id !== windowId)].slice(0, 10);
  await chrome.storage.session.set({ focusStack: next });
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  enqueue(() => rememberFocus(windowId), "focus");
});

chrome.windows.onRemoved.addListener((windowId) => {
  enqueue(async () => {
    const { focusStack = [] } = await chrome.storage.session.get("focusStack");
    await chrome.storage.session.set({ focusStack: focusStack.filter((id) => id !== windowId) });
  }, "window-removed");
});

// --- follow mode: pinned tabs move into a genuinely new window ----------------
chrome.windows.onCreated.addListener((win) => {
  enqueue(() => followIntoWindow(win), "window-created");
});

async function followIntoWindow(win) {
  const settings = await getSettings();
  if (!settings.followNewWindow) return;
  if (!win || win.type !== "normal" || win.incognito) return;

  // A genuinely new window (Cmd+N) has exactly one tab on an empty page.
  // Windows born from dragging a tab out, "open link in new window",
  // session restore or OAuth popups all fail this check and keep their tabs.
  let tabs = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    tabs = await chrome.tabs.query({ windowId: win.id }).catch(() => []);
    if (tabs.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (tabs.length !== 1) return;
  const url = tabUrl(tabs[0]);
  if (url && !NEW_TAB_URLS.test(url)) return;

  const donorId = await findDonorWindow(win.id);
  if (donorId === null) return;
  const pinned = await chrome.tabs.query({ windowId: donorId, pinned: true });
  if (!pinned.length) return;

  traceDiag(`follow: moving ${pinned.length} pinned from win=${donorId} to win=${win.id}`);
  for (let i = 0; i < pinned.length; i++) {
    try {
      // Cross-window move drops the pin; re-pin right away. No onRemoved
      // fires for moves, and the unpin grace keeps protection continuous.
      await chrome.tabs.move(pinned[i].id, { windowId: win.id, index: i });
      await chrome.tabs.update(pinned[i].id, { pinned: true });
    } catch (err) {
      traceDiag(`follow: move failed for tab=${pinned[i].id}: ${err && err.message}`);
    }
  }
}

// The most recently focused normal window (excluding the given one) that has
// pinned tabs; also serves as "the" pinned-home window for auto-snapshots.
async function findDonorWindow(excludeWindowId) {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const withPins = new Set();
  for (const w of windows) {
    if (w.id === excludeWindowId || w.incognito) continue;
    if ((w.tabs || []).some((t) => t.pinned)) withPins.add(w.id);
  }
  if (!withPins.size) return null;
  const { focusStack = [] } = await chrome.storage.session.get("focusStack");
  for (const id of focusStack) {
    if (withPins.has(id)) return id;
  }
  return withPins.values().next().value;
}

// --- snapshots -----------------------------------------------------------------
function snapshotFromTabs(tabs) {
  return {
    urls: tabs.map((t) => tabUrl(t)),
    titles: tabs.map((t) => t.title || ""),
    savedAt: Date.now(),
  };
}

const pinnedTabsOf = (windowId) => chrome.tabs.query({ windowId, pinned: true });

async function listSnapshots() {
  const all = await chrome.storage.sync.get(null);
  const named = Object.entries(all)
    .filter(([key]) => key.startsWith(SNAP_PREFIX))
    .map(([key, value]) => ({
      name: key.slice(SNAP_PREFIX.length),
      count: (value.urls || []).length,
      savedAt: value.savedAt || 0,
      auto: false,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
  const { [AUTO_SNAP_KEY]: auto } = await chrome.storage.local.get(AUTO_SNAP_KEY);
  const result = [];
  if (auto && (auto.urls || []).length) {
    result.push({ name: "Авто", count: auto.urls.length, savedAt: auto.savedAt || 0, auto: true });
  }
  return result.concat(named);
}

// Rolling safety net: the last non-empty pinned set. Never overwritten with
// an empty set, so "closed the window with all my pins" stays recoverable.
let autoSnapTimer = null;
function scheduleAutoSnapshot() {
  clearTimeout(autoSnapTimer);
  autoSnapTimer = setTimeout(() => {
    enqueue(writeAutoSnapshot, "auto-snapshot");
  }, AUTO_SNAP_DEBOUNCE_MS);
}

async function writeAutoSnapshot() {
  const settings = await getSettings();
  if (!settings.autoSnapshot) return;
  const homeId = await findDonorWindow(chrome.windows.WINDOW_ID_NONE);
  if (homeId === null) return; // no pinned tabs anywhere: keep the last set
  const pinned = await pinnedTabsOf(homeId);
  if (!pinned.length) return;
  const snap = snapshotFromTabs(pinned);
  const { [AUTO_SNAP_KEY]: prev } = await chrome.storage.local.get(AUTO_SNAP_KEY);
  if (prev && prev.urls && prev.urls.join("\n") === snap.urls.join("\n")) return;
  await chrome.storage.local.set({ [AUTO_SNAP_KEY]: snap });
}

async function saveSnapshot(name, windowId) {
  const pinned = await pinnedTabsOf(windowId);
  if (!pinned.length) return { error: "Нет закреплённых вкладок" };
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return { error: "Пустое имя" };
  await chrome.storage.sync.set({ [SNAP_PREFIX + clean]: snapshotFromTabs(pinned) });
  return { ok: true };
}

async function deleteSnapshot(name) {
  await chrome.storage.sync.remove(SNAP_PREFIX + name);
  return { ok: true };
}

// Diff-restore: reuse matching pinned tabs in place (no reload), create the
// missing ones, close the extras. The set being replaced is written to the
// auto-snapshot first, so a restore is always undoable from "Авто".
async function restoreSnapshot({ name, auto }, windowId) {
  let snap;
  if (auto) {
    ({ [AUTO_SNAP_KEY]: snap } = await chrome.storage.local.get(AUTO_SNAP_KEY));
  } else {
    ({ [SNAP_PREFIX + name]: snap } = await chrome.storage.sync.get(SNAP_PREFIX + name));
  }
  if (!snap || !(snap.urls || []).length) return { error: "Набор пуст или не найден" };

  const current = await pinnedTabsOf(windowId);
  if (current.length && !auto) {
    await chrome.storage.local.set({ [AUTO_SNAP_KEY]: snapshotFromTabs(current) });
  }

  const used = new Set();
  let reused = 0;
  let created = 0;
  for (let i = 0; i < snap.urls.length; i++) {
    const url = snap.urls[i];
    const match = current.find((t) => !used.has(t.id) && tabUrl(t) === url);
    if (match) {
      used.add(match.id);
      reused++;
      if (match.index !== i) {
        await chrome.tabs.move(match.id, { index: i }).catch(() => {});
      }
    } else {
      try {
        const tab = await chrome.tabs.create({ windowId, url, pinned: true, index: i, active: false });
        used.add(tab.id);
        created++;
      } catch (err) {
        traceDiag(`restoreSnapshot: create failed for ${url}: ${err && err.message}`);
      }
    }
  }
  const extras = current.filter((t) => !used.has(t.id)).map((t) => t.id);
  if (extras.length) {
    await markSelfClosed(extras);
    await chrome.tabs.remove(extras).catch(() => {});
  }
  traceDiag(`restoreSnapshot: reused=${reused} created=${created} closed=${extras.length}`);
  return { ok: true, reused, created, closed: extras.length };
}

// --- popup UI backend -----------------------------------------------------------
async function handleUi(request) {
  switch (request.type) {
    case "ui:getState": {
      const settings = await getSettings();
      const pinned = await pinnedTabsOf(request.windowId);
      let active = null;
      if (request.tabId !== undefined) {
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        if (tab) {
          const state = (await getTabState(tab.id)) || newTabState(tab);
          active = {
            id: tab.id,
            title: tab.title || "",
            pinned: !!tab.pinned,
            protected: computeProtected({ ...state, pinned: !!tab.pinned }, settings),
          };
        }
      }
      return {
        pinned: pinned.map((t) => ({ id: t.id, title: t.title || tabUrl(t), url: tabUrl(t) })),
        active,
        snapshots: await listSnapshots(),
        settings,
      };
    }
    case "ui:toggle": {
      const tab = await chrome.tabs.get(request.tabId).catch(() => null);
      if (!tab) return { error: "Вкладка не найдена" };
      const state = await toggleTab(tab);
      return { ok: true, protected: state.protected };
    }
    case "ui:saveSnapshot":
      return saveSnapshot(request.name, request.windowId);
    case "ui:deleteSnapshot":
      return deleteSnapshot(request.name);
    case "ui:restoreSnapshot":
      return restoreSnapshot({ name: request.name, auto: request.auto }, request.windowId);
    default:
      return { error: `unknown ${request.type}` };
  }
}
