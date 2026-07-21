// TruePin - popup. All logic lives in the service worker; the popup only
// renders ui:getState and sends ui:* commands.

let windowId = null;
let activeTabId = null;
let state = null;

const $ = (id) => document.getElementById(id);
const t = (key, subs) => tpI18n.t(key, subs);

const send = (message) => chrome.runtime.sendMessage(message);

// Theme: "auto" lets prefers-color-scheme govern; "light"/"dark" force it via a
// data-theme attribute the CSS overrides key off. Chosen in Options (System /
// Light / Dark) and persisted in settings.theme; the popup only applies it.
function applyTheme(v) {
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}

// Bottom action bar. openOptions keeps its own handler in init(); the github,
// review and donate buttons stay hidden until their config URLs are set, so
// there are never dead links.
function initFooter() {
  const wire = (id, url) => {
    if (!url) {
      $(id).hidden = true;
    } else {
      $(id).addEventListener("click", () => chrome.tabs.create({ url }));
    }
  };
  wire("githubBtn", typeof TP_GITHUB_URL === "undefined" ? "" : TP_GITHUB_URL);
  wire("reviewBtn", typeof TP_REVIEW_URL === "undefined" ? "" : TP_REVIEW_URL);
  wire("donateBtn", typeof TP_PAYPAL_URL === "undefined" ? "" : TP_PAYPAL_URL);
}

function localizeDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}

function favicon(url) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "16");
  return u.toString();
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60_000) return t("relNow");
  if (d < 3_600_000) return t("relMin", [Math.floor(d / 60_000)]);
  if (d < 86_400_000) return t("relHours", [Math.floor(d / 3_600_000)]);
  return new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
}

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text || "";
  el.className = isError ? "err" : "";
}

async function refresh() {
  state = await send({ type: "ui:getState", windowId, tabId: activeTabId });
  render();
}

function snapRow({ label, meta, metaTitle, onRestore, onDelete, tooltip }) {
  const row = document.createElement("div");
  row.className = "snap";
  const info = document.createElement("span");
  info.className = "info";
  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = label;
  nameEl.title = tooltip || label;
  const metaEl = document.createElement("span");
  metaEl.className = "meta muted";
  metaEl.textContent = meta;
  if (metaTitle) metaEl.title = metaTitle;
  info.append(nameEl, metaEl);
  const restoreBtn = document.createElement("button");
  restoreBtn.textContent = t("restoreBtn");
  restoreBtn.addEventListener("click", onRestore);
  row.append(info, restoreBtn);
  if (onDelete) {
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = t("deleteTitle");
    x.addEventListener("click", () => {
      if (x.dataset.confirm) {
        onDelete();
      } else {
        x.dataset.confirm = "1";
        x.textContent = t("confirmDelete");
        setTimeout(() => {
          delete x.dataset.confirm;
          x.textContent = "✕";
        }, 2500);
      }
    });
    row.append(x);
  }
  return row;
}

const OPEN_LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

// The LOCKED shelf: manually-locked non-pinned tabs across all windows. Rendered
// only when there is at least one, so at rest the popup is byte-for-byte as before.
function renderLocked() {
  const section = $("lockedSection");
  const locked = (state && state.locked) || [];
  if (!locked.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("lockCount").textContent = `(${locked.length})`;
  const list = $("lockedList");
  list.textContent = "";
  // Current-window locks first, then the ones living in other windows.
  const rows = [...locked].sort(
    (a, b) => (a.windowId === windowId ? 0 : 1) - (b.windowId === windowId ? 0 : 1),
  );
  for (const tab of rows) {
    const li = document.createElement("li");
    li.title = t("gotoTitle");
    const img = document.createElement("img");
    img.src = favicon(tab.url);
    li.append(img);
    const lock = document.createElement("span");
    lock.className = "lockmark";
    lock.textContent = "\u{1F512}";
    li.append(lock);
    const span = document.createElement("span");
    span.className = "t";
    span.textContent = tab.title;
    li.append(span);
    if (tab.windowId !== windowId) {
      const other = document.createElement("span");
      other.className = "winmark";
      other.title = t("otherWindowTitle");
      li.append(other);
    }
    const unlock = document.createElement("button");
    unlock.className = "u";
    unlock.title = t("unlockTitle");
    unlock.innerHTML = OPEN_LOCK_SVG;
    unlock.addEventListener("click", async (event) => {
      event.stopPropagation();
      await send({ type: "ui:clearLock", tabId: tab.id });
      refresh();
    });
    li.append(unlock);
    li.addEventListener("click", () => focusTab(tab.id, tab.windowId));
    list.append(li);
  }
}

// The action popup tears down the moment focus leaves it, so both calls must be
// dispatched synchronously before that - awaiting the first dropped the second
// when the popup closed mid-await, which is why clicks never switched tabs.
// Activate the tab first (the point of the click), then raise its window.
function focusTab(id, win) {
  chrome.tabs.update(id, { active: true });
  chrome.windows.update(win, { focused: true });
  window.close();
}

function render() {
  // Three controls, all always shown:
  //  - "Protect pinned tabs" drives the GLOBAL auto-protection setting.
  //  - "Pin this tab" is the active tab's own pinned state (inert without one).
  //  - "Lock this tab" is the active tab's own manual lock; inert (greyed) when
  //    there is no active tab, or the active tab is pinned - a pinned tab is
  //    governed by "Protect pinned tabs", not by a per-tab lock.
  const active = state.active;
  $("protectToggle").checked = !!state.settings.autoLockPinned;

  const pinToggle = $("pinToggle");
  const pinDisabled = !active;
  pinToggle.disabled = pinDisabled;
  pinToggle.checked = !pinDisabled && !!active.pinned;
  $("pinRow").classList.toggle("disabled", pinDisabled);

  const lockDisabled = !active || !!active.pinned;
  const lockToggle = $("lockToggle");
  lockToggle.disabled = lockDisabled;
  lockToggle.checked = !lockDisabled && !!active.protected;
  $("lockRow").classList.toggle("disabled", lockDisabled);

  // Current pinned tabs.
  const list = $("pinnedList");
  list.textContent = "";
  $("pinCount").textContent = state.pinned.length ? `(${state.pinned.length})` : "";
  if (!state.pinned.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = t("noPinned");
    list.append(li);
  }
  for (const tab of state.pinned) {
    const li = document.createElement("li");
    li.title = t("gotoTitle");
    li.addEventListener("click", () => focusTab(tab.id, tab.windowId));
    const img = document.createElement("img");
    img.src = favicon(tab.url);
    li.append(img);
    // The lock reflects the tab's real protected state, so it shows even on a
    // discarded pin that has not reported its state yet.
    if (tab.protected) {
      const lock = document.createElement("span");
      lock.className = "lockmark";
      lock.textContent = "\u{1F512}";
      lock.title = t("pinnedProtectedTitle");
      li.append(lock);
    }
    const span = document.createElement("span");
    span.className = "t";
    span.textContent = tab.title;
    span.title = tab.url;
    li.append(span);
    if (tab.split !== undefined && tab.split !== -1) {
      const mark = document.createElement("span");
      mark.className = "splitmark";
      mark.textContent = "⧉";
      mark.title = t("splitTitle");
      li.append(mark);
    }
    list.append(li);
  }
  $("saveBtn").disabled = !state.pinned.length;
  updateSaveButton();
  renderLocked();

  // Named snapshots.
  const snapList = $("snapList");
  snapList.textContent = "";
  if (!state.snapshots.length) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = t("noSnaps");
    snapList.append(div);
  }
  for (const snap of state.snapshots) {
    const splitMark = snap.splits ? ` · ⧉${snap.splits > 1 ? snap.splits : ""}` : "";
    const localMark = snap.synced === false ? ` · ${t("localOnly")}` : "";
    snapList.append(
      snapRow({
        label: snap.name,
        meta: `${tpI18n.tabsCount(snap.count)} · ${relTime(snap.savedAt)}${splitMark}${localMark}`,
        metaTitle: snap.synced === false ? t("localOnly") : snap.splits ? t("splitTitle") : undefined,
        onRestore: () => restoreSnap({ name: snap.name }),
        onDelete: async () => {
          await send({ type: "ui:deleteSnapshot", name: snap.name });
          setStatus(t("statusDeleted", [snap.name]));
          refresh();
        },
      }),
    );
  }

  // Autosaves dropdown.
  const autoList = $("autoList");
  autoList.textContent = "";
  $("autoCount").textContent = state.autoSnaps.length ? `(${state.autoSnaps.length})` : "";
  if (!state.autoSnaps.length) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = t("noAutoSnaps");
    autoList.append(div);
  }
  for (const snap of state.autoSnaps) {
    const splitMark = snap.splits ? ` · ⧉${snap.splits > 1 ? snap.splits : ""}` : "";
    autoList.append(
      snapRow({
        label: relTime(snap.savedAt),
        meta: `${tpI18n.tabsCount(snap.count)}${splitMark}`,
        metaTitle: snap.splits ? t("splitTitle") : undefined,
        onRestore: () => restoreSnap({ autoIndex: snap.index }),
      }),
    );
  }
}

function updateSaveButton() {
  const name = $("snapName").value.trim();
  const exists = state && state.snapshots.some((s) => s.name === name);
  $("saveBtn").textContent = exists ? t("updateBtn") : t("saveBtn");
}

async function saveSnap() {
  const name = $("snapName").value.trim();
  if (!name) {
    setStatus(t("statusNameEmpty"), true);
    $("snapName").focus();
    return;
  }
  const result = await send({ type: "ui:saveSnapshot", windowId, name });
  if (result.error) {
    setStatus(t(result.error), true);
    return;
  }
  const count = tpI18n.tabsCount(result.count ?? state.pinned.length);
  setStatus(
    result.synced === false
      ? t("statusSavedLocal", [name, count])
      : t("statusSaved", [name, count]),
  );
  $("snapName").value = "";
  refresh();
}

async function restoreSnap(target) {
  const result = await send({ type: "ui:restoreSnapshot", windowId, ...target });
  if (result.error) {
    setStatus(t(result.error), true);
    return;
  }
  setStatus(
    `${t("statusRestored", [result.created, result.reused, result.closed])}. ${t("statusUndo")}`,
  );
  refresh();
}

async function init() {
  const { settings } = await chrome.storage.sync.get("settings");
  applyTheme((settings && settings.theme) || "auto");
  await tpI18n.init((settings && settings.language) || "auto");
  localizeDom();
  initFooter();

  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : undefined;

  $("protectToggle").addEventListener("change", async () => {
    const result = await send({ type: "ui:setAutoLock", on: $("protectToggle").checked });
    if (result && result.error) setStatus(t(result.error), true);
    refresh();
  });
  $("pinToggle").addEventListener("change", async () => {
    // render() disables this without an active tab; guard anyway.
    if (!state || !state.active) return;
    const result = await send({ type: "ui:setPinned", tabId: activeTabId, on: $("pinToggle").checked });
    if (result && result.error) setStatus(t(result.error), true);
    refresh();
  });
  $("lockToggle").addEventListener("change", async () => {
    // render() disables this for a pinned or absent active tab; guard anyway.
    if (!state || !state.active || state.active.pinned) return;
    const result = await send({ type: "ui:toggle", tabId: activeTabId });
    if (result && result.error) setStatus(t(result.error), true);
    refresh();
  });
  $("saveBtn").addEventListener("click", saveSnap);
  $("snapName").addEventListener("input", updateSaveButton);
  $("snapName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveSnap();
  });
  $("openOptions").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $("refreshSnaps").addEventListener("click", () => {
    const btn = $("refreshSnaps");
    btn.classList.remove("spin");
    void btn.offsetWidth; // restart the spin on repeated clicks
    btn.classList.add("spin");
    refresh();
  });

  // Named sets live in storage.sync; locks live in storage.session. Reflect
  // either changing live (a set propagated from another machine, or a lock set
  // elsewhere) instead of only on the next popup open.
  let sessionRefreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.keys(changes).some((k) => k.startsWith("snap:"))) {
      refresh();
    } else if (area === "session" && Object.keys(changes).some((k) => /^t\d+$/.test(k))) {
      clearTimeout(sessionRefreshTimer);
      sessionRefreshTimer = setTimeout(refresh, 150);
    }
  });

  await refresh();
  // First render has set the real toggle states; re-enable switch animations for
  // subsequent user interaction. Two frames so the applied state is painted
  // before transitions turn back on (otherwise the enabling frame animates).
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.documentElement.classList.remove("tp-preload")),
  );
}

init();
