// TruePin - service worker.
//
// Protection model, per tab (v3 - one rule, no dialogs):
//   protected = manual override (popup switch), otherwise
//               settings.autoLockPinned && tab.pinned
//   A protected tab CANNOT be closed: any close is undone immediately and
//   silently - the tab is reopened in place (chrome.sessions first, plain
//   re-create as a fallback). The one sanctioned way to close it is to
//   remove the protection first: unpin the tab (or flip the popup switch
//   for manually locked ones), then close. No beforeunload dialogs, no
//   notifications; reloading and navigating protected tabs is free.
//
// Mirroring: pinned tabs form logical GROUPS that exist in every normal
// window. A new window gets a copy of each group; pinning a tab creates
// copies elsewhere; unpinning keeps that tab as a regular one and closes
// its copies. Copies are live independent instances of the same page -
// navigation inside one copy is not forced onto its siblings.
//
// Snapshots: named sets of pinned tabs (storage.sync) plus a ring of the
// last 10 autosaves (storage.local). An autosave happens when the set
// changes structurally: a pin is added, removed, or navigates to a
// different page - query-string-only changes are ignored.
//
// All per-tab and group state lives in chrome.storage.session: it survives
// service worker suspension and resets together with tab ids on restart.

importScripts("i18n.js");

const DEFAULTS = {
  autoLockPinned: true,
  showIcon: true,
  mirrorPinned: true,
  autoSnapshot: true,
  language: "auto",
};

const SCRIPTABLE = /^(https?|file|ftp):/i;
// Chrome unpins a pinned tab moments before closing it, firing onUpdated
// {pinned:false} and only then onRemoved. Within this window an unpin does
// not yet count as "the user removed protection".
const CLOSE_UNPIN_GRACE_MS = 500;
// A real user unpin is confirmed when the tab still exists this long after
// the unpin event (a close-unpin would have removed it by then).
const UNPIN_CONFIRM_MS = 750;
const SELF_CLOSED_TTL_MS = 60 * 1000;
const AUTO_SNAPS_KEY = "autoSnaps";
const AUTO_SNAPS_MAX = 10;
const AUTO_SNAP_DEBOUNCE_MS = 1500;
const SNAP_PREFIX = "snap:";

// --- serialized state mutations ----------------------------------------
let queueTail = Promise.resolve();
// Diagnostics, readable from the SW console: chrome://extensions -> service worker.
globalThis.__tpDiag = { queued: 0, finished: 0, last: "", trace: [] };
function traceDiag(entry) {
  globalThis.__tpDiag.trace.push(entry);
  if (globalThis.__tpDiag.trace.length > 40) globalThis.__tpDiag.trace.shift();
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

// --- i18n ------------------------------------------------------------------
let i18nReady = null;
function ensureI18n() {
  i18nReady ??= getSettings().then((settings) => tpI18n.init(settings.language));
  return i18nReady;
}

const stateKey = (tabId) => `t${tabId}`;

// A restoring/navigating tab often has no committed url yet, only pendingUrl.
const tabUrl = (tab) => (tab && (tab.url || tab.pendingUrl)) || "";

// Page identity ignoring query string and hash: "the same page" for group
// matching and for autosave triggering.
function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url || "";
  }
}

async function getTabState(tabId) {
  const record = await chrome.storage.session.get(stateKey(tabId));
  return record[stateKey(tabId)] || null;
}

function newTabState(tab) {
  return {
    manual: null,
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

// Fire-and-forget calls often target a tab that is mid-close. With the
// promise form Chromium still logs "Unchecked runtime.lastError" for these
// per-tab errors even when the rejection is caught - the callback form with
// an explicit lastError read is the only quiet way.
const checked = () => void chrome.runtime.lastError;

// Promisified callback-form call: resolves with the result (undefined on
// error) and always reads lastError, so nothing is logged for dead tabs.
const quiet = (api, ...args) =>
  new Promise((resolve) =>
    api(...args, (result) => {
      void chrome.runtime.lastError;
      resolve(result);
    }),
  );

function applyToTab(tabId, state, settings) {
  chrome.tabs.sendMessage(
    tabId,
    { type: "apply", locked: state.protected, showIcon: settings.showIcon },
    { frameId: 0 },
    checked,
  );
  updateAction(tabId, state.protected);
}

function updateAction(tabId, isProtected) {
  const variant = isProtected ? "locked" : "unlocked";
  chrome.action.setIcon(
    {
      tabId,
      path: {
        16: `icons/${variant}-16.png`,
        32: `icons/${variant}-32.png`,
        48: `icons/${variant}-48.png`,
        128: `icons/${variant}-128.png`,
      },
    },
    checked,
  );
  ensureI18n().then(() => {
    chrome.action.setTitle(
      {
        tabId,
        title: tpI18n.t(isProtected ? "actionProtected" : "actionUnprotected"),
      },
      checked,
    );
  });
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

// --- pin groups (mirroring) -----------------------------------------------
// groups: { [gid]: { url, members: { [windowId]: tabId } } }
// order:  [gid] in pin-strip order.
// pending: [{ windowId, gid, url }] - copies we asked Chrome to create.
async function getMirror() {
  const { groups = {}, groupOrder = [], pendingCreates = [] } =
    await chrome.storage.session.get(["groups", "groupOrder", "pendingCreates"]);
  return { groups, order: groupOrder, pending: pendingCreates };
}

async function putMirror(mirror) {
  await chrome.storage.session.set({
    groups: mirror.groups,
    groupOrder: mirror.order,
    pendingCreates: mirror.pending,
  });
}

function groupOfTab(mirror, tabId) {
  for (const [gid, group] of Object.entries(mirror.groups)) {
    for (const memberId of Object.values(group.members)) {
      if (memberId === tabId) return gid;
    }
  }
  return null;
}

async function nextGid() {
  const { groupSeq = 0 } = await chrome.storage.session.get("groupSeq");
  await chrome.storage.session.set({ groupSeq: groupSeq + 1 });
  return `g${groupSeq + 1}`;
}

async function normalWindows() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.filter((w) => !w.incognito);
}

// Create a mirror copy of a group in a window; the pending record lets the
// onCreated handler adopt the new tab instead of treating it as a user pin.
async function createCopy(mirror, gid, windowId, index) {
  const group = mirror.groups[gid];
  mirror.pending.push({ windowId, gid, url: group.url });
  const tab = await quiet(chrome.tabs.create, {
    windowId,
    url: group.url,
    pinned: true,
    index,
    active: false,
  });
  if (tab) {
    group.members[windowId] = tab.id;
  } else {
    traceDiag(`createCopy failed win=${windowId} gid=${gid}`);
    mirror.pending = mirror.pending.filter((p) => !(p.windowId === windowId && p.gid === gid));
  }
}

// A pinned tab appeared (user pin, mirror copy, restore, session restore):
// bind it to a group - by pending record, by page identity, or as a new
// group that then gets mirrored into every other window.
async function registerPinnedTab(tab, settings) {
  if (!settings.mirrorPinned) return;
  if (!tab || tab.id === undefined || tab.incognito) return;
  const mirror = await getMirror();
  const bound = groupOfTab(mirror, tab.id);
  if (bound) {
    // Already bound (member recorded at create time). Consume the matching
    // pending record so it cannot mis-bind a future tab.
    const stale = mirror.pending.findIndex(
      (p) => p.windowId === tab.windowId && p.gid === bound,
    );
    if (stale !== -1) {
      mirror.pending.splice(stale, 1);
      await putMirror(mirror);
    }
    return;
  }

  const url = tabUrl(tab);
  const pendingIndex = mirror.pending.findIndex(
    (p) => p.windowId === tab.windowId && pathKey(p.url) === pathKey(url),
  );
  if (pendingIndex !== -1) {
    const { gid } = mirror.pending[pendingIndex];
    mirror.pending.splice(pendingIndex, 1);
    if (mirror.groups[gid]) mirror.groups[gid].members[tab.windowId] = tab.id;
    await putMirror(mirror);
    return;
  }

  const adoptable = mirror.order.find((gid) => {
    const group = mirror.groups[gid];
    return group && group.members[tab.windowId] === undefined && pathKey(group.url) === pathKey(url);
  });
  if (adoptable) {
    mirror.groups[adoptable].members[tab.windowId] = tab.id;
    await putMirror(mirror);
    return;
  }

  // New group: user pinned a tab. Mirror it into every other window.
  const gid = await nextGid();
  mirror.groups[gid] = { url, members: { [tab.windowId]: tab.id } };
  const position = Math.min(Math.max(tab.index, 0), mirror.order.length);
  mirror.order.splice(position, 0, gid);
  traceDiag(`group ${gid} created for ${pathKey(url)} @win=${tab.windowId}`);
  for (const w of await normalWindows()) {
    if (w.id !== tab.windowId && mirror.groups[gid].members[w.id] === undefined) {
      await createCopy(mirror, gid, w.id, position);
    }
  }
  await putMirror(mirror);
  scheduleAutoSnapshot();
}

// Drop a group everywhere (confirmed unpin, or a close of an unprotected
// pinned tab). keepTabId survives - the tab the user unpinned stays open.
async function dissolveGroup(mirror, gid, keepTabId) {
  const group = mirror.groups[gid];
  if (!group) return;
  const victims = Object.values(group.members).filter(
    (tabId) => tabId !== keepTabId,
  );
  delete mirror.groups[gid];
  mirror.order = mirror.order.filter((g) => g !== gid);
  await closeTabs(victims);
  traceDiag(`group ${gid} dissolved, closed ${victims.length} sibling(s)`);
}

// Ensure a window holds one member of every group: adopt what matches,
// create what is missing. Never closes anything - used for new windows,
// bootstrap and gap-filling.
async function syncWindowFill(windowId, settings) {
  if (!settings.mirrorPinned) return;
  const existing = await chrome.tabs.query({ windowId, pinned: true }).catch(() => []);
  for (const tab of existing) {
    await registerPinnedTab(tab, settings);
  }
  const mirror = await getMirror();
  let changed = false;
  for (let i = 0; i < mirror.order.length; i++) {
    const gid = mirror.order[i];
    if (mirror.groups[gid].members[windowId] === undefined) {
      await createCopy(mirror, gid, windowId, i);
      changed = true;
    }
  }
  if (changed) await putMirror(mirror);
}

async function rebuildMirror(settings) {
  if (!settings.mirrorPinned) {
    await chrome.storage.session.set({ groups: {}, groupOrder: [], pendingCreates: [] });
    return;
  }
  // At browser startup the session-restored windows are still growing their
  // tab strips; adopting a half-restored window would duplicate the rest.
  let previous = -1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tabs = await chrome.tabs.query({});
    if (tabs.length > 0 && tabs.length === previous) break;
    previous = tabs.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  for (const w of await normalWindows()) {
    await syncWindowFill(w.id, settings);
  }
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
          target: { tabId: tab.id },
          files: ["content.js"],
          injectImmediately: true,
        })
        .catch(() => {}); // restricted or unloaded pages
    }
  }
  await rebuildMirror(settings);
  scheduleAutoSnapshot();
}

chrome.runtime.onInstalled.addListener(() => enqueue(() => bootstrapAll(true), "installed"));
chrome.runtime.onStartup.addListener(() => enqueue(() => bootstrapAll(false), "startup"));

// Settings changed (options page) - recompute every tab, reload language.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  i18nReady = null;
  enqueue(() => bootstrapAll(false), "settings-changed");
});

// --- self-closed markers ------------------------------------------------
// Tabs the extension closes itself (mirroring, snapshot restore) must not
// be reopened by the protection.
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

// Close tabs the extension owns (mirror copies, snapshot extras), silently
// and without partial failures:
//   1. Discard the page first: a discarded document runs no beforeunload,
//      so a page's OWN unload handler (draft warnings etc.) cannot pop a
//      dialog in a window the user is not even looking at.
//   2. Remove each tab individually - a batched tabs.remove() fails as a
//      whole when any single id is already gone, leaving survivors behind.
// Marked self-closed first so the protection does not reopen them.
async function closeTabs(tabIds) {
  if (!tabIds.length) return;
  await markSelfClosed(tabIds);
  await Promise.all(
    tabIds.map(async (id) => {
      const discarded = await quiet(chrome.tabs.discard, id);
      let finalId = id;
      if (discarded && discarded.id !== undefined && discarded.id !== id) {
        finalId = discarded.id;
        await markSelfClosed([finalId]);
      }
      await quiet(chrome.tabs.remove, finalId);
    }),
  );
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
      state.pinned = !!tab.pinned;
      if (tabUrl(tab)) state.url = tabUrl(tab);
      state.protected = computeProtected(state, settings);
      await putTabState(tab.id, state);
      updateAction(tab.id, state.protected);
      sendResponse({ locked: state.protected, showIcon: settings.showIcon });
    }, "hello");
    return true; // async sendResponse
  }
});

// --- tab lifecycle ---------------------------------------------------------
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  enqueue(async () => {
    const settings = await getSettings();
    await refreshTab(tab, settings);
    if (tab.pinned) {
      await registerPinnedTab(tab, settings);
      scheduleAutoSnapshot();
    }
  }, "created");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const relevant =
    changeInfo.pinned !== undefined ||
    changeInfo.status === "loading" ||
    changeInfo.url !== undefined;
  if (!relevant) return;
  enqueue(async () => {
    traceDiag(`updated tab=${tabId} change=${JSON.stringify(changeInfo)}`);
    const settings = await getSettings();
    const state = (await getTabState(tabId)) || newTabState(tab);
    state.pinned = !!tab.pinned;
    if (tabUrl(tab)) state.url = tabUrl(tab);
    state.protected = computeProtected(state, settings);
    if (changeInfo.pinned === false) {
      // Might be Chrome's own unpin-on-close; remember when it happened.
      state.unpinnedAt = Date.now();
    } else if (state.pinned) {
      state.unpinnedAt = null;
    }
    await putTabState(tabId, state);
    applyToTab(tabId, state, settings);

    // Mirroring bookkeeping.
    if (changeInfo.pinned === true) {
      await registerPinnedTab(tab, settings);
      scheduleAutoSnapshot();
    }
    if (changeInfo.pinned === false) {
      scheduleUnpinConfirm(tabId);
      scheduleAutoSnapshot();
    }
    if (changeInfo.url && tab.pinned) {
      const mirror = await getMirror();
      const gid = groupOfTab(mirror, tabId);
      if (gid) {
        const oldKey = pathKey(mirror.groups[gid].url);
        mirror.groups[gid].url = changeInfo.url;
        await putMirror(mirror);
        // Autosave only on a real page change, not query-string noise.
        if (oldKey !== pathKey(changeInfo.url)) scheduleAutoSnapshot();
      } else {
        scheduleAutoSnapshot();
      }
    }
  }, "updated");
});

// A real unpin (tab still alive after the grace) dissolves its group:
// the unpinned tab stays as a regular tab, its copies elsewhere close.
function scheduleUnpinConfirm(tabId) {
  setTimeout(() => {
    enqueue(async () => {
      const settings = await getSettings();
      if (!settings.mirrorPinned) return;
      const tab = await quiet(chrome.tabs.get, tabId);
      if (!tab || tab.pinned) return; // closed (handled by onRemoved) or re-pinned
      const mirror = await getMirror();
      const gid = groupOfTab(mirror, tabId);
      if (!gid) return;
      await dissolveGroup(mirror, gid, tabId);
      await putMirror(mirror);
      scheduleAutoSnapshot();
    }, "unpin-confirm");
  }, UNPIN_CONFIRM_MS);
}

// Prerender/instant pages swap tab ids; carry the state over.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const state = await getTabState(removedTabId);
    await dropTabState(removedTabId);
    if (state) await putTabState(addedTabId, state);
    const mirror = await getMirror();
    const gid = groupOfTab(mirror, removedTabId);
    if (gid) {
      for (const [win, memberId] of Object.entries(mirror.groups[gid].members)) {
        if (memberId === removedTabId) mirror.groups[gid].members[win] = addedTabId;
      }
      await putMirror(mirror);
    }
  }, "replaced");
});

// --- the protection: a closed protected tab comes right back -----------------
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  enqueue(async () => {
    const state = await getTabState(tabId);
    await dropTabState(tabId);
    traceDiag(
      `removed tab=${tabId} winClosing=${removeInfo.isWindowClosing} state=${JSON.stringify(state)}`,
    );

    const settings = await getSettings();
    const mirror = await getMirror();
    const gid = groupOfTab(mirror, tabId);
    if (gid) {
      for (const [win, memberId] of Object.entries(mirror.groups[gid].members)) {
        if (memberId === tabId) delete mirror.groups[gid].members[win];
      }
    }

    const finishMirror = async () => {
      if (gid && mirror.groups[gid] && Object.keys(mirror.groups[gid].members).length === 0) {
        delete mirror.groups[gid];
        mirror.order = mirror.order.filter((g) => g !== gid);
      }
      await putMirror(mirror);
    };

    // Closed by the extension itself: bookkeeping only.
    if (await wasSelfClosed(tabId)) {
      await finishMirror();
      return;
    }

    if (!state) {
      await finishMirror();
      return;
    }
    if (state.pinned || state.protected) scheduleAutoSnapshot();

    // Whole window closing is a window-level act: its copies die with it,
    // siblings elsewhere and the group survive; autosaves keep the set
    // restorable when it was the only window.
    if (removeInfo.isWindowClosing) {
      await finishMirror();
      return;
    }

    // Chrome unpins a pinned tab milliseconds before closing it; within the
    // grace window the tab still counts as pinned, NOT as user-unpinned.
    const wasPinnedAtClose =
      state.pinned ||
      !!(state.unpinnedAt && Date.now() - state.unpinnedAt < CLOSE_UNPIN_GRACE_MS);
    const protectedAtClose =
      state.protected ||
      (wasPinnedAtClose && computeProtected({ ...state, pinned: true }, settings));

    if (protectedAtClose) {
      // The rule: protected tabs do not close. Bring it back, silently.
      // The group stays; the reopened tab re-adopts it by page identity.
      await finishMirror();
      await reopenTab(state, removeInfo.windowId, settings);
      return;
    }

    // Unprotected pinned tab (autoLockPinned off): the close is legitimate;
    // mirror it to the other windows so the set stays in sync.
    if (gid && wasPinnedAtClose && settings.mirrorPinned) {
      await dissolveGroup(mirror, gid, null);
    }
    await finishMirror();
  }, "removed");
});

async function reopenTab(state, windowId, settings) {
  const url = state.url || "";
  let newTab = null;
  // chrome.sessions preserves history, scroll and form state - try it first.
  for (let attempt = 0; attempt < 8 && !newTab; attempt++) {
    let sessions = [];
    try {
      sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    } catch {
      break;
    }
    const match = sessions.find((s) => s.tab && s.tab.sessionId && s.tab.url === url);
    if (match) {
      const restored = await quiet(chrome.sessions.restore, match.tab.sessionId);
      if (restored && restored.tab) {
        newTab = restored.tab;
        traceDiag(`reopen: session-restored ${pathKey(url)} -> ${newTab.id}`);
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!newTab) {
    // Fallback: plain re-create (at the end of the pin strip when pinned).
    const target = {};
    if (windowId !== undefined && windowId !== chrome.windows.WINDOW_ID_NONE) {
      const win = await quiet(chrome.windows.get, windowId);
      if (win) target.windowId = windowId;
    }
    const wasPinned = state.pinned || state.unpinnedAt !== null;
    const pinnedCount =
      wasPinned && target.windowId
        ? (await quiet(chrome.tabs.query, { windowId: target.windowId, pinned: true }) || [])
            .length
        : undefined;
    newTab = await quiet(chrome.tabs.create, {
      ...target,
      url: url || undefined,
      pinned: wasPinned,
      active: false,
      ...(pinnedCount !== undefined ? { index: pinnedCount } : {}),
    });
    traceDiag(`reopen: re-created ${pathKey(url)} -> ${newTab ? newTab.id : "failed"}`);
  }
  // Carry a manual lock over to the reopened tab - the protection must not
  // evaporate just because the tab id changed.
  if (newTab && newTab.id !== undefined && state.manual === true) {
    const carried = (await getTabState(newTab.id)) || newTabState(newTab);
    carried.manual = true;
    carried.pinned = !!newTab.pinned;
    if (url) carried.url = url;
    carried.protected = computeProtected(carried, settings);
    await putTabState(newTab.id, carried);
    applyToTab(newTab.id, carried, settings);
  }
}

// --- window lifecycle ---------------------------------------------------------
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

// The window's own tab strip must be COMPLETE before we fill gaps: a
// session-restored window populates its tabs over many milliseconds, and
// filling too early duplicates every pin that had not appeared yet. Wait
// until the tab count is non-zero and stable across consecutive polls.
async function waitForStableStrip(windowId) {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tabs = await quiet(chrome.tabs.query, { windowId });
    if (tabs === undefined) return false; // window is gone
    const count = tabs.length;
    if (count > 0 && count === previous) {
      stable++;
      if (stable >= 2) return true;
    } else {
      stable = 0;
    }
    previous = count;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return true;
}

// Every new normal window gets a copy of each pinned group.
chrome.windows.onCreated.addListener((win) => {
  enqueue(async () => {
    const settings = await getSettings();
    if (!settings.mirrorPinned) return;
    if (!win || win.type !== "normal" || win.incognito) return;
    if (!(await waitForStableStrip(win.id))) return;
    await syncWindowFill(win.id, settings);
  }, "window-created");
});

// --- snapshots -----------------------------------------------------------------
function snapshotFromTabs(tabs) {
  return {
    urls: tabs.map((t) => tabUrl(t)),
    titles: tabs.map((t) => t.title || ""),
    keys: tabs.map((t) => pathKey(tabUrl(t))),
    savedAt: Date.now(),
  };
}

const pinnedTabsOf = (windowId) => chrome.tabs.query({ windowId, pinned: true });

// The window whose pinned set represents "the" set: most recently focused
// normal window that has pinned tabs (they are mirrored anyway).
async function pinnedHomeWindow() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const withPins = new Set();
  for (const w of windows) {
    if (w.incognito) continue;
    if ((w.tabs || []).some((t) => t.pinned)) withPins.add(w.id);
  }
  if (!withPins.size) return null;
  const { focusStack = [] } = await chrome.storage.session.get("focusStack");
  for (const id of focusStack) {
    if (withPins.has(id)) return id;
  }
  return withPins.values().next().value;
}

async function getAutoSnaps() {
  const { [AUTO_SNAPS_KEY]: ring = [] } = await chrome.storage.local.get(AUTO_SNAPS_KEY);
  return ring;
}

// Ring of the last N pinned sets. A new entry appears only when the set
// changes structurally: membership or a page change (query/hash ignored).
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
  const homeId = await pinnedHomeWindow();
  if (homeId === null) return; // no pinned tabs anywhere: keep history as is
  const pinned = await pinnedTabsOf(homeId);
  if (!pinned.length) return;
  const snap = snapshotFromTabs(pinned);
  const ring = await getAutoSnaps();
  const signature = snap.keys.join("\n");
  if (ring[0] && (ring[0].keys || []).join("\n") === signature) return;
  ring.unshift(snap);
  await chrome.storage.local.set({ [AUTO_SNAPS_KEY]: ring.slice(0, AUTO_SNAPS_MAX) });
}

async function listSnapshots() {
  const all = await chrome.storage.sync.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(SNAP_PREFIX))
    .map(([key, value]) => ({
      name: key.slice(SNAP_PREFIX.length),
      count: (value.urls || []).length,
      savedAt: value.savedAt || 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

async function saveSnapshot(name, windowId) {
  const pinned = await pinnedTabsOf(windowId);
  if (!pinned.length) return { error: "noPinned" };
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return { error: "statusNameEmpty" };
  await chrome.storage.sync.set({ [SNAP_PREFIX + clean]: snapshotFromTabs(pinned) });
  return { ok: true };
}

async function deleteSnapshot(name) {
  await chrome.storage.sync.remove(SNAP_PREFIX + name);
  return { ok: true };
}

// Make `urls` the pinned set: diff-apply in the authoritative window (reuse
// matching tabs in place, create missing, close extras), then rebuild the
// groups from it and sync every other window the same way.
async function applyCanonicalSet(urls, authWindowId, settings) {
  // The set being replaced becomes an autosave entry (undo path).
  await writeAutoSnapshot();

  const stats = await diffApplyWindow(urls, authWindowId, true);

  // Rebuild groups from the authoritative window.
  const authPinned = await pinnedTabsOf(authWindowId);
  const mirror = await getMirror();
  mirror.groups = {};
  mirror.order = [];
  mirror.pending = [];
  for (const tab of authPinned) {
    const gid = await nextGid();
    mirror.groups[gid] = { url: tabUrl(tab), members: { [authWindowId]: tab.id } };
    mirror.order.push(gid);
  }
  await putMirror(mirror);

  if (settings.mirrorPinned) {
    for (const w of await normalWindows()) {
      if (w.id === authWindowId) continue;
      await diffApplyWindow(urls, w.id, true);
      // Bind the resulting tabs to the rebuilt groups.
      const tabs = await pinnedTabsOf(w.id);
      const fresh = await getMirror();
      for (const tab of tabs) {
        const gid = fresh.order.find(
          (g) =>
            fresh.groups[g].members[w.id] === undefined &&
            pathKey(fresh.groups[g].url) === pathKey(tabUrl(tab)),
        );
        if (gid) fresh.groups[gid].members[w.id] = tab.id;
      }
      await putMirror(fresh);
    }
  }
  scheduleAutoSnapshot();
  return stats;
}

// Diff one window's pinned tabs against the target list of urls.
async function diffApplyWindow(urls, windowId, closeExtras) {
  const current = await pinnedTabsOf(windowId);
  const used = new Set();
  let reused = 0;
  let created = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const match =
      current.find((t) => !used.has(t.id) && tabUrl(t) === url) ||
      current.find((t) => !used.has(t.id) && pathKey(tabUrl(t)) === pathKey(url));
    if (match) {
      used.add(match.id);
      reused++;
      if (match.index !== i) {
        await quiet(chrome.tabs.move, match.id, { index: i });
      }
    } else {
      const tab = await quiet(chrome.tabs.create, {
        windowId,
        url,
        pinned: true,
        index: i,
        active: false,
      });
      if (tab) {
        used.add(tab.id);
        created++;
      } else {
        traceDiag(`diffApply: create failed for ${url}`);
      }
    }
  }
  let closed = 0;
  if (closeExtras) {
    const extras = current.filter((t) => !used.has(t.id)).map((t) => t.id);
    if (extras.length) {
      await closeTabs(extras);
      closed = extras.length;
    }
  }
  return { reused, created, closed };
}

async function restoreSnapshot(request, windowId, settings) {
  let snap;
  if (request.autoIndex !== undefined) {
    const ring = await getAutoSnaps();
    snap = ring[request.autoIndex];
  } else {
    ({ [SNAP_PREFIX + request.name]: snap } = await chrome.storage.sync.get(
      SNAP_PREFIX + request.name,
    ));
  }
  if (!snap || !(snap.urls || []).length) return { error: "noSnaps" };
  const stats = await applyCanonicalSet(snap.urls, windowId, settings);
  traceDiag(`restoreSnapshot: ${JSON.stringify(stats)}`);
  return { ok: true, ...stats };
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
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab) return null;
  return enqueue(() => toggleTab(tab), "toggle-test");
};
globalThis.__tpUiCall = (request) => enqueue(() => handleUi(request), `${request.type}-test`);

// --- popup UI backend -----------------------------------------------------------
async function handleUi(request) {
  const settings = await getSettings();
  switch (request.type) {
    case "ui:getState": {
      const pinned = await pinnedTabsOf(request.windowId);
      let active = null;
      if (request.tabId !== undefined) {
        const tab = await quiet(chrome.tabs.get, request.tabId);
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
      const ring = await getAutoSnaps();
      return {
        pinned: pinned.map((t) => ({ id: t.id, title: t.title || tabUrl(t), url: tabUrl(t) })),
        active,
        snapshots: await listSnapshots(),
        autoSnaps: ring.map((snap, index) => ({
          index,
          count: (snap.urls || []).length,
          savedAt: snap.savedAt || 0,
        })),
        settings,
      };
    }
    case "ui:toggle": {
      const tab = await quiet(chrome.tabs.get, request.tabId);
      if (!tab) return { error: "hintPlain" };
      const state = await toggleTab(tab);
      return { ok: true, protected: state.protected };
    }
    case "ui:saveSnapshot":
      return saveSnapshot(request.name, request.windowId);
    case "ui:deleteSnapshot":
      return deleteSnapshot(request.name);
    case "ui:restoreSnapshot":
      return restoreSnapshot(request, request.windowId, settings);
    default:
      return { error: `unknown ${request.type}` };
  }
}
