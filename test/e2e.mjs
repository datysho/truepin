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

  // ---- 2.1.0: snapshots + follow mode -----------------------------------
  const uiCall = (request) => swEval((r) => globalThis.__tpUiCall(r), request);
  const pinnedOf = (windowId) =>
    swEval(
      async (wid) =>
        (await chrome.tabs.query({ windowId: wid, pinned: true })).map((t) => ({
          id: t.id,
          url: t.url || t.pendingUrl || "",
        })),
      windowId,
    );

  let snapWindowId = null;
  let s1TabId = null;

  await test("snapshot: save, mutate, diff-restore (reuse + create + close extra)", async () => {
    // Clean the pinned /six left over from the previous test.
    step("cleanup /six");
    const six = await findTab("/six");
    await setPinned(six.id, false);
    await waitFor("/six unprotected", async () => (await tabState(six.id))?.protected === false);
    await sleep(600); // stay clear of the unpin-close grace window
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
      "auto-snapshot picked up the set",
      async () => {
        const auto = await swEval(
          async () => (await chrome.storage.local.get("autoSnapshot")).autoSnapshot,
        );
        return (
          auto &&
          auto.urls.some((u) => u.includes("/s1")) &&
          auto.urls.some((u) => u.includes("/s2"))
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
    await sleep(600); // stay clear of the unpin-close grace window
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
    const undo = await swEval(
      async () => (await chrome.storage.local.get("autoSnapshot")).autoSnapshot,
    );
    assert(undo.urls.some((u) => u.includes("/s3")), "replaced set kept in auto-snapshot (undo)");
  });

  await test("popup: renders pinned set and snapshots, saves a set via UI", async () => {
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
        document.querySelectorAll("#snapList .snap").length >= 2,
      { timeout: 8000 },
    );
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("#snapList .snap .info")].map((el) => el.textContent),
    );
    assert(names.some((n) => n.includes("work")), "'work' listed");
    assert(names.some((n) => n.includes("Авто")), "auto-snapshot listed");
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

  let followWinId = null;

  await test("follow: new empty window pulls the pinned tabs over", async () => {
    const before = await pinnedOf(snapWindowId);
    assert(before.length === 2, "two pinned before");
    step("create empty window");
    followWinId = await swEval(async () => (await chrome.windows.create({})).id);
    await waitFor(
      "pins moved to the new window",
      async () => {
        const pins = await pinnedOf(followWinId);
        return pins.length === 2 && pins[0].url.includes("/s1") && pins[1].url.includes("/s2");
      },
      8000,
      250,
    );
    const moved = await pinnedOf(followWinId);
    assert(
      moved[0].id === before[0].id && moved[1].id === before[1].id,
      "same tabs moved, not recreated",
    );
    assert((await pinnedOf(snapWindowId)).length === 0, "old window has no pinned left");
    await waitFor(
      "still protected after the move",
      async () => (await tabState(s1TabId))?.protected === true,
    );
  });

  await test("follow guard: window opened with a URL keeps pins in place", async () => {
    step("create window with url");
    const urlWinId = await swEval(
      async (u) => (await chrome.windows.create({ url: u })).id,
      `${baseUrl}/g1`,
    );
    await sleep(1800);
    assert((await pinnedOf(urlWinId)).length === 0, "url window got no pins");
    assert((await pinnedOf(followWinId)).length === 2, "pins stayed home");
  });

  await test("follow toggle off: new empty window stays empty", async () => {
    step("disable followNewWindow");
    await swEval(() =>
      chrome.storage.sync.set({
        settings: {
          autoLockPinned: true,
          showIcon: true,
          restoreClosed: true,
          restoreCooldownSec: 15,
          followNewWindow: false,
          autoSnapshot: true,
        },
      }),
    );
    const plainWinId = await swEval(async () => (await chrome.windows.create({})).id);
    await sleep(1800);
    assert((await pinnedOf(plainWinId)).length === 0, "no pins moved");
    assert((await pinnedOf(followWinId)).length === 2, "pins stayed");
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
