// TruePin - content script.
//
// Top frame: owns the beforeunload guard and the 🔒 title prefix.
// Every frame: reports user activation to the background, because Chrome
// only shows the beforeunload dialog after the page has been interacted
// with - and clicks inside iframes count.
(() => {
  if (window.__truePinLoaded) return;
  window.__truePinLoaded = true;

  const IS_TOP = window.self === window.top;
  const TITLE_PREFIX = "\u{1F512}\u200E ";
  const TAKEOVER_EVENT = "__truepin_takeover__";

  let locked = false;
  let showIcon = true;
  let orphaned = false; // a newer copy of this script took over
  let activationSent = false;
  let titleObserver = null;
  let titleDeferred = false;

  // After an extension update/reload the old copy keeps its DOM listeners but
  // loses its chrome.* context. The fresh copy announces itself; stale copies
  // mute themselves so the tab is not guarded by a ghost.
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

  // --- the guard -----------------------------------------------------------
  if (IS_TOP) {
    window.addEventListener(
      "beforeunload",
      (event) => {
        if (!locked || orphaned) return;
        event.preventDefault();
        // Kept for older Chrome; modern Chrome only needs preventDefault().
        event.returnValue = "";
      },
      true,
    );

    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (orphaned || !request || request.type !== "apply") return;
      applyState(request);
      sendResponse({ ok: true });
    });
  }

  // --- user activation tracking ---------------------------------------------
  const hasBeenActive = () =>
    !!(navigator.userActivation && navigator.userActivation.hasBeenActive);

  function reportActivation() {
    if (activationSent || orphaned) return;
    activationSent = true;
    send({ type: "activated" });
  }
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, reportActivation, { capture: true, passive: true });
  }

  // --- state sync ------------------------------------------------------------
  function hello() {
    if (hasBeenActive()) activationSent = true;
    send({ type: "hello", top: IS_TOP, hasBeenActive: hasBeenActive() }).then(
      (response) => {
        if (response && IS_TOP) applyState(response);
      },
    );
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
  // Restored from the back/forward cache: re-sync, the tab may have been
  // (un)pinned while this document was frozen.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) hello();
  });

  // --- 🔒 title prefix ---------------------------------------------------------
  function updateTitle() {
    if (!IS_TOP) return;
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
