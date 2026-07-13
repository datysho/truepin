// TruePin - content script (top frame only).
//
// Since v3 the extension never argues with a close via beforeunload - a
// protected tab that gets closed is simply reopened by the service worker.
// The content script's only job left is the 🔒 title prefix.
(() => {
  if (window.__truePinLoaded) return;
  window.__truePinLoaded = true;
  if (window.self !== window.top) return;

  const TITLE_PREFIX = "\u{1F512}\u200E ";
  const TAKEOVER_EVENT = "__truepin_takeover__";

  let locked = false;
  let showIcon = true;
  let orphaned = false; // a newer copy of this script took over
  let titleObserver = null;
  let titleDeferred = false;

  // After an extension update/reload the old copy keeps its DOM listeners but
  // loses its chrome.* context. The fresh copy announces itself; stale copies
  // mute themselves.
  window.dispatchEvent(new Event(TAKEOVER_EVENT));
  window.addEventListener(TAKEOVER_EVENT, () => {
    orphaned = true;
    locked = false;
    stopTitleWatch();
    unprefixTitle();
  });

  function send(message) {
    if (orphaned) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      orphaned = true; // extension context invalidated
      return Promise.resolve(undefined);
    }
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (orphaned || !request || request.type !== "apply") return;
    applyState(request);
    sendResponse({ ok: true });
  });

  function hello() {
    send({ type: "hello", top: true }).then((response) => {
      if (response) applyState(response);
    });
  }

  function applyState(state) {
    locked = !!state.locked;
    showIcon = state.showIcon !== false;
    updateTitle();
  }

  if (document.prerendering) {
    document.addEventListener("prerenderingchange", hello, { once: true });
  } else {
    hello();
  }
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) hello();
  });

  // --- 🔒 title prefix ---------------------------------------------------------
  function updateTitle() {
    if (document.readyState === "loading") {
      // <title> is not parsed yet at document_start.
      if (!titleDeferred) {
        titleDeferred = true;
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            titleDeferred = false;
            applyTitleNow();
          },
          { once: true },
        );
      }
      return;
    }
    applyTitleNow();
  }

  function applyTitleNow() {
    if (locked && showIcon && !orphaned) {
      prefixTitle();
      watchTitle();
    } else {
      stopTitleWatch();
      unprefixTitle();
    }
  }

  function prefixTitle() {
    if (!document.title.startsWith(TITLE_PREFIX)) {
      document.title = TITLE_PREFIX + document.title.split(TITLE_PREFIX).join("");
    }
  }

  function unprefixTitle() {
    if (document.title.includes(TITLE_PREFIX)) {
      document.title = document.title.split(TITLE_PREFIX).join("");
    }
  }

  function watchTitle() {
    if (titleObserver || typeof MutationObserver === "undefined") return;
    const titleElement = document.querySelector("head > title");
    if (!titleElement) return;
    titleObserver = new MutationObserver(() => {
      if (locked && showIcon && !orphaned) prefixTitle();
    });
    titleObserver.observe(titleElement, { subtree: true, childList: true });
  }

  function stopTitleWatch() {
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
  }
})();
