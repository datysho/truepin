// Standalone reproduction of the "pins duplicate during a Google Meet call"
// report (2026-07-23, v3.15.5). Meet opens a Document Picture-in-Picture
// window when the user switches away from the call tab (auto-PiP while someone
// presents). This probe asks the two questions that decide the mechanism:
//
//   1. What does chrome.windows report for a Document PiP window - "normal"?
//      (If yes, windows.onCreated -> syncWindowFill fills it with the WHOLE
//      pinned set: one copy per canon page, exactly the reported symptom.)
//   2. Where do those copies actually land - in the PiP window, or in the
//      user's real window as visible duplicates?
//
// Control: a plain popup window must NOT be filled.
//
// Run: node repro-pip-window.mjs   (HEADFUL=1 to watch)
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGES = ["/chat", "/claude", "/gemini", "/fathom", "/perplexity", "/deepl"];

const server = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><title>page-${name}</title>` +
      `<body style="height:100vh;margin:0">page ${name}` +
      `<script>
         document.body.addEventListener("click", async () => {
           try {
             const w = await documentPictureInPicture.requestWindow({width: 300, height: 200});
             w.document.body.textContent = "pip";
             window.__pipOk = true;
           } catch (e) { window.__pipErr = String(e); }
         });
       </script>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
  { timeout: 20_000 },
);
const worker = await target.worker();
const swEval = (fn, ...a) => worker.evaluate(fn, ...a);

async function waitFor(label, probe, ms = 15000, iv = 250) {
  const start = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(iv);
  }
}

const windowsDump = () =>
  swEval(async () => {
    const all = await chrome.windows.getAll({ populate: true });
    const normalOnly = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return {
      all: all.map((w) => ({ id: w.id, type: w.type, tabs: (w.tabs || []).length })),
      normalIds: normalOnly.map((w) => w.id),
    };
  });

const pinnedIn = (wid) =>
  swEval(
    async (id) => (await chrome.tabs.query({ windowId: id, pinned: true })).map((t) => t.url),
    wid,
  );

const allPinned = () =>
  swEval(async () =>
    (await chrome.tabs.query({ pinned: true })).map((t) => `${t.windowId}:${t.url}`),
  );

const mirrorDump = () =>
  swEval(async () => {
    const s = await chrome.storage.session.get(["groups", "groupOrder"]);
    const groups = s.groups || {};
    return (s.groupOrder || []).map((gid) => ({
      gid,
      url: groups[gid]?.url,
      members: groups[gid]?.members,
    }));
  });

let failed = false;
try {
  await waitFor(
    "mirror ready",
    async () =>
      (await swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady)) ===
      true,
  );

  console.log("== setup: one window, six pinned pages (the canon set) ==");
  const mainId = await swEval(async (args) => {
    const w = await chrome.windows.create({ url: args.base + args.pages[0] });
    const [first] = await chrome.tabs.query({ windowId: w.id });
    await chrome.tabs.update(first.id, { pinned: true });
    for (const p of args.pages.slice(1)) {
      await chrome.tabs.create({ windowId: w.id, url: args.base + p, pinned: true, active: false });
      await new Promise((r) => setTimeout(r, 400));
    }
    return w.id;
  }, { base, pages: PAGES });
  await waitFor("six pins settled", async () => (await pinnedIn(mainId)).length === PAGES.length);
  console.log(`   main window ${mainId}: ${(await pinnedIn(mainId)).length} pins`);
  console.log("   groups:", JSON.stringify(await mirrorDump()));

  console.log("\n== control: a POPUP window opens (must NOT be filled) ==");
  const popupId = await swEval(
    async (b) => (await chrome.windows.create({ url: b + "/popup", type: "popup" })).id,
    base,
  );
  await sleep(4000);
  const popupPins = await pinnedIn(popupId);
  console.log(`   popup window ${popupId}: ${popupPins.length} pins (expected 0)`);
  console.log(`   main window still: ${(await pinnedIn(mainId)).length} pins (expected 6)`);

  console.log("\n== probe: Google Meet's Document Picture-in-Picture window ==");
  const before = await allPinned();
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes("/chat")) || pages[pages.length - 1];
  await page.bringToFront();
  await page.click("body");
  await sleep(1500);
  const pipState = await page.evaluate(() => ({ ok: !!window.__pipOk, err: window.__pipErr || null }));
  console.log("   requestWindow:", JSON.stringify(pipState));
  if (!pipState.ok) {
    console.log("   (PiP did not open in this environment - probe inconclusive, try HEADFUL=1)");
  }

  const dump = await windowsDump();
  console.log("   windows now:", JSON.stringify(dump.all));
  console.log("   getAll({windowTypes:['normal']}) ->", JSON.stringify(dump.normalIds));

  await sleep(8000); // let waitForStableStrip + syncWindowFill run
  const after = await allPinned();
  const mainPins = await pinnedIn(mainId);
  console.log(`\nRESULT pinned tabs: ${before.length} before -> ${after.length} after`);
  console.log(`   main window ${mainId}: ${mainPins.length} pins`);
  console.log("   all pins:", JSON.stringify(after, null, 1));
  console.log("   groups after:", JSON.stringify(await mirrorDump(), null, 1));
  console.log("   trace:", JSON.stringify(await swEval(() => globalThis.__tpDiag.trace.slice(-15)), null, 1));

  if (after.length > before.length) {
    console.log(`\nFAIL  the pinned set multiplied: ${before.length} -> ${after.length}`);
    failed = true;
  } else {
    console.log(`\nPASS  no duplication (${after.length} pins)`);
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
