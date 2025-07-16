// Screenshot a page of the game in headless Chrome. On macOS it renders on
// the real GPU (ANGLE/Metal); elsewhere it falls back to SwiftShader, which
// is fine for layout but hides GPU-only bugs such as NaN pixels.
//
//   node dev/shot.mjs <url-path> <out.png> [width] [height] [waitMs]
//
// Expects a static server on http://localhost:8123 serving the repo root,
// e.g. `python3 -m http.server 8123`. Playwright is not a dependency of the
// game: copy this file next to a node_modules that has it and run it there.
import { chromium } from "playwright";

const [path = "dev/scene.html?scene=neon", out = "shot.png", w = "1440", h = "900", wait = "4000"] =
  process.argv.slice(2);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    ...(process.platform === "darwin"
      ? ["--use-angle=metal", "--enable-gpu"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(m.type() + ": " + m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://localhost:8123/" + path, { waitUntil: "load" });
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
const fps = await page.evaluate(() => {
  const s = window.__stage;
  return s ? { quality: s.quality, prScale: s.prScale, bloom: s.bloom.enabled } : null;
});
console.log(JSON.stringify({ out, fps, errors: errors.slice(0, 20) }, null, 1));
await browser.close();
