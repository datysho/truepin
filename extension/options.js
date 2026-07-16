// TruePin - options page. Saves on change, no Save button.
const DEFAULTS = {
  autoLockPinned: true,
  mirrorPinned: true,
  autoSnapshot: true,
  notifyReopen: true,
  navRedirect: true,
  linkRedirect: true,
  iconStyle: "color",
  lockToFront: "off",
  theme: "auto",
  language: "auto",
};
const FIELDS = Object.keys(DEFAULTS);

// "auto" -> prefers-color-scheme governs; "light"/"dark" force via data-theme.
function applyTheme(v) {
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}

function fieldKind(field) {
  const def = DEFAULTS[field];
  if (typeof def === "boolean") return "bool";
  if (typeof def === "number") return "num";
  return "str";
}

async function localize() {
  const { settings } = await chrome.storage.sync.get("settings");
  await tpI18n.init((settings && settings.language) || "auto");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = tpI18n.t(el.dataset.i18n);
  }
  document.title = tpI18n.t("optSettingsTitle");
  document.querySelector('#language option[value="auto"]').textContent = tpI18n.t("langAuto");
}

async function load() {
  const { settings } = await chrome.storage.sync.get("settings");
  const merged = { ...DEFAULTS, ...(settings || {}) };
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    const kind = fieldKind(field);
    if (kind === "bool") el.checked = !!merged[field];
    else el.value = merged[field];
  }
  applyTheme(merged.theme);
}

let savedTimer = null;

async function save() {
  const settings = {};
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    const kind = fieldKind(field);
    if (kind === "bool") {
      settings[field] = el.checked;
    } else if (kind === "num") {
      const value = Number(el.value);
      settings[field] =
        Number.isFinite(value) && value > 0
          ? Math.max(3, Math.min(120, Math.round(value)))
          : DEFAULTS[field];
    } else {
      settings[field] = el.value;
    }
  }
  await chrome.storage.sync.set({ settings });
  applyTheme(settings.theme);
  await localize(); // language may have changed
  const saved = document.getElementById("saved");
  saved.style.visibility = "visible";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    saved.style.visibility = "hidden";
  }, 1500);
}

for (const field of FIELDS) {
  document.getElementById(field).addEventListener("change", save);
}
localize().then(load);

// One-click diagnostics: full engine state to the clipboard, so a weirdness
// report can carry the evidence without opening a console.
document.getElementById("diagBtn").addEventListener("click", async () => {
  const dump = await chrome.runtime.sendMessage({ type: "ui:diagnostics" });
  await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
  const note = document.getElementById("diagCopied");
  note.style.visibility = "visible";
  setTimeout(() => {
    note.style.visibility = "hidden";
  }, 2500);
});

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;
