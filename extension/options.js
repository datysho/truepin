// TruePin - options page. Saves on change, no Save button.
const DEFAULTS = {
  autoLockPinned: true,
  showIcon: true,
  restoreClosed: true,
  restoreCooldownSec: 15,
  followNewWindow: true,
  autoSnapshot: true,
};
const FIELDS = Object.keys(DEFAULTS);

async function load() {
  const { settings } = await chrome.storage.sync.get("settings");
  const merged = { ...DEFAULTS, ...(settings || {}) };
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    if (typeof DEFAULTS[field] === "boolean") {
      el.checked = !!merged[field];
    } else {
      el.value = merged[field];
    }
  }
}

let savedTimer = null;

async function save() {
  const settings = {};
  for (const field of FIELDS) {
    const el = document.getElementById(field);
    if (typeof DEFAULTS[field] === "boolean") {
      settings[field] = el.checked;
    } else {
      const value = Number(el.value);
      settings[field] = Number.isFinite(value) && value > 0
        ? Math.max(3, Math.min(120, Math.round(value)))
        : DEFAULTS[field];
    }
  }
  await chrome.storage.sync.set({ settings });
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
load();
