// TruePin - options page. Saves on change, no Save button.
// Defaults and validation come from the shared platform module - the page
// carried its own drifting copy once (theme lived only here).
const DEFAULTS = tpPlatform.DEFAULTS;
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
  const patch = {};
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    const kind = fieldKind(field);
    if (kind === "bool") {
      patch[field] = el.checked;
    } else if (kind === "num") {
      const value = Number(el.value);
      patch[field] =
        Number.isFinite(value) && value > 0
          ? Math.max(3, Math.min(120, Math.round(value)))
          : DEFAULTS[field];
    } else {
      patch[field] = el.value;
    }
  }
  // Merge over the RAW stored object, never replace it: keys a newer TruePin
  // added on a synced machine must survive this page's write.
  const { settings: raw } = await chrome.storage.sync.get("settings");
  const settings = tpPlatform.normalizeSettings({ ...(raw || {}), ...patch });
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

// One toast for every transient confirmation, so copy / export / import all
// speak with one uniform voice instead of a note wedged beside each button.
let toastTimer = null;
function showToast(key, kind = "ok") {
  const toast = document.getElementById("toast");
  toast.textContent = tpI18n.t(key);
  toast.classList.toggle("err", kind === "err");
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

// --- backup: export / import ------------------------------------------------
// One clean JSON file: settings + named sets. No secrets exist in TruePin,
// so there is nothing to opt into. Import is additive-by-name for sets and
// goes through the engine (validated, serialized with everything else).
document.getElementById("exportBtn").addEventListener("click", async () => {
  const payload = await chrome.runtime.sendMessage({ type: "ui:exportData" });
  if (!payload || payload.error) return showToast("dataFailed", "err");
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `truepin-settings-${payload.version}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("dataExported");
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // re-selecting the same file must fire again
  if (!file) return;
  if (file.size > tpPlatform.IMPORT_MAX_BYTES) return showToast("dataFailed", "err");
  let parsed = null;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return showToast("dataFailed", "err");
  }
  const result = await chrome.runtime.sendMessage({ type: "ui:importData", payload: parsed });
  if (!result || !result.ok) return showToast("dataFailed", "err");
  await localize();
  await load(); // repaint the controls from the imported truth
  showToast("dataImported");
});

// One-click diagnostics: full engine state to the clipboard, so a weirdness
// report can carry the evidence without opening a console.
document.getElementById("diagBtn").addEventListener("click", async () => {
  const dump = await chrome.runtime.sendMessage({ type: "ui:diagnostics" });
  try {
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
  } catch {
    return showToast("dataFailed", "err");
  }
  showToast("optDiagCopied");
});

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;
