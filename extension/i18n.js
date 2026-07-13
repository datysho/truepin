// TruePin - tiny i18n layer over _locales with a runtime language override.
// chrome.i18n cannot switch locale at runtime, so messages are fetched from
// _locales/<lang>/messages.json directly. Fallback: exact -> base -> en.
// Used by the service worker (importScripts) and by popup/options (<script>).
const tpI18n = (() => {
  const SUPPORTED = ["en", "ru", "uk", "de", "fr", "es", "pt", "zh_CN"];
  let messages = null;
  let pluralRules = null;

  function resolve(lang) {
    const norm = String(lang || "").replace(/-/g, "_");
    if (SUPPORTED.includes(norm)) return norm;
    const base = norm.split("_")[0];
    if (base === "zh") return "zh_CN";
    if (SUPPORTED.includes(base)) return base;
    return "en";
  }

  async function init(language) {
    const lang = resolve(
      language && language !== "auto" ? language : chrome.i18n.getUILanguage(),
    );
    const response = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    messages = await response.json();
    pluralRules = new Intl.PluralRules(lang.replace("_", "-"));
    return lang;
  }

  function t(key, subs = []) {
    const entry = messages && messages[key];
    let text = entry ? entry.message : key;
    const list = Array.isArray(subs) ? subs : [subs];
    list.forEach((value, i) => {
      text = text.split(`$${i + 1}`).join(String(value));
    });
    return text;
  }

  function tabsCount(n) {
    const category = pluralRules ? pluralRules.select(n) : "other";
    const key = `tabs_${category}`;
    return t(messages && messages[key] ? key : "tabs_other", [n]);
  }

  return { init, t, tabsCount, resolve };
})();
