// Screenshot popup + options in light and dark, from the real extension.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUTDIR = process.argv[2] || "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, "") || "index";
  const title =
    name === "one" ? "Gmail - Входящие" : name === "two" ? "Google Календарь" : "TickTick";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body style="height:100vh">x</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: true,
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
const extId = new URL(target.url()).host;

async function setTheme(theme) {
  await worker.evaluate(async (th) => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({
      settings: {
        ...(settings || {}),
        autoLockPinned: true,
        showIcon: true,
        mirrorPinned: true,
        autoSnapshot: true,
        language: "ru",
        theme: th,
      },
    });
  }, theme);
}

// Seed: three pinned tabs + a named set + a split set.
for (const p of ["/one", "/two", "/three"]) {
  const page = await browser.newPage();
  await page.goto(`${base}${p}`);
}
await setTheme("auto");
await worker.evaluate(async (b) => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if ((t.url || "").startsWith(b)) await chrome.tabs.update(t.id, { pinned: true });
}, base);
await sleep(2500);
const winId = await worker.evaluate(async () => (await chrome.windows.getAll())[0].id);
await worker.evaluate((w) => globalThis.__tpUiCall({ type: "ui:saveSnapshot", windowId: w, name: "Работа" }), winId);
await worker.evaluate(async (b) => {
  await chrome.storage.sync.set({
    "snap:Аналитика": {
      urls: [`${b}/one`, `${b}/two`],
      titles: ["Gmail", "Календарь"],
      keys: [`${b}/one`, `${b}/two`],
      splits: [[0, 1]],
      savedAt: Date.now() - 3 * 3600e3,
    },
  });
}, base);
await sleep(300);

async function shotPopup(theme, out) {
  await setTheme(theme);
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 680, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(700);
  await page.evaluate(() => {
    const d = document.getElementById("autoDetails");
    if (d) d.open = true;
  });
  await sleep(250);
  await page.screenshot({ path: `${OUTDIR}/popup-${out}.png`, fullPage: true });
  await page.close();
  console.log("saved", `popup-${out}.png`);
}

async function shotOptions(theme, out) {
  await setTheme(theme);
  const page = await browser.newPage();
  await page.setViewport({ width: 680, height: 760, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extId}/options.html`);
  await sleep(700);
  await page.screenshot({ path: `${OUTDIR}/options-${out}.png`, fullPage: true });
  await page.close();
  console.log("saved", `options-${out}.png`);
}

await shotPopup("auto", "light");
await shotPopup("dark", "dark");
await shotOptions("auto", "light");
await shotOptions("dark", "dark");

await browser.close();
server.close();
process.exit(0);
