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
// The CANON is the one source of truth for what the pinned set IS: the
// ordered list of group urls, persisted in storage.local (it survives
// restarts; tab ids and the group map do not). Windows are always converged
// TO the canon by one engine - restore, browser startup and window fill all
// run the same diff-apply. The canon changes only through explicit acts:
// a user pin/unpin, a navigation commit in a member, a restore. Leftover
// tabs found lying around are never silently promoted into the canon -
// re-deriving truth from whatever tabs exist is how duplicate pins used to
// compound across restarts (pages like chat apps redirect every copy to its
// own unique path, so leftovers never look like duplicates to a URL check).
//
// Snapshots: named sets of pinned tabs (storage.sync) plus a ring of the
// last 10 autosaves (storage.local). An autosave happens when the set
// changes structurally: a pin is added, removed, or navigates to a
// different page - query-string-only changes are ignored.
//
// All per-tab and group state lives in chrome.storage.session: it survives
// service worker suspension and resets together with tab ids on restart.
//
// Safety: every tab this extension creates passes a circuit breaker (rate
// ledger + per-page cooldown for engine copies). Whatever else ever goes
// wrong, mass tab creation is physically capped and reported, never silent.

importScripts("i18n.js");
importScripts("config.js");
importScripts("platform.js");

// One source of truth for defaults and validation - shared verbatim with the
// options page (platform.js). The local copy this replaced had already
// drifted from the page's copy once (theme lived only there).
const DEFAULTS = tpPlatform.DEFAULTS;
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
const CANON_KEY = "canonLayout";
// Circuit breaker: base creation budget per sliding minute. Bounded bulk
// operations (restore, startup converge) declare their exact extra budget up
// front; event-driven paths live off the base. A runaway loop therefore
// stalls and reports itself instead of opening tabs forever.
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_BURST = 25;
// An engine-made copy of a page is never re-created in the same window twice
// in a row: mirror loops always re-create the same page in the same window.
const COPY_COOLDOWN_MS = 20 * 1000;
// After forking an intercepted navigation into a new tab, the protected tab
// must be back on its page within this window, or the goBack is presumed
// missed (no history entry) and the url is restored explicitly.
const NAV_REDIRECT_VERIFY_MS = 500;

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
  // Normalize on every read: types and enums are validated, a poisoned store
  // degrades to defaults instead of poisoning every consumer downstream.
  return tpPlatform.normalizeSettings(settings);
}

// The single write path for settings. Reads raw, overlays the patch,
// normalizes, writes - and because normalize passes unknown keys through, a
// NEWER version's keys survive this version's write on a synced profile.
async function writeSettings(patch) {
  const { settings: raw } = await chrome.storage.sync.get("settings");
  const next = tpPlatform.normalizeSettings({ ...(raw || {}), ...patch });
  await chrome.storage.sync.set({ settings: next });
  return next;
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

// Looser identity for adoption fallback: SPA copies of the same app diverge
// in path (chatgpt.com/ vs chatgpt.com/c/xyz) but share the origin.
function originKey(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url || "";
  }
}

// Ephemeral pages are not content: blank tabs, the empty new-tab page and
// Chrome's split-view tab picker. Chrome creates exactly such pinned tabs as
// split-view partners - they must not be protected, mirrored or snapshotted,
// or they turn into phantom empty pins (resurrected after Chrome closes the
// picker itself, copied into other windows, saved into sets). Once such a
// tab navigates to a real page it becomes a first-class pin.
function isEphemeralUrl(url) {
  if (!url) return true;
  if (/^about:(blank|newtab)$/i.test(url)) return true;
  // The new-tab page across Chromium browsers (Chrome, Edge, Opera, Vivaldi,
  // Brave): the scheme and host vary, the meaning does not.
  if (
    /^(chrome|edge|opera|vivaldi|brave):\/\/(newtab|new-tab-page|new-tab-page-third-party|startpage)\/?([?#].*)?$/i.test(
      url,
    )
  ) {
    return true;
  }
  if (/^https:\/\/ntp\.msn\.com\//i.test(url)) return true; // Edge's NTP
  if (/^chrome:\/\/vivaldi-webui\/startpage/i.test(url)) return true; // Vivaldi's NTP
  // The split-view picker ("Choose a tab to add to split view") is a pinned
  // tab at kChromeUISplitViewNewTabPageURL - a page under the
  // tab-search.top-chrome host, which is browser UI, never user content.
  return /^chrome:\/\/tab-search\.top-chrome\//i.test(url);
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
    prevUrl: null,
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
  return settings.autoLockPinned && state.pinned && !isEphemeralUrl(state.url);
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
  updateAction(tabId, state.protected, settings);
}

function updateAction(tabId, isProtected, settings) {
  const mono = settings && settings.iconStyle === "mono" ? "-mono" : "";
  const variant = (isProtected ? "locked" : "unlocked") + mono;
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

async function putMirror(mirror, { preserveCanon = false } = {}) {
  await chrome.storage.session.set({
    groups: mirror.groups,
    groupOrder: mirror.order,
    pendingCreates: mirror.pending,
  });
  // The canon follows the mirror through this single writer: the ordered
  // group urls, persisted across restarts (storage.local). Gated on a
  // settled mirror: while the bootstrap is still reconstructing groups the
  // mirror is legitimately empty or partial, and writing that through would
  // erase exactly the truth the bootstrap needs. Once live, the canon
  // tracks every change - down to empty on the last unpin. A window-close
  // is the one death that must NOT empty it (preserveCanon): the session
  // will restore those tabs and the canon has to be waiting for them, or
  // the next start re-crystallizes over whatever the restore drags in.
  const { mirrorReady } = await chrome.storage.session.get("mirrorReady");
  if (!mirrorReady) return;
  const urls = mirror.order
    .map((gid) => mirror.groups[gid] && mirror.groups[gid].url)
    .filter((url) => url && !isEphemeralUrl(url));
  if (urls.length) {
    await chrome.storage.local.set({ [CANON_KEY]: { urls, savedAt: Date.now() } });
  } else if (!preserveCanon) {
    await clearCanon();
  }
}

async function getCanon() {
  const { [CANON_KEY]: canon } = await chrome.storage.local.get(CANON_KEY);
  const urls =
    canon && Array.isArray(canon.urls) ? canon.urls.filter((u) => !isEphemeralUrl(u)) : [];
  // Two identical entries in the canon are always a disease - they would
  // materialize as a visible duplicate pin on every start. Drop at read.
  return [...new Set(urls)];
}

// The canon empties only through explicit user acts (the last unpin, a
// mirror-off switch) - never through a cold start finding no groups yet.
async function clearCanon() {
  await chrome.storage.local.remove(CANON_KEY);
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
  // Never add a duplicate: if this window already holds a pinned tab of the
  // same page, a copy would multiply the set across windows. Adopt a free
  // matching pin if there is one (exact page first, then a same-origin one -
  // copies of chat apps drift to their own unique paths and would otherwise
  // never match); otherwise skip entirely.
  const existing = (await quiet(chrome.tabs.query, { windowId, pinned: true })) || [];
  const twin = existing.find((t) => pathKey(tabUrl(t)) === pathKey(group.url));
  if (twin) {
    if (!groupOfTab(mirror, twin.id)) group.members[windowId] = twin.id;
    return;
  }
  const drifted = existing.find(
    (t) => !groupOfTab(mirror, t.id) && originKey(tabUrl(t)) === originKey(group.url),
  );
  if (drifted && !mirror.order.some((g) => g !== gid && mirror.groups[g] && originKey(mirror.groups[g].url) === originKey(group.url))) {
    // Safe only when this is the sole group of that origin - two Notion-page
    // groups must not collapse onto one tab.
    group.members[windowId] = drifted.id;
    return;
  }
  mirror.pending.push({ windowId, gid, url: group.url });
  const tab = await guardedCreate(
    { windowId, url: group.url, pinned: true, index, active: false },
    `mirror-copy ${pathKey(group.url)}`,
    true,
  );
  if (tab) {
    group.members[windowId] = tab.id;
  } else {
    traceDiag(`createCopy skipped/failed win=${windowId} gid=${gid}`);
    mirror.pending = mirror.pending.filter((p) => !(p.windowId === windowId && p.gid === gid));
  }
}

// A pinned tab appeared (user pin, mirror copy, restore, session restore):
// bind it to a group - by pending record, by page identity, or as a new
// group that then gets mirrored into every other window. `via` says HOW it
// appeared: "pinned" (an explicit unpinned->pinned transition), "created"
// (arrived already pinned - restore-shaped), "bootstrap" (adoption pass).
async function registerPinnedTab(tab, settings, via = "pinned") {
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
  if (isEphemeralUrl(url)) return; // split-view partners, blank pins
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

  // Join an existing group: exact page match first, same-origin fallback
  // (SPA copies diverge in path but stay the same app).
  const adoptable =
    mirror.order.find((gid) => {
      const group = mirror.groups[gid];
      return (
        group && group.members[tab.windowId] === undefined && pathKey(group.url) === pathKey(url)
      );
    }) ||
    mirror.order.find((gid) => {
      const group = mirror.groups[gid];
      return (
        group &&
        group.members[tab.windowId] === undefined &&
        originKey(group.url) === originKey(url)
      );
    });
  if (adoptable) {
    mirror.groups[adoptable].members[tab.windowId] = tab.id;
    await putMirror(mirror);
    return;
  }

  // This window already holds a pin of the same app in a group: a second one
  // is a redundant duplicate (a leftover cascade copy, or the same app pinned
  // twice - e.g. a page that navigated to a diverged path). Do NOT spin up a
  // parallel group and mirror it into every window - that is exactly what
  // multiplies the set. Leave it as an inert, ungrouped pin.
  const dupeInWindow = mirror.order.some((gid) => {
    const g = mirror.groups[gid];
    return (
      g &&
      g.members[tab.windowId] !== undefined &&
      g.members[tab.windowId] !== tab.id &&
      pathKey(g.url) === pathKey(url)
    );
  });
  if (dupeInWindow) return;

  // A tab that ARRIVED pinned (chrome.tabs.onCreated with pinned:true) and
  // matched nothing above is restore-shaped: session restore, reopen-closed,
  // another tool re-materializing tabs. That is not a user pinning a page -
  // it must not mint a group and fan out (drift residue re-entering this way
  // is exactly how the set used to compound). A follow-up convergence lets
  // the canon adjudicate: covered pages bind, an unknown origin pinned once
  // is kept, residue closes. Only a live canon can adjudicate - without one
  // this is simply the first pin of a fresh profile. An explicit unpinned ->
  // pinned transition (via === "pinned") always mints.
  if (via === "created" && (await getCanon()).length) {
    traceDiag(`restore-shaped pin ${pathKey(url)} @win=${tab.windowId}: converge follow-up`);
    scheduleConverge();
    return;
  }

  // New group: user pinned a tab. Mirror it into every other window -
  // ADOPTING an existing matching pin there before ever creating a copy
  // (blind creation is how an extension reload used to duplicate the set).
  // The copies are budgeted to exactly the windows this one act can reach:
  // the allowance is what separates a user pin from a feedback loop.
  const gid = await nextGid();
  mirror.groups[gid] = { url, members: { [tab.windowId]: tab.id } };
  const position = Math.min(Math.max(tab.index, 0), mirror.order.length);
  mirror.order.splice(position, 0, gid);
  traceDiag(`group ${gid} created for ${pathKey(url)} @win=${tab.windowId}`);
  const windows = await normalWindows();
  await withCreateAllowance(Math.max(0, windows.length - 1), async () => {
    for (const w of windows) {
      if (w.id === tab.windowId || mirror.groups[gid].members[w.id] !== undefined) continue;
      const candidates = (await quiet(chrome.tabs.query, { windowId: w.id, pinned: true })) || [];
      const free =
        candidates.find(
          (t) => !groupOfTab(mirror, t.id) && pathKey(tabUrl(t)) === pathKey(url),
        ) ||
        candidates.find(
          (t) => !groupOfTab(mirror, t.id) && originKey(tabUrl(t)) === originKey(url),
        );
      if (free) {
        mirror.groups[gid].members[w.id] = free.id;
        continue;
      }
      await createCopy(mirror, gid, w.id, position);
    }
  });
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
  const missing = mirror.order.filter(
    (gid) =>
      !isEphemeralUrl(mirror.groups[gid].url) && mirror.groups[gid].members[windowId] === undefined,
  ).length;
  if (!missing) return;
  await withCreateAllowance(missing, async () => {
    let changed = false;
    for (let i = 0; i < mirror.order.length; i++) {
      const gid = mirror.order[i];
      if (isEphemeralUrl(mirror.groups[gid].url)) continue; // never fill these
      if (mirror.groups[gid].members[windowId] === undefined) {
        await createCopy(mirror, gid, windowId, i);
        changed = true;
      }
    }
    if (changed) await putMirror(mirror);
  });
}

async function rebuildMirror(settings) {
  if (!settings.mirrorPinned) {
    await chrome.storage.session.set({ groups: {}, groupOrder: [], pendingCreates: [] });
    await clearCanon();
    return;
  }
  // Unregister groups recorded with an ephemeral url (an older version could
  // register the split-view picker); their tabs are left alone.
  const mirror = await getMirror();
  const bad = mirror.order.filter(
    (gid) => !mirror.groups[gid] || isEphemeralUrl(mirror.groups[gid].url),
  );
  if (bad.length) {
    for (const gid of bad) delete mirror.groups[gid];
    mirror.order = mirror.order.filter((gid) => !bad.includes(gid));
    await putMirror(mirror);
  }
  // At browser startup the session-restored windows are still growing their
  // tab strips; adopting a half-restored window would duplicate the rest.
  // Restores come in bursts with real pauses between them, so one matching
  // poll is not stability - require a stretch of silence.
  let previous = -1;
  let calm = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const tabs = await chrome.tabs.query({});
    if (tabs.length > 0 && tabs.length === previous) {
      calm++;
      if (calm >= 3) break;
    } else {
      calm = 0;
    }
    previous = tabs.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Converge to the canon only on a COLD start (the mirror not settled yet:
  // browser restart, extension reload/update). A mid-session rebuild - a
  // settings change - runs over a live, complete mirror; converging there
  // races user acts (an unpin in flight looks like a missing pin and would
  // be resurrected). Mid-session the adopt+fill below is exactly enough.
  const cold = !(await isMirrorReady());
  let canon = await getCanon();
  if (cold && canon.length) {
    // One-time migration heal: a canon written by an earlier version may
    // carry mass-duplication residue baked in at its first crystallization.
    // Users at scale have no saved set and no channel to be told about a
    // manual cleanup - the disease signature is unmistakable, so it heals
    // itself, with the pre-heal state parked in the autosave ring (undo).
    const { canonHealVersion } = await chrome.storage.local.get("canonHealVersion");
    if (!canonHealVersion) {
      const healed = healMassDuplication(
        canon.map((url, order) => ({ url, order })),
        await savedSetUrls(),
      );
      if (healed) {
        await writeAutoSnapshot();
        traceDiag(`migration heal: canon ${canon.length} -> ${healed.keep.length}`);
        canon = healed.keep.sort((a, b) => a.order - b.order).map((e) => e.url);
        await chrome.storage.local.set({ [CANON_KEY]: { urls: canon, savedAt: Date.now() } });
        notifyHealed();
      }
      await chrome.storage.local.set({
        canonHealVersion: chrome.runtime.getManifest().version,
      });
    }
    await convergeToCanon(canon, settings);
    return;
  }
  if (cold) {
    // Cold start with no canon (update from a pre-canon version, or a canon
    // lost some other way). The most recently focused window with pins IS
    // the set: crystallize the canon from it and converge everything with
    // the same engine as every other start. Never adopt-and-fan-out
    // whatever lies around - drift residue (chat copies on unique paths)
    // multiplies exactly there. The one exception is a FRESH INSTALL: the
    // user's pins across windows all predate us and are all intent - adopt
    // them additively, close nothing.
    const { freshInstall } = await chrome.storage.session.get("freshInstall");
    if (!freshInstall) {
      const authWindowId = await pinnedHomeWindow();
      if (authWindowId !== null) {
        let authPins = (await pinnedTabsOf(authWindowId)).filter(
          (t) => !isEphemeralUrl(tabUrl(t)),
        );
        if (authPins.length) {
          // The window being crystallized from can itself carry the mass
          // residue (that is exactly how it looked in the field). Heal it
          // BEFORE its contents become truth.
          const healed = healMassDuplication(
            authPins.map((t, order) => ({ url: tabUrl(t), id: t.id, order })),
            await savedSetUrls(),
          );
          if (healed) {
            await writeAutoSnapshot();
            traceDiag(
              `crystallize heal win=${authWindowId}: ${authPins.length} -> ${healed.keep.length} pins`,
            );
            await closeTabs(healed.close.map((e) => e.id));
            const keptIds = new Set(healed.keep.map((e) => e.id));
            authPins = authPins.filter((t) => keptIds.has(t.id));
            notifyHealed();
          }
          traceDiag(`crystallize canon from win=${authWindowId}: ${authPins.length} pins`);
          await convergeToCanon(
            authPins.map((t) => tabUrl(t)),
            settings,
          );
        }
      }
      return;
    }
  }
  // Fresh install, or a mid-session rebuild (settings change) over a live
  // mirror: adopt what exists and fill gaps, without closing anything; the
  // canon keeps tracking the mirror.
  for (const w of await normalWindows()) {
    await syncWindowFill(w.id, settings);
  }
}

// --- mass-duplication healing ----------------------------------------------
// Residue from a duplication bug has an unmistakable shape: MANY origins
// duplicated at once - the whole set multiplied. A user's deliberate
// same-site pins duplicate one origin, maybe two (two Notion pages, three
// spreadsheets), never the board. When at least HEAL_MIN_ORIGINS origins
// carry duplicates in one strip or canon, it is disease: keep one pin per
// duplicated origin - preferring one recorded in a saved set, an explicit
// user act - and close the rest. The pre-heal state goes into the autosave
// ring first, so one click undoes a wrong guess, and a notification says
// what happened. Runs only where unattended residue can become truth
// (crystallization, one-time canon migration) - never against a live canon
// the user is deliberately growing.
const HEAL_MIN_ORIGINS = 3;

async function savedSetUrls() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  const urls = new Set();
  for (const bag of [synced, local]) {
    for (const [key, value] of Object.entries(bag)) {
      if (!key.startsWith(SNAP_PREFIX) || !value || !Array.isArray(value.urls)) continue;
      for (const url of value.urls) urls.add(url);
    }
  }
  return urls;
}

// entries: [{ url, order, ...ref }] in strip/canon order. Returns null when
// the strip does not look diseased, else { keep, close } (keep in original
// order via the order field).
function healMassDuplication(entries, setUrls) {
  const byOrigin = new Map();
  for (const entry of entries) {
    const key = originKey(entry.url);
    if (!byOrigin.has(key)) byOrigin.set(key, []);
    byOrigin.get(key).push(entry);
  }
  const duplicated = [...byOrigin.values()].filter((list) => list.length >= 2);
  if (duplicated.length < HEAL_MIN_ORIGINS) return null;
  const keep = [];
  const close = [];
  const setPathKeys = new Set([...setUrls].map((u) => pathKey(u)));
  for (const list of byOrigin.values()) {
    if (list.length === 1) {
      keep.push(list[0]);
      continue;
    }
    const keeper =
      list.find((e) => setUrls.has(e.url)) ||
      list.find((e) => setPathKeys.has(pathKey(e.url))) ||
      list[0];
    keep.push(keeper);
    for (const e of list) if (e !== keeper) close.push(e);
  }
  keep.sort((a, b) => a.order - b.order);
  return { keep, close };
}

function notifyHealed() {
  ensureI18n().then(() => {
    chrome.notifications.clear("truepin-healed", () => {
      void chrome.runtime.lastError;
      chrome.notifications.create(
        "truepin-healed",
        {
          type: "basic",
          iconUrl: "icons/locked-128.png",
          title: "TruePin",
          message: tpI18n.t("notifHealed"),
        },
        checked,
      );
    });
  });
}

// The persisted canon is the truth: converge every window to it with the
// same engine a restore uses. Leftover pins beyond the canon are residue of
// past duplication and close; they are never promoted into groups. The one
// exception: an origin the canon does not know at all, pinned exactly ONCE
// across all windows - that is a user pin the canon write may have missed
// (crash right after pinning). Counted per origin, not per page: drift
// residue is many unique paths on one origin, and a per-page count would
// wave it all through.
async function convergeToCanon(canon, settings) {
  const windows = await normalWindows();
  const canonOrigins = new Set(canon.map((u) => originKey(u)));
  const strays = new Map(); // origin -> { count, url }
  for (const w of windows) {
    const pins = (await quiet(chrome.tabs.query, { windowId: w.id, pinned: true })) || [];
    for (const t of pins) {
      const url = tabUrl(t);
      if (!url || isEphemeralUrl(url) || canonOrigins.has(originKey(url))) continue;
      const record = strays.get(originKey(url)) || { count: 0, url };
      record.count++;
      strays.set(originKey(url), record);
    }
  }
  const target = [...canon];
  for (const record of strays.values()) {
    if (record.count === 1) target.push(record.url);
  }
  // Same-origin multiplicity in the canon is legal (two Notion pages) but it
  // is also what drift disease looks like - leave a trace for diagnostics.
  const byOrigin = new Map();
  for (const u of target) byOrigin.set(originKey(u), (byOrigin.get(originKey(u)) || 0) + 1);
  const multi = [...byOrigin.entries()].filter(([, n]) => n > 1);
  if (multi.length) traceDiag(`converge: same-origin canon multiplicity ${JSON.stringify(multi)}`);
  const authWindowId = (await pinnedHomeWindow()) ?? (windows[0] && windows[0].id);
  if (authWindowId === undefined) return;
  await applyCanonicalSet(target, authWindowId, settings, { loose: true });
}

// Debounced follow-up convergence, for session-restore stragglers that
// arrive after the bootstrap has already settled.
let convergeTimer = null;
function scheduleConverge() {
  clearTimeout(convergeTimer);
  convergeTimer = setTimeout(() => {
    enqueue(async () => {
      const settings = await getSettings();
      if (!settings.mirrorPinned) return;
      const canon = await getCanon();
      if (canon.length) await convergeToCanon(canon, settings);
    }, "converge-followup");
  }, 2500);
}

// --- cold-start settling --------------------------------------------------
// On a cold start (browser restart or extension reload) storage.session is
// wiped, and Chrome then re-creates the pinned tabs across every window,
// firing onCreated while the mirror is still empty. Registering those pins
// live makes the engine copy each one into windows whose own copy has not
// been restored yet, and the restored originals then spawn fresh groups: an
// N-window cascade that multiplies the pinned set on every restart. So until
// the first bootstrap has settled, live tab events touch nothing in the
// mirror - they only make sure that bootstrap runs. The bootstrap waits for
// the strips to stabilize, then adopts every existing pin without copying.
async function isMirrorReady() {
  const { mirrorReady } = await chrome.storage.session.get("mirrorReady");
  return !!mirrorReady;
}

let coldBootstrapInFlight = false;
function ensureColdBootstrap() {
  if (coldBootstrapInFlight) return;
  coldBootstrapInFlight = true;
  enqueue(async () => {
    try {
      if (await isMirrorReady()) return; // another bootstrap already settled it
      await bootstrapAll();
    } finally {
      coldBootstrapInFlight = false;
    }
  }, "cold-bootstrap");
}

// Live tab events (onCreated/onUpdated) route pin registration here; the
// bootstrap's own syncWindowFill keeps calling registerPinnedTab directly.
async function registerPinnedLive(tab, settings, via) {
  if (!settings.mirrorPinned) return;
  if (await isMirrorReady()) {
    await registerPinnedTab(tab, settings, via);
  } else {
    ensureColdBootstrap();
  }
}

// --- bootstrap -----------------------------------------------------------
async function bootstrapAll() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) continue;
    await refreshTab(tab, settings);
  }
  await rebuildMirror(settings);
  // Mirror settled: live tab events may register pins directly again.
  await chrome.storage.session.set({ mirrorReady: true });
  scheduleAutoSnapshot();
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === "install") {
    // Fresh install: the crystallization below must adopt additively, not
    // converge (nothing that exists is our residue - it is all user intent).
    chrome.storage.session.set({ freshInstall: true }, () => {
      void chrome.runtime.lastError;
      ensureColdBootstrap();
    });
    return;
  }
  ensureColdBootstrap();
});
chrome.runtime.onStartup.addListener(() => {
  ensureColdBootstrap();
  broadcastLockedFront(); // the sibling re-queries at its settle; this is the early hint
});

// --- update applier ---------------------------------------------------------
// Chrome downloads CWS updates in the background and applies them when the
// extension goes idle; a busy worker or an open page can defer that
// indefinitely. This closes the tail: apply the pending update at the first
// QUIET moment - mirror converged, none of our pages open. No "update ready"
// UI, ever: the butler updates himself. Deferred attempts retry on every
// natural worker wake (this file re-executes) - no alarm needed.
// Spec: docs/specs/settings-platform.md.
async function tryApplyUpdate(dry = false) {
  const { updatePending } = await chrome.storage.session.get("updatePending");
  if (!updatePending) return "none";
  const { mirrorReady } = await chrome.storage.session.get("mirrorReady");
  if (!mirrorReady) return "blocked:mirror"; // cold convergence in flight
  const contexts = await chrome.runtime
    .getContexts({ contextTypes: ["TAB", "POPUP"] })
    .catch(() => []);
  if (contexts && contexts.length) return "blocked:pages"; // the user is in our pages
  if (!dry) chrome.runtime.reload();
  return "applied";
}
globalThis.__tpTryApplyUpdate = (dry) => tryApplyUpdate(dry);

chrome.runtime.onUpdateAvailable.addListener((details) => {
  chrome.storage.session
    .set({ updatePending: details.version || true })
    .then(() => tryApplyUpdate());
});
tryApplyUpdate(); // worker wake = natural retry for a deferred update

// Settings changed (options page) - recompute every tab, reload language.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  i18nReady = null;
  enqueue(async () => {
    await bootstrapAll(false);
    const settings = await getSettings();
    if (settings.lockToFront === "always") {
      for (const w of await normalWindows()) await enforceLockedFront(w.id);
    }
    broadcastLockedFront(); // mode may have flipped: tell the sibling
  }, "settings-changed");
});

// --- self-closed markers ------------------------------------------------
// Tabs the extension closes itself (mirroring, snapshot restore) must not
// be reopened by the protection.
//
// Every mutation of the shared record goes through ONE serializer:
// chrome.storage get/set are not atomic, and concurrent read-modify-write
// cycles (a restore once discarded dozens of tabs in parallel, each
// appending its swapped id) lose entries. An unmarked self-close then looks
// user-made and the protection resurrects the tab.
let selfClosedTail = Promise.resolve();
function withSelfClosed(mutate) {
  const run = selfClosedTail.then(async () => {
    const { selfClosed = {} } = await chrome.storage.session.get("selfClosed");
    const now = Date.now();
    for (const [id, ts] of Object.entries(selfClosed)) {
      if (now - ts > SELF_CLOSED_TTL_MS) delete selfClosed[id];
    }
    const result = mutate(selfClosed, now);
    await chrome.storage.session.set({ selfClosed });
    return result;
  });
  selfClosedTail = run.then(
    () => {},
    () => {},
  );
  return run;
}

function markSelfClosed(tabIds) {
  return withSelfClosed((record, now) => {
    for (const id of tabIds) record[id] = now;
  });
}

function wasSelfClosed(tabId) {
  return withSelfClosed((record) => {
    if (!(tabId in record)) return false;
    delete record[tabId];
    return true;
  });
}

// Close tabs the extension owns (mirror copies, snapshot extras), silently
// and without partial failures:
//   1. Discard the page first: a discarded document runs no beforeunload,
//      so a page's OWN unload handler (draft warnings etc.) cannot pop a
//      dialog in a window the user is not even looking at. A discard swaps
//      the tab id; the swapped ids are marked in one write, not N racing
//      ones.
//   2. Remove each tab individually - a batched tabs.remove() fails as a
//      whole when any single id is already gone, leaving survivors behind.
//   3. Verify. A remove can fail silently (strip busy); reporting a close
//      that never happened is how "restore left extras behind" hides.
// Returns the number of tabs that are actually gone.
async function closeTabs(tabIds) {
  if (!tabIds.length) return 0;
  await markSelfClosed(tabIds);
  const finalIds = await Promise.all(
    tabIds.map(async (id) => {
      const discarded = await quiet(chrome.tabs.discard, id);
      return discarded && discarded.id !== undefined ? discarded.id : id;
    }),
  );
  const swapped = finalIds.filter((id) => !tabIds.includes(id));
  if (swapped.length) await markSelfClosed(swapped);
  await Promise.all(finalIds.map((id) => quiet(chrome.tabs.remove, id)));
  let closed = 0;
  const survivors = [];
  for (const id of finalIds) {
    if (await quiet(chrome.tabs.get, id)) survivors.push(id);
    else closed++;
  }
  if (survivors.length) {
    await Promise.all(survivors.map((id) => quiet(chrome.tabs.remove, id)));
    for (const id of survivors) {
      if (await quiet(chrome.tabs.get, id)) traceDiag(`closeTabs: tab ${id} refused to close`);
      else closed++;
    }
  }
  return closed;
}

// --- creation circuit breaker ---------------------------------------------
// The last line of the "never mass-open tabs" guarantee: every tab the
// extension creates passes through here. The rate ledger lives in
// storage.session so a crashing worker cannot reset its own budget; the
// allowance is in-memory because it never outlives the queued job that
// granted it.
let createAllowance = 0;
let breakerNotifiedAt = 0;

async function withCreateAllowance(extra, work) {
  createAllowance = Math.max(createAllowance, extra);
  try {
    return await work();
  } finally {
    createAllowance = 0;
  }
}

function notifyBreaker() {
  if (Date.now() - breakerNotifiedAt < 5 * 60 * 1000) return;
  breakerNotifiedAt = Date.now();
  ensureI18n().then(() => {
    chrome.notifications.create(
      "truepin-breaker",
      {
        type: "basic",
        iconUrl: "icons/locked-128.png",
        title: "TruePin",
        message: tpI18n.t("notifBreaker"),
      },
      checked,
    );
  });
}

// One creation token, or an honest refusal. All extension code runs through
// the job queue, so the ledger read-modify-write here is never concurrent.
async function takeCreateToken(why) {
  const now = Date.now();
  const { createLedger = [] } = await chrome.storage.session.get("createLedger");
  const recent = createLedger.filter((ts) => now - ts < CREATE_WINDOW_MS);
  if (createAllowance > 0) {
    createAllowance--;
  } else if (recent.length >= CREATE_BURST) {
    traceDiag(`breaker: refused ${why} (${recent.length} creations in the last minute)`);
    notifyBreaker();
    return false;
  }
  recent.push(now);
  await chrome.storage.session.set({ createLedger: recent });
  return true;
}

// Engine copies only: the same page is never re-created in the same window
// twice within the cooldown - a mirror loop is exactly that signature, while
// a legitimate copy of a page lands in a window once.
async function underCopyCooldown(windowId, url) {
  const key = `${windowId}|${pathKey(url)}`;
  const now = Date.now();
  const { copyStamps = {} } = await chrome.storage.session.get("copyStamps");
  for (const [k, ts] of Object.entries(copyStamps)) {
    if (now - ts > COPY_COOLDOWN_MS) delete copyStamps[k];
  }
  if (copyStamps[key]) {
    traceDiag(`breaker: copy cooldown hit for ${key}`);
    return true;
  }
  copyStamps[key] = now;
  await chrome.storage.session.set({ copyStamps });
  return false;
}

// Guarded chrome.tabs.create. Returns the tab or null (refused / failed).
async function guardedCreate(props, why, isEngineCopy) {
  if (isEngineCopy && (await underCopyCooldown(props.windowId, props.url))) return null;
  if (!(await takeCreateToken(why))) return null;
  return quiet(chrome.tabs.create, props);
}

// --- messages (popup UI) --------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.type !== "string") return;

  if (request.type.startsWith("ui:")) {
    enqueue(() => handleUi(request).then(sendResponse), request.type);
    return true;
  }
});

// --- tab lifecycle ---------------------------------------------------------
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  scheduleEnforceLockedFront(tab.windowId);
  enqueue(async () => {
    const settings = await getSettings();
    await refreshTab(tab, settings);
    if (tab.pinned) {
      await registerPinnedLive(tab, settings, "created");
      scheduleAutoSnapshot();
    }
  }, "created");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned !== undefined) scheduleEnforceLockedFront(tab.windowId);
  // Leaving a tab group re-enters the front cluster (joining one leaves it -
  // the same enforcement pass reads membership and skips). family-interop.
  if (changeInfo.groupId !== undefined) scheduleEnforceLockedFront(tab.windowId);
  const relevant =
    changeInfo.pinned !== undefined ||
    changeInfo.status === "loading" ||
    changeInfo.url !== undefined;
  if (!relevant) return;
  enqueue(async () => {
    traceDiag(`updated tab=${tabId} change=${JSON.stringify(changeInfo)}`);
    const settings = await getSettings();
    const state = (await getTabState(tabId)) || newTabState(tab);
    const priorUrl = state.url;
    state.pinned = !!tab.pinned;
    if (tabUrl(tab) && tabUrl(tab) !== priorUrl) state.prevUrl = priorUrl;
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
      await registerPinnedLive(tab, settings, "pinned");
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
        // A group never takes an ephemeral url as its identity: a member
        // passing through the new-tab page keeps representing its old page.
        if (!isEphemeralUrl(changeInfo.url)) {
          const oldKey = pathKey(mirror.groups[gid].url);
          mirror.groups[gid].url = changeInfo.url;
          await putMirror(mirror);
          // Autosave only on a real page change, not query-string noise.
          if (oldKey !== pathKey(changeInfo.url)) scheduleAutoSnapshot();
        }
      } else if (!isEphemeralUrl(changeInfo.url)) {
        // A pinned tab that was ephemeral (split-view partner on the empty
        // new-tab page) just navigated somewhere real: the user took it to a
        // page - a first-class pin, group and mirror it now. If it was
        // ALREADY on a real page, this is just a created/restored tab
        // committing or redirecting - keep it on the adjudication path.
        const wasEphemeral = isEphemeralUrl(priorUrl);
        await registerPinnedLive(tab, settings, wasEphemeral ? "pinned" : "created");
        scheduleAutoSnapshot();
      }
    }
  }, "updated");
});

// --- navigation redirect ----------------------------------------------------
// A protected tab keeps its page. An address-bar navigation (typed URL or
// search), or a link click leading to a clearly different site, forks into a
// new tab and the protected tab goes back to where it was. Reloads, same-site
// links, JS/server redirects (OAuth chains), and back/forward stay in place.
// MV3 has no true cancel: the navigation commits, then snaps back - a brief
// flash, documented in the README.

// Registrable domain (eTLD+1) approximation without a public-suffix list:
// last two host labels, or three when the second-to-last is a well-known
// second-level TLD label. IP literals compare whole.
const KNOWN_SLD = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);
function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    const take = KNOWN_SLD.has(parts[parts.length - 2]) ? 3 : 2;
    return parts.slice(-take).join(".");
  } catch {
    return url || "";
  }
}

// Classify a webNavigation commit: "address" (omnibox act), "link" (real
// in-page click), or null (everything that must stay untouched).
function redirectKind(details) {
  if (details.frameId !== 0) return null;
  // Speculative (prerender) commits are not user acts.
  if (details.documentLifecycle && details.documentLifecycle !== "active") return null;
  const qualifiers = details.transitionQualifiers || [];
  // A back/forward commit re-reports the history entry's ORIGINAL transition
  // type (our own goBack included) - never a fresh user act.
  if (qualifiers.includes("forward_back")) return null;
  // Retyping the current URL commits as a reload; reloads stay in place.
  if (details.transitionType === "reload") return null;
  if (
    qualifiers.includes("from_address_bar") ||
    // Chromium forks with custom address bars can omit the qualifier.
    ["typed", "generated", "keyword"].includes(details.transitionType)
  ) {
    return "address";
  }
  // Only real clicks: JS and server redirects carry qualifiers and must pass
  // (breaking an OAuth chain mid-flight helps nobody).
  if (
    details.transitionType === "link" &&
    !qualifiers.includes("client_redirect") &&
    !qualifiers.includes("server_redirect")
  ) {
    return "link";
  }
  return null;
}

chrome.webNavigation.onCommitted.addListener((details) => {
  const kind = redirectKind(details);
  if (!kind) return;
  enqueue(() => navRedirect(details.tabId, details.url, kind), "nav-redirect");
});

async function navRedirect(tabId, url, kind) {
  const settings = await getSettings();
  if (kind === "address" ? !settings.navRedirect : !settings.linkRedirect) return;
  const state = await getTabState(tabId);
  if (!state || !state.protected) return;
  // Our onUpdated job may or may not have run first (event delivery order is
  // not guaranteed); both orders resolve to the pre-navigation url.
  const restoreUrl = state.url && state.url !== url ? state.url : state.prevUrl;
  if (!restoreUrl || restoreUrl === url || isEphemeralUrl(restoreUrl)) return;
  // Links fork only when the destination is a clearly different site.
  if (kind === "link" && registrableDomain(restoreUrl) === registrableDomain(url)) return;
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab) return;
  // New tab FIRST: if the breaker refuses, the in-place navigation stands -
  // the typed destination is never lost.
  const created = await guardedCreate(
    { windowId: tab.windowId, url, active: true, openerTabId: tabId },
    `nav-redirect ${pathKey(url)}`,
    false,
  );
  if (!created) return;
  await quiet(chrome.tabs.goBack, tabId); // BFCache keeps the page state alive
  scheduleNavRestoreVerify(tabId, restoreUrl);
  traceDiag(
    `nav-redirect (${kind}) tab=${tabId}: ${pathKey(url)} -> tab ${created.id}, back to ${pathKey(restoreUrl)}`,
  );
}

// Off-queue wait (pattern: scheduleUnpinConfirm) - never block the FIFO.
function scheduleNavRestoreVerify(tabId, restoreUrl) {
  setTimeout(() => {
    enqueue(async () => {
      const tab = await quiet(chrome.tabs.get, tabId);
      if (!tab) return;
      // Done, or the back-commit is still in flight - do not double-fire.
      if (tab.url === restoreUrl || tab.pendingUrl === restoreUrl) return;
      traceDiag(`nav-redirect verify: goBack missed, forcing ${pathKey(restoreUrl)}`);
      await quiet(chrome.tabs.update, tabId, { url: restoreUrl });
    }, "nav-redirect-verify");
  }, NAV_REDIRECT_VERIFY_MS);
}

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
      // A window-level death never empties the canon - only explicit unpins do.
      await putMirror(mirror, { preserveCanon: !!removeInfo.isWindowClosing });
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
  // Never resurrect an ephemeral page: Chrome closes the split-view picker
  // by itself, and state recorded by an older version may still claim such
  // a tab was protected. A manual lock is an explicit user decision.
  if (state.manual !== true && isEphemeralUrl(url)) return;
  // One pin per page per window: if the page is already pinned there, this
  // close was bookkeeping noise (a stale carried-over state, a duplicate),
  // not a user loss - resurrecting it would mint a second copy.
  if (
    state.manual !== true &&
    windowId !== undefined &&
    windowId !== chrome.windows.WINDOW_ID_NONE
  ) {
    const pins = (await quiet(chrome.tabs.query, { windowId, pinned: true })) || [];
    if (pins.some((t) => pathKey(tabUrl(t)) === pathKey(url))) {
      traceDiag(`reopen skipped: ${pathKey(url)} already pinned in win=${windowId}`);
      return;
    }
  }
  // The breaker is the outer net: a reopen storm is a bug by construction
  // (mass closes of protected tabs are either window closes, which skip
  // reopening, or extension closes, which are marked self-closed).
  if (!(await takeCreateToken(`reopen ${pathKey(url)}`))) return;
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
  if (newTab && settings.notifyReopen) notifyReopened(state.manual === true);
}

// One short notification; a fixed id keeps repeats from stacking up.
function notifyReopened(isManualLock) {
  ensureI18n().then(() => {
    chrome.notifications.clear("truepin-reopen", () => {
      void chrome.runtime.lastError;
      chrome.notifications.create(
        "truepin-reopen",
        {
          type: "basic",
          iconUrl: "icons/locked-128.png",
          title: "TruePin",
          message: tpI18n.t(isManualLock ? "notifReopenedManual" : "notifReopenedPinned"),
        },
        checked,
      );
    });
  });
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

// --- locked tabs to the front ----------------------------------------------
// Optional: a manually-locked REGULAR (non-pinned) tab can be pulled to the
// front of the tab strip, right after the pinned tabs. "onLock" moves it once,
// the moment it is locked; "always" also keeps every locked regular tab
// clustered at the front, re-asserting when the strip is reordered. Off by
// default. Split-view members are left where they are.
function isSplitTab(tab) {
  return tab.splitViewId !== undefined && tab.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE;
}

// A popup / app / DevTools window is not "normal": the mirror never fills it,
// and the locked-to-front feature leaves it alone for the same reason.
async function isNormalWindow(windowId) {
  const win = await quiet(chrome.windows.get, windowId);
  return !!win && win.type === "normal" && !win.incognito;
}

// A locked tab the USER placed into a tab group keeps its page protection
// but stops being pulled to the front: group membership is the user's own
// layout decision, and yanking the tab out of its group's row fights the
// user, not other software. It re-enters the front cluster when it leaves
// the group. (family-interop)
function inUserGroup(tab) {
  return tab.groupId !== -1 && tab.groupId != null;
}

async function moveLockedToFront(tab) {
  if (!tab || tab.pinned || isSplitTab(tab) || inUserGroup(tab) || tab.windowId === undefined) {
    return;
  }
  if (!(await isNormalWindow(tab.windowId))) return;
  const pinned = (await quiet(chrome.tabs.query, { windowId: tab.windowId, pinned: true })) || [];
  await quiet(chrome.tabs.move, tab.id, { index: pinned.length });
}

// Cluster every manually-locked regular tab at the front, in their current
// relative order. Idempotent - re-running with them in place is a no-op, so
// the onMoved our own moves trigger cannot loop.
async function enforceLockedFront(windowId) {
  const settings = await getSettings();
  if (settings.lockToFront !== "always") return;
  if (!(await isNormalWindow(windowId))) return;
  const tabs = (await quiet(chrome.tabs.query, { windowId })) || [];
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const locked = [];
  for (const t of tabs) {
    if (t.pinned || isSplitTab(t) || inUserGroup(t)) continue;
    const st = await getTabState(t.id);
    if (st && st.manual === true) locked.push(t);
  }
  if (!locked.length) return;
  locked.sort((a, b) => a.index - b.index);
  if (locked.every((t, i) => t.index === pinnedCount + i)) return; // already in place
  for (let i = 0; i < locked.length; i++) {
    await quiet(chrome.tabs.move, locked[i].id, { index: pinnedCount + i });
  }
  broadcastLockedFront(); // the zone moved: tell the sibling
}

const lockFrontTimers = {};
function scheduleEnforceLockedFront(windowId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(lockFrontTimers[windowId]);
  lockFrontTimers[windowId] = setTimeout(() => {
    delete lockFrontTimers[windowId];
    enqueue(() => enforceLockedFront(windowId), "lock-front");
  }, 200);
}

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  scheduleEnforceLockedFront(moveInfo.windowId);
});
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  scheduleEnforceLockedFront(attachInfo.newWindowId);
});

// --- family interop (TrueTabs) ---------------------------------------------
// One message family over onMessageExternal, allowlisted to the sibling's
// browser-attested ids. TrueTabs asks who is locked-to-front and reserves
// that zone in its layout; TruePin stays the zone's enforcer. Either side
// absent = silence and today's standalone behavior - a contract of graceful
// degradation, not coupling. Spec: docs/specs/family-interop.md (canonical
// copy in the TrueTabs repo).
const FAMILY_IDS = new Set([
  "kidmlipfadbjifiaokampaemiadnngfl", // TrueTabs, dev-key id (fixed by its manifest key)
  // TrueTabs' CWS id joins this list right after its first publication
  // (release-checklist line) - ids are stable, never patterns.
]);

async function lockedFrontPayload() {
  const settings = await getSettings();
  const mode = settings.lockToFront;
  const tabIds = [];
  if (mode === "always") {
    const wins = (await quiet(chrome.windows.getAll, { windowTypes: ["normal"] })) || [];
    for (const win of wins) {
      if (win.incognito) continue;
      const tabs = (await quiet(chrome.tabs.query, { windowId: win.id })) || [];
      for (const t of tabs) {
        if (t.pinned || isSplitTab(t) || inUserGroup(t)) continue;
        const st = await getTabState(t.id);
        if (st && st.manual === true) tabIds.push(t.id);
      }
    }
  }
  return { v: 1, tabIds, mode };
}

// Plain async on purpose: broadcast is called from inside queue jobs
// (enforce, toggle) and a nested enqueue would deadlock the serializer. It
// only reads state and fires messages - nothing here mutates shared keys.
function broadcastLockedFront() {
  lockedFrontPayload()
    .then((payload) => {
      const msg = { type: "family:lockedFront:changed", ...payload };
      for (const id of FAMILY_IDS) {
        try {
          chrome.runtime.sendMessage(id, msg, () => void chrome.runtime.lastError);
        } catch {
          // sibling not installed: exactly the silence the contract wants
        }
      }
    })
    .catch(() => {});
}

function handleFamilyMessage(msg, senderId, sendResponse) {
  if (!senderId || !FAMILY_IDS.has(senderId)) return false; // strangers get silence
  if (!msg || msg.v !== 1 || msg.type !== "family:lockedFront:get") return false;
  lockedFrontPayload().then(sendResponse);
  return true; // async response
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) =>
  handleFamilyMessage(msg, sender.id, sendResponse),
);

// --- snapshots -----------------------------------------------------------------
function snapshotFromTabs(allTabs) {
  const tabs = allTabs.filter((t) => !isEphemeralUrl(tabUrl(t)));
  // Split-view pairs, as index pairs into this set. Chrome's extensions API
  // exposes splitViewId read-only (Chrome 148: no create/update), so this is
  // stored forward-compatibly and applied once Chrome ships a write API.
  const splits = [];
  const seen = new Map();
  tabs.forEach((tab, index) => {
    const sid = tab.splitViewId !== undefined ? tab.splitViewId : chrome.tabs.SPLIT_VIEW_ID_NONE;
    if (sid === chrome.tabs.SPLIT_VIEW_ID_NONE) return;
    if (seen.has(sid)) splits.push([seen.get(sid), index]);
    else seen.set(sid, index);
  });
  return {
    urls: tabs.map((t) => tabUrl(t)),
    titles: tabs.map((t) => t.title || ""),
    keys: tabs.map((t) => pathKey(tabUrl(t))),
    splits,
    savedAt: Date.now(),
  };
}

// Strip ephemeral urls out of a stored snapshot (entries written by an older
// version can contain the split-view picker); split index pairs are remapped
// to the surviving positions.
function sanitizeSnap(snap) {
  const urls = snap.urls || [];
  const keep = urls.map((url) => !isEphemeralUrl(url));
  if (keep.every(Boolean)) return snap;
  const remap = new Map();
  let next = 0;
  keep.forEach((kept, index) => {
    if (kept) remap.set(index, next++);
  });
  const pick = (list) => (list || []).filter((_, index) => keep[index]);
  return {
    ...snap,
    urls: pick(urls),
    titles: pick(snap.titles),
    keys: pick(snap.keys),
    splits: (snap.splits || [])
      .filter(([a, b]) => remap.has(a) && remap.has(b))
      .map(([a, b]) => [remap.get(a), remap.get(b)]),
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
  // Collapse identical states to a single (newest) entry: an autosave records a
  // pinned-set state, and the same state can recur (navigate away and back,
  // restore an earlier set), which used to pile up rows that look the same. The
  // ring is newest-first, so the first occurrence of each signature wins.
  const seen = new Set();
  const out = [];
  for (const raw of ring) {
    const snap = sanitizeSnap(raw);
    const sig = (snap.keys || []).join("\n");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(snap);
  }
  return out;
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
  const pinned = (await pinnedTabsOf(homeId)).filter((t) => !isEphemeralUrl(tabUrl(t)));
  if (!pinned.length) return;
  const snap = snapshotFromTabs(pinned);
  const ring = await getAutoSnaps();
  const signature = snap.keys.join("\n");
  if (ring[0] && (ring[0].keys || []).join("\n") === signature) return; // unchanged since latest
  // Drop any older copy of this exact state so a recurring set moves to the top
  // with a fresh time instead of leaving a duplicate row behind.
  const deduped = ring.filter((s) => (s.keys || []).join("\n") !== signature);
  deduped.unshift(snap);
  await chrome.storage.local.set({ [AUTO_SNAPS_KEY]: deduped.slice(0, AUTO_SNAPS_MAX) });
}

// A named set lives in storage.sync so it follows the user across machines
// (Chrome Sync). Only these fields are read back: restore applies `urls`, the
// list sorts by `savedAt`, `splits` is kept forward-compat for a Chrome
// split-view write API. `titles`/`keys` are never read on this path and only
// burn the 8KB-per-item sync budget, so they are stripped before syncing -
// which roughly doubles how many tabs fit in one set.
function syncedSnap(snap) {
  return {
    urls: snap.urls || [],
    splits: snap.splits || [],
    savedAt: snap.savedAt || Date.now(),
  };
}

// Named sets normally live in sync; ones too big for the 8KB item limit fall
// back to local (see saveSnapshot). The list unions both, newest first, and
// flags which ones actually travel across devices.
async function listSnapshots() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  const rows = new Map(); // name -> row; a synced copy wins over a local one
  const collect = (bag, isSynced) => {
    for (const [key, value] of Object.entries(bag)) {
      if (!key.startsWith(SNAP_PREFIX)) continue;
      const name = key.slice(SNAP_PREFIX.length);
      if (rows.has(name)) continue;
      const clean = sanitizeSnap(value);
      rows.set(name, {
        name,
        count: clean.urls.length,
        splits: (clean.splits || []).length,
        savedAt: value.savedAt || 0,
        synced: isSynced,
      });
    }
  };
  collect(synced, true);
  collect(local, false);
  return [...rows.values()].sort((a, b) => b.savedAt - a.savedAt);
}

async function saveSnapshot(name, windowId) {
  const pinned = (await pinnedTabsOf(windowId)).filter((t) => !isEphemeralUrl(tabUrl(t)));
  if (!pinned.length) return { error: "noPinned" };
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return { error: "statusNameEmpty" };
  const key = SNAP_PREFIX + clean;
  const value = syncedSnap(snapshotFromTabs(pinned));
  try {
    await chrome.storage.sync.set({ [key]: value });
    await chrome.storage.local.remove(key); // clear any older too-big copy of this name
    return { ok: true, count: value.urls.length };
  } catch {
    // Sync rejected: item over 8KB, total quota hit, or sync unavailable. Keep
    // the set on this machine so an explicit save is never lost - it just will
    // not travel to other devices until it fits.
    await chrome.storage.local.set({ [key]: value });
    await chrome.storage.sync.remove(key).catch(() => {}); // drop a stale synced copy
    return { ok: true, synced: false, count: value.urls.length };
  }
}

async function deleteSnapshot(name) {
  const key = SNAP_PREFIX + name;
  await Promise.all([chrome.storage.sync.remove(key), chrome.storage.local.remove(key)]);
  return { ok: true };
}

// Make `urls` the pinned set: diff-apply in the authoritative window (reuse
// matching tabs in place, create missing, close extras), then rebuild the
// groups from it and sync every other window the same way. ONE engine for
// both a restore (strict matching: the user asked for the saved pages, not
// whatever a copy drifted to) and startup convergence (loose matching: a
// same-origin drifted copy is the same logical pin and keeps its live
// state). Creation is budgeted to exactly this set across these windows.
async function applyCanonicalSet(urls, authWindowId, settings, { loose = false } = {}) {
  // The set being replaced becomes an autosave entry (undo path).
  await writeAutoSnapshot();
  const windows = settings.mirrorPinned ? await normalWindows() : [];
  const budget = urls.length * Math.max(1, windows.length) + 4;

  return withCreateAllowance(budget, async () => {
    const stats = await diffApplyWindow(urls, authWindowId, true, loose);

    // Rebuild groups from the authoritative window.
    const authPinned = await pinnedTabsOf(authWindowId);
    const mirror = await getMirror();
    mirror.groups = {};
    mirror.order = [];
    mirror.pending = [];
    for (const tab of authPinned) {
      if (isEphemeralUrl(tabUrl(tab))) continue;
      const gid = await nextGid();
      mirror.groups[gid] = { url: tabUrl(tab), members: { [authWindowId]: tab.id } };
      mirror.order.push(gid);
    }
    await putMirror(mirror);

    if (settings.mirrorPinned) {
      for (const w of windows) {
        if (w.id === authWindowId) continue;
        await diffApplyWindow(urls, w.id, true, loose);
        await bindWindowToGroups(w.id);
      }
      // Verify the post-condition: every window holds exactly the set. One
      // corrective pass for a window that raced away, then honesty - the
      // trace and the popup report what actually happened, never wishes.
      for (const w of windows) {
        const pins = (await pinnedTabsOf(w.id)).filter((t) => !isEphemeralUrl(tabUrl(t)));
        if (pins.length !== mirror.order.length) {
          traceDiag(
            `converge verify win=${w.id}: ${pins.length} pins vs ${mirror.order.length} groups, re-applying`,
          );
          await diffApplyWindow(urls, w.id, true, loose);
          await bindWindowToGroups(w.id);
        }
      }
    }
    // The outcome of a canonical apply IS the canon, by definition, for both
    // callers: a restore is user truth, a startup converge is the persisted
    // truth re-asserted. Written directly - the putMirror ready-gate rightly
    // blocks canon writes DURING the bootstrap, but this one must land, or
    // the canon sits empty after a cold converge until the first live event,
    // and a restore-shaped straggler in that window can still mint and fan
    // out.
    const outcome = await getMirror();
    const canonUrls = outcome.order
      .map((gid) => outcome.groups[gid] && outcome.groups[gid].url)
      .filter((url) => url && !isEphemeralUrl(url));
    if (canonUrls.length) {
      await chrome.storage.local.set({ [CANON_KEY]: { urls: canonUrls, savedAt: Date.now() } });
    }
    scheduleAutoSnapshot();
    return stats;
  });
}

// Bind a window's unbound pinned tabs to the current groups: exact page
// first, then a same-origin drifted copy - but only when that origin has a
// single group (two Notion-page groups must not collapse onto one tab).
async function bindWindowToGroups(windowId) {
  const tabs = await pinnedTabsOf(windowId);
  const mirror = await getMirror();
  const originGroups = new Map();
  for (const gid of mirror.order) {
    const key = originKey(mirror.groups[gid].url);
    originGroups.set(key, (originGroups.get(key) || 0) + 1);
  }
  for (const tab of tabs) {
    if (groupOfTab(mirror, tab.id)) continue;
    const url = tabUrl(tab);
    if (isEphemeralUrl(url)) continue;
    const gid =
      mirror.order.find(
        (g) =>
          mirror.groups[g].members[windowId] === undefined &&
          pathKey(mirror.groups[g].url) === pathKey(url),
      ) ||
      mirror.order.find(
        (g) =>
          mirror.groups[g].members[windowId] === undefined &&
          originKey(mirror.groups[g].url) === originKey(url) &&
          originGroups.get(originKey(url)) === 1,
      );
    if (gid) mirror.groups[gid].members[windowId] = tab.id;
  }
  await putMirror(mirror);
}

// Diff one window's pinned tabs against the target list of urls.
async function diffApplyWindow(urls, windowId, closeExtras, loose = false) {
  const current = await pinnedTabsOf(windowId);
  const used = new Set();
  let reused = 0;
  let created = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const match =
      current.find((t) => !used.has(t.id) && tabUrl(t) === url) ||
      current.find((t) => !used.has(t.id) && pathKey(tabUrl(t)) === pathKey(url)) ||
      (loose
        ? current.find((t) => !used.has(t.id) && originKey(tabUrl(t)) === originKey(url))
        : undefined);
    if (match) {
      used.add(match.id);
      reused++;
      // A tab sitting in a live split view is never moved: Chrome gives
      // extensions no way to re-create a split (splitViewId is read-only),
      // so a matched tab keeps its split at the cost of exact ordering.
      const inSplit =
        match.splitViewId !== undefined &&
        match.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE;
      if (!inSplit && match.index !== i) {
        await quiet(chrome.tabs.move, match.id, { index: i });
      }
    } else {
      const tab = await guardedCreate(
        { windowId, url, pinned: true, index: i, active: false },
        `converge ${pathKey(url)}`,
        false,
      );
      if (tab) {
        used.add(tab.id);
        created++;
      } else {
        traceDiag(`diffApply: create refused/failed for ${url}`);
      }
    }
  }
  let closed = 0;
  if (closeExtras) {
    const extras = current.filter((t) => !used.has(t.id)).map((t) => t.id);
    if (extras.length) closed = await closeTabs(extras);
  }
  return { reused, created, closed };
}

async function restoreSnapshot(request, windowId, settings) {
  let snap;
  if (request.autoIndex !== undefined) {
    const ring = await getAutoSnaps();
    snap = ring[request.autoIndex];
  } else {
    const key = SNAP_PREFIX + request.name;
    ({ [key]: snap } = await chrome.storage.sync.get(key));
    if (!snap) ({ [key]: snap } = await chrome.storage.local.get(key)); // oversized set kept only locally
  }
  if (snap) snap = sanitizeSnap(snap);
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
  if (settings.lockToFront !== "off" && state.manual === true && !tab.pinned) {
    await moveLockedToFront(tab);
  }
  broadcastLockedFront(); // lock set changed: tell the sibling
  return state;
}

// Exposed for the e2e suite (reachable from extension contexts only).
globalThis.truePinToggle = async (tabId) => {
  const tab = await quiet(chrome.tabs.get, tabId);
  if (!tab) return null;
  return enqueue(() => toggleTab(tab), "toggle-test");
};
globalThis.__tpUiCall = (request) => enqueue(() => handleUi(request), `${request.type}-test`);
// Family interop, testable without a second extension in the harness: the
// payload builder and the external router with a chosen sender id.
globalThis.__tpFamilyPayload = () => lockedFrontPayload();
globalThis.__tpFamilyHandle = (msg, senderId) =>
  new Promise((resolve) => {
    const handled = handleFamilyMessage(msg, senderId, resolve);
    if (!handled) resolve(null);
  });
// Test hook: drive a synthetic webNavigation commit through the production
// classifier and job (puppeteer cannot type into the real omnibox).
globalThis.__tpSimulateNavCommit = (details) => {
  const kind = redirectKind(details);
  if (kind) enqueue(() => navRedirect(details.tabId, details.url, kind), "nav-redirect-test");
  return kind;
};
// Test hook: what a chrome://extensions Reload does to our state - the SW
// restarts with storage.session wiped and runs the install bootstrap.
globalThis.__tpSimulateReload = () => {
  chrome.storage.session.clear(() => {
    void chrome.runtime.lastError;
    enqueue(() => bootstrapAll(true), "test-reload");
  });
  return true;
};
// Test hook: a cold start WITHOUT an immediate bootstrap - storage.session is
// wiped and nothing else runs, so the caller can re-create the pinned tabs
// (as a session restore does) and let their onCreated events drive the
// settling path, exactly as on a real browser restart.
globalThis.__tpWipeState = () =>
  new Promise((resolve) => {
    coldBootstrapInFlight = false;
    chrome.storage.session.clear(() => {
      void chrome.runtime.lastError;
      resolve(true);
    });
  });

// --- popup UI backend -----------------------------------------------------------
// Manually-locked NON-pinned tabs across all normal windows, for the popup's
// LOCKED shelf. One session scan + one tab query, no per-tab round-trips.
async function lockedTabs() {
  const rec = await chrome.storage.session.get(null);
  const ids = new Set();
  for (const [key, value] of Object.entries(rec)) {
    if (/^t\d+$/.test(key) && value && value.manual === true) ids.add(Number(key.slice(1)));
  }
  if (!ids.size) return [];
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => ids.has(t.id) && !t.pinned && !isEphemeralUrl(tabUrl(t)))
    .map((t) => ({ id: t.id, title: t.title || tabUrl(t), url: tabUrl(t), windowId: t.windowId }));
}

async function handleUi(request) {
  const settings = await getSettings();
  switch (request.type) {
    case "ui:getState": {
      const pinned = (await pinnedTabsOf(request.windowId)).filter(
        (t) => !isEphemeralUrl(tabUrl(t)),
      );
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
        // `protected` is the real per-tab state (same rule as `active`), so the
        // popup renders the lock from this even for a discarded pin that has
        // not reported its state yet.
        pinned: await Promise.all(
          pinned.map(async (t) => {
            const st = (await getTabState(t.id)) || newTabState(t);
            return {
              id: t.id,
              windowId: t.windowId,
              title: t.title || tabUrl(t),
              url: tabUrl(t),
              protected: computeProtected({ ...st, pinned: !!t.pinned, url: tabUrl(t) }, settings),
              split:
                t.splitViewId !== undefined && t.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE
                  ? t.splitViewId
                  : -1,
            };
          }),
        ),
        active,
        locked: await lockedTabs(),
        snapshots: await listSnapshots(),
        autoSnaps: ring.map((snap, index) => ({
          index,
          count: (snap.urls || []).length,
          splits: (snap.splits || []).length,
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
    case "ui:clearLock": {
      // Release a manual lock from the LOCKED shelf. Sets manual=null (back to
      // the derived default), NOT manual=false - so if the tab is later pinned,
      // auto-protection still applies.
      const tab = await quiet(chrome.tabs.get, request.tabId);
      if (!tab) return { error: "hintPlain" };
      const state = (await getTabState(tab.id)) || newTabState(tab);
      state.pinned = !!tab.pinned;
      if (tabUrl(tab)) state.url = tabUrl(tab);
      state.manual = null;
      state.protected = computeProtected(state, settings);
      await putTabState(tab.id, state);
      applyToTab(tab.id, state, settings);
      return { ok: true };
    }
    case "ui:setAutoLock": {
      // The popup's toggle on a pinned tab drives the GLOBAL auto-protection.
      await writeSettings({ autoLockPinned: !!request.on });
      return { ok: true };
    }
    case "ui:exportData": {
      // Everything durable and portable in one clean file: settings plus the
      // named sets. Autosaves and the canonical pinned layout stay device-
      // local by design - restoring another machine's canon is exactly the
      // mass-duplication class v3.8.0 killed.
      const all = await chrome.storage.sync.get(null);
      return tpPlatform.buildExport(all, chrome.runtime.getManifest().version);
    }
    case "ui:importData": {
      const v = tpPlatform.validateImport(request.payload);
      if (!v.ok) return { ok: false, error: v.error };
      await writeSettings(v.settings);
      i18nReady = null; // language may have changed
      let setsWritten = 0;
      for (const [name, value] of Object.entries(v.sets)) {
        // Additive by name: replace the same-named, add the new, never touch
        // the unmentioned. A single oversized set fails its own write only.
        const ok = await chrome.storage.sync
          .set({ [`${SNAP_PREFIX}${name}`]: value })
          .then(() => true)
          .catch(() => false);
        if (ok) setsWritten++;
      }
      return { ok: true, sets: setsWritten };
    }
    case "ui:diagnostics": {
      // One-click state dump for the options page: everything needed to
      // diagnose a duplication or convergence report, nothing personal
      // beyond what the popup already shows. Stays local - the user decides
      // where the clipboard goes.
      const [canon, mirror, windows, session] = await Promise.all([
        getCanon(),
        getMirror(),
        chrome.windows.getAll({ populate: true }),
        chrome.storage.session.get(["createLedger", "mirrorReady", "selfClosed"]),
      ]);
      return {
        version: chrome.runtime.getManifest().version,
        settings,
        canon,
        groups: mirror.order.map((gid) => ({
          gid,
          url: mirror.groups[gid] && mirror.groups[gid].url,
          members: mirror.groups[gid] && mirror.groups[gid].members,
        })),
        pending: mirror.pending,
        windows: windows.map((w) => ({
          id: w.id,
          type: w.type,
          incognito: w.incognito,
          tabs: (w.tabs || [])
            .filter((t) => t.pinned)
            .map((t) => ({ id: t.id, url: tabUrl(t), index: t.index })),
        })),
        createLedger: session.createLedger || [],
        mirrorReady: !!session.mirrorReady,
        selfClosedCount: Object.keys(session.selfClosed || {}).length,
        trace: globalThis.__tpDiag ? globalThis.__tpDiag.trace.slice() : [],
        at: new Date().toISOString(),
      };
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
