// Standalone, fresh-profile reproduction of the "pins multiply" report.
// No accumulated suite state: launch Chrome + the unpacked extension, set up
// two windows with one pinned page, then add a SECOND pin of the EXACT SAME
// page (an unwanted duplicate, as a browser-restart cascade leaves behind) and
// observe whether a parallel group forms and multiplies the copy across
// windows. Distinct pages (different paths) are a separate, correct case and
// must still mirror to every window.
//
// Run: PUPPETEER_EXECUTABLE_PATH=<cft148> node repro-multiply.mjs
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(label, probe, ms = 12000, iv = 250) {
  const start = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await sleep(iv);
  }
}
const dupeCount = (wid) =>
  swEval(
    async (id) =>
      (await chrome.tabs.query({ windowId: id, pinned: true })).filter((t) =>
        (t.url || t.pendingUrl || "").includes("/app"),
      ).length,
    wid,
  );
const dumpMirror = () =>
  swEval(async () => {
    const s = await chrome.storage.session.get(["groups", "groupOrder"]);
    const groups = s.groups || {};
    const order = s.groupOrder || [];
    return {
      groupCount: order.length,
      groups: order.map((gid) => ({ gid, url: groups[gid]?.url, members: groups[gid]?.members })),
    };
  });

try {
  // The extension boots with mirror on by default; wait until it settles.
  await waitFor(
    "mirror ready",
    async () => (await swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady)) === true,
  );

  console.log("\n== setup: window A with one pinned page /app ==");
  const aId = await swEval(async (b) => {
    const w = await chrome.windows.create({ url: b + "/app" });
    const [t] = await chrome.tabs.query({ windowId: w.id });
    await chrome.tabs.update(t.id, { pinned: true });
    return w.id;
  }, base);
  await waitFor("A pinned", async () => (await dupeCount(aId)) === 1);

  console.log("== window B opens; it should receive one copy ==");
  const bId = await swEval(async () => (await chrome.windows.create({})).id);
  await waitFor("B mirrored", async () => (await dupeCount(bId)) === 1);
  console.log(`A=${await dupeCount(aId)}  B=${await dupeCount(bId)}  (expected 1 / 1)`);
  console.log("groups after setup:", JSON.stringify(await dumpMirror(), null, 2));

  console.log("\n== add a SECOND pin of the EXACT SAME page /app to A (a duplicate) ==");
  await swEval(
    async (args) =>
      chrome.tabs.create({ windowId: args.aId, url: args.base + "/app", pinned: true, active: false }),
    { aId, base },
  );
  await sleep(4000);

  const aAfter = await dupeCount(aId);
  const bAfter = await dupeCount(bId);
  console.log(`\nRESULT: A=${aAfter}  B=${bAfter}`);
  console.log("groups after:", JSON.stringify(await dumpMirror(), null, 2));
  if (bAfter > 1) {
    console.log(`\nFAIL  window B gained a duplicate (B=${bAfter}) - the set multiplied`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS  no cross-window multiplication (B=${bAfter})`);
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
