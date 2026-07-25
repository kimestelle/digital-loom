#!/usr/bin/env node
// Playwright driver for eyeballing the cloth scene: boots the app in Chrome
// (channel "chrome" so WebGPU works without a browser download), waits for the
// scene to actually render, runs a named scenario, and captures a timed burst
// of stage screenshots so transitions can be inspected frame by frame.
//
//   node scripts/pwloop.mjs <scenario> [--url=http://localhost:3000]
//        [--headed] [--out=shots] [--reduced]
//
// Scenarios: boot, weave, sample, sky, rapid, hoverclick
// Frames land in <out>/<scenario>/frame-NN.png. Console errors and the
// detected render backend are printed to stdout.

import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) ?? "boot";
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const URL_ = opt("url", "http://localhost:3000");
const OUT = path.resolve(opt("out", "shots"), scenario);
const HEADED = args.includes("--headed");
const REDUCED = args.includes("--reduced");

const log = (...a) => console.log("[pwloop]", ...a);

async function bigCanvas(page) {
  // The scene canvas is the only one wider than ~500 CSS px.
  return page.evaluateHandle(() => {
    const all = [...document.querySelectorAll("canvas")];
    return all.find((c) => c.clientWidth > 500) ?? null;
  });
}

async function waitForScene(page, timeoutMs = 90_000) {
  const t0 = Date.now();
  // Sample thumbs registering is the same signal the transfer system keys on.
  await page.waitForSelector('section[data-dye="gardenia"] .swatch-face', {
    timeout: timeoutMs,
  });
  while (Date.now() - t0 < timeoutMs) {
    const ready = await page.evaluate(() => {
      const canvas = [...document.querySelectorAll("canvas")].find(
        (c) => c.clientWidth > 500,
      );
      const thumb = document.querySelector(
        'section[data-dye="gardenia"] .swatch-face img',
      );
      return Boolean(
        canvas && thumb && thumb.complete && thumb.naturalWidth > 0,
      );
    });
    if (ready) break;
    await page.waitForTimeout(500);
  }
  // Backend probe: asking for a context kind the canvas already holds returns
  // it; asking for a different kind returns null.
  const backend = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find(
      (x) => x.clientWidth > 500,
    );
    if (!c) return "no-canvas";
    for (const kind of ["webgpu", "webgl2"]) {
      try {
        if (c.getContext(kind)) return kind;
      } catch {
        /* context kind mismatch throws on some engines */
      }
    }
    return "unknown";
  });
  log(`scene up after ${((Date.now() - t0) / 1000).toFixed(1)}s, backend=${backend}, webgpuAvailable=${await page.evaluate(() => Boolean(navigator.gpu))}`);
  // Let the drape settle + first maps land before poking anything.
  await page.waitForTimeout(3000);
}

let frameNo = 0;
let FULLPAGE = false; // scenarios exercising DOM chrome flip this on
async function shot(page, label) {
  const name = `frame-${String(frameNo++).padStart(2, "0")}-${label}.png`;
  const el = FULLPAGE ? null : (await bigCanvas(page)).asElement();
  if (el) await el.screenshot({ path: path.join(OUT, name) });
  else await page.screenshot({ path: path.join(OUT, name) });
  return name;
}

async function burst(page, label, frames = 14, intervalMs = 100) {
  for (let i = 0; i < frames; i++) {
    await shot(page, `${label}-${i * intervalMs}ms`);
    await page.waitForTimeout(intervalMs);
  }
}

const scenarios = {
  // Just boot and take one settled shot.
  boot: async (page) => {
    await shot(page, "settled");
  },

  // Mobile viewport: tri-tab dock, sheet collapse, no stray labels.
  mobile: async (page) => {
    FULLPAGE = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, "workshop");
    await page.locator(".mobile-nav-tab", { hasText: "my swatches" }).click();
    await page.waitForTimeout(600);
    await shot(page, "swatches");
    await page.locator(".mobile-nav-tab", { hasText: "tuning" }).click();
    await page.waitForTimeout(600);
    await shot(page, "tuning");
    await page.locator(".mobile-nav-tab", { hasText: "tuning" }).click();
    await page.waitForTimeout(600);
    await shot(page, "collapsed");
  },

  // Workshop panel tabs: slide to "my swatches" (frayed stamp masks) and
  // back, catching mid-transition frames.
  tabs: async (page) => {
    FULLPAGE = true;
    await shot(page, "workshop");
    await page.getByRole("tab", { name: "my swatches" }).click();
    await burst(page, "to-swatches", 6, 120);
    await page.waitForTimeout(400);
    await shot(page, "swatches-settled");
    await page.getByRole("tab", { name: "workshop", exact: true }).click();
    await burst(page, "to-workshop", 6, 120);
  },

  // Stamp flight: in the swatches tab, hover then click a swatch and catch
  // the canvas fly-layer mid-flight — the flying copy must keep its frayed
  // stamp silhouette (and the drop caret CSS is exercised via drag in
  // manual testing; grid gaps are visible here).
  stampfly: async (page) => {
    FULLPAGE = true;
    await page.getByRole("tab", { name: "my swatches" }).click();
    await page.waitForTimeout(600);
    const faces = page.locator('section[data-dye="gardenia"] .swatch-face');
    await faces.nth(2).hover();
    await burst(page, "hover-fly", 5, 70);
    await faces.nth(2).click();
    await burst(page, "click-fly", 8, 90);
  },

  // Click a non-active weave tile → expect mesh dissolve out + in (~520ms),
  // then a second tile to confirm repeatability.
  weave: async (page) => {
    await shot(page, "before");
    await page.locator("button.weave-tile:not([data-active='true'])").first().click();
    await burst(page, "tile1", 10, 90);
    await page.locator("button.weave-tile:not([data-active='true'])").nth(1).click();
    await burst(page, "tile2", 10, 90);
  },

  // Click the second sample swatch → canvas fly + mesh dissolve, gated on the
  // new albedo. Longer burst to cover the full flight.
  sample: async (page) => {
    await shot(page, "before");
    await page
      .locator('section[data-dye="gardenia"] .swatch-face')
      .nth(1)
      .click();
    await burst(page, "swap", 18, 100);
  },

  // Sky → black backdrop toggle, then back.
  sky: async (page) => {
    await shot(page, "sky-before");
    await page.getByRole("tab", { name: "black" }).click();
    await page.waitForTimeout(400);
    await shot(page, "black");
    await page.waitForTimeout(400);
    await shot(page, "black-late");
    await page.getByRole("tab", { name: "sky", exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, "sky-after");
  },

  // Hammer several committing intents quickly — the queue must serialize with
  // the newest pending intent winning; no stuck-invisible cloth at the end.
  rapid: async (page) => {
    await shot(page, "before");
    const tiles = page.locator("button.weave-tile");
    for (let i = 0; i < 4; i++) await tiles.nth(i).click({ delay: 40 });
    await page
      .locator('section[data-dye="gardenia"] .swatch-face')
      .nth(1)
      .click();
    await burst(page, "storm", 24, 120);
  },

  // Iridescence A/B: measure fps at 0 and at 1 (rAF counter, 2s each), then
  // burst frames across ~10s of sun orbit to catch backlit + grazing looks.
  iris: async (page) => {
    const setIris = (v) =>
      page.evaluate((val) => {
        const label = [...document.querySelectorAll("label.slider")].find(
          (l) => l.textContent?.includes("iridescence"),
        );
        const input = label?.querySelector("input[type=range]");
        if (!input) throw new Error("iridescence slider not found");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(input, String(val));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, v);
    const measureFps = () =>
      page.evaluate(
        () =>
          new Promise((res) => {
            let n = 0;
            const t0 = performance.now();
            const tick = () => {
              n++;
              const dt = performance.now() - t0;
              if (dt < 2000) requestAnimationFrame(tick);
              else res(Math.round((n / dt) * 1000));
            };
            requestAnimationFrame(tick);
          }),
      );
    await setIris(0);
    await page.waitForTimeout(300);
    log(`fps @ iridescence=0: ${await measureFps()}`);
    await shot(page, "iris-off");
    await setIris(1);
    await page.waitForTimeout(300);
    log(`fps @ iridescence=1: ${await measureFps()}`);
    // Full sun orbit is ~66s; sample the whole lap so the frames catch the
    // sun crossing the narrow 30° FOV (that's when the lens flare fires).
    await burst(page, "iris-max", 22, 3000);
  },

  // Hover a swatch, then click THAT swatch: the parked preview must hand off
  // straight to the mesh reveal — no retreat to the box, no second fly-out.
  hoversame: async (page) => {
    const faces = page.locator('section[data-dye="gardenia"] .swatch-face');
    await faces.nth(1).hover();
    await page.waitForTimeout(500);
    await shot(page, "hover-held");
    await faces.nth(1).click();
    await burst(page, "handoff", 14, 100);
  },

  // Hover a swatch then click another mid-hover: hover preview must yield.
  hoverclick: async (page) => {
    const faces = page.locator('section[data-dye="gardenia"] .swatch-face');
    await faces.nth(2).hover();
    await page.waitForTimeout(250);
    await shot(page, "hovering");
    await faces.nth(1).click();
    await burst(page, "click-during-hover", 16, 100);
  },
};

const run = scenarios[scenario];
if (!run) {
  console.error(`unknown scenario "${scenario}" — one of: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: !HEADED,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: REDUCED ? "reduce" : "no-preference",
});
const page = await context.newPage();
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    problems.push(`[console.${m.type()}] ${m.text()}`);
  }
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

try {
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await waitForScene(page);
  await run(page);
  log(`scenario "${scenario}" done → ${OUT}`);
} finally {
  if (problems.length) {
    log(`${problems.length} console problem(s):`);
    for (const p of problems.slice(0, 20)) console.log("  " + p);
  } else {
    log("console clean");
  }
  await browser.close();
}
