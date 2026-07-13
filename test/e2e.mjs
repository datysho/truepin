// E2E suite for TruePin. Drives a real Chrome (for Testing) with
// the unpacked extension and verifies both protection layers:
//   1. beforeunload dialog on interacted, protected tabs;
//   2. silent-close auto-restore for non-interacted tabs + cooldown override.
//
// Rules the suite lives by:
// - The initial about:blank tab is never closed, so single-tab closes never
//   count as "window closing" (which the extension deliberately lets through).
// - Pages that must stay activation-free are NEVER touched with
//   page.evaluate()/page.title(): Puppeteer evaluates with userGesture=true,
//   which would grant the page user activation and break the scenario.
//   Everything is asserted from the service worker side instead.
//
// Run: npm test   (HEADFUL=1 npm test to watch)

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const TEST_TIMEOUT_MS = 45_000;

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

async function getWorker() {
  if (cachedWorker) return cachedWorker;
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
    { timeout: 10_000 },
  );
  cachedWorker = await target.worker();
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
    return tab ? { id: tab.id, pinned: tab.pinned, title: tab.title || "" } : null;
  }, marker);

const tabState = (tabId) =>
  swEval(async (key) => (await chrome.storage.session.get(key))[key] ?? null, `t${tabId}`);

const setPinned = (tabId, pinned) =>
  swEval((id, p) => chrome.tabs.update(id, { pinned: p }), tabId, pinned);

const removeTab = (tabId) => swEval((id) => chrome.tabs.remove(id), tabId);

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
  {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
      { timeout: 10_000 },
    );
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

  await test("extension boots: service worker up, defaults in effect", async () => {
    step("read settings");
    const settings = await swEval(async () => {
      const { settings } = await chrome.storage.sync.get("settings");
      return settings ?? "defaults";
    });
    assert(settings === "defaults" || settings.autoLockPinned, "autoLockPinned on");
  });

  await test("pinned + interacted tab: close shows beforeunload dialog", async () => {
    const { page, dialogs, tab } = await openPage("/one");
    step("pin");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    // Title prefix proves the apply message reached the content script.
    await waitFor(
      "🔒 title",
      async () => ((await findTab("/one"))?.title || "").startsWith("🔒"),
    );
    await clickPage(page, "/one");
    await waitFor("activation recorded", async () => (await tabState(tab.id))?.activated === true);

    step("close with runBeforeUnload");
    page.close({ runBeforeUnload: true }).catch(() => {});
    await waitFor("dialog shown", () => dialogs.length > 0, 6000);
    assert(dialogs[0].type === "beforeunload", `dialog type ${dialogs[0].type}`);
    step("verify tab survived");
    await sleep(400);
    assert(await findTab("/one"), "tab survived after dismissing the dialog");

    // Cleanup: CDP force-close skips beforeunload entirely; the tab had
    // activation, so the extension must NOT restore it.
    step("cleanup force close");
    await page.close().catch(() => {});
    await sleep(800);
    assert(!(await findTab("/one")), "activated tab is not restored after force close");
  });

  let restoredTabId = null;

  await test("pinned, never interacted: silent close is auto-restored pinned", async () => {
    const { page, dialogs, tab } = await openPage("/two");
    step("pin");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => {
      const s = await tabState(tab.id);
      return s?.protected === true && (s.url || "").includes("/two");
    });

    step("silent close");
    await Promise.race([page.close({ runBeforeUnload: true }).catch(() => {}), sleep(4000)]);
    const restored = await waitFor(
      "restored tab",
      async () => {
        const t = await findTab("/two");
        return t && t.id !== tab.id ? t : null;
      },
      10_000,
    );
    assert(dialogs.length === 0, "no dialog without user activation");
    assert(restored.pinned === true, "restored tab came back pinned");
    await waitFor("restored tab re-protected", async () => {
      const s = await tabState(restored.id);
      return s?.protected === true && (s.url || "").includes("/two");
    });
    restoredTabId = restored.id;
  });

  await test("second silent close within cooldown is deliberate: stays closed", async () => {
    assert(restoredTabId !== null, "previous test restored a tab");
    step("remove restored tab");
    await removeTab(restoredTabId);
    step("wait to confirm it stays closed");
    await sleep(2500);
    assert(!(await findTab("/two")), "tab stayed closed on second close");
  });

  await test("unpinning removes protection: closes without dialog or restore", async () => {
    const { page, dialogs, tab } = await openPage("/three");
    step("pin");
    await setPinned(tab.id, true);
    await waitFor("protected", async () => (await tabState(tab.id))?.protected === true);
    step("unpin");
    await setPinned(tab.id, false);
    await waitFor("unprotected", async () => (await tabState(tab.id))?.protected === false);
    await clickPage(page, "/three");

    step("close");
    await Promise.race([page.close({ runBeforeUnload: true }).catch(() => {}), sleep(4000)]);
    await sleep(1500);
    assert(dialogs.length === 0, "no dialog on unprotected tab");
    assert(!(await findTab("/three")), "tab closed and was not restored");
  });

  await test("toolbar toggle locks a regular tab: dialog appears", async () => {
    const { page, dialogs, tab } = await openPage("/four");
    step("toggle lock");
    await swEval((id) => globalThis.truePinToggle(id), tab.id);
    await waitFor("manually protected", async () => {
      const s = await tabState(tab.id);
      return s?.protected === true && s.manual === true;
    });
    await clickPage(page, "/four");
    await waitFor("activation recorded", async () => (await tabState(tab.id))?.activated === true);

    step("close with runBeforeUnload");
    page.close({ runBeforeUnload: true }).catch(() => {});
    await waitFor("dialog shown", () => dialogs.length > 0, 6000);
    assert(dialogs[0].type === "beforeunload", "beforeunload dialog");
    step("verify tab survived");
    await sleep(300);
    assert(await findTab("/four"), "tab survived");
    step("cleanup force close");
    await page.close().catch(() => {});
    await sleep(800);
    assert(!(await findTab("/four")), "activated tab is not restored after force close");
  });

  await test("plain unpinned tab: untouched by the extension", async () => {
    const { page, dialogs, tab } = await openPage("/five");
    await clickPage(page, "/five");
    step("close");
    await Promise.race([page.close({ runBeforeUnload: true }).catch(() => {}), sleep(4000)]);
    await sleep(1200);
    assert(dialogs.length === 0, "no dialog");
    assert(!(await findTab("/five")), "closed for good");
    void tab;
  });

  await test("autoLockPinned=false disables auto-protection; re-enable recomputes", async () => {
    const write = (auto) =>
      swEval(
        (a) =>
          chrome.storage.sync.set({
            settings: {
              autoLockPinned: a,
              showIcon: true,
              restoreClosed: true,
              restoreCooldownSec: 15,
            },
          }),
        auto,
      );
    step("disable autoLockPinned");
    await write(false);
    const { tab } = await openPage("/six");
    step("pin");
    await setPinned(tab.id, true);
    await sleep(1000);
    assert((await tabState(tab.id))?.protected !== true, "not protected while disabled");
    step("re-enable autoLockPinned");
    await write(true);
    await waitFor(
      "protected after re-enable",
      async () => (await tabState(tab.id))?.protected === true,
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
    // Clean the pinned /six left over from the previous test.
    step("cleanup /six");
    const six = await findTab("/six");
    await setPinned(six.id, false);
    await waitFor("/six unprotected", async () => (await tabState(six.id))?.protected === false);
    await sleep(900); // unpin grace + unpin-confirm must both pass
    await removeTab(six.id);
    await sleep(400);

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
    await sleep(1500); // the closed extra must not be resurrected by the restore net
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
      8000,
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
      8000,
      250,
    );
    const own = await findTab("/g1");
    assert(own && own.pinned === false, "the window's own tab stays unpinned");
  });

  let m1Page = null;
  let m1TabId = null;

  await test("mirror: pinning a tab creates copies in every window", async () => {
    const m = await openPage("/m1"); // opens in the first window
    m1Page = m.page;
    m1TabId = m.tab.id;
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
      8000,
      250,
    );
  });

  await test("mirror: deliberate close of a pinned tab closes its copies", async () => {
    // Activate the original (not a mirror copy) so its close is deliberate.
    assert(m1Page && m1TabId, "original /m1 handle from the previous test");
    await clickPage(m1Page, "/m1");
    await waitFor(
      "activation recorded",
      async () => (await tabState(m1TabId))?.activated === true,
    );
    step("force close the original");
    await m1Page.close().catch(() => {});
    await waitFor(
      "all /m1 copies closed everywhere",
      async () => {
        for (const wid of [snapWindowId, mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          if (pins.some((p) => p.url.includes("/m1"))) return false;
        }
        return true;
      },
      8000,
      250,
    );
    await sleep(1500);
    assert(!(await findTab("/m1")), "no /m1 resurrected anywhere");
  });

  await test("mirror: unpinning keeps the tab but closes its copies elsewhere", async () => {
    const s2 = (await pinnedOf(snapWindowId)).find((p) => p.url.includes("/s2"));
    assert(s2, "/s2 original present");
    step("unpin /s2 in the first window");
    await setPinned(s2.id, false);
    await waitFor(
      "/s2 copies closed in other windows",
      async () => {
        for (const wid of [mirrorWinId, urlWinId]) {
          const pins = await pinnedOf(wid);
          if (pins.some((p) => p.url.includes("/s2"))) return false;
        }
        return true;
      },
      8000,
      250,
    );
    const still = await findTab("/s2");
    assert(still && still.pinned === false, "unpinned original stays open as a regular tab");
    step("cleanup: close the unpinned /s2");
    await sleep(900);
    await removeTab(s2.id);
  });

  await test("mirrorPinned=false: new window stays empty, groups cleared", async () => {
    step("disable mirrorPinned");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          showIcon: true,
          restoreClosed: true,
          restoreCooldownSec: 15,
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
}, 300_000);
watchdog.unref();

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
