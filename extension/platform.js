// TruePin - the settings platform, shared VERBATIM by the service worker
// (importScripts) and the options page (script tag). One source of truth for
// defaults and validation heals the drift that had two DEFAULTS copies in two
// files, guards every read against a poisoned store, and keeps writes
// forward-compatible: keys a NEWER version added ride through an older
// version's write untouched. Spec: docs/specs/settings-platform.md.
const tpPlatform = (() => {
  const DEFAULTS = {
    autoLockPinned: true,
    mirrorPinned: true,
    autoSnapshot: true,
    notifyReopen: true,
    navRedirect: true, // address-bar navigation in a protected tab forks to a new tab
    linkRedirect: true, // cross-site link clicks in a protected tab fork to a new tab
    iconStyle: "color", // "color" | "mono" (match browser UI)
    lockToFront: "off", // "off" | "onLock" | "always" - pull locked regular tabs to the front
    theme: "auto", // "auto" | "light" | "dark" (options/popup shell)
    language: "auto",
  };

  const SETTING_ENUMS = {
    iconStyle: ["color", "mono"],
    lockToFront: ["off", "onLock", "always"],
    theme: ["auto", "light", "dark"],
  };

  // Validate every known key against its default's shape; enums must be in
  // range, booleans boolean, strings capped. Unknown keys pass through - they
  // belong to a newer schema and dropping them here is how settings written
  // on one machine used to be silently eaten on another.
  function normalizeSettings(raw) {
    const src = raw && typeof raw === "object" ? { ...raw } : {};
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const value = src[key];
      const def = DEFAULTS[key];
      if (typeof def === "boolean") {
        if (typeof value === "boolean") out[key] = value;
      } else if (SETTING_ENUMS[key]) {
        if (SETTING_ENUMS[key].includes(value)) out[key] = value;
      } else if (typeof value === "string") {
        out[key] = value.slice(0, 200);
      }
    }
    for (const key of Object.keys(src)) {
      if (!(key in out)) out[key] = src[key];
    }
    return out;
  }

  const SNAP_PREFIX = "snap:";
  const EXPORT_FORMAT = "truepin-settings";
  const IMPORT_MAX_BYTES = 256 * 1024; // sets carry urls; a real export is far smaller

  // Build the export payload from a full storage.sync snapshot. Settings are
  // normalized (a broken store exports healthy), named sets ride verbatim.
  // There are no secrets in TruePin - the file is clean by construction.
  function buildExport(syncAll, version) {
    const sets = {};
    for (const [key, value] of Object.entries(syncAll || {})) {
      if (key.startsWith(SNAP_PREFIX) && value && Array.isArray(value.urls)) {
        sets[key.slice(SNAP_PREFIX.length)] = value;
      }
    }
    return {
      format: EXPORT_FORMAT,
      schema: 1,
      version,
      exportedAt: new Date().toISOString(),
      settings: normalizeSettings(syncAll && syncAll.settings),
      sets,
    };
  }

  // Validate a parsed import. Returns {ok, settings, sets, counts} or
  // {ok:false, error}. Import is additive-by-name for sets: replace the
  // same-named, add the new, never delete the unmentioned - "import wiped my
  // other machine's sets" is designed out, not warned about.
  function validateImport(parsed) {
    if (!parsed || typeof parsed !== "object" || parsed.format !== EXPORT_FORMAT) {
      return { ok: false, error: "format" };
    }
    const settings = normalizeSettings(parsed.settings);
    const sets = {};
    for (const [name, value] of Object.entries(parsed.sets || {})) {
      if (typeof name !== "string" || !name.trim()) continue;
      if (!value || !Array.isArray(value.urls)) continue;
      const urls = value.urls.filter((u) => typeof u === "string").slice(0, 200);
      if (!urls.length) continue;
      sets[name.slice(0, 80)] = { ...value, urls };
    }
    return {
      ok: true,
      settings,
      sets,
      counts: { settings: Object.keys(DEFAULTS).length, sets: Object.keys(sets).length },
    };
  }

  return {
    DEFAULTS,
    SETTING_ENUMS,
    SNAP_PREFIX,
    EXPORT_FORMAT,
    IMPORT_MAX_BYTES,
    normalizeSettings,
    buildExport,
    validateImport,
  };
})();
