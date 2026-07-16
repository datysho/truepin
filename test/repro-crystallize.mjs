// Standalone, fresh-profile reproduction of the CRYSTALLIZATION hole
// (field report 2026-07-16, second episode: duplicates reappeared on v3.8.0).
//
// A cold start with NO canon (update from a pre-canon version, or a canon
// emptied by a window-level death) used to run the legacy adopt+fill path:
// EVERY pin found anywhere became truth. Drift residue sitting in a non-focal
// window (chat copies on unique paths) was adopted into groups and fanned out
// into every other window - junk won, and the union only ever grew.
//
// The fix under test: with no canon, the canon crystallizes from the
// AUTHORITATIVE window's pins (plus unknown-origin singletons), and every
// window converges to it. Residue in other windows closes instead of
// becoming truth.
//
// PASS = after a no-canon cold start, the canon equals the authoritative
// window's pre-boot set, every window holds exactly it, junk is gone.
// FAIL (old code) = the junk is adopted and fanned out everywhere.
//
// Run: node repro-crystallize.mjs
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let conversation = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/chat" || req.url === "/chat/") {
    res.writeHead(302, { location: `/chat/u${++conversation}` });
    res.end();
    return;
  }
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

async function waitFor(label, probe, ms = 20_000, iv = 250) {
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
const canonUrls = () =>
  swEval(
    async () => ((await chrome.storage.local.get("canonLayout")).canonLayout || {}).urls || [],
  );

try {
  await waitFor(
    "mirror ready",
    async () =>
      (await swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady)) ===
      true,
  );

  console.log("== setup: the initial (authoritative) window pins the chat app; window B mirrors ==");
  const iId = await swEval(async (b) => {
    const w = await chrome.windows.getCurrent();
    const t = await chrome.tabs.create({ windowId: w.id, url: b + "/chat", active: false });
    await new Promise((r) => setTimeout(r, 800));
    await chrome.tabs.update(t.id, { pinned: true });
    return w.id;
  }, base);
  await waitFor("auth pin drifted", async () => (await pinsOf(iId)).some((u) => u.includes("/chat/u")));
  const bId = await swEval(async (b) => (await chrome.windows.create({ url: b + "/anchor-b" })).id, base);
  await waitFor("B mirrored", async () => (await pinsOf(bId)).some((u) => u.includes("/chat/")));
  const authSet = (await pinsOf(iId)).map((u) => u.replace(base, "")).sort();
  console.log(`   auth window set: ${JSON.stringify(authSet)}`);

  console.log("== no-canon cold start; session restore drags drift junk into window B ==");
  // A real cold start begins with a dead job queue: drain the setup's
  // lingering jobs (window fill, autosnapshot) before simulating the wipe,
  // or a pre-wipe job would leak across the "restart" - impossible in
  // reality, where the whole service worker dies.
  await waitFor("queue drained", async () => {
    const d = await swEval(() => ({
      queued: globalThis.__tpDiag.queued,
      finished: globalThis.__tpDiag.finished,
    }));
    return d.queued === d.finished;
  });
  await sleep(2000); // debounced autosnapshot timer
  await swEval(async () => {
    await chrome.storage.local.remove("canonLayout");
    return globalThis.__tpWipeState();
  });
  // The user is looking at the authoritative window when the browser comes
  // back: focus it so pinnedHomeWindow resolves deterministically.
  await swEval(async (id) => chrome.windows.update(id, { focused: true }), iId);
  await sleep(400);
  for (const n of [81, 83, 85]) {
    await swEval(
      async (args) =>
        chrome.tabs.create({
          windowId: args.bId,
          url: args.base + "/chat/u" + args.n,
          pinned: true,
          active: false,
        }),
      { bId, base, n },
    );
    await sleep(150);
  }
  console.log(`   pins before bootstrap settles: ${await totalPins()}`);

  await sleep(14_000);
  const snap = async () => ({
    total: await totalPins(),
    canon: (await canonUrls()).map((u) => u.replace(base, "")).sort(),
    i: (await pinsOf(iId)).map((u) => u.replace(base, "")).sort(),
    b: (await pinsOf(bId)).map((u) => u.replace(base, "")).sort(),
  });
  const s1 = await snap();
  await sleep(3000);
  const s2 = await snap();
  console.log(`\nRESULT: total=${s2.total}  canon=${JSON.stringify(s2.canon)}`);
  console.log(`windows: I=${JSON.stringify(s2.i)}  B=${JSON.stringify(s2.b)}`);
  console.log(
    "trace:",
    JSON.stringify(await swEval(() => globalThis.__tpDiag.trace.slice(-12))),
  );

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const canonIsAuth = same(s2.canon, authSet);
  const converged = same(s2.i, s2.canon) && same(s2.b, s2.canon);
  const junkGone = s2.total === s2.canon.length * 2;
  const stable = same(s1, s2);
  if (!canonIsAuth || !converged || !junkGone || !stable) {
    console.log(
      `\nFAIL  junk became truth (canonIsAuth=${canonIsAuth} converged=${converged} junkGone=${junkGone} stable=${stable})`,
    );
    process.exitCode = 1;
  } else {
    console.log("\nPASS  canon crystallized from the authoritative window; junk closed everywhere");
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
