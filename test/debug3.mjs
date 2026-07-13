// Reproduce "Unchecked runtime.lastError: No tab with id" on forced closes.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>p</title></head><body style="height:100vh">x</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
  ],
});
const target = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
);
const worker = await target.worker();

// Capture everything the SW logs/throws.
const errors = [];
const session = await target.createCDPSession();
await session.send("Runtime.enable");
await session.send("Log.enable");
session.on("Runtime.exceptionThrown", (e) => {
  const text = e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || "";
  errors.push(`exception: ${text.split("\n")[0]}`);
});
session.on("Log.entryAdded", (e) => {
  errors.push(`log[${e.entry.level}]: ${e.entry.text}`);
});
session.on("Runtime.consoleAPICalled", (e) => {
  if (e.type === "error" || e.type === "warning") {
    errors.push(`console.${e.type}: ${e.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
});

// Two windows with mirroring, then a deliberate close of the original.
const pageA = await browser.newPage();
await pageA.goto(`${base}/a`);
const tabA = await worker.evaluate(async (u) => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || "").includes(u))?.id;
}, "/a");
await worker.evaluate((id) => chrome.tabs.update(id, { pinned: true }), tabA);
await sleep(800);
log("second window...");
await worker.evaluate(async () => (await chrome.windows.create({})).id);
await sleep(1500);

log("activate and force-close the original...");
await pageA.click("body");
await sleep(400);
await pageA.close().catch(() => {});
await sleep(2500);

log("silent close + cooldown double-close of a copy...");
const pageB = await browser.newPage();
await pageB.goto(`${base}/b`);
const tabB = await worker.evaluate(async (u) => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || "").includes(u))?.id;
}, "/b");
await worker.evaluate((id) => chrome.tabs.update(id, { pinned: true }), tabB);
await sleep(1200);
await pageB.close({ runBeforeUnload: true }).catch(() => {});
await sleep(2000);
// double-close the restored one
const restored = await worker.evaluate(async (u) => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || "").includes(u))?.id;
}, "/b");
if (restored) {
  await worker.evaluate((id) => chrome.tabs.remove(id), restored);
}
await sleep(2500);

log("---- captured entries ----");
for (const e of errors) log(e);
log(`total: ${errors.length}`);
await browser.close();
server.close();
process.exit(0);
