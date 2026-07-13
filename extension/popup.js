// TruePin - popup. All logic lives in the service worker; the popup only
// renders ui:getState and sends ui:* commands.

let windowId = null;
let activeTabId = null;
let state = null;

const $ = (id) => document.getElementById(id);
const t = (key, subs) => tpI18n.t(key, subs);

const send = (message) => chrome.runtime.sendMessage(message);

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

function snapRow({ label, meta, onRestore, onDelete, tooltip }) {
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
  metaEl.textContent = `· ${meta}`;
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

function render() {
  // Lock switch for the active tab.
  const active = state.active;
  $("lockToggle").checked = !!(active && active.protected);
  $("lockHint").textContent = !active
    ? ""
    : active.protected
      ? active.pinned
        ? t("hintProtectedPinned")
        : t("hintProtectedManual")
      : active.pinned
        ? t("hintAutoOff")
        : t("hintPlain");

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
    const img = document.createElement("img");
    img.src = favicon(tab.url);
    const span = document.createElement("span");
    span.className = "t";
    span.textContent = tab.title;
    span.title = tab.url;
    li.append(img, span);
    list.append(li);
  }
  $("saveBtn").disabled = !state.pinned.length;
  updateSaveButton();

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
    snapList.append(
      snapRow({
        label: snap.name,
        meta: `${tpI18n.tabsCount(snap.count)} · ${relTime(snap.savedAt)}`,
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
    autoList.append(
      snapRow({
        label: relTime(snap.savedAt),
        meta: tpI18n.tabsCount(snap.count),
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
  setStatus(t("statusSaved", [name, tpI18n.tabsCount(state.pinned.length)]));
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
  await tpI18n.init((settings && settings.language) || "auto");
  localizeDom();

  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : undefined;

  $("lockToggle").addEventListener("change", async () => {
    if (activeTabId === undefined) return;
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

  await refresh();
}

init();
