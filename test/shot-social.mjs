// Build the GitHub social/hero images (1280x640 @2x, 2:1):
//   store/social-preview.png       - light (also the Settings -> Social preview upload)
//   store/social-preview-dark.png  - dark (README hero via <picture>)
// Left: icon, name, tagline. Right: the real popup (English seed), top aligned,
// bottom bleeding off the frame - composed natively for the 2:1 crop so nothing
// important is ever cut.
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

// Each seeded page carries a lettered SVG favicon so the popup rows read like
// real sites instead of a wall of gray globes.
const PAGES = {
  p1: { title: "Perplexity", letter: "P", color: "#20808d" },
  p2: { title: "ChatGPT", letter: "G", color: "#10a37f" },
  p3: { title: "Claude", letter: "C", color: "#d97757" },
  p4: { title: "Notion - Roadmap", letter: "N", color: "#37352f" },
  p5: { title: "Figma - store assets", letter: "F", color: "#a259ff" },
};

const THEMES = {
  light: {
    bg: "linear-gradient(135deg, #f7f9fc 0%, #eef3f9 55%, #e6edf6 100%)",
    name: "#1a1f27",
    h1: "#212835",
    sub: "#5b6472",
    shadow: "0 24px 64px rgba(20, 35, 60, 0.18), 0 4px 16px rgba(20, 35, 60, 0.10)",
    border: "none",
    popupBg: "#ffffff",
  },
  dark: {
    bg: "linear-gradient(135deg, #0f1319 0%, #151b24 55%, #1a222d 100%)",
    name: "#e8eaed",
    h1: "#dfe4ea",
    sub: "#98a2b0",
    shadow: "0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    popupBg: "#292a2d",
  },
};

const server = http.createServer((req, res) => {
  const key = req.url.replace(/\W/g, "");
  const page = PAGES[key];
  if (!page) {
    res.writeHead(404).end();
    return;
  }
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

// Seed: three pinned "AI" tabs, two locked regular tabs, two named sets.
for (const key of Object.keys(PAGES)) {
  const page = await browser.newPage();
  await page.goto(`${base}/${key}`);
}
async function setSettings(patch) {
  await worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({ settings: { ...(settings || {}), ...p } });
  }, patch);
}
await setSettings({ autoLockPinned: true, mirrorPinned: true, autoSnapshot: true, language: "en", theme: "light" });
await worker.evaluate(
  async (b) => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      const m = (t.url || "").match(new RegExp(`^${b}/(p[123])$`));
      if (m) await chrome.tabs.update(t.id, { pinned: true });
    }
  },
  base,
);
await sleep(2500); // let the mirror settle and the auto-snapshot land
await worker.evaluate(
  async (b) => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (/\/(p4|p5)$/.test(t.url || "")) await globalThis.__tpUiCall({ type: "ui:toggle", tabId: t.id });
    }
  },
  base,
);
await worker.evaluate(
  async (b) => {
    const now = Date.now();
    await chrome.storage.sync.set({
      "snap:Main": {
        urls: [1, 2, 3, 4, 5].map((i) => `${b}/main${i}`),
        savedAt: now - 35 * 60e3,
      },
      "snap:Work": { urls: [1, 2, 3].map((i) => `${b}/work${i}`), savedAt: now - 2 * 3600e3 },
    });
  },
  base,
);
await sleep(400);

// Shoot the popup, top part only - the composition crops the rest anyway.
// Readiness is observed, not slept for: the second popup open can race a
// suspending service worker and render empty (ui:getState never resolves) -
// wait for real rows and reload once if they do not come.
async function shootPopup(theme) {
  await setSettings({ theme });
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 900, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const ready = () =>
    page
      .waitForFunction(
        () =>
          document.querySelectorAll("#pinnedList li:not(.muted)").length >= 3 &&
          document.getElementById("lockLabel").textContent.length > 0 &&
          document.querySelectorAll("#snapList .snap").length >= 2,
        { timeout: 5000 },
      )
      .then(() => true, () => false);
  if (!(await ready())) {
    await page.reload();
    if (!(await ready())) throw new Error(`popup (${theme}) never rendered its data`);
  }
  await sleep(300); // favicons settle
  const file = path.join(os.tmpdir(), `truepin-social-popup-${theme}-${process.pid}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  return file;
}

// Compose the 2:1 frame. Images go in as data URIs: file:// subresources do
// not load inside setContent's about:blank context.
const iconUri = dataUri(path.join(EXTENSION_DIR, "icons", "locked-128.png"));
async function composeFrame(theme, popupFile, out) {
  const t = THEMES[theme];
  const compose = await browser.newPage();
  await compose.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await compose.setContent(
    `<!doctype html><html><head><style>
      * { margin: 0; box-sizing: border-box; }
      body {
        width: 1280px; height: 640px; overflow: hidden;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: ${t.bg};
        display: flex; align-items: center;
      }
      .left { flex: 1; padding: 0 64px 0 96px; }
      .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 36px; }
      .brand img { width: 76px; height: 76px; border-radius: 16px; }
      .brand .name { font-size: 58px; font-weight: 650; letter-spacing: -0.5px; color: ${t.name}; }
      h1 { font-size: 40px; line-height: 1.2; font-weight: 600; letter-spacing: -0.3px; color: ${t.h1}; max-width: 560px; }
      .sub { margin-top: 22px; font-size: 21px; line-height: 1.5; color: ${t.sub}; max-width: 540px; }
      .right { flex: none; width: 460px; height: 640px; position: relative; }
      .popup {
        position: absolute; top: 56px; left: 0; width: 400px;
        border-radius: 16px; overflow: hidden;
        border: ${t.border};
        box-shadow: ${t.shadow};
        background: ${t.popupBg};
      }
      .popup img { display: block; width: 100%; }
    </style></head><body>
      <div class="left">
        <div class="brand">
          <img src="${iconUri}" alt="">
          <span class="name">TruePin</span>
        </div>
        <h1>Pinned tabs that can&rsquo;t be closed by accident</h1>
        <p class="sub">Any close is undone instantly. Named sets sync across your devices. Zero network requests.</p>
      </div>
      <div class="right">
        <div class="popup"><img src="${dataUri(popupFile)}" alt=""></div>
      </div>
    </body></html>`,
    { waitUntil: "networkidle0" },
  );
  await sleep(300);
  await compose.screenshot({ path: out });
  await compose.close();
  console.log("saved", out);
}

for (const [theme, file] of [
  ["light", "social-preview.png"],
  ["dark", "social-preview-dark.png"],
]) {
  const popupFile = await shootPopup(theme);
  await composeFrame(theme, popupFile, path.join(OUTDIR, file));
  unlinkSync(popupFile);
}

await browser.close();
server.close();
process.exit(0);
