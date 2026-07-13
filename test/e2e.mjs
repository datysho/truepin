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
