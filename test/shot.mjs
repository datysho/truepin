// Screenshot the popup with real data (for eyeballing the UI).
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUT = process.argv[2] || "/tmp/popup.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, "") || "index";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>${name === "one" ? "Gmail - Входящие" : name === "two" ? "Google Календарь" : "TickTick"}</title></head><body style="height:100vh">x</body></html>`);
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
const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
const worker = await target.worker();

for (const p of ["/one", "/two", "/three"]) {
  const page = await browser.newPage();
  await page.goto(`${base}${p}`);
}
await worker.evaluate(async (b) => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if ((t.url || "").startsWith(b)) await chrome.tabs.update(t.id, { pinned: true });
  }
}, base);
await sleep(2500); // let auto-snapshot land
const winId = await worker.evaluate(async () => (await chrome.windows.getAll())[0].id);
await worker.evaluate((w) => globalThis.__tpUiCall({ type: "ui:saveSnapshot", windowId: w, name: "Работа" }), winId);
await sleep(300);

const extId = new URL(target.url()).host;
const popup = await browser.newPage();
await popup.setViewport({ width: 340, height: 560, deviceScaleFactor: 2 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await sleep(800);
await popup.screenshot({ path: OUT, fullPage: true });
console.log("saved", OUT);
await browser.close();
server.close();
process.exit(0);
