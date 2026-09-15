#!/usr/bin/env node
/** Compare baked light with the actual live filter inside the real room's
 * clipped, transformed, plus-lighter receivers. No cloth or app-state mocks.
 * Usage: node scripts/verify-room-sunlight-display.mjs --base-url http://localhost:3003
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, webkit } from "playwright";
import sharp from "sharp";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://localhost:3003" },
  browser: { type: "string", default: "webkit" },
  "output-dir": { type: "string", default: resolve(tmpdir(), "loom-sunlight-display-verification") },
} });
const browserType = { chromium, webkit }[values.browser];
if (!browserType) throw new Error("--browser must be chromium or webkit");
const atlas = JSON.parse(readFileSync(new URL("../public/2d-textures/room-sunlight-day.json", import.meta.url), "utf8"));
const output = resolve(values["output-dir"]);
mkdirSync(output, { recursive: true });

async function compare(before, after) {
  const [a, b] = await Promise.all([before, after].map(bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error("Room capture sizes differ");
  let absolute = 0, square = 0, maximum = 0, changed = 0;
  for (let pixel = 0; pixel < a.data.length; pixel += 4) {
    let peak = 0;
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(a.data[pixel + channel] - b.data[pixel + channel]);
      absolute += error; square += error ** 2; peak = Math.max(peak, error);
    }
    maximum = Math.max(maximum, peak);
    if (peak > 8) changed++;
  }
  const count = a.info.width * a.info.height;
  const round = value => Number(value.toFixed(6));
  return { meanAbsoluteRgbByteError: round(absolute / (count * 3)), rootMeanSquareRgbByteError: round(Math.sqrt(square / (count * 3))),
    maximumRgbByteError: maximum, pixelsOverEightBytesFraction: round(changed / count) };
}

const browser = await browserType.launch({ headless: true });
const deadline = setTimeout(() => { void browser.close(); }, 120_000);
try {
  const results = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 832 }]) {
    const deviceScaleFactor = viewport.width <= 820 ? 2 : 1;
    const context = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: "reduce" });
    for (const position of [0.375, 0.438]) {
      const page = await context.newPage();
      await page.goto(`${values["base-url"]}/room/components/preview?component=sunlight`, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      await root.waitFor();
      await page.waitForFunction(() => document.querySelector(".room-frame").dataset.roomSunlightReady === "true");
      await page.getByRole("slider", { name: "time of day", exact: true }).evaluate((input, time) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(time));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, position);
      await page.addStyleTag({ content: ".room-frame *, .room-frame *::before, .room-frame *::after { animation-play-state:paused!important;transition:none!important } nextjs-portal,.workbench-sunlight-tools {visibility:hidden!important}" });
      await page.waitForFunction(expected => {
        const room = document.querySelector(".room-frame");
        const images = [...room.querySelectorAll(".room-frame__sunlight-receiver img")];
        const windowState = room.querySelector(".room-frame__window-vector").dataset.windowBloom;
        return images.length === expected.length * 2 && images.every(image => expected.includes(Number(image.dataset.sunlightFrame))
          && image.complete && image.naturalWidth > 0 && image.dataset.sunlightDisplay === "baked")
          && ["cached", "fallback"].includes(windowState);
      }, position === 0.375 ? [1] : [1, 2]);
      if (viewport.width <= 820) await page.waitForFunction(() => document.querySelector(".room-frame").dataset.roomSurfaceCached === "true");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const basename = `${viewport.width}-${position}`;
      const baked = await root.screenshot({ path: resolve(output, `${basename}-baked.png`), animations: "disabled" });
      await root.evaluate(async (element, frames) => {
        await Promise.all([...element.querySelectorAll(".room-frame__sunlight-receiver img")].map(async image => {
          const index = Number(image.dataset.sunlightFrame);
          const receiver = image.closest(".room-frame__sunlight-receiver").dataset.receiver;
          const prefix = receiver === "floor" ? `--room-bake-${index}` : `--room-wall-bake-${index}`;
          const frame = frames[index];
          image.width = frame.width;
          image.height = frame.height;
          image.style.transform = `translate3d(var(${prefix}-left, 0px), var(${prefix}-top, 0px), 0)`;
          image.style.filter = "var(--room-bake-exposure-filter) blur(4px)";
          image.src = `${frame.image}?v=${frame.checks.pngSha256.slice(0, 12)}`;
          await image.decode();
        }));
      }, atlas.frames);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const live = await root.screenshot({ path: resolve(output, `${basename}-live.png`), animations: "disabled" });
      const result = { viewport, deviceScaleFactor, position, ...(await compare(baked, live)) };
      results.push(result);
      console.log(JSON.stringify(result));
      await page.close();
    }
    await context.close();
  }
  const report = { engine: values.browser, version: browser.version(), results };
  writeFileSync(resolve(output, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (results.some(result => result.meanAbsoluteRgbByteError > 1)) throw new Error("Room comparison exceeded one mean RGB byte; inspect the retained captures");
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  clearTimeout(deadline);
  await browser.close();
}
