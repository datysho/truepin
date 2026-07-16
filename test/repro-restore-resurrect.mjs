// Standalone, fresh-profile reproduction of the "restore 5 tabs -> 31 pins"
// report (2026-07-16). Setup mirrors the field state: one window carries the
// residue of older duplication bugs - many protected pins of the same page
// (post-3.7.7 "inert" duplicates) - and the user restores a small named set.
//
// diffApplyWindow(closeExtras) closes all the residue via closeTabs. Every
// discard swaps the tab id and appends the new id to storage.session
// selfClosed with a concurrent read-modify-write; those writes lose entries,
// onRemoved then treats the affected closes as user closes of protected tabs
// and RESURRECTS them, and the mirror multiplies the zombies back across
// windows. The restore of a 5-url set ends with dozens of pins.
//
// PASS = both windows converge to exactly the restored set and stay there.
//
// Run: node repro-restore-resurrect.mjs
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DUPES = 16; // residue size; the field incident carried ~26

const server = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>page-${name}</title><body>page ${name}`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
  { timeout: 20_000 },
);
const worker = await target.worker();
const swEval = (fn, ...a) => worker.evaluate(fn, ...a);

async function waitFor(label, probe, ms = 15_000, iv = 250) {
  const start = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(iv);
  }
}

const pinsOf = (wid) =>
  swEval(
    async (id) =>
      (await chrome.tabs.query({ windowId: id, pinned: true })).map(
        (t) => t.url || t.pendingUrl || "",
      ),
    wid,
  );
const totalPins = () =>
  swEval(async () => (await chrome.tabs.query({ pinned: true })).length);

try {
  await waitFor(
    "mirror ready",
    async () =>
      (await swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady)) ===
      true,
  );

  console.log("== setup: window A pins /work; window B receives its mirror copy ==");
  const aId = await swEval(async (b) => {
    const w = await chrome.windows.create({ url: b + "/work" });
    const [t] = await chrome.tabs.query({ windowId: w.id });
    await chrome.tabs.update(t.id, { pinned: true });
    return w.id;
  }, base);
  const bId = await swEval(async () => (await chrome.windows.create({})).id);
  await waitFor(
    "B mirrored /work",
    async () => (await pinsOf(bId)).filter((u) => u.includes("/work")).length === 1,
  );

  console.log(`== seed residue: ${DUPES} extra protected pins of the same /work page in A ==`);
  await swEval(
    async (args) => {
      for (let i = 0; i < args.n; i++) {
        await chrome.tabs.create({
          windowId: args.aId,
          url: args.base + "/work",
          pinned: true,
          active: false,
        });
      }
    },
    { n: DUPES, aId, base },
  );
  // Let them register (inert per v3.7.7) and finish loading so a discard
  // will swap tab ids, as it does for real loaded pages.
  await waitFor(
    "residue settled and loaded",
    async () =>
      (await swEval(
        async (id) =>
          (await chrome.tabs.query({ windowId: id, pinned: true })).filter(
            (t) => t.status === "complete",
          ).length,
        aId,
      )) >=
      DUPES + 1,
  );
  console.log(`A=${(await pinsOf(aId)).length}  B=${(await pinsOf(bId)).length}  total=${await totalPins()}`);

  console.log("\n== restore the named set Main (2 pages) into window A ==");
  await swEval(async (b) => {
    await chrome.storage.sync.set({
      "snap:Main": { urls: [b + "/alpha", b + "/beta"], splits: [], savedAt: Date.now() },
    });
  }, base);
  await swEval(
    (args) =>
      globalThis.__tpUiCall({ type: "ui:restoreSnapshot", name: "Main", windowId: args.aId }),
    { aId },
  );

  // Give the event tail time to do its worst (reopen storm peaks within ~2s).
  await sleep(6000);

  const aPins = await pinsOf(aId);
  const bPins = await pinsOf(bId);
  const total = await totalPins();
  console.log(`\nRESULT: A=${aPins.length}  B=${bPins.length}  total pinned=${total}`);
  console.log("A urls:", aPins.map((u) => u.replace(base, "")).join(", "));
  console.log("B urls:", bPins.map((u) => u.replace(base, "")).join(", "));

  // Stability check: no late resurrections either.
  await sleep(3000);
  const aLate = (await pinsOf(aId)).length;
  const bLate = (await pinsOf(bId)).length;

  const ok =
    aPins.length === 2 &&
    bPins.length === 2 &&
    aLate === 2 &&
    bLate === 2 &&
    aPins.every((u) => u.includes("/alpha") || u.includes("/beta")) &&
    bPins.every((u) => u.includes("/alpha") || u.includes("/beta"));
  if (!ok) {
    console.log(`\nFAIL  restore did not converge to the set (late: A=${aLate} B=${bLate})`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS  restore converged to exactly the set in every window");
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
