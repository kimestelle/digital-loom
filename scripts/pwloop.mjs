#!/usr/bin/env node
// Playwright driver for eyeballing the cloth scene: boots the app in Chrome
// (channel "chrome" so WebGPU works without a browser download), waits for the
// scene to actually render, runs a named scenario, and captures a timed burst
// of stage screenshots so transitions can be inspected frame by frame.
//
//   node scripts/pwloop.mjs <scenario> [--url=http://localhost:3000/]
//        [--headed] [--out=shots] [--reduced]
//
// Scenarios: boot, mobile, cabinet, light, loupe, weave, sample, rapid, iris
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
const URL_ = opt("url", "http://localhost:3000/");
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
  // Wait for both the persistent specimen renderer and a real archive source.
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

async function showCabinetFace(page, face) {
  const cabinet = page.locator(".material-cabinet");
  if ((await cabinet.getAttribute("data-face")) === face) return;
  await page
    .getByRole("button", {
      name: face === "material" ? "show material dossier" : "show swatch archive",
    })
    .click();
  await cabinet.waitFor({ state: "visible" });
  await page.waitForTimeout(500);
}

const scenarios = {
  // Just boot and take one settled shot.
  boot: async (page) => {
    await shot(page, "settled");
  },

  // Mobile viewport: the archive and dossier share one fixed lower-third
  // cabinet while the specimen keeps the upper two thirds.
  mobile: async (page) => {
    FULLPAGE = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, "archive");
    await showCabinetFace(page, "material");
    await shot(page, "material");
    await showCabinetFace(page, "archive");
    await shot(page, "archive-return");
  },

  // Cabinet reversal: both faces stay mounted while the punched handle keeps
  // a stable position and DOM identity.
  cabinet: async (page) => {
    FULLPAGE = true;
    await shot(page, "archive");
    await page.getByRole("button", { name: "show material dossier" }).click();
    await burst(page, "to-material", 7, 90);
    await page.getByRole("button", { name: "show swatch archive" }).click();
    await burst(page, "to-archive", 7, 90);
  },

  // The Figma mark opens the one-control daylight sheet. Sample the left,
  // high-center, and right positions and their room projections.
  light: async (page) => {
    FULLPAGE = true;
    await page.getByRole("button", { name: "open daylight controls" }).click();
    const slider = page.getByRole("dialog", { name: "daylight path" }).getByRole("slider");
    for (const [label, value] of [["left", "0"], ["high", "0.5"], ["right", "1"]]) {
      await slider.fill(value);
      await page.waitForTimeout(350);
      await shot(page, label);
    }
    await page.keyboard.press("Escape");
  },

  // Renderer-native magnifier: no preview canvas or second scene, just the
  // bounded local inspection pass on the persistent specimen renderer.
  loupe: async (page) => {
    const canvas = (await bigCanvas(page)).asElement();
    if (!canvas) throw new Error("scene canvas not found");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("scene canvas has no bounds");
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await burst(page, "left", 5, 100);
    await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.52, {
      steps: 8,
    });
    await burst(page, "right", 5, 100);
    await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4);
    await shot(page, "released");
  },

  // Change construction twice and capture how the live specimen settles.
  weave: async (page) => {
    await showCabinetFace(page, "material");
    await shot(page, "before");
    await page.locator("button.construction-option:not([data-active='true'])").first().click();
    await burst(page, "tile1", 10, 90);
    await page.locator("button.construction-option:not([data-active='true'])").nth(1).click();
    await burst(page, "tile2", 10, 90);
  },

  // Click the second sample swatch → one uniform specimen fade, gated on the
  // new albedo. Longer burst covers the complete material handoff.
  sample: async (page) => {
    await shot(page, "before");
    await page
      .locator('section[data-dye="gardenia"] .swatch-face')
      .nth(1)
      .click();
    await burst(page, "swap", 18, 100);
  },

  // Hammer several committing intents quickly — the queue must serialize with
  // the newest pending intent winning; no stuck-invisible cloth at the end.
  rapid: async (page) => {
    await showCabinetFace(page, "material");
    await shot(page, "before");
    const tiles = page.locator("button.construction-option");
    for (let i = 0; i < 4; i++) await tiles.nth(i).click({ delay: 40 });
    await showCabinetFace(page, "archive");
    await page
      .locator('section[data-dye="gardenia"] .swatch-face')
      .nth(1)
      .click();
    await burst(page, "storm", 24, 120);
  },

  // Iridescence A/B: measure fps at 0 and at 1 (rAF counter, 2s each), then
  // burst frames across ~10s of sun orbit to catch backlit + grazing looks.
  iris: async (page) => {
    await showCabinetFace(page, "material");
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
    await burst(page, "iris-max", 12, 600);
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
