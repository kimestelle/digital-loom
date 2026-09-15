#!/usr/bin/env node
/** Rasterize the actual display filter, not an approximation of its optics.
 * Original transport maps are hash-verified and never overwritten.
 * Usage: node scripts/bake-room-sunlight-display.mjs [--browser chromium|webkit]
 *        [--output-dir /absolute/path] [--verify-only]
 * Regenerate with the recorded browser version for byte-reproducible output.
 * --verify-only compares in the generating engine. For cross-engine visual
 * verification, use verify-room-sunlight-display.mjs: actual projective crops
 * are a better oracle than a tiny-scale synthetic browser-filter comparison.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { ROOM_SUNLIGHT_DISPLAY_SETTINGS, roomSunlightFilterMarkup } from "../lib/ui/roomSunlightFilter.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  browser: { type: "string", default: "chromium" },
  "output-dir": { type: "string", default: resolve(repository, "public/2d-textures") },
  "verify-only": { type: "boolean", default: false },
} });
const browserType = { chromium, webkit }[values.browser];
if (!browserType) throw new Error("--browser must be chromium or webkit");
const output = resolve(values["output-dir"]);
const atlas = JSON.parse(readFileSync(resolve(repository, "public/2d-textures/room-sunlight-day.json"), "utf8"));
const settings = ROOM_SUNLIGHT_DISPLAY_SETTINGS;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const uri = bytes => `data:image/png;base64,${bytes.toString("base64")}`;
const filterMarkup = roomSunlightFilterMarkup("room-display-bake", settings.bloom);
const manifestPath = resolve(output, "room-sunlight-display-day.json");

// Compare premultiplied pixels: transparent RGB bytes do not affect display.
async function difference(left, right) {
  const [a, b] = await Promise.all([left, right].map(bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error("Comparison dimensions differ");
  let absolute = 0, maximum = 0, square = 0, changedPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelMaximum = 0;
    for (let c = 0; c < 4; c++) {
      const av = c === 3 ? a.data[i + c] : a.data[i + c] * a.data[i + 3] / 255;
      const bv = c === 3 ? b.data[i + c] : b.data[i + c] * b.data[i + 3] / 255;
      const error = Math.abs(av - bv);
      absolute += error; square += error * error;
      maximum = Math.max(maximum, error); pixelMaximum = Math.max(pixelMaximum, error);
    }
    if (pixelMaximum > 1) changedPixels++;
  }
  const round = value => Number(value.toFixed(5));
  return { meanAbsoluteByteError: round(absolute / a.data.length), rootMeanSquareByteError: round(Math.sqrt(square / a.data.length)),
    maximumByteError: round(maximum), pixelsOverOneByteFraction: round(changedPixels / (a.data.length / 4)) };
}

const browser = await browserType.launch({ headless: true });
const deadline = setTimeout(() => { void browser.close(); }, 120_000);
try {
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1280, height: 768 } });
  const page = await context.newPage();
  const frames = [];
  if (!values["verify-only"]) mkdirSync(output, { recursive: true });
  async function render({ frame, source, display, scale = 1 }) {
    const width = Math.ceil(frame.width * scale) + settings.workingPaddingPx * 2;
    const height = Math.ceil(frame.height * scale) + settings.workingPaddingPx * 2;
    await page.setViewportSize({ width, height });
    await page.setContent(`<style>html,body{margin:0;background:transparent;overflow:hidden}#plate{position:absolute;left:${settings.workingPaddingPx}px;top:${settings.workingPaddingPx}px;transform-origin:0 0;transform:scale(${scale});width:${frame.width}px;height:${frame.height}px}#crop{position:absolute;left:0;top:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden}img{position:absolute;left:0;top:0;max-width:none}</style>
      <svg width="0" height="0" style="position:absolute"><defs>${filterMarkup}</defs></svg>
      <div id="plate"><div id="crop">${display
        ? `<img src="${uri(display)}" width="${frame.width}" height="${frame.height}">`
        : `<img src="${uri(source)}" width="${frame.width}" height="${frame.height}" style="filter:url(#room-display-bake) blur(${settings.edgeBlurPx}px)">`}</div></div>`);
    await page.locator("img").evaluate(image => image.decode());
    // The real plate clips to a subset of original source bounds. Keep the
    // full filter working extent, but ship no invisible exterior padding.
    return page.screenshot({ omitBackground: true, animations: "disabled", clip: {
      x: settings.workingPaddingPx, y: settings.workingPaddingPx,
      width: frame.width * scale, height: frame.height * scale,
    } });
  }
  for (const frame of atlas.frames) {
    const source = readFileSync(resolve(repository, "public", frame.image.slice(1)));
    if (digest(source) !== frame.checks.pngSha256) throw new Error(`Unreviewed source change: ${frame.image}`);
    const name = frame.image.split("/").at(-1).replace("room-sunlight-", "room-sunlight-display-");
    const path = resolve(output, name);
    const bytes = values["verify-only"] ? readFileSync(path) : await render({ frame, source });
    const repeat = await render({ frame, source });
    const validation = [{ scale: 1, ...(await difference(repeat, bytes)) }];
    for (const scale of [0.6, 0.35]) {
      const live = await render({ frame, source, scale });
      const baked = await render({ frame, display: bytes, scale });
      validation.push({ scale, ...(await difference(live, baked)) });
    }
    // Quantization/resampling can differ when browser filters are evaluated
    // after scale. A >1-byte mean error fails the numeric comparison gate.
    if (validation.some(check => check.meanAbsoluteByteError > 1)) throw new Error(`${name}: display comparison exceeded one mean byte: ${JSON.stringify(validation)}`);
    if (!values["verify-only"]) writeFileSync(path, bytes);
    frames.push({ originalImage: frame.image, image: `/2d-textures/${name}`, pathPosition: frame.pathPosition,
      width: frame.width, height: frame.height, offsetX: 0, offsetY: 0,
      checks: { originalPngSha256: digest(source), pngSha256: digest(bytes), bytes: bytes.length, validation } });
    console.log(JSON.stringify({ image: name, bytes: bytes.length, validation }));
  }
  const manifest = { schemaVersion: 1, settings, renderer: { engine: values.browser, version: browser.version(), deviceScaleFactor: 1 },
    filterSha256: digest(filterMarkup), frames };
  if (!values["verify-only"]) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ verified: true, originalImagesPreserved: true, totalPngBytes: frames.reduce((sum, frame) => sum + frame.checks.bytes, 0), manifest: manifestPath }));
} finally {
  clearTimeout(deadline);
  await browser.close();
}
