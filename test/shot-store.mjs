// Build the Chrome Web Store listing screenshots (exactly 1280x800, the legal
// size), rendered from the real extension:
//   store/screenshots/store-popup-{light,dark}.png
//   store/screenshots/store-options-{light,dark}.png
// Each is a headline + subtitle over a gradient with the real popup / options
// centered below. The inner shot is captured at 2x and placed at 1x CSS width,
// so the composite is a crisp 1280x800 (no 2x - the store rejects other sizes).
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(__dirname, "../extension");
const OUTDIR = process.argv[2] || path.resolve(__dirname, "../store/screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

// Lettered SVG favicons so the popup rows read like real sites, not gray globes.
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
    h1: "#212835",
    sub: "#5b6472",
    shadow: "0 24px 64px rgba(20, 35, 60, 0.18), 0 4px 16px rgba(20, 35, 60, 0.10)",
    border: "none",
    cardBg: "#ffffff",
  },
  dark: {
    bg: "linear-gradient(135deg, #0f1319 0%, #151b24 55%, #1a222d 100%)",
    h1: "#dfe4ea",
    sub: "#98a2b0",
    shadow: "0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    cardBg: "#292a2d",
  },
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

// Seed: three pinned "AI" tabs, two locked regular tabs, one named set - the
// same shape as the reference listing shot.
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
await sleep(2500); // mirror settles, auto-snapshot lands
await worker.evaluate(async (b) => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (/\/(p4|p5)$/.test(t.url || "")) await globalThis.__tpUiCall({ type: "ui:toggle", tabId: t.id });
  }
}, base);
await worker.evaluate(async (b) => {
  await chrome.storage.sync.set({
    "snap:Main": { urls: [1, 2, 3, 4, 5].map((i) => `${b}/main${i}`), savedAt: Date.now() - 35 * 60e3 },
  });
}, base);
await sleep(400);

async function shootRaw(url, width, tallReady, clipSel) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
  await page.goto(url);
  const ready = () => page.waitForFunction(tallReady, { timeout: 5000 }).then(() => true, () => false);
  if (!(await ready())) {
    await page.reload();
    if (!(await ready())) throw new Error(`${url} never rendered its data`);
  }
  await sleep(350); // favicons / fonts settle
  const file = path.join(os.tmpdir(), `truepin-store-${Math.abs(hash(url))}-${process.pid}.png`);
  // The popup's flex body is capped at 600 with an internal scroll; in a plain
  // tab (not a real action popup) that leaves trailing empty space below the
  // footer, which fullPage would capture. Clip to the real content box instead -
  // body width by the footer's bottom - so the shot is tight.
  if (clipSel) {
    const box = await page.evaluate((sel) => {
      const w = Math.ceil(document.body.getBoundingClientRect().width);
      const el = document.querySelector(sel);
      return { w, h: Math.ceil(el.getBoundingClientRect().bottom) };
    }, clipSel);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: box.w, height: box.h } });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }
  await page.close();
  return file;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// PNG intrinsic size (IHDR: width @16, height @20, big-endian).
function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// Compose the 1280x800 frame at 1x (the store's exact required size). The inner
// shot was captured at 2x and placed at a CSS width chosen so the WHOLE shot
// fits under the headline - the options page grew past the old fixed width, so
// the card scales to the frame instead of bleeding off it. Placed at a fixed
// top so the headline gap is constant whatever the copy wraps to.
const CARD_TOP = 172;
const BOTTOM_MARGIN = 24;
const AVAIL_H = 800 - CARD_TOP - BOTTOM_MARGIN;
async function compose(theme, contentFile, { headline, sub, maxWidth }, out) {
  const t = THEMES[theme];
  const { w: rawW, h: rawH } = pngSize(contentFile);
  const cardWidth = Math.min(maxWidth, Math.floor((AVAIL_H * rawW) / rawH));
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>
      * { margin: 0; box-sizing: border-box; }
      body {
        position: relative; width: 1280px; height: 800px; overflow: hidden;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: ${t.bg};
      }
      .head { position: absolute; top: 50px; left: 0; right: 0; text-align: center; padding: 0 48px; }
      h1 { font-size: 40px; line-height: 1.2; font-weight: 700; letter-spacing: -0.3px; color: ${t.h1}; }
      .sub { margin-top: 14px; font-size: 21px; line-height: 1.5; color: ${t.sub}; }
      .card {
        position: absolute; top: ${CARD_TOP}px; left: 50%; transform: translateX(-50%);
        width: ${cardWidth}px;
        border-radius: 16px; overflow: hidden;
        border: ${t.border}; box-shadow: ${t.shadow}; background: ${t.cardBg};
      }
      .card img { display: block; width: 100%; }
    </style></head><body>
      <div class="head"><h1>${headline}</h1><p class="sub">${sub}</p></div>
      <div class="card"><img src="${dataUri(contentFile)}" alt=""></div>
    </body></html>`,
    { waitUntil: "networkidle0" },
  );
  await sleep(300);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1280, height: 800 } });
  await page.close();
  console.log("saved", out, `(card ${cardWidth}px)`);
}

const POPUP_READY = () =>
  document.querySelectorAll("#pinnedList li:not(.muted)").length >= 3 &&
  document.querySelectorAll("#snapList .snap").length >= 1;
const OPTIONS_READY = () => !!document.getElementById("autoLockPinned");

const COPY = {
  popup: {
    headline: "Pinned tabs that can&rsquo;t be closed by accident",
    sub: "Any close is instantly undone. Save named sets and restore them in one click &ndash; synced across your devices.",
    maxWidth: 344,
  },
  options: {
    headline: "Every behaviour is a switch",
    sub: "Auto-protect, mirroring, autosaves, notifications &ndash; light, dark and 8 languages.",
    maxWidth: 600,
  },
};

for (const theme of ["light", "dark"]) {
  await setSettings({ theme });
  const popup = await shootRaw(`chrome-extension://${extId}/popup.html`, 360, POPUP_READY, "footer.action-bar");
  await compose(theme, popup, COPY.popup, path.join(OUTDIR, `store-popup-${theme}.png`));
  unlinkSync(popup);

  const options = await shootRaw(`chrome-extension://${extId}/options.html`, 680, OPTIONS_READY);
  await compose(theme, options, COPY.options, path.join(OUTDIR, `store-options-${theme}.png`));
  unlinkSync(options);
}

await browser.close();
server.close();
process.exit(0);
