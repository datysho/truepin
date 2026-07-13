// TruePin - service worker.
//
// Protection model, per tab:
//   protected = manual override (toolbar click), otherwise
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
// All per-tab state lives in chrome.storage.session: it survives service
// worker suspension and resets together with tab ids on browser restart.

const DEFAULTS = {
  autoLockPinned: true,
  showIcon: true,
  restoreClosed: true,
  restoreCooldownSec: 15,
};

const SCRIPTABLE = /^(https?|file|ftp):/i;
const RESTORE_MARKS_TTL_MS = 10 * 60 * 1000;
// Chrome unpins a pinned tab moments before closing it, firing onUpdated
// {pinned:false} and only then onRemoved. Within this window an unpin does
// not yet count as "the user removed protection".
const CLOSE_UNPIN_GRACE_MS = 500;

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
      title: isProtected
        ? "TruePin: вкладка защищена (клик - снять защиту)"
        : "TruePin: без защиты (клик - защитить)",
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
// that are already open - the single biggest reason the original extension
// felt broken. Inject programmatically into everything scriptable.
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

// --- content script messages ---------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !sender.tab || sender.tab.id === undefined || sender.tab.id < 0) {
    return;
  }
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
    // A protection drop caused by an unpin milliseconds ago is Chrome's own
    // unpin-on-close, not a user decision - the tab still counts as protected.
    const closeUnpinGrace =
      !state.protected &&
      state.unpinnedAt &&
      Date.now() - state.unpinnedAt < CLOSE_UNPIN_GRACE_MS;
    if (!state.protected && !closeUnpinGrace) return;
    // Whole window closing is a deliberate act; Cmd+Shift+T brings it back.
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
        "сними закрепление или выключи замок кликом по иконке расширения.",
    })
    .catch(() => {});
}

// --- toolbar button: manual lock toggle -------------------------------------
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

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  enqueue(() => toggleTab(tab), "toggle");
});

// Exposed for the e2e suite (reachable from extension contexts only).
globalThis.truePinToggle = async (tabId) => {
  const tab = await chrome.tabs.get(tabId);
  return enqueue(() => toggleTab(tab), "toggle-test");
};
