// TruePin - popup. All logic lives in the service worker; the popup only
// renders ui:getState and sends ui:* commands.

let windowId = null;
let activeTabId = null;
let state = null;

const $ = (id) => document.getElementById(id);

const send = (message) => chrome.runtime.sendMessage(message);

function favicon(url) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "16");
  return u.toString();
}

function tabsWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} вкладка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} вкладки`;
  return `${n} вкладок`;
}

function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60_000) return "только что";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} мин назад`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} ч назад`;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
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

function render() {
  // Lock switch for the active tab.
  const active = state.active;
  $("lockToggle").checked = !!(active && active.protected);
  $("lockHint").textContent = !active
    ? ""
    : active.protected
      ? active.pinned
        ? "Защищена (закреплена)"
        : "Защищена вручную"
      : active.pinned
        ? "Автозащита закреплённых выключена"
        : "Обычная вкладка";

  // Current pinned tabs.
  const list = $("pinnedList");
  list.textContent = "";
  $("pinCount").textContent = state.pinned.length ? `(${state.pinned.length})` : "";
  if (!state.pinned.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Закреплённых вкладок нет";
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

  // Snapshots.
  const snapList = $("snapList");
  snapList.textContent = "";
  if (!state.snapshots.length) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "Наборов пока нет - сохрани текущий.";
    snapList.append(div);
  }
  for (const snap of state.snapshots) {
    const row = document.createElement("div");
    row.className = "snap";
    const info = document.createElement("span");
    info.className = "info";
    info.textContent = snap.auto ? "Авто" : snap.name;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = ` · ${tabsWord(snap.count)} · ${relTime(snap.savedAt)}`;
    info.append(meta);
    if (snap.auto) {
      info.title = "Последний набор закреплённых: страховка и «отменить» после восстановления";
    }
    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "Восстановить";
    restoreBtn.addEventListener("click", () => restoreSnap(snap));
    row.append(info, restoreBtn);
    if (!snap.auto) {
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "✕";
      x.title = "Удалить набор";
      x.addEventListener("click", async () => {
        if (x.dataset.confirm) {
          await send({ type: "ui:deleteSnapshot", name: snap.name });
          setStatus(`Набор «${snap.name}» удалён`);
          refresh();
        } else {
          x.dataset.confirm = "1";
          x.textContent = "точно?";
          setTimeout(() => {
            delete x.dataset.confirm;
            x.textContent = "✕";
          }, 2500);
        }
      });
      row.append(x);
    }
    snapList.append(row);
  }
}

function updateSaveButton() {
  const name = $("snapName").value.trim();
  const exists = state && state.snapshots.some((s) => !s.auto && s.name === name);
  $("saveBtn").textContent = exists ? "Обновить" : "Сохранить";
}

async function saveSnap() {
  const name = $("snapName").value.trim();
  if (!name) {
    setStatus("Дай набору имя", true);
    $("snapName").focus();
    return;
  }
  const result = await send({ type: "ui:saveSnapshot", windowId, name });
  if (result.error) {
    setStatus(result.error, true);
    return;
  }
  setStatus(`Набор «${name}» сохранён (${tabsWord(state.pinned.length)})`);
  $("snapName").value = "";
  refresh();
}

async function restoreSnap(snap) {
  const result = await send({
    type: "ui:restoreSnapshot",
    windowId,
    name: snap.auto ? undefined : snap.name,
    auto: snap.auto,
  });
  if (result.error) {
    setStatus(result.error, true);
    return;
  }
  const parts = [];
  if (result.created) parts.push(`открыто ${result.created}`);
  if (result.reused) parts.push(`на месте ${result.reused}`);
  if (result.closed) parts.push(`закрыто ${result.closed}`);
  setStatus(
    `Восстановлено (${parts.join(", ") || "без изменений"})` +
      (snap.auto ? "" : ". Прежний набор - в «Авто»"),
  );
  refresh();
}

async function init() {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : undefined;

  $("lockToggle").addEventListener("change", async () => {
    if (activeTabId === undefined) return;
    const result = await send({ type: "ui:toggle", tabId: activeTabId });
    if (result && result.error) setStatus(result.error, true);
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
