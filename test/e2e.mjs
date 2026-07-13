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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>page-${name}</title></head>` +
        `<body style="height:100vh;margin:0">page ${name}</body></html>`,
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
    await waitFor("🔒 title", async () => ((await findTab("/one"))?.title || "").startsWith("🔒"));

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
      async () => ((await findTab("/one"))?.title || "").startsWith("🔒"),
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
      `diff counts (${JSON.stringify(result)})`,
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
    await uiCall({ type: "ui:deleteSnapshot", name: "a-very-long-snapshot-name-that-keeps-go" });
    await uiCall({ type: "ui:deleteSnapshot", name: "second" });
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
        `window ${i}: expected ${before[i]}, got ${pins.length}`,
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
