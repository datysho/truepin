// Build the Chrome Web Store promo tiles. The store demands "JPEG or 24-bit PNG
// (no alpha)"; a Puppeteer PNG is always RGBA and reads as "has alpha", so these
// are JPEG (no alpha channel by construction) at high quality.
//   store/promo-small.jpg    - 440x280  (small promo tile)
//   store/promo-marquee.jpg  - 1400x560 (marquee promo tile)
// Small tile: brand + tagline. Marquee: brand + tagline left, the real popup
// right, bottom bleeding off the frame - the same language as the social hero.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUTDIR = process.argv[2] || path.resolve(__dirname, "../store");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

const PAGES = {
  p1: { title: "Perplexity", letter: "P", color: "#20808d" },
  p2: { title: "ChatGPT", letter: "G", color: "#10a37f" },
  p3: { title: "Claude", letter: "C", color: "#d97757" },
  p4: { title: "Notion - Roadmap", letter: "N", color: "#37352f" },
  p5: { title: "Figma - store assets", letter: "F", color: "#a259ff" },
};

// One light palette - promo tiles read best bright and brand-forward.
const T = {
  bg: "linear-gradient(135deg, #f7f9fc 0%, #eef3f9 55%, #e6edf6 100%)",
  name: "#1a1f27",
  h1: "#212835",
  sub: "#5b6472",
  shadow: "0 24px 64px rgba(20, 35, 60, 0.18), 0 4px 16px rgba(20, 35, 60, 0.10)",
  popupBg: "#ffffff",
};

const server = http.createServer((req, res) => {
  const key = req.url.replace(/\W/g, "");
  const page = PAGES[key];
  if (!page) return void res.writeHead(404).end();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${page.color}'/><text x='16' y='22' font-family='system-ui,sans-serif' font-size='18' font-weight='700' fill='#fff' text-anchor='middle'>${page.letter}</text></svg>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><title>${page.title}</title><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}"></head><body style="height:100vh">x</body></html>`,
  );
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

async function setSettings(patch) {
  await worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({ settings: { ...(settings || {}), ...p } });
  }, patch);
}

for (const key of Object.keys(PAGES)) {
  const page = await browser.newPage();
  await page.goto(`${base}/${key}`);
}
await setSettings({ autoLockPinned: true, mirrorPinned: true, autoSnapshot: true, language: "en", theme: "light" });
await worker.evaluate(async (b) => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const m = (t.url || "").match(new RegExp(`^${b}/(p[123])$`));
    if (m) await chrome.tabs.update(t.id, { pinned: true });
  }
}, base);
await sleep(2500);
await worker.evaluate(async (b) => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (/\/(p4|p5)$/.test(t.url || "")) await globalThis.__tpUiCall({ type: "ui:toggle", tabId: t.id });
}, base);
await worker.evaluate((b) => chrome.storage.sync.set({ "snap:Main": { urls: [1, 2, 3, 4, 5].map((i) => `${b}/main${i}`), savedAt: Date.now() - 35 * 60e3 } }), base);
await sleep(400);

async function shootPopup() {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 900, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const ready = () =>
    page
      .waitForFunction(
        () =>
          document.querySelectorAll("#pinnedList li:not(.muted)").length >= 3 &&
          document.querySelectorAll("#snapList .snap").length >= 1,
        { timeout: 5000 },
      )
      .then(() => true, () => false);
  if (!(await ready())) {
    await page.reload();
    if (!(await ready())) throw new Error("popup never rendered its data");
  }
  await sleep(350);
  const file = path.join(os.tmpdir(), `truepin-promo-popup-${process.pid}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

const iconUri = dataUri(path.join(EXTENSION_DIR, "icons", "locked-128.png"));

async function shoot(html, width, height, out) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await sleep(300);
  await page.screenshot({ path: out, type: "jpeg", quality: 95, clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log("saved", out);
}

// Marquee 1400x560: brand + tagline left, popup right (bottom bleeds).
const popupFile = await shootPopup();
await shoot(
  `<!doctype html><html><head><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: 1400px; height: 560px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: ${T.bg}; display: flex; align-items: center; }
    .left { flex: 1; padding: 0 56px 0 92px; }
    .brand { display: flex; align-items: center; gap: 18px; margin-bottom: 28px; }
    .brand img { width: 68px; height: 68px; border-radius: 15px; }
    .brand .name { font-size: 54px; font-weight: 650; letter-spacing: -0.5px; color: ${T.name}; }
    h1 { font-size: 40px; line-height: 1.2; font-weight: 600; letter-spacing: -0.3px; color: ${T.h1}; max-width: 620px; }
    .sub { margin-top: 20px; font-size: 21px; line-height: 1.5; color: ${T.sub}; max-width: 560px; }
    .right { flex: none; width: 500px; height: 560px; position: relative; }
    .popup { position: absolute; top: 52px; left: 0; width: 400px; border-radius: 16px; overflow: hidden; box-shadow: ${T.shadow}; background: ${T.popupBg}; }
    .popup img { display: block; width: 100%; }
  </style></head><body>
    <div class="left">
      <div class="brand"><img src="${iconUri}" alt=""><span class="name">TruePin</span></div>
      <h1>Pinned tabs that can&rsquo;t be closed by accident</h1>
      <p class="sub">Any close is undone instantly. Named sets sync across your devices. Zero network requests.</p>
    </div>
    <div class="right"><div class="popup"><img src="${dataUri(popupFile)}" alt=""></div></div>
  </body></html>`,
  1400,
  560,
  path.join(OUTDIR, "promo-marquee.jpg"),
);
unlinkSync(popupFile);

// Small 440x280: centered brand + tagline (no popup - too small to read).
await shoot(
  `<!doctype html><html><head><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: 440px; height: 280px; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: ${T.bg}; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 30px; }
    .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; }
    .brand img { width: 46px; height: 46px; border-radius: 11px; }
    .brand .name { font-size: 38px; font-weight: 650; letter-spacing: -0.4px; color: ${T.name}; }
    h1 { font-size: 21px; line-height: 1.35; font-weight: 600; letter-spacing: -0.2px; color: ${T.h1}; max-width: 360px; }
  </style></head><body>
    <div class="brand"><img src="${iconUri}" alt=""><span class="name">TruePin</span></div>
    <h1>Pinned tabs that can&rsquo;t be closed by accident</h1>
  </body></html>`,
  440,
  280,
  path.join(OUTDIR, "promo-small.jpg"),
);

await browser.close();
server.close();
process.exit(0);
