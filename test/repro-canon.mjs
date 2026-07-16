// Standalone, fresh-profile reproduction of the compound duplication loop
// (field report 2026-07-16: "restore my 5-tab set -> 31 pins, again").
//
// The fuel: pages that redirect every new load to a unique path (chat apps:
// chatgpt.com/c/<id>, gemini /app/<id>). Copies of one logical pin drift to
// paths that never match each other, so every URL-keyed duplicate check
// (pathKey) sees "different pages". On each cold start the engine used to
// re-derive truth from whatever tabs it found: drifted leftovers spun up
// parallel groups, the mirror fanned them into every window, and the set
// grew another step - "stops, then grows again after a restart".
//
// The fix under test: a persisted CANON (storage.local) that survives
// restarts. Startup converges every window TO the canon; leftovers are
// closed, never promoted. A restored set therefore STAYS restored across
// junk-shaped restarts.
//
// PASS = after a restore and then a junk-shaped cold start, every window
// holds exactly the restored set, stable. FAIL (old code) = windows keep
// the junk and the junk multiplies.
//
// Run: node repro-canon.mjs
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bare /chat drifts to a fresh unique conversation path on every load, the
// way AI chat apps assign a new conversation; existing /chat/uN pages serve.
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
const allWindows = () =>
  swEval(async () =>
    (await chrome.windows.getAll({ windowTypes: ["normal"] })).map((w) => w.id),
  );
const chatCount = async () => {
  let n = 0;
  for (const wid of await allWindows()) {
    n += (await pinsOf(wid)).filter((u) => u.includes("/chat/")).length;
  }
  return n;
};

try {
  await waitFor(
    "mirror ready",
    async () =>
      (await swEval(async () => (await chrome.storage.session.get("mirrorReady")).mirrorReady)) ===
      true,
  );

  console.log("== 1. window A pins the chat app root; it drifts to a unique path ==");
  const aId = await swEval(async (b) => {
    const w = await chrome.windows.create({ url: b + "/chat" });
    await new Promise((r) => setTimeout(r, 800));
    const [t] = await chrome.tabs.query({ windowId: w.id });
    await chrome.tabs.update(t.id, { pinned: true });
    return w.id;
  }, base);
  await waitFor("A pin drifted", async () => (await pinsOf(aId)).some((u) => u.includes("/chat/u")));

  console.log("== 2. window B opens and receives the mirror copy ==");
  const bId = await swEval(async () => (await chrome.windows.create({})).id);
  await waitFor("B has a chat pin", async () => (await pinsOf(bId)).some((u) => u.includes("/chat/")));

  console.log("== 3. drift injection: B's copy moves to its own conversation; junk pin lands in A ==");
  await swEval(
    async (args) => {
      const [copy] = (await chrome.tabs.query({ windowId: args.bId, pinned: true })).filter((t) =>
        (t.url || "").includes("/chat/"),
      );
      await chrome.tabs.update(copy.id, { url: args.base + "/chat/u77" });
      await chrome.tabs.create({
        windowId: args.aId,
        url: args.base + "/chat/u78",
        pinned: true,
        active: false,
      });
    },
    { aId, bId, base },
  );
  await sleep(2500);
  console.log(`   chat pins now: ${await chatCount()} (drifted copies + junk, possibly fanned out)`);

  console.log("\n== 4. the user restores the named set Main (2 pages) ==");
  await swEval(async (b) => {
    await chrome.storage.sync.set({
      "snap:Main": { urls: [b + "/alpha", b + "/beta"], splits: [], savedAt: Date.now() },
    });
  }, base);
  await swEval(
    (args) => globalThis.__tpUiCall({ type: "ui:restoreSnapshot", name: "Main", windowId: args.aId }),
    { aId },
  );
  await sleep(5000);
  const afterRestore = { a: await pinsOf(aId), b: await pinsOf(bId), chat: await chatCount() };
  console.log(
    `   after restore: A=${afterRestore.a.length} B=${afterRestore.b.length} chat-pins=${afterRestore.chat}`,
  );

  console.log("\n== 5. junk-shaped cold start: wiped state, session restore brings drifted junk ==");
  // Anchor a regular tab in each window first - a window dies with its last
  // tab, and the wipe below removes every pin.
  await swEval(
    async (args) => {
      for (const wid of [args.aId, args.bId]) {
        await chrome.tabs.create({ windowId: wid, url: args.base + "/anchor", active: false });
      }
    },
    { aId, bId, base },
  );
  await swEval(() => globalThis.__tpWipeState());
  // The previous session "died" with junky strips: close what is open now,
  // then trickle drifted chat pins back in, as Chrome's session restore does.
  await swEval(async () => {
    const pins = await chrome.tabs.query({ pinned: true });
    await Promise.all(pins.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
  });
  for (const [wid, urls] of [
    [aId, ["/chat/u81", "/chat/u82"]],
    [bId, ["/chat/u83", "/chat/u84"]],
  ]) {
    for (const u of urls) {
      await swEval(
        async (args) =>
          chrome.tabs.create({ windowId: args.wid, url: args.base + args.u, pinned: true, active: false }),
        { wid, base, u },
      );
      await sleep(150);
    }
  }

  console.log("   waiting for the cold-start bootstrap to settle...");
  await sleep(14_000); // strip-stability polling + converge
  const settle = async () => ({
    perWindow: await Promise.all((await allWindows()).map(async (wid) => (await pinsOf(wid)).map((u) => u.replace(base, "")))),
    chat: await chatCount(),
  });
  const s1 = await settle();
  await sleep(3000);
  const s2 = await settle();
  console.log(`\nRESULT: chat-pins=${s2.chat} windows=${JSON.stringify(s2.perWindow)}`);

  const convergedToSet = s2.perWindow.every(
    (urls) =>
      urls.length === 2 &&
      urls.every((u) => u.includes("/alpha") || u.includes("/beta")),
  );
  const stable = JSON.stringify(s1) === JSON.stringify(s2);
  if (!convergedToSet || !stable || s2.chat !== 0) {
    console.log(
      `\nFAIL  junk survived the restart or multiplied (converged=${convergedToSet} stable=${stable} chat=${s2.chat})`,
    );
    if (s2.chat > 4) console.log(`      growth: trickled 4 chat pins, now ${s2.chat} - the compound loop`);
    process.exitCode = 1;
  } else {
    console.log("\nPASS  the restored set survived a junk-shaped cold start in every window");
  }
} catch (e) {
  console.error("REPRO ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
