// E2E suite for TruePin v3. Drives a real Chrome (for Testing) with the
// unpacked extension and verifies the one-rule protection model:
//   a protected tab cannot be closed - any close is silently undone;
//   the only sanctioned path is unpin (or unlock) first, then close.
// Plus: mirroring across windows, snapshots, the autosave ring, i18n.
//
// The initial about:blank tab is never closed, so single-tab closes never
// count as "window closing" (which the protection deliberately lets go).
//
// Run: npm test   (HEADFUL=1 npm test to watch)

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const TEST_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- harness
let browser;
let baseUrl;
let currentStep = "";
const results = [];

const step = (label) => {
  currentStep = label;
};

function assert(condition, label) {
  if (!condition) throw new Error(`assert failed: ${label}`);
}

async function test(name, fn) {
  currentStep = "(start)";
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`test timed out at step: ${currentStep}`)),
      TEST_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([fn(), timeout]);
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL  ${name}\n      ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, probe, timeoutMs = 8000, intervalMs = 150) {
  step(`waitFor ${label}`);
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(intervalMs);
  }
}

let cachedWorker = null;
let currentSwTarget = null;

async function findSwTarget(excludeTarget) {
  const target = await browser.waitForTarget(
    (t) =>
      t.type() === "service_worker" &&
      t.url().endsWith("background.js") &&
      (!excludeTarget || t !== excludeTarget),
    { timeout: 20_000 },
  );
  currentSwTarget = target;
  return target;
}

async function getWorker() {
  if (cachedWorker) return cachedWorker;
  const target = await findSwTarget(null);
  cachedWorker = await Promise.race([
    target.worker(),
    sleep(5000).then(() => {
      throw new Error("worker attach timed out");
    }),
  ]);
  return cachedWorker;
}

async function swEval(fn, ...args) {
  for (let attempt = 0; ; attempt++) {
    try {
      const worker = await getWorker();
      return await Promise.race([
        worker.evaluate(fn, ...args),
        sleep(10_000).then(() => {
          throw new Error("swEval timed out");
        }),
      ]);
    } catch (err) {
      cachedWorker = null; // worker may have been suspended; re-attach
      if (attempt >= 1) throw new Error(`swEval failed at "${currentStep}": ${err.message}`);
      await sleep(300);
    }
  }
}

const findTab = (marker) =>
  swEval(async (m) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => ((t.url || t.pendingUrl) || "").includes(m));
    return tab
      ? { id: tab.id, pinned: tab.pinned, title: tab.title || "", windowId: tab.windowId }
      : null;
  }, marker);

const tabState = (tabId) =>
  swEval(async (key) => (await chrome.storage.session.get(key))[key] ?? null, `t${tabId}`);

const setPinned = (tabId, pinned) =>
  swEval((id, p) => chrome.tabs.update(id, { pinned: p }), tabId, pinned);

const removeTab = (tabId) =>
  swEval(
    (id) => new Promise((resolve) => chrome.tabs.remove(id, () => {
      void chrome.runtime.lastError;
      resolve();
    })),
    tabId,
  );

function watchDialogs(page) {
  const seen = [];
  page.on("dialog", async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss().catch(() => {});
  });
  return seen;
}

async function openPage(marker) {
  step(`newPage ${marker}`);
  const page = await browser.newPage();
  const dialogs = watchDialogs(page);
  step(`goto ${marker}`);
  await page.goto(`${baseUrl}${marker}`, { timeout: 15_000 });
  const tab = await waitFor(`tab ${marker}`, () => findTab(marker));
  return { page, dialogs, tab };
}

async function clickPage(page, marker) {
  step(`click ${marker}`);
  await Promise.race([
    page.click("body"),
    sleep(8000).then(() => {
      throw new Error("click timed out");
    }),
  ]);
}

// Close-and-expect-reopen helper: the tab must come back with the same url,
// pinned, under a NEW tab id.
async function closeAndExpectReopen(marker, closeFn) {
  const before = await findTab(marker);
  assert(before, `${marker} present before close`);
  await closeFn(before);
  const after = await waitFor(
    `${marker} reopened`,
    async () => {
      const t = await findTab(marker);
      return t && t.id !== before.id ? t : null;
    },
    10_000,
    200,
  );
  return { before, after };
}

// ----------------------------------------------------------------- server
function startServer() {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/\W/g, "") || "index";
    // A /pip… page opens a Document Picture-in-Picture window when clicked -
    // the shape Google Meet uses for its in-call mini window. Only these pages
    // carry the handler: other tests click the body just for a user gesture.
    const pipScript = name.startsWith("pip")
      ? `<script>document.body.addEventListener("click", async () => {
           try {
             const w = await documentPictureInPicture.requestWindow({ width: 320, height: 240 });
             w.document.body.textContent = "pip";
             window.__pipOpen = true;
           } catch (e) { window.__pipError = String(e); }
         });</script>`
      : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>page-${name}</title></head>` +
        `<body style="height:100vh;margin:0">page ${name}${pipScript}</body></html>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ------------------------------------------------------------------ tests
async function main() {
  const server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  // Collect service worker errors for the whole run (regression guard for
  // "Unchecked runtime.lastError" on calls that race a closing tab).
  const swErrors = [];
  async function attachSwErrorCollector(targetOverride) {
    const swTarget = targetOverride || (await findSwTarget(null));
    const session = await swTarget.createCDPSession();
    await session.send("Runtime.enable");
    await session.send("Log.enable");
    session.on("Log.entryAdded", (event) => {
      const text = event.entry?.text || "";
      if (/Unchecked runtime\.lastError|Uncaught \(in promise\)/.test(text)) {
        swErrors.push(text);
      }
    });
    session.on("Runtime.exceptionThrown", (event) => {
      const text =
        event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "";
      swErrors.push(`exception: ${text.split("\n")[0]}`);
    });
  }
  await attachSwErrorCollector();

  await test("extension boots: service worker up, defaults in effect", async () => {
    step("read settings");
    const settings = await swEval(async () => {
      const { settings } = await chrome.storage.sync.get("settings");
      return settings ?? "defaults";
    });
    assert(settings === "defaults" || settings.autoLockPinned, "autoLockPinned on");
  });

  await test("protection: force-closed pinned tab comes right back", async () => {
    const { dialogs, tab } = await openPage("/one");
    step("pin");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);

    step("close via tabs.remove");
    const { after } = await closeAndExpectReopen("/one", (t) => removeTab(t.id));
    assert(after.pinned === true, "reopened pinned");
    assert(dialogs.length === 0, "no dialog anywhere");
    await waitFor(
      "reopened tab re-protected",
      async () => (await tabState(after.id))?.protected === true,
    );
    await waitFor("laconic notification shown", async () => {
      const notes = await swEval(() => new Promise((r) => chrome.notifications.getAll(r)));
      return notes && notes["truepin-reopen"];
    });
  });

  await test("protection: user-style close (runBeforeUnload) - no dialog, still comes back", async () => {
    const existing = await findTab("/one");
    assert(existing, "/one still around from the previous test");
    step("activate the page");
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes("/one"));
    assert(page, "page handle");
    const dialogs = watchDialogs(page);
    await clickPage(page, "/one");
    step("close with runBeforeUnload");
    const { after } = await closeAndExpectReopen("/one", async () => {
      await Promise.race([page.close({ runBeforeUnload: true }).catch(() => {}), sleep(3000)]);
    });
    assert(dialogs.length === 0, "no beforeunload dialog even on an activated tab");
    assert(after.pinned === true, "reopened pinned");
  });

  await test("protection: closing the reopened tab again just brings it back again", async () => {
    const tab = await findTab("/one");
    step("close again immediately");
    const { after } = await closeAndExpectReopen("/one", (t) => removeTab(t.id));
    assert(after.pinned === true, "still immortal - no cooldown escape");
    void tab;
  });

  await test("protection: reload and navigation are free, no dialogs", async () => {
    const tab = await findTab("/one");
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes("/one"));
    assert(page, "page handle for the reopened /one");
    const dialogs = watchDialogs(page);
    step("activate");
    await clickPage(page, "/one");
    step("scripted reload");
    await Promise.race([page.evaluate(() => location.reload()).catch(() => {}), sleep(1500)]);
    await waitFor(
      "reloaded and still protected",
      async () => (await tabState(tab.id))?.protected === true,
    );
    step("navigate to another page");
    await swEval((id, url) => chrome.tabs.update(id, { url }), tab.id, `${baseUrl}/one-nav`);
    await waitFor("navigated", async () => !!(await findTab("/one-nav")));
    assert(dialogs.length === 0, "no dialogs for reload or navigation");
    step("cleanup: unpin and close");
    await setPinned(tab.id, false);
    await sleep(900);
    await removeTab(tab.id);
    await sleep(500);
    assert(!(await findTab("/one-nav")), "cleanup close respected after unpin");
  });

  await test("sanctioned path: unpin, then close - tab stays closed", async () => {
    const { tab } = await openPage("/two");
    step("pin");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    step("unpin");
    await setPinned(tab.id, false);
    await waitFor("unprotected", async () => (await tabState(tab.id))?.protected === false);
    await sleep(900); // unpin grace + unpin-confirm must both pass
    step("close");
    await removeTab(tab.id);
    await sleep(1500);
    assert(!(await findTab("/two")), "closed for good after unpin");
  });

  await test("manual lock: locked tab is immortal until unlocked", async () => {
    const { tab } = await openPage("/three");
    step("lock via toggle");
    await swEval((id) => globalThis.truePinToggle(id), tab.id);
    await waitFor("manually protected", async () => {
      const s = await tabState(tab.id);
      return s?.protected === true && s.manual === true;
    });
    step("close: must come back");
    const { after } = await closeAndExpectReopen("/three", (t) => removeTab(t.id));
    assert(after.pinned === false, "reopened as a regular (unpinned) tab");
    await waitFor("manual lock carried over", async () => {
      const s = await tabState(after.id);
      return s?.protected === true && s.manual === true;
    });
    step("unlock, then close: stays closed");
    await swEval((id) => globalThis.truePinToggle(id), after.id);
    await waitFor("unlocked", async () => (await tabState(after.id))?.protected === false);
    await removeTab(after.id);
    await sleep(1200);
    assert(!(await findTab("/three")), "closed for good after unlock");
  });

  await test("plain unpinned tab: untouched by the extension", async () => {
    const { page, dialogs, tab } = await openPage("/four");
    await clickPage(page, "/four");
    step("close");
    await Promise.race([page.close({ runBeforeUnload: true }).catch(() => {}), sleep(3000)]);
    await sleep(1200);
    assert(dialogs.length === 0, "no dialog");
    assert(!(await findTab("/four")), "closed for good");
    void tab;
  });

  await test("autoLockPinned=false: pinned tabs close freely; re-enable recomputes", async () => {
    const write = (auto) =>
      swEval(
        (a) =>
          chrome.storage.sync.set({
            settings: {
              autoLockPinned: a,
              showIcon: true,
              mirrorPinned: true,
              autoSnapshot: true,
              language: "auto",
            },
          }),
        auto,
      );
    try {
      step("disable autoLockPinned");
      await write(false);
      await sleep(500);
      const { tab } = await openPage("/five");
      step("pin");
      await setPinned(tab.id, true);
      await sleep(1000);
      assert((await tabState(tab.id))?.protected !== true, "not protected while disabled");
      step("close: no resurrection");
      await removeTab(tab.id);
      await sleep(1500);
      assert(!(await findTab("/five")), "closed while protection is off");
    } finally {
      step("re-enable");
      await write(true); // never leak disabled protection into later tests
    }
    const { tab: tab2 } = await openPage("/six");
    await setPinned(tab2.id, true);
    await waitFor(
      "protected after re-enable",
      async () => (await tabState(tab2.id))?.protected === true,
    );
  });

  // ---- snapshots + autosave ring + mirroring + i18n -----------------------
  const uiCall = (request) => swEval((r) => globalThis.__tpUiCall(r), request);
  const pinnedOf = (windowId) =>
    swEval(
      async (wid) =>
        (await chrome.tabs.query({ windowId: wid, pinned: true })).map((t) => ({
          id: t.id,
          url: t.url || t.pendingUrl || "",
          pinned: t.pinned,
        })),
      windowId,
    );
  const autoRing = () =>
    swEval(async () => (await chrome.storage.local.get("autoSnaps")).autoSnaps || []);

  await test("protection: a closed middle pin reopens in its slot, not at the strip end", async () => {
    // Three pins in order; closing the middle one must bring it back where it
    // sat. A protected close is a resurrection, not a reorder - the pinned
    // strip's order has to survive the round-trip.
    //
    // The reopen tries chrome.sessions.restore first (which, in this test
    // browser, happens to keep the index) and falls back to a plain re-create
    // when no session entry matches - the path real users hit when the closed
    // tab has drifted out of the recently-closed list. That fallback is where
    // <=3.15.2 dropped the pin at the END of the strip. Stub the session
    // lookup empty so the test exercises the fallback deterministically: red on
    // 3.15.2, green here.
    await swEval(() => {
      globalThis.__origGetRecentlyClosed = chrome.sessions.getRecentlyClosed;
      chrome.sessions.getRecentlyClosed = () => Promise.resolve([]);
    });
    try {
      for (const marker of ["/ord1", "/ord2", "/ord3"]) {
        const { tab } = await openPage(marker);
        await setPinned(tab.id, true);
        await waitFor(
          `${marker} protected`,
          async () => (await tabState(tab.id))?.protected === true,
        );
      }
      const windowId = (await findTab("/ord2")).windowId;
      // Just our three pins, in strip order (ignores anything else pinned).
      const ordOrder = async () =>
        (await pinnedOf(windowId))
          .map((p) => (p.url.match(/\/(ord\d)/) || [])[1])
          .filter(Boolean)
          .join(",");
      await waitFor("three ord pins in order", async () => (await ordOrder()) === "ord1,ord2,ord3");

      step("close the middle pin");
      const before = await findTab("/ord2");
      await removeTab(before.id);
      await waitFor(
        "ord2 reopened under a new id",
        async () => {
          const t = await findTab("/ord2");
          return t && t.id !== before.id ? t : null;
        },
        10_000,
        200,
      );
      // Give any stray reorder a chance to land before asserting the order held.
      await sleep(600);
      const after = await ordOrder();
      assert(after === "ord1,ord2,ord3", `pinned order preserved after reopen (got ${after})`);
    } finally {
      await swEval(() => {
        if (globalThis.__origGetRecentlyClosed) {
          chrome.sessions.getRecentlyClosed = globalThis.__origGetRecentlyClosed;
          delete globalThis.__origGetRecentlyClosed;
        }
      });
      step("cleanup: unpin and close the three ord pins");
      for (const marker of ["/ord1", "/ord2", "/ord3"]) {
        const t = await findTab(marker);
        if (!t) continue;
        await setPinned(t.id, false);
        await sleep(900);
        const live = await findTab(marker);
        if (live) await removeTab(live.id);
        await sleep(300);
      }
    }
  });

  await test("protection: a session-restored middle pin keeps its slot natively, and does not churn", async () => {
    // The reopen leans on chrome.sessions.restore, which returns the tab to the
    // index it was closed from on its own - so no reposition move is needed (and
    // the move that v3.15.3 added onto the last slot unpinned the pin and
    // resurrected it in a loop). Close a MIDDLE pin so "native kept the slot"
    // is distinguishable from "it was appended", then confirm the reopened pin
    // is not churning a second later.
    for (const marker of ["/ses1", "/ses2", "/ses3"]) {
      const { tab } = await openPage(marker);
      await setPinned(tab.id, true);
      await waitFor(`${marker} protected`, async () => (await tabState(tab.id))?.protected === true);
    }
    const windowId = (await findTab("/ses2")).windowId;
    const sesOrder = async () =>
      (await pinnedOf(windowId))
        .map((p) => (p.url.match(/\/(ses\d)/) || [])[1])
        .filter(Boolean)
        .join(",");
    await waitFor("three ses pins in order", async () => (await sesOrder()) === "ses1,ses2,ses3");

    step("close the middle pin (real close -> recently-closed -> native restore)");
    const before = await findTab("/ses2");
    await removeTab(before.id);
    await waitFor(
      "ses2 reopened under a new id",
      async () => {
        const t = await findTab("/ses2");
        return t && t.id !== before.id ? t : null;
      },
      10_000,
      200,
    );
    await sleep(700);
    assert((await sesOrder()) === "ses1,ses2,ses3", `native restore kept the slot (got ${await sesOrder()})`);

    step("no reopen storm: the restored pin's id is stable a second later");
    const settledId = (await findTab("/ses2")).id;
    await sleep(1200);
    const laterId = (await findTab("/ses2"))?.id;
    assert(laterId === settledId, `ses2 not churning (was ${settledId}, now ${laterId})`);

    step("cleanup");
    for (const marker of ["/ses1", "/ses2", "/ses3"]) {
      const t = await findTab(marker);
      if (!t) continue;
      await setPinned(t.id, false);
      await sleep(900);
      const live = await findTab(marker);
      if (live) await removeTab(live.id);
      await sleep(300);
    }
  });

  await test("protection: a dragged pin, once closed, returns to its dragged slot (canon follows the strip)", async () => {
    // Michael's report: a pin dragged out of its original spot came back at the
    // stale canon slot (the strip end) instead of where it now sits. Dragging
    // must move the canon order too. Force the re-create fallback (empty session
    // list) so placement comes purely from the canon slot the drag updated -
    // red before the onMoved resync, green after.
    await swEval(() => {
      globalThis.__origGetRecentlyClosed = chrome.sessions.getRecentlyClosed;
      chrome.sessions.getRecentlyClosed = () => Promise.resolve([]);
    });
    try {
      for (const marker of ["/drg1", "/drg2", "/drg3"]) {
        const { tab } = await openPage(marker);
        await setPinned(tab.id, true);
        await waitFor(
          `${marker} protected`,
          async () => (await tabState(tab.id))?.protected === true,
        );
      }
      const windowId = (await findTab("/drg3")).windowId;
      const drgOrder = async () =>
        (await pinnedOf(windowId))
          .map((p) => (p.url.match(/\/(drg\d)/) || [])[1])
          .filter(Boolean)
          .join(",");
      await waitFor("three drg pins in order", async () => (await drgOrder()) === "drg1,drg2,drg3");

      step("drag the last pin to the front of the strip");
      const drg3 = await findTab("/drg3");
      await swEval((id) => chrome.tabs.move(id, { index: 0 }), drg3.id);
      await waitFor(
        "strip reordered to drg3,drg1,drg2",
        async () => (await drgOrder()) === "drg3,drg1,drg2",
      );
      await sleep(600); // let the debounced canon resync land

      step("close the dragged pin; it must come back at the front, where it now sits");
      const before = await findTab("/drg3");
      await removeTab(before.id);
      await waitFor(
        "drg3 reopened under a new id",
        async () => {
          const t = await findTab("/drg3");
          return t && t.id !== before.id ? t : null;
        },
        10_000,
        200,
      );
      await sleep(600);
      const after = await drgOrder();
      assert(after === "drg3,drg1,drg2", `dragged pin returns to its dragged slot (got ${after})`);
    } finally {
      await swEval(() => {
        if (globalThis.__origGetRecentlyClosed) {
          chrome.sessions.getRecentlyClosed = globalThis.__origGetRecentlyClosed;
          delete globalThis.__origGetRecentlyClosed;
        }
      });
      step("cleanup: unpin and close the three drg pins");
      for (const marker of ["/drg1", "/drg2", "/drg3"]) {
        const t = await findTab(marker);
        if (!t) continue;
        await setPinned(t.id, false);
        await sleep(900);
        const live = await findTab(marker);
        if (live) await removeTab(live.id);
        await sleep(300);
      }
    }
  });

  await test("locked shelf: manual-locked non-pinned tabs surface in getState and clear to null", async () => {
    step("open a regular tab and manually lock it");
    const a = await openPage("/lock-a");
    const winId = await swEval(async (id) => (await chrome.tabs.get(id)).windowId, a.tab.id);
    await swEval((id) => globalThis.truePinToggle(id), a.tab.id);
    await waitFor("A protected via manual lock", async () => (await tabState(a.tab.id))?.protected === true);

    step("getState lists it under `locked`, not `pinned`");
    let s = await uiCall({ type: "ui:getState", windowId: winId, tabId: a.tab.id });
    const rowA = (s.locked || []).find((t) => (t.url || "").includes("/lock-a"));
    assert(rowA && rowA.windowId === winId, `locked row present (${JSON.stringify(s.locked)})`);
    assert(!(s.pinned || []).some((t) => (t.url || "").includes("/lock-a")), "not in the pinned list");

    step("ui:clearLock releases it and leaves manual === null (NOT false)");
    await uiCall({ type: "ui:clearLock", tabId: a.tab.id });
    await waitFor("A unprotected", async () => (await tabState(a.tab.id))?.protected === false);
    const st = await tabState(a.tab.id);
    assert(st.manual === null, `manual cleared to null, got ${JSON.stringify(st.manual)}`);
    s = await uiCall({ type: "ui:getState", windowId: winId, tabId: a.tab.id });
    assert(!(s.locked || []).some((t) => (t.url || "").includes("/lock-a")), "gone from the locked shelf");

    step("regression: after clearLock, pinning auto-protects (manual=false would have blocked it)");
    await setPinned(a.tab.id, true);
    await waitFor("A auto-protected once pinned", async () => (await tabState(a.tab.id))?.protected === true);

    step("cleanup: unpin and close");
    await setPinned(a.tab.id, false);
    await sleep(900);
    const live = await findTab("/lock-a");
    if (live) await removeTab(live.id);
  });

  await test("popup lock is state-driven: ui:getState reports real protected per pin, not the 🔒 title", async () => {
    // Regression: the popup used to infer each row's lock from the content
    // script's 🔒 title prefix. A protected pin that was never scripted (a
    // discarded pin after a browser restart, a restricted page) carries no
    // prefix, so its lock went missing though protection was fully in force.
    // getState now returns the real protected flag the popup renders from.
    step("fresh settings: autoLockPinned on");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          showIcon: true,
          mirrorPinned: true,
          autoSnapshot: true,
          language: "auto",
        },
      }),
    );
    await sleep(500);

    const a = await openPage("/plock-a");
    const b = await openPage("/plock-b");
    step("pin both (auto-protected)");
    await setPinned(a.tab.id, true);
    await setPinned(b.tab.id, true);
    await waitFor(
      "both protected",
      async () =>
        (await tabState(a.tab.id))?.protected === true &&
        (await tabState(b.tab.id))?.protected === true,
    );
    const winId = await swEval(async (id) => (await chrome.tabs.get(id)).windowId, a.tab.id);

    step("manually unlock B");
    await swEval((id) => globalThis.truePinToggle(id), b.tab.id);
    await waitFor("B unprotected", async () => (await tabState(b.tab.id))?.protected === false);

    const s = await uiCall({ type: "ui:getState", windowId: winId, tabId: a.tab.id });
    const rowA = (s.pinned || []).find((t) => (t.url || "").includes("/plock-a"));
    const rowB = (s.pinned || []).find((t) => (t.url || "").includes("/plock-b"));
    assert(rowA && rowA.protected === true, `A shows lock (${JSON.stringify(rowA)})`);
    assert(rowB && rowB.protected === false, `B shows no lock (${JSON.stringify(rowB)})`);

    step("cleanup: unpin both, close");
    for (const marker of ["/plock-a", "/plock-b"]) {
      const live = await findTab(marker);
      if (live) await setPinned(live.id, false);
    }
    await sleep(900); // unpin grace + confirm must both pass
    for (const marker of ["/plock-a", "/plock-b"]) {
      const live = await findTab(marker);
      if (live) await removeTab(live.id);
    }
    await sleep(500);
  });

  let snapWindowId = null;
  let s1TabId = null;

  await test("snapshot: save, mutate, diff-restore (reuse + create + close extra)", async () => {
    // Fresh slate: earlier tests (and their failures) must not leak pins
    // or settings in.
    step("fresh slate: default settings, unpin and close all pinned tabs");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          showIcon: true,
          mirrorPinned: true,
          autoSnapshot: true,
          language: "auto",
        },
      }),
    );
    await sleep(600);
    const leftovers = await swEval(async () =>
      (await chrome.tabs.query({ pinned: true })).map((t) => t.id),
    );
    for (const id of leftovers) await setPinned(id, false);
    await sleep(900); // unpin grace + unpin-confirm must both pass
    for (const id of leftovers) await removeTab(id);
    await sleep(500);

    const a = await openPage("/s1");
    const b = await openPage("/s2");
    step("pin s1, s2");
    await setPinned(a.tab.id, true);
    await setPinned(b.tab.id, true);
    await waitFor(
      "both protected",
      async () =>
        (await tabState(a.tab.id))?.protected === true &&
        (await tabState(b.tab.id))?.protected === true,
    );
    s1TabId = a.tab.id;
    snapWindowId = await swEval(async (id) => (await chrome.tabs.get(id)).windowId, a.tab.id);

    await waitFor(
      "autosave ring picked up the set",
      async () => {
        const ring = await autoRing();
        const top = ring[0];
        return (
          top &&
          top.urls.some((u) => u.includes("/s1")) &&
          top.urls.some((u) => u.includes("/s2"))
        );
      },
      6000,
      300,
    );

    step("save snapshot 'work'");
    const saved = await uiCall({ type: "ui:saveSnapshot", windowId: snapWindowId, name: "work" });
    assert(saved.ok, "saved");
    const snapRaw = await swEval(
      async () => (await chrome.storage.sync.get("snap:work"))["snap:work"],
    );
    assert(Array.isArray(snapRaw.splits), "snapshot stores split-view pairs (forward-compat)");

    step("mutate: drop s2, add s3");
    await setPinned(b.tab.id, false);
    await waitFor("s2 unprotected", async () => (await tabState(b.tab.id))?.protected === false);
    await sleep(900); // unpin grace + unpin-confirm must both pass
    await removeTab(b.tab.id);
    await sleep(400);
    assert(!(await findTab("/s2")), "s2 closed");
    const c = await openPage("/s3");
    await setPinned(c.tab.id, true);
    await waitFor("s3 protected", async () => (await tabState(c.tab.id))?.protected === true);

    step("restore snapshot 'work'");
    const result = await uiCall({
      type: "ui:restoreSnapshot",
      windowId: snapWindowId,
      name: "work",
    });
    assert(result.ok, "restore ok");
    assert(
      result.reused === 1 && result.created === 1 && result.closed === 1,
      `diff counts (${JSON.stringify(result)}; saved=${JSON.stringify(snapRaw.urls)})`,
    );

    step("verify restored set");
    await waitFor("pinned set matches snapshot", async () => {
      const pins = await pinnedOf(snapWindowId);
      return (
        pins.length === 2 &&
        pins[0].url.includes("/s1") &&
        pins[1].url.includes("/s2") &&
        pins[0].id === s1TabId
      );
    });
    await sleep(1500); // the closed extra was protected - it must NOT resurrect
    assert(!(await findTab("/s3")), "extra tab stays closed (self-close guard)");
    const ring = await autoRing();
    assert(
      ring.some((snap) => (snap.urls || []).some((u) => u.includes("/s3"))),
      "replaced set kept in the autosave ring (undo)",
    );
  });

  await test("saved sets: slim sync payload + oversized sets fall back to local", async () => {
    step("save 'slim' and inspect the synced payload");
    const slim = await uiCall({ type: "ui:saveSnapshot", windowId: snapWindowId, name: "slim" });
    assert(slim.ok && slim.synced !== false, "slim saved to sync");
    const slimRaw = await swEval(
      async () => (await chrome.storage.sync.get("snap:slim"))["snap:slim"],
    );
    assert(Array.isArray(slimRaw.urls) && slimRaw.urls.length > 0, "sync set keeps urls");
    assert(
      slimRaw.titles === undefined && slimRaw.keys === undefined,
      "sync set drops titles/keys to fit the 8KB item budget",
    );

    step("force a sync-quota rejection and save 'huge'");
    await swEval(() => {
      globalThis.__origSyncSet = chrome.storage.sync.set.bind(chrome.storage.sync);
      chrome.storage.sync.set = () =>
        Promise.reject(new Error("QUOTA_BYTES_PER_ITEM quota exceeded"));
    });
    const huge = await uiCall({ type: "ui:saveSnapshot", windowId: snapWindowId, name: "huge" });
    assert(huge.ok && huge.synced === false, "oversized save reported as local-only");
    const placement = await swEval(async () => ({
      sync: (await chrome.storage.sync.get("snap:huge"))["snap:huge"] || null,
      local: (await chrome.storage.local.get("snap:huge"))["snap:huge"] || null,
    }));
    assert(
      !placement.sync && placement.local && placement.local.urls.length > 0,
      "oversized set lives in local, not sync",
    );

    step("list flags synced vs local; restore reads the local fallback");
    const listed = await uiCall({ type: "ui:getState", windowId: snapWindowId });
    const hugeRow = listed.snapshots.find((s) => s.name === "huge");
    const slimRow = listed.snapshots.find((s) => s.name === "slim");
    assert(hugeRow && hugeRow.synced === false, "huge listed as not synced");
    assert(slimRow && slimRow.synced === true, "slim listed as synced");
    const restored = await uiCall({
      type: "ui:restoreSnapshot",
      windowId: snapWindowId,
      name: "huge",
    });
    assert(restored.ok, "restore reads the local fallback");

    step("cleanup: unpatch sync.set and drop the test sets from both stores");
    await swEval(() => {
      chrome.storage.sync.set = globalThis.__origSyncSet;
    });
    await uiCall({ type: "ui:deleteSnapshot", name: "huge" });
    await uiCall({ type: "ui:deleteSnapshot", name: "slim" });
  });

  await test("autosave ring: query-string change ignored, page change recorded", async () => {
    step("make the snapshot window the focused home");
    await swEval(async (wid) => {
      await chrome.windows.update(wid, { focused: true }).catch(() => {});
      await chrome.storage.session.set({ focusStack: [wid] });
    }, snapWindowId);
    await sleep(1800); // let any pending debounced autosave settle
    const lengthBefore = (await autoRing()).length;

    step("navigate s1 to the same page with a query string");
    await swEval(
      (id, url) => chrome.tabs.update(id, { url }),
      s1TabId,
      `${baseUrl}/s1?x=1&y=2`,
    );
    await sleep(2500);
    const afterQuery = await autoRing();
    assert(
      afterQuery.length === lengthBefore,
      `query-only change did not autosave (${lengthBefore} -> ${afterQuery.length})`,
    );

    step("navigate s1 to a different page");
    await swEval((id, url) => chrome.tabs.update(id, { url }), s1TabId, `${baseUrl}/s1b`);
    await waitFor(
      "new autosave entry for the page change",
      async () => {
        const ring = await autoRing();
        return ring.length > lengthBefore && ring[0].urls.some((u) => u.includes("/s1b"));
      },
      6000,
      300,
    );
    const ring = await autoRing();
    assert(ring.length <= 10, "ring capped at 10");
  });

  await test("popup backend: pinned-tab toggle drives global auto-protection", async () => {
    step("turn auto-protection off via ui:setAutoLock");
    const off = await uiCall({ type: "ui:setAutoLock", on: false });
    assert(off.ok, "off ok");
    await waitFor("setting off", async () => {
      const s = await swEval(async () => (await chrome.storage.sync.get("settings")).settings);
      return s && s.autoLockPinned === false;
    });
    step("turn it back on");
    await uiCall({ type: "ui:setAutoLock", on: true });
    await waitFor("pins protected again", async () => {
      const pins = await pinnedOf(snapWindowId);
      return pins.length > 0 && (await tabState(pins[0].id))?.protected === true;
    });
  });

  await test("popup: renders pinned set, snapshots and autosaves; saves via UI", async () => {
    step("open popup page");
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
    );
    const extensionId = new URL(swTarget.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: 15_000 });
    step("wait for popup render");
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#pinnedList li").length >= 2 &&
        document.querySelectorAll("#snapList .snap").length >= 1 &&
        document.querySelectorAll("#autoList .snap").length >= 1,
      { timeout: 8000 },
    );
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("#snapList .snap .info")].map((el) => el.textContent),
    );
    assert(names.some((n) => n.includes("work")), "'work' listed");
    step("save 'second' via UI");
    await page.type("#snapName", "second");
    await page.click("#saveBtn");
    await waitFor("snap:second in sync storage", async () => {
      const snap = await swEval(
        async () => (await chrome.storage.sync.get("snap:second"))["snap:second"],
      );
      return snap && snap.urls.length === 2;
    });
    step("long set name never hides the meta info");
    await uiCall({
      type: "ui:saveSnapshot",
      windowId: snapWindowId,
      name: "a-very-long-snapshot-name-that-keeps-going-forever",
    });
    await page.reload({ timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("#snapList .snap").length >= 2,
      { timeout: 8000 },
    );
    const metaOk = await page.evaluate(() =>
      [...document.querySelectorAll("#snapList .snap")].every((row) => {
        const meta = row.querySelector(".meta");
        const rowBox = row.getBoundingClientRect();
        const metaBox = meta.getBoundingClientRect();
        return meta.offsetWidth > 0 && metaBox.right <= rowBox.right + 1;
      }),
    );
    assert(metaOk, "meta visible and inside the row for every set");

    step("a set carrying split-view pairs shows the split mark");
    await swEval(async (base) => {
      await chrome.storage.sync.set({
        "snap:with-split": {
          urls: [`${base}/s1b`, `${base}/s2`],
          titles: ["a", "b"],
          keys: [`${base}/s1b`, `${base}/s2`],
          splits: [[0, 1]],
          savedAt: Date.now(),
        },
      });
    }, baseUrl);
    await page.reload({ timeout: 10_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#snapList .snap .meta")].some((m) =>
          m.textContent.includes("⧉"),
        ),
      { timeout: 8000 },
    );
    await uiCall({ type: "ui:deleteSnapshot", name: "with-split" });

    await uiCall({ type: "ui:deleteSnapshot", name: "a-very-long-snapshot-name-that-keeps-go" });
    await uiCall({ type: "ui:deleteSnapshot", name: "second" });

    step("pin / lock switches render for the active (unpinned popup) tab");
    const switches = await page.evaluate(() => ({
      hasPin: !!document.getElementById("pinToggle"),
      pinDisabled: document.getElementById("pinToggle").disabled,
      pinChecked: document.getElementById("pinToggle").checked,
      lockDisabled: document.getElementById("lockToggle").disabled,
    }));
    assert(switches.hasPin && !switches.pinDisabled, "'Pin this tab' shown and enabled on a normal tab");
    assert(!switches.pinChecked, "'Pin this tab' unchecked for an unpinned tab");
    assert(!switches.lockDisabled, "'Lock this tab' enabled while the tab is unpinned");

    step("close popup page");
    await page.close().catch(() => {});
  });

  let mirrorWinId = null;
  let urlWinId = null;

  await test("mirror: new window gets copies, original window keeps its pins", async () => {
    const before = await pinnedOf(snapWindowId);
    assert(before.length === 2, "two pinned before");
    step("create empty window");
    mirrorWinId = await swEval(async () => (await chrome.windows.create({})).id);
    await waitFor(
      "copies appear in the new window",
      async () => {
        const pins = await pinnedOf(mirrorWinId);
        return pins.length === 2 && pins[0].url.includes("/s1b") && pins[1].url.includes("/s2");
      },
      10_000,
      250,
    );
    step("verify originals stayed");
    const after = await pinnedOf(snapWindowId);
    assert(after.length === 2, "original window still has its pins");
    assert(
      after[0].id === before[0].id && after[1].id === before[1].id,
      "original tabs untouched",
    );
    const copies = await pinnedOf(mirrorWinId);
    assert(
      copies.every((c) => c.id !== before[0].id && c.id !== before[1].id),
      "copies are new tabs",
    );
    await waitFor(
      "copies are protected",
      async () => (await tabState(copies[0].id))?.protected === true,
    );
  });

  await test("mirror: window opened with a URL also gets the copies", async () => {
    step("create window with url");
    urlWinId = await swEval(
      async (u) => (await chrome.windows.create({ url: u })).id,
      `${baseUrl}/g1`,
    );
    await waitFor(
      "copies + own tab",
      async () => {
        const pins = await pinnedOf(urlWinId);
        const all = await swEval(
          async (wid) => (await chrome.tabs.query({ windowId: wid })).length,
          urlWinId,
        );
        return pins.length === 2 && all === 3;
      },
      10_000,
      250,
    );
    const own = await findTab("/g1");
    assert(own && own.pinned === false, "the window's own tab stays unpinned");
  });

  await test("mirror: pinning a tab creates copies in every window", async () => {
    const m = await openPage("/m1"); // opens in the first window
    step("pin /m1");
    await setPinned(m.tab.id, true);
    await waitFor(
      "copies of /m1 in all three windows",
      async () => {
        const counts = [];
        for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          counts.push(pins.filter((p) => p.url.includes("/m1")).length);
        }
        return counts.every((n) => n === 1);
      },
      10_000,
      250,
    );
  });

  await test("mirror: closing a copy reopens it in place, siblings untouched", async () => {
    const copies = await pinnedOf(mirrorWinId);
    const copy = copies.find((p) => p.url.includes("/m1"));
    assert(copy, "/m1 copy in the mirror window");
    const originalBefore = (await pinnedOf(snapWindowId)).find((p) => p.url.includes("/m1"));
    step("close the copy");
    await removeTab(copy.id);
    await waitFor(
      "copy reopened in the same window",
      async () => {
        const pins = await pinnedOf(mirrorWinId);
        const back = pins.find((p) => p.url.includes("/m1"));
        return back && back.id !== copy.id ? back : null;
      },
      10_000,
      250,
    );
    const originalAfter = (await pinnedOf(snapWindowId)).find((p) => p.url.includes("/m1"));
    assert(
      originalAfter && originalAfter.id === originalBefore.id,
      "original in the first window untouched",
    );
    step("verify each window still has exactly one /m1");
    for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
      const count = (await pinnedOf(wid)).filter((p) => p.url.includes("/m1")).length;
      assert(count === 1, `window ${wid}: one /m1 (got ${count})`);
    }
  });

  await test("mirror: unpin dissolves copies; the unpinned original then closes for good", async () => {
    const original = (await pinnedOf(snapWindowId)).find((p) => p.url.includes("/m1"));
    assert(original, "/m1 original present");
    step("unpin /m1 in the first window");
    await setPinned(original.id, false);
    await waitFor(
      "/m1 copies closed in other windows",
      async () => {
        for (const wid of [mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          if (pins.some((p) => p.url.includes("/m1"))) return false;
        }
        return true;
      },
      10_000,
      250,
    );
    const still = await findTab("/m1");
    assert(still && still.pinned === false, "unpinned original stays open as a regular tab");
    step("close the unpinned original: stays closed");
    await sleep(900);
    await removeTab(still.id);
    await sleep(1500);
    assert(!(await findTab("/m1")), "gone for good everywhere");
  });

  await test("mirror: a window arriving with its own pin is adopted, not duplicated", async () => {
    // Simulates a session-restored window: it shows up already containing a
    // pin of an existing group. The fill must adopt it instead of creating
    // a second copy.
    const groupUrl = (await pinnedOf(snapWindowId))[0].url;
    step("create window preloaded with the group's url and pin it quickly");
    const winC = await swEval(async (u) => {
      const win = await chrome.windows.create({ url: u });
      const [tab] = await chrome.tabs.query({ windowId: win.id });
      if (tab) await chrome.tabs.update(tab.id, { pinned: true });
      return win.id;
    }, groupUrl);
    step("wait for the strip to settle and fill to run");
    await sleep(3500);
    const pins = await pinnedOf(winC);
    const matching = pins.filter((p) => p.url.split("?")[0] === groupUrl.split("?")[0]);
    assert(
      matching.length === 1,
      `exactly one copy of the group in the new window (got ${matching.length})`,
    );
    for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
      const winPins = await pinnedOf(wid);
      const count = winPins.filter((p) => p.url.split("?")[0] === groupUrl.split("?")[0]).length;
      assert(count === 1, `window ${wid} still has exactly one (got ${count})`);
    }
    step("close the extra window (window close is not resisted)");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), winC);
    await sleep(800);
    const counts = [];
    for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
      counts.push((await pinnedOf(wid)).length);
    }
    assert(
      counts.every((n) => n === counts[0]),
      "closing a whole window resurrected nothing",
    );
  });

  await test("empty pinned tab (split-view partner): not mirrored, not protected, becomes real on navigation", async () => {
    const beforeCounts = {};
    for (const wid of [mirrorWinId, urlWinId]) beforeCounts[wid] = (await pinnedOf(wid)).length;

    step("create a pinned empty tab (what Chrome makes as a split partner)");
    const ntp = await swEval(async (wid) => {
      const tab = await chrome.tabs.create({
        windowId: wid,
        url: "chrome://newtab/",
        pinned: true,
        active: false,
      });
      return tab.id;
    }, snapWindowId);
    await sleep(2000);
    step("no copies were mirrored");
    for (const wid of [mirrorWinId, urlWinId]) {
      assert(
        (await pinnedOf(wid)).length === beforeCounts[wid],
        `window ${wid} unchanged by the empty pin`,
      );
    }
    step("closing the empty pin does not resurrect it");
    await removeTab(ntp);
    await sleep(1800);
    const stillThere = await swEval(
      async (wid) =>
        (await chrome.tabs.query({ windowId: wid, pinned: true })).some((t) =>
          /newtab/i.test(t.url || t.pendingUrl || ""),
        ),
      snapWindowId,
    );
    assert(!stillThere, "empty pinned tab stayed closed");

    step("a partner that navigates to a real page becomes a first-class pin");
    const ntp2 = await swEval(async (wid) => {
      const tab = await chrome.tabs.create({
        windowId: wid,
        url: "chrome://newtab/",
        pinned: true,
        active: false,
      });
      return tab.id;
    }, snapWindowId);
    await sleep(800);
    await swEval((id, url) => chrome.tabs.update(id, { url }), ntp2, `${baseUrl}/sp1`);
    await waitFor(
      "copies appear after navigation",
      async () => {
        for (const wid of [mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          if (!pins.some((p) => p.url.includes("/sp1"))) return false;
        }
        return true;
      },
      10_000,
      250,
    );
    await waitFor("now protected", async () => (await tabState(ntp2))?.protected === true);
    step("cleanup: unpin (dissolves copies), then close");
    await setPinned(ntp2, false);
    await sleep(1200);
    await removeTab(ntp2);
    await sleep(600);
    assert(!(await findTab("/sp1")), "cleaned up");
  });

  await test("split-view picker tab (tab-search.top-chrome): never registered, never resurrected", async () => {
    // Chrome opens the "Choose a tab to add to split view" picker as a real
    // pinned tab at kChromeUISplitViewNewTabPageURL and closes it by itself
    // once a tab is picked. It must be invisible to the extension end to end.
    const PICKER = "chrome://tab-search.top-chrome/split_new_tab_page.html";
    const predicate = await swEval(
      (u) => [
        isEphemeralUrl(u),
        isEphemeralUrl("chrome://new-tab-page-third-party/"),
        isEphemeralUrl(""),
        // Other Chromium browsers' new-tab pages.
        isEphemeralUrl("edge://newtab/"),
        isEphemeralUrl("https://ntp.msn.com/edge/ntp?locale=en-US"),
        isEphemeralUrl("opera://startpage/"),
        isEphemeralUrl("vivaldi://newtab"),
        isEphemeralUrl("chrome://vivaldi-webui/startpage?section=Speed-dials"),
        isEphemeralUrl("brave://newtab/"),
        isEphemeralUrl("about:newtab"),
        // Real content must never be ephemeral.
        !isEphemeralUrl("https://example.com/"),
        !isEphemeralUrl("https://ntp.msn.com.evil.example/"),
      ],
      PICKER,
    );
    assert(predicate.every(Boolean), `isEphemeralUrl coverage (${predicate})`);

    const beforeCounts = {};
    for (const wid of [mirrorWinId, urlWinId]) beforeCounts[wid] = (await pinnedOf(wid)).length;
    step("create a pinned picker tab (what the split gesture makes)");
    const picker = await swEval(
      async (wid, url) => {
        const tab = await chrome.tabs.create({ windowId: wid, url, pinned: true, active: false });
        return tab.id;
      },
      snapWindowId,
      PICKER,
    );
    await sleep(2200);

    step("not registered: no mirror copies, no group, not protected");
    for (const wid of [mirrorWinId, urlWinId]) {
      assert(
        (await pinnedOf(wid)).length === beforeCounts[wid],
        `window ${wid} unchanged by the picker tab`,
      );
    }
    const grouped = await swEval(async (id) => {
      const { groups = {} } = await chrome.storage.session.get("groups");
      return Object.values(groups).some((g) => Object.values(g.members).includes(id));
    }, picker);
    assert(!grouped, "picker tab is in no mirror group");
    const st = await tabState(picker);
    assert(!st || st.protected === false, `picker tab unprotected (${JSON.stringify(st)})`);

    step("Chrome closes the picker itself: it must stay closed");
    await removeTab(picker);
    await sleep(1800);
    const resurrected = await swEval(async () =>
      (await chrome.tabs.query({ pinned: true })).some((t) =>
        /tab-search\.top-chrome|newtab|new-tab-page/i.test(t.url || t.pendingUrl || ""),
      ),
    );
    assert(!resurrected, "no pinned picker/newtab anywhere after the close");
    const ring = await autoRing();
    const poisonedRing = ring.some((s) =>
      (s.urls || []).some((u) => /tab-search\.top-chrome|chrome:\/\/newtab/i.test(u)),
    );
    assert(!poisonedRing, "no autosave entry contains the picker url");

    step("a poisoned autosave from an older version restores without the picker");
    await swEval(
      async (real, pickerUrl) => {
        const { autoSnaps = [] } = await chrome.storage.local.get("autoSnaps");
        autoSnaps.unshift({
          urls: [pickerUrl, real],
          titles: ["", "page"],
          keys: [pickerUrl, real],
          splits: [[0, 1]],
          savedAt: Date.now(),
        });
        await chrome.storage.local.set({ autoSnaps });
      },
      `${baseUrl}/pk1`,
      PICKER,
    );
    const res = await uiCall({ type: "ui:restoreSnapshot", windowId: snapWindowId, autoIndex: 0 });
    assert(res && res.ok, `restore ok (${JSON.stringify(res)})`);
    await waitFor(
      "only the real page restored everywhere, picker skipped",
      async () => {
        for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          const ok =
            pins.length === 1 &&
            pins[0].url.includes("/pk1") &&
            !pins.some((p) => /tab-search\.top-chrome/i.test(p.url));
          if (!ok) return false;
        }
        return true;
      },
      10_000,
      250,
    );
    // Settle: the restore closed tabs across three windows; their
    // onUpdated/onRemoved events must be fully processed before the next
    // test wipes storage.session, or the wipe erases the self-closed
    // markers mid-flight and the still-queued events resurrect the tabs
    // (a real extension reload kills the queue along with the worker, so
    // this race exists only in the simulated one).
    await waitFor(
      "event queue drained",
      async () => {
        const d = await swEval(() => ({
          queued: globalThis.__tpDiag.queued,
          finished: globalThis.__tpDiag.finished,
        }));
        return d.queued === d.finished;
      },
      10_000,
      200,
    );
    await sleep(2200);
  });

  await test("extension reload (simulated): bootstrap over wiped state does not duplicate", async () => {
    // A chrome://extensions Reload restarts the SW with storage.session
    // wiped and fires the install bootstrap. runtime.reload() kills a
    // --load-extension extension in this harness entirely, so the state
    // transition is simulated via a test hook - the duplication mechanics
    // (blind copy creation over multiple windows) are identical.
    const winIds = [snapWindowId, mirrorWinId, urlWinId];
    const before = [];
    for (const wid of winIds) before.push((await pinnedOf(wid)).length);
    assert(before.every((n) => n === before[0] && n > 0), `mirrored before (${before})`);
    step("wipe session state and re-run the install bootstrap");
    await swEval(() => globalThis.__tpSimulateReload());
    await sleep(4000); // bootstrap + strip-stability wait
    step("counts unchanged after bootstrap");
    for (let i = 0; i < winIds.length; i++) {
      const pins = await pinnedOf(winIds[i]);
      assert(
        pins.length === before[i],
        `window ${i}: expected ${before[i]}, got ${pins.length} [${pins.map((p) => p.url).join(", ")}]`,
      );
    }
    step("counts stay stable (no delayed creations)");
    await sleep(3000);
    for (let i = 0; i < winIds.length; i++) {
      const pins = await pinnedOf(winIds[i]);
      assert(
        pins.length === before[i],
        `window ${i} stable: expected ${before[i]}, got ${pins.length}`,
      );
    }
  });

  await test("cold-start restore across windows does not duplicate (real browser-restart race)", async () => {
    // The gap the simulated-reload test above cannot reach: on a real restart
    // Chrome wipes storage.session and then RE-CREATES the pinned tabs across
    // every window, firing onCreated with an empty mirror. The engine used to
    // copy each such pin into windows whose own copy had not been restored
    // yet, and the restored originals then spawned fresh groups - an N-window
    // cascade that multiplied the pinned set on every restart. Cold-start
    // events must instead funnel into ONE stabilizing bootstrap that
    // converges the windows to the persisted canon. So: pin normally first
    // (the canon absorbs the page), kill the tabs over a wiped mirror, then
    // trickle them back in as a session restore does.
    const winIds = [snapWindowId, mirrorWinId, urlWinId];
    const url = `${baseUrl}/restart-x`;

    step("pin restart-x normally (a user act); it mirrors everywhere and enters the canon");
    await swEval(
      async (args) => {
        const t = await chrome.tabs.create({ windowId: args.wid, url: args.url, active: false });
        await new Promise((r) => setTimeout(r, 400));
        await chrome.tabs.update(t.id, { pinned: true });
      },
      { wid: winIds[0], url },
    );
    await waitFor(
      "restart-x mirrored to every window",
      async () => {
        for (const wid of winIds) {
          const count = (await pinnedOf(wid)).filter((p) => p.url.includes("restart-x")).length;
          if (count !== 1) return false;
        }
        return true;
      },
      10_000,
      250,
    );

    step("cold start: wipe mirror state, close the dead session's restart-x tabs");
    await swEval(() => globalThis.__tpWipeState());
    await swEval(async (marker) => {
      const tabs = await chrome.tabs.query({ pinned: true });
      await Promise.all(
        tabs
          .filter((t) => ((t.url || t.pendingUrl) || "").includes(marker))
          .map((t) => chrome.tabs.remove(t.id).catch(() => {})),
      );
    }, "restart-x");

    step("session restore trickles the pin back into every window, staggered");
    for (const wid of winIds) {
      await swEval(
        async (args) =>
          chrome.tabs.create({ windowId: args.wid, url: args.url, pinned: true, active: false }),
        { wid, url },
      );
      await sleep(150);
    }

    step("let the single cold-start bootstrap settle");
    await waitFor(
      "event queue drained",
      async () => {
        const d = await swEval(() => ({
          queued: globalThis.__tpDiag.queued,
          finished: globalThis.__tpDiag.finished,
        }));
        return d.queued === d.finished;
      },
      15_000,
      250,
    );
    await sleep(1500);

    step("exactly one copy of the restored pin per window - no cascade");
    for (const wid of winIds) {
      const count = (await pinnedOf(wid)).filter((p) => p.url.includes("restart-x")).length;
      assert(count === 1, `window ${wid}: expected 1 restored pin, got ${count}`);
    }

    step("cleanup: unpin everywhere, then remove every restart-x tab");
    for (const wid of winIds) {
      for (const p of (await pinnedOf(wid)).filter((p) => p.url.includes("restart-x"))) {
        await setPinned(p.id, false);
      }
    }
    await sleep(1600);
    for (let i = 0; i < 12; i++) {
      const t = await findTab("restart-x");
      if (!t) break;
      await removeTab(t.id);
      await sleep(250);
    }
  });

  await test("popup windows are ignored: the pinned set is never dumped into a popup", async () => {
    // OAuth popups, window.open popups, app/PWA windows and DevTools are type
    // "popup"/"app", not "normal". Every fill path uses normalWindows() and
    // windows.onCreated early-returns for non-normal windows, so a popup must
    // never receive mirror copies.
    step("mirror on; a fresh normal window with a pinned tab (a real group)");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          mirrorPinned: true,
          autoSnapshot: false,
          notifyReopen: false,
          lockToFront: "off",
          language: "auto",
        },
      }),
    );
    await sleep(700);
    const normId = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/popup-src" });
      const [t] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.update(t.id, { pinned: true });
      return win.id;
    }, baseUrl);
    await sleep(2500); // let the pin mirror across the normal windows
    step("open a POPUP window with its own page");
    const popupId = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/in-popup", type: "popup" });
      return win.id;
    }, baseUrl);
    await sleep(2500); // give any (wrong) fill every chance to run
    step("the popup holds only its own tab - no pinned copies were injected");
    const pinnedInPopup = await swEval(
      async (id) => (await chrome.tabs.query({ windowId: id, pinned: true })).length,
      popupId,
    );
    assert(pinnedInPopup === 0, `popup got no pinned copies (found ${pinnedInPopup})`);
    const totalInPopup = await swEval(
      async (id) => (await chrome.tabs.query({ windowId: id })).length,
      popupId,
    );
    assert(totalInPopup === 1, `popup keeps only its own tab (found ${totalInPopup})`);
    step("cleanup");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), popupId);
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), normId);
    await sleep(700);
  });

  await test("picture-in-picture window: reports type normal, still gets no copies", async () => {
    // Google Meet opens a Document PiP window when the user leaves the call tab
    // while somebody presents. Chrome reports it as type "normal" - windows.
    // onCreated and windows.getAll alike - but it hosts no tab strip, and a
    // tabs.create aimed at it silently lands the tab in the user's REAL window.
    // Filling it therefore materialized a whole duplicate pinned set there
    // (report 2026-07-23, v3.15.5). alwaysOnTop is what tells the two apart.
    step("mirror on; a normal window with a pinned tab (a real group to copy)");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          mirrorPinned: true,
          autoSnapshot: false,
          notifyReopen: false,
          lockToFront: "off",
          language: "auto",
        },
      }),
    );
    await sleep(700);
    const normId = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/pip-src" });
      const [t] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.update(t.id, { pinned: true });
      return win.id;
    }, baseUrl);
    await sleep(2500); // let the pin mirror across the normal windows

    step("open a Document PiP window from a page (user gesture)");
    const pinnedBefore = await swEval(async () => (await chrome.tabs.query({ pinned: true })).length);
    const { page } = await openPage("/pip-host");
    await page.bringToFront();
    await clickPage(page, "/pip-host");
    const pip = await waitFor(
      "pip window",
      () =>
        swEval(async () => {
          const all = await chrome.windows.getAll({ populate: true });
          const w = all.find((x) => x.alwaysOnTop);
          return w ? { id: w.id, type: w.type, tabs: (w.tabs || []).length } : null;
        }),
      10_000,
    );
    assert(
      await page.evaluate(() => !!window.__pipOpen),
      `document PiP opened (${await page.evaluate(() => window.__pipError || "no error")})`,
    );
    // The platform fact this whole guard rests on, asserted rather than
    // remembered: if a future Chrome starts calling it "popup", we find out here.
    assert(pip.type === "normal", `PiP window still reports type normal (got ${pip.type})`);

    step("no copies injected, and none leaked into the real window");
    await sleep(5000); // stable-strip wait + any (wrong) fill would be done by now
    const pipTabs = await swEval(
      async (id) => (await chrome.tabs.query({ windowId: id })).length,
      pip.id,
    );
    assert(pipTabs === 1, `PiP window keeps only its own tab (found ${pipTabs})`);
    const pinnedAfter = await swEval(async () => (await chrome.tabs.query({ pinned: true })).length);
    assert(
      pinnedAfter === pinnedBefore,
      `pinned set unchanged by the PiP window (${pinnedBefore} -> ${pinnedAfter})`,
    );

    step("cleanup");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), pip.id);
    await page.close().catch(() => {});
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), normId);
    await sleep(700);
  });

  await test("mirrorPinned=false: new window stays empty, groups cleared", async () => {
    step("disable mirrorPinned");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          showIcon: true,
          mirrorPinned: false,
          autoSnapshot: true,
          language: "auto",
        },
      }),
    );
    await sleep(600); // let settings-changed rebuild run
    const plainWinId = await swEval(async () => (await chrome.windows.create({})).id);
    await sleep(1800);
    assert((await pinnedOf(plainWinId)).length === 0, "no copies in the new window");
    const groups = await swEval(
      async () => (await chrome.storage.session.get("groups")).groups || {},
    );
    assert(Object.keys(groups).length === 0, "groups cleared");
  });

  const setLockFront = (mode) =>
    swEval(
      (m) =>
        chrome.storage.sync.set({
          settings: {
            autoLockPinned: true,
            mirrorPinned: false,
            autoSnapshot: false,
            notifyReopen: false,
            lockToFront: m,
            language: "auto",
          },
        }),
      mode,
    );

  await test("lockToFront=onLock: locking a regular tab pulls it to the front", async () => {
    step("settings: lockToFront=onLock, mirror off");
    await setLockFront("onLock");
    await sleep(700);
    step("fresh window: 1 pinned tab + 3 regular tabs");
    const w = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/lf-pin" });
      const [first] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.update(first.id, { pinned: true });
      await chrome.tabs.create({ windowId: win.id, url: base + "/lf-a", active: false });
      await chrome.tabs.create({ windowId: win.id, url: base + "/lf-b", active: false });
      const target = await chrome.tabs.create({ windowId: win.id, url: base + "/lf-target", active: false });
      return { winId: win.id, targetId: target.id };
    }, baseUrl);
    await sleep(900);
    const before = await swEval(async (id) => (await chrome.tabs.get(id)).index, w.targetId);
    assert(before >= 2, `target starts behind the strip (index ${before})`);
    step("lock the target regular tab");
    await swEval((id) => globalThis.truePinToggle(id), w.targetId);
    await waitFor(
      "locked target moved to the front of the regular tabs (index 1)",
      async () => (await swEval(async (id) => (await chrome.tabs.get(id)).index, w.targetId)) === 1,
      5000,
      200,
    );
    step("cleanup window");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w.winId);
    await sleep(500);
  });

  await test("lockToFront=always: a displaced locked tab snaps back to the front", async () => {
    step("settings: lockToFront=always");
    await setLockFront("always");
    await sleep(700);
    step("fresh window: 3 regular tabs, lock the first");
    const w = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/lf2-a" });
      const [locked] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.create({ windowId: win.id, url: base + "/lf2-b", active: false });
      await chrome.tabs.create({ windowId: win.id, url: base + "/lf2-c", active: false });
      return { winId: win.id, lockedId: locked.id };
    }, baseUrl);
    await sleep(800);
    await swEval((id) => globalThis.truePinToggle(id), w.lockedId);
    await sleep(700);
    step("drag it to the back");
    await swEval((id) => chrome.tabs.move(id, { index: 2 }), w.lockedId);
    step("always-mode snaps it back to the front (index 0)");
    await waitFor(
      "locked tab returned to the front",
      async () => (await swEval(async (id) => (await chrome.tabs.get(id)).index, w.lockedId)) === 0,
      5000,
      200,
    );
    step("cleanup window");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w.winId);
    await sleep(500);
  });

  await test("lockToFront=off: locking leaves the tab where it is", async () => {
    step("settings: lockToFront=off");
    await setLockFront("off");
    await sleep(700);
    const w = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/lf3-a" });
      await chrome.tabs.create({ windowId: win.id, url: base + "/lf3-b", active: false });
      const target = await chrome.tabs.create({ windowId: win.id, url: base + "/lf3-target", active: false });
      return { winId: win.id, targetId: target.id };
    }, baseUrl);
    await sleep(900);
    const before = await swEval(async (id) => (await chrome.tabs.get(id)).index, w.targetId);
    step("lock the last tab; it must NOT move");
    await swEval((id) => globalThis.truePinToggle(id), w.targetId);
    await sleep(900);
    const after = await swEval(async (id) => (await chrome.tabs.get(id)).index, w.targetId);
    assert(after === before, `off: index unchanged (was ${before}, now ${after})`);
    step("cleanup window");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w.winId);
    await sleep(500);
  });

  // ---- navigation redirect (v3.9.0) ---------------------------------------

  await test("nav redirect: address-bar nav in a protected tab forks to a new tab", async () => {
    step("pin a page");
    const { tab } = await openPage("/navsrc");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    await sleep(900); // mirror settles
    const before = await swEval(async () => (await chrome.tabs.query({})).length);
    const dest = `${baseUrl}/navdest`;

    step("try a real CDP typed navigation first");
    let drove = "cdp";
    let forked = null;
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes("/navsrc"));
    if (page) {
      try {
        const cdp = await page.createCDPSession();
        await cdp.send("Page.navigate", { url: dest, transitionType: "typed" });
        // The fork is a DIFFERENT tab on the destination: on a slow machine
        // the poll can catch the SOURCE still sitting on /navdest before its
        // goBack lands - matching it would assert the wrong tab (CI, 2-core).
        forked = await waitFor(
          "fork appeared (cdp)",
          async () => {
            const t = await findTab("/navdest");
            return t && t.id !== tab.id ? t : null;
          },
          4000,
          200,
        );
      } catch {
        forked = null;
      }
    }
    if (!forked) {
      step("CDP transition did not map - drive the production hook");
      drove = "hook";
      const kind = await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: dest,
        frameId: 0,
        transitionType: "typed",
        transitionQualifiers: ["from_address_bar"],
        documentLifecycle: "active",
      });
      assert(kind === "address", `hook classified as address (got ${kind})`);
      forked = await waitFor(
        "fork appeared (hook)",
        async () => {
          const t = await findTab("/navdest");
          return t && t.id !== tab.id ? t : null;
        },
        5000,
        200,
      );
    }

    step(`forked via ${drove}: destination in a NEW regular tab, source restored`);
    assert(forked.id !== tab.id, "destination lives in a new tab");
    assert(!forked.pinned, "fork is a regular, unprotected tab");
    const src = await waitFor(
      "source back on its page, same tab id, still pinned",
      async () =>
        swEval(async (id) => {
          const t = await new Promise((resolve) =>
            chrome.tabs.get(id, (x) => {
              void chrome.runtime.lastError;
              resolve(x || null);
            }),
          );
          const url = t && (t.url || t.pendingUrl || "");
          return t && t.pinned && url.includes("/navsrc") ? { id: t.id } : null;
        }, tab.id),
      6000,
      250,
    );
    assert(src.id === tab.id, "source kept its tab id (no reopen)");

    step("no cascade: exactly one tab added");
    await sleep(1500);
    const after = await swEval(async () => (await chrome.tabs.query({})).length);
    assert(after === before + 1, `one tab added (was ${before}, now ${after})`);

    step("cleanup");
    await removeTab(forked.id);
    await setPinned(tab.id, false);
    await sleep(1600);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("nav redirect: manually locked regular tab forks too, lock survives", async () => {
    const { tab } = await openPage("/locknav");
    await swEval((id) => globalThis.truePinToggle(id), tab.id);
    await waitFor("locked", async () => (await tabState(tab.id))?.manual === true);
    const dest = `${baseUrl}/lockdest`;
    const kind = await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
      tabId: tab.id,
      url: dest,
      frameId: 0,
      transitionType: "generated",
      transitionQualifiers: ["from_address_bar"],
      documentLifecycle: "active",
    });
    assert(kind === "address", `omnibox search classified as address (got ${kind})`);
    const forked = await waitFor("fork appeared", async () => findTab("/lockdest"), 5000, 200);
    assert(forked.id !== tab.id, "destination in a new tab");
    const state = await tabState(tab.id);
    assert(state && state.manual === true, "manual lock survives on the same tab id");
    step("cleanup");
    await swEval((r) => globalThis.__tpUiCall(r), { type: "ui:clearLock", tabId: tab.id });
    await sleep(400);
    await removeTab(forked.id);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("nav redirect: classifier ignores reloads, back/forward, prerender, subframes, redirects", async () => {
    const { tab } = await openPage("/navneg");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    await sleep(900);
    const count0 = await swEval(async () => (await chrome.tabs.query({})).length);
    const cases = [
      ["reload from address bar (same-url retype)", { transitionType: "reload", transitionQualifiers: ["from_address_bar"] }],
      ["back/forward re-reporting typed", { transitionType: "typed", transitionQualifiers: ["forward_back"] }],
      ["prerender commit", { transitionType: "typed", transitionQualifiers: ["from_address_bar"], documentLifecycle: "prerender" }],
      ["subframe commit", { transitionType: "typed", transitionQualifiers: ["from_address_bar"], frameId: 7 }],
      ["JS redirect dressed as link", { transitionType: "link", transitionQualifiers: ["client_redirect"] }],
      ["server redirect link", { transitionType: "link", transitionQualifiers: ["server_redirect"] }],
      // A redirect can commit tagged with an address-bar transitionType. Google
      // Meet's in-call reconnects do exactly this - "generated"/"typed" with a
      // client_redirect qualifier - and the pre-fix classifier read them as an
      // omnibox act and forked the live call into duplicate tabs.
      ["client redirect tagged generated (Meet in-call)", { transitionType: "generated", transitionQualifiers: ["client_redirect"] }],
      ["client redirect tagged typed + from_address_bar", { transitionType: "typed", transitionQualifiers: ["client_redirect", "from_address_bar"] }],
      ["server redirect tagged generated", { transitionType: "generated", transitionQualifiers: ["server_redirect"] }],
    ];
    for (const [name, d] of cases) {
      const kind = await swEval((details) => globalThis.__tpSimulateNavCommit(details), {
        tabId: tab.id,
        url: "http://example.com/x",
        frameId: d.frameId ?? 0,
        transitionType: d.transitionType,
        transitionQualifiers: d.transitionQualifiers,
        documentLifecycle: d.documentLifecycle || "active",
      });
      assert(kind === null, `${name}: not intercepted (got ${kind})`);
    }
    await sleep(1000);
    const count1 = await swEval(async () => (await chrome.tabs.query({})).length);
    assert(count1 === count0, "no tabs created by any ignored case");
    step("cleanup");
    await setPinned(tab.id, false);
    await sleep(1600);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("nav redirect: cross-site link forks; same-site link and disabled toggles stay put", async () => {
    const writeSettings = (extra) =>
      swEval(
        (s) => chrome.storage.sync.set({ settings: s }),
        {
          autoLockPinned: true,
          mirrorPinned: true,
          autoSnapshot: true,
          notifyReopen: true,
          navRedirect: true,
          linkRedirect: true,
          language: "auto",
          ...extra,
        },
      );
    const { tab } = await openPage("/linksrc");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    await sleep(900);
    const crossBase = baseUrl.replace("127.0.0.1", "localhost");

    try {
      step("cross-site link (127.0.0.1 -> localhost) forks");
      const kind = await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: `${crossBase}/linkdest`,
        frameId: 0,
        transitionType: "link",
        transitionQualifiers: [],
        documentLifecycle: "active",
      });
      assert(kind === "link", `classified as link (got ${kind})`);
      const forked = await waitFor("cross-site fork appeared", async () => findTab("/linkdest"), 5000, 200);
      assert(forked.id !== tab.id && !forked.pinned, "fork is a new regular tab");
      await removeTab(forked.id);
      await sleep(300);

      step("same-site link stays in place");
      await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: `${baseUrl}/samesite`,
        frameId: 0,
        transitionType: "link",
        transitionQualifiers: [],
        documentLifecycle: "active",
      });
      await sleep(1000);
      assert(!(await findTab("/samesite")), "no fork for a same-site link");

      step("linkRedirect=false: cross-site link stays");
      await writeSettings({ linkRedirect: false });
      await sleep(600);
      await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: `${crossBase}/linkoff`,
        frameId: 0,
        transitionType: "link",
        transitionQualifiers: [],
        documentLifecycle: "active",
      });
      await sleep(1000);
      assert(!(await findTab("/linkoff")), "no fork with the link toggle off");

      step("navRedirect=false: typed nav stays");
      await writeSettings({ navRedirect: false });
      await sleep(600);
      await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: `${crossBase}/typedoff`,
        frameId: 0,
        transitionType: "typed",
        transitionQualifiers: ["from_address_bar"],
        documentLifecycle: "active",
      });
      await sleep(1000);
      assert(!(await findTab("/typedoff")), "no fork with the address toggle off");

      step("unprotected regular tab: typed nav stays");
      await writeSettings({});
      await sleep(600);
      const plain = await openPage("/plainnav");
      await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: plain.tab.id,
        url: `${crossBase}/plaindest`,
        frameId: 0,
        transitionType: "typed",
        transitionQualifiers: ["from_address_bar"],
        documentLifecycle: "active",
      });
      await sleep(1000);
      assert(!(await findTab("/plaindest")), "no fork on an unprotected tab");
      await removeTab(plain.tab.id);
    } finally {
      await writeSettings({});
      await sleep(400);
    }
    step("cleanup");
    await setPinned(tab.id, false);
    await sleep(1600);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("nav redirect: breaker refusal leaves the navigation alone", async () => {
    const { tab } = await openPage("/brknav");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    await sleep(900);
    try {
      step("exhaust the creation ledger");
      await swEval(async () => {
        const now = Date.now();
        await chrome.storage.session.set({ createLedger: Array.from({ length: 25 }, () => now) });
      });
      const kind = await swEval((d) => globalThis.__tpSimulateNavCommit(d), {
        tabId: tab.id,
        url: `${baseUrl.replace("127.0.0.1", "localhost")}/brkdest`,
        frameId: 0,
        transitionType: "typed",
        transitionQualifiers: ["from_address_bar"],
        documentLifecycle: "active",
      });
      assert(kind === "address", "still classified");
      await sleep(1200);
      assert(!(await findTab("/brkdest")), "breaker refused the fork; nothing was created");
    } finally {
      await swEval(() => chrome.storage.session.set({ createLedger: [] }));
    }
    step("cleanup");
    await setPinned(tab.id, false);
    await sleep(1600);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("mass-duplication heal: signature detection and keeper choice (unit)", async () => {
    step("three duplicated origins = disease; saved-set url wins as keeper");
    const diseased = await swEval(
      (args) => {
        const out = healMassDuplication(args.entries, new Set(args.setUrls));
        return out && { keep: out.keep.map((e) => e.url), close: out.close.map((e) => e.url) };
      },
      {
        entries: [
          { url: "https://a.com/1", order: 0 },
          { url: "https://a.com/2", order: 1 },
          { url: "https://b.com/x", order: 2 },
          { url: "https://b.com/y", order: 3 },
          { url: "https://c.com/p", order: 4 },
          { url: "https://c.com/q", order: 5 },
          { url: "https://solo.com/only", order: 6 },
        ],
        setUrls: ["https://b.com/y"],
      },
    );
    assert(diseased, "mass signature detected");
    assert(diseased.keep.length === 4, `one per origin + solo kept (${diseased.keep.join(", ")})`);
    assert(diseased.keep.includes("https://b.com/y"), "saved-set url wins as keeper");
    assert(diseased.keep.includes("https://a.com/1"), "first pin wins without a set match");
    assert(diseased.keep.includes("https://solo.com/only"), "singleton origin untouched");
    assert(diseased.close.length === 3, "the other copies close");

    step("two duplicated origins = plausible user intent, no heal");
    const healthy = await swEval(
      (args) => healMassDuplication(args.entries, new Set()),
      {
        entries: [
          { url: "https://a.com/1", order: 0 },
          { url: "https://a.com/2", order: 1 },
          { url: "https://b.com/x", order: 2 },
          { url: "https://b.com/y", order: 3 },
          { url: "https://solo.com/only", order: 4 },
        ],
      },
    );
    assert(healthy === null, "no heal below the mass threshold");
  });

  await test("migration heal: a mass-duplicated canon collapses once, marker set", async () => {
    step("seed a diseased canon, clear the heal marker");
    await swEval(async () => {
      await chrome.storage.local.set({
        canonLayout: {
          urls: [
            "https://tp-a.invalid/1",
            "https://tp-a.invalid/2",
            "https://tp-b.invalid/x",
            "https://tp-b.invalid/y",
            "https://tp-c.invalid/p",
            "https://tp-c.invalid/q",
          ],
          savedAt: Date.now(),
        },
      });
      await chrome.storage.local.remove("canonHealVersion");
    });
    step("cold bootstrap runs the one-time migration");
    await swEval(() => globalThis.__tpSimulateReload());
    await sleep(5500);
    const after = await swEval(async () => ({
      canon: ((await chrome.storage.local.get("canonLayout")).canonLayout || {}).urls || [],
      marker: (await chrome.storage.local.get("canonHealVersion")).canonHealVersion,
    }));
    assert(after.marker, "heal marker set");
    const origins = after.canon.map((u) => new URL(u).origin);
    assert(
      new Set(origins).size === origins.length,
      `disease shape gone - no origin twice (${after.canon.join(", ")})`,
    );
    step("cleanup: drop the synthetic canon and its error-page pins, rebuild from live state");
    for (let i = 0; i < 10; i++) {
      const t = await findTab("tp-");
      if (!t) break;
      await setPinned(t.id, false);
      await sleep(1100);
      await removeTab(t.id);
      await sleep(250);
    }
    await swEval(async () => {
      await chrome.storage.local.remove("canonLayout");
      return globalThis.__tpSimulateReload();
    });
    await sleep(4500);
  });

  await test("canon: survives a window-death write, empties on an explicit dissolve", async () => {
    step("pin a page so the canon is non-empty");
    const w = await swEval(async (b) => {
      const win = await chrome.windows.create({ url: b + "/canonlife" });
      await new Promise((r) => setTimeout(r, 700));
      const [t] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.update(t.id, { pinned: true });
      return win.id;
    }, baseUrl);
    const canonUrls = () =>
      swEval(
        async () => ((await chrome.storage.local.get("canonLayout")).canonLayout || {}).urls || [],
      );
    await waitFor("canon carries the page", async () =>
      (await canonUrls()).some((u) => u.includes("canonlife")),
    );
    step("an empty write with preserveCanon (window death) keeps the canon");
    await swEval(() => putMirror({ groups: {}, order: [], pending: [] }, { preserveCanon: true }));
    assert((await canonUrls()).length > 0, "canon survived the window-death write");
    step("an empty write without the flag (explicit dissolve) clears it");
    await swEval(() => putMirror({ groups: {}, order: [], pending: [] }));
    assert((await canonUrls()).length === 0, "canon cleared on dissolve semantics");
    step("cleanup: rebuild the live mirror, then retire the test pin");
    await swEval(() => globalThis.__tpSimulateReload());
    await sleep(4500);
    for (let i = 0; i < 8; i++) {
      const t = await findTab("/canonlife");
      if (!t) break;
      await setPinned(t.id, false);
      await sleep(1200);
      await removeTab(t.id);
      await sleep(300);
    }
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w);
    await sleep(500);
  });

  await test("circuit breaker: a creation storm is capped, never unbounded", async () => {
    step("hammer the token ledger with no allowance");
    const res = await swEval(async () => {
      const { createLedger: before = [] } = await chrome.storage.session.get("createLedger");
      const now = Date.now();
      const recentBefore = before.filter((ts) => now - ts < 60_000).length;
      let granted = 0;
      for (let i = 0; i < 80; i++) {
        if (await takeCreateToken("breaker-e2e")) granted++;
      }
      // Restore the budget so later scenarios are unaffected.
      await chrome.storage.session.set({ createLedger: before });
      return { granted, recentBefore };
    });
    step(`granted ${res.granted} with ${res.recentBefore} recent`);
    assert(
      res.granted === Math.max(0, 25 - res.recentBefore),
      `cap honored exactly (granted ${res.granted}, prior ${res.recentBefore})`,
    );
  });

  await test("i18n: english by default, russian messages load", async () => {
    const en = await swEval(async () => {
      await ensureI18n();
      return tpI18n.t("saveBtn");
    });
    assert(en === "Save", `UI-locale message (got "${en}")`);
    const ru = await swEval(async () => {
      const response = await fetch(chrome.runtime.getURL("_locales/ru/messages.json"));
      const messages = await response.json();
      return messages.saveBtn.message;
    });
    assert(ru === "Сохранить", `russian message (got "${ru}")`);
    const zh = await swEval(async () => {
      const response = await fetch(chrome.runtime.getURL("_locales/zh_CN/messages.json"));
      const messages = await response.json();
      return messages.saveBtn.message;
    });
    assert(zh === "保存", `chinese message (got "${zh}")`);
  });

  // ---- family interop + settings platform (v3.12.0) -------------------------
  const TT_DEV_ID = "kidmlipfadbjifiaokampaemiadnngfl"; // TrueTabs, allowlisted sibling

  await test("family: a locked tab inside a user group is not yanked to the front", async () => {
    step("settings: lockToFront=always");
    await setLockFront("always");
    await sleep(700);
    const w = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/fg-a" });
      const [locked] = await chrome.tabs.query({ windowId: win.id });
      await chrome.tabs.create({ windowId: win.id, url: base + "/fg-b", active: false });
      await chrome.tabs.create({ windowId: win.id, url: base + "/fg-c", active: false });
      return { winId: win.id, lockedId: locked.id };
    }, baseUrl);
    await sleep(800);
    await swEval((id) => globalThis.truePinToggle(id), w.lockedId);
    await sleep(700);
    step("the user drags the locked tab to the back and groups it");
    await swEval(async (id) => {
      await chrome.tabs.move(id, { index: 2 });
      await chrome.tabs.group({ tabIds: [id] });
    }, w.lockedId);
    await sleep(1200); // give the 200ms enforcer every chance to misbehave
    const t = await swEval((id) => chrome.tabs.get(id), w.lockedId);
    assert(t.groupId !== -1, "still in the user's group");
    assert(t.index === 2, `not yanked to the front (index ${t.index})`);
    step("leaving the group re-enters the front cluster");
    await swEval((id) => chrome.tabs.ungroup([id]), w.lockedId);
    await waitFor(
      "re-enforced to the front",
      async () => (await swEval(async (id) => (await chrome.tabs.get(id)).index, w.lockedId)) === 0,
      5000,
      200,
    );
    step("cleanup");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w.winId);
    await setLockFront("off");
    await sleep(500);
  });

  await test("family: the responder answers the contract shape for the sibling", async () => {
    step("settings: lockToFront=always, one locked loose tab + one locked grouped tab");
    await setLockFront("always");
    await sleep(700);
    const w = await swEval(async (base) => {
      const win = await chrome.windows.create({ url: base + "/fr-a" });
      const [a] = await chrome.tabs.query({ windowId: win.id });
      const b = await chrome.tabs.create({ windowId: win.id, url: base + "/fr-b", active: false });
      return { winId: win.id, aId: a.id, bId: b.id };
    }, baseUrl);
    await sleep(800);
    await swEval((id) => globalThis.truePinToggle(id), w.aId);
    await swEval((id) => globalThis.truePinToggle(id), w.bId);
    await sleep(700);
    await swEval((id) => chrome.tabs.group({ tabIds: [id] }), w.bId);
    await sleep(600);
    const resp = await swEval(
      (sid) => globalThis.__tpFamilyHandle({ v: 1, type: "family:lockedFront:get" }, sid),
      TT_DEV_ID,
    );
    assert(resp && resp.v === 1 && resp.mode === "always", "contract shape");
    assert(resp.tabIds.includes(w.aId), "the loose locked tab is in the zone");
    assert(!resp.tabIds.includes(w.bId), "the grouped locked tab is the user's layout, not the zone");
    step("cleanup");
    await swEval((id) => chrome.windows.remove(id).catch(() => {}), w.winId);
    await setLockFront("off");
    await sleep(500);
  });

  await test("family: the router ignores strangers and alien messages", async () => {
    const stranger = await swEval(
      (sid) => globalThis.__tpFamilyHandle({ v: 1, type: "family:lockedFront:get" }, sid),
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert(stranger === null, "a stranger gets silence");
    const alienType = await swEval(
      (sid) => globalThis.__tpFamilyHandle({ v: 1, type: "ui:diagnostics" }, sid),
      TT_DEV_ID,
    );
    assert(alienType === null, "alien types are not routed");
    const alienVersion = await swEval(
      (sid) => globalThis.__tpFamilyHandle({ v: 2, type: "family:lockedFront:get" }, sid),
      TT_DEV_ID,
    );
    assert(alienVersion === null, "unknown versions are ignored");
  });

  await test("platform: unknown future keys survive a settings write", async () => {
    await swEval(() =>
      chrome.storage.sync.set({
        settings: { iconStyle: "mono", futureKnob: "keep-me" },
      }),
    );
    await swEval(() => globalThis.__tpUiCall({ type: "ui:setAutoLock", on: false }));
    const raw = await swEval(async () => (await chrome.storage.sync.get("settings")).settings);
    assert(raw.futureKnob === "keep-me", "the newer version's key survived the write");
    assert(raw.autoLockPinned === false, "the patch landed");
    assert(raw.iconStyle === "mono", "existing values kept");
    await swEval(() => globalThis.__tpUiCall({ type: "ui:setAutoLock", on: true }));
  });

  await test("platform: reads normalize a poisoned store", async () => {
    await swEval(() =>
      chrome.storage.sync.set({
        settings: { lockToFront: "banana", autoLockPinned: "yes", language: 42 },
      }),
    );
    const settings = await swEval(() => getSettings());
    assert(settings.lockToFront === "off", "bad enum degrades to default");
    assert(settings.autoLockPinned === true, "bad boolean degrades to default");
    assert(settings.language === "auto", "bad string degrades to default");
    await swEval(() => chrome.storage.sync.remove("settings"));
  });

  await test("platform: export-import round trip, sets additive by name", async () => {
    step("seed settings and a named set");
    await swEval(async () => {
      // Earlier tests leave their own snapshots in sync - a clean slate makes
      // the additive-by-name arithmetic exact.
      const all = await chrome.storage.sync.get(null);
      const snaps = Object.keys(all).filter((k) => k.startsWith("snap:"));
      if (snaps.length) await chrome.storage.sync.remove(snaps);
      await chrome.storage.sync.set({
        settings: { iconStyle: "mono", lockToFront: "onLock" },
        "snap:Alpha": { urls: ["https://a.example/1", "https://a.example/2"], savedAt: 1 },
      });
    });
    const exported = await swEval(() => globalThis.__tpUiCall({ type: "ui:exportData" }));
    assert(exported.format === "truepin-settings" && exported.schema === 1, "export envelope");
    assert(exported.sets.Alpha && exported.sets.Alpha.urls.length === 2, "set exported");
    step("wipe, plant an unrelated set, import back");
    await swEval(async () => {
      await chrome.storage.sync.remove(["settings", "snap:Alpha"]);
      await chrome.storage.sync.set({ "snap:Beta": { urls: ["https://b.example/1"], savedAt: 2 } });
    });
    const result = await swEval(
      (payload) => globalThis.__tpUiCall({ type: "ui:importData", payload }),
      exported,
    );
    assert(result && result.ok && result.sets === 1, "import applied");
    const after = await swEval(async () => await chrome.storage.sync.get(null));
    assert(after.settings.iconStyle === "mono" && after.settings.lockToFront === "onLock", "settings restored");
    assert(after["snap:Alpha"] && after["snap:Alpha"].urls.length === 2, "set restored");
    assert(after["snap:Beta"], "the unmentioned set survived - additive by name");
    step("cleanup");
    await swEval(() => chrome.storage.sync.remove(["settings", "snap:Alpha", "snap:Beta"]));
  });

  await test("platform: import rejects a foreign file readably", async () => {
    const result = await swEval(() =>
      globalThis.__tpUiCall({ type: "ui:importData", payload: { format: "not-ours" } }),
    );
    assert(result && result.ok === false && result.error === "format", "readable reject");
  });

  await test("platform: a deferred update applies only at a quiet moment", async () => {
    await swEval(() => chrome.storage.session.set({ updatePending: "9.9.9", mirrorReady: false }));
    assert(
      (await swEval(() => globalThis.__tpTryApplyUpdate(true))) === "blocked:mirror",
      "cold convergence blocks the apply",
    );
    await swEval(() => chrome.storage.session.set({ mirrorReady: true }));
    assert(
      (await swEval(() => globalThis.__tpTryApplyUpdate(true))) === "applied",
      "quiet moment applies (dry run)",
    );
    await swEval(() => chrome.storage.session.remove("updatePending"));
    assert(
      (await swEval(() => globalThis.__tpTryApplyUpdate(true))) === "none",
      "no pending update, no action",
    );
  });

  await test("popup pin switch: ui:setPinned pins and unpins the active tab", async () => {
    const { tab } = await openPage("/pinswitch");
    const pinnedNow = () =>
      swEval(
        (id) =>
          new Promise((r) =>
            chrome.tabs.get(id, (x) => {
              void chrome.runtime.lastError;
              r(x ? x.pinned : null);
            }),
          ),
        tab.id,
      );
    assert((await pinnedNow()) === false, "starts unpinned");
    await swEval((r) => globalThis.__tpUiCall(r), { type: "ui:setPinned", tabId: tab.id, on: true });
    await waitFor("pinned via ui:setPinned", async () => (await pinnedNow()) === true, 6000, 200);
    await swEval((r) => globalThis.__tpUiCall(r), { type: "ui:setPinned", tabId: tab.id, on: false });
    await waitFor("unpinned via ui:setPinned", async () => (await pinnedNow()) === false, 6000, 200);
    step("cleanup");
    await sleep(1600); // let unpin-confirm settle before removing
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("re-enable: worker wake re-settles the mirror so per-tab icons reapply", async () => {
    step("mono style, pin a tab, settle once");
    await swEval(() => chrome.storage.sync.set({ settings: { iconStyle: "mono" } }));
    const { tab } = await openPage("/reenable");
    await setPinned(tab.id, true);
    await waitFor("settled once", async () =>
      swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady === true),
    );
    step("re-enable: session wiped, fresh worker, no onInstalled/onStartup");
    await swEval(() => globalThis.__tpSimulateReenable());
    const resettled = await waitFor(
      "mirror re-settles after re-enable",
      async () =>
        swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady === true),
      6000,
      200,
    );
    // The settle IS the icon reapply: bootstrapAll refreshes every tab, and
    // refreshTab writes the iconStyle icon. Pre-fix, nothing ran on re-enable,
    // so the toolbar kept the manifest default (color) while settings read mono.
    assert(resettled, "re-enable reruns bootstrap, reapplying iconStyle to every tab");
    step("cleanup");
    await swEval(() => chrome.storage.sync.remove("settings"));
    await setPinned(tab.id, false);
    await sleep(1600);
    await removeTab(tab.id);
    await sleep(400);
  });

  await test("service worker: no unchecked runtime errors during the run", async () => {
    step("settle");
    await sleep(600);
    assert(
      swErrors.length === 0,
      `${swErrors.length} SW error(s): ${swErrors.slice(0, 3).join(" | ")}`,
    );
  });

  step("browser close");
  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

const watchdog = setTimeout(() => {
  console.error(`global timeout (last step: ${currentStep})`);
  process.exit(2);
}, 420_000);
watchdog.unref();

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
