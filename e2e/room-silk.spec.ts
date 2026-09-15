import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { expect, test, type Locator, type Page } from "playwright/test";
import type { LoomMaterialV3 } from "../lib/core/loomMaterial";
import type { MaterialPreset } from "../lib/presets/types";

const SILK_HASH = "71871d958aa681541baf9159cbf98bc4";
const MAPS = ["albedo", "normal", "roughness", "height"];

// Trace snapshots repeatedly read back this live GPU canvas and can dominate
// software WebGL. Keep deliberate optical captures, not per-action tracing.
test.use({ trace: "off", viewport: { width: 960, height: 720 } });

async function installIsolatedSilk(page: Page) {
  const seed = JSON.parse(await readFile(join(process.cwd(),
    "fabrics/presets", `${SILK_HASH}.json`), "utf8")) as MaterialPreset;
  const attemptedWrites: string[] = [];
  const errors: string[] = [];
  const loadedMaps = new Set<string>();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /shader|webgl|webgpu|renderer|\btsl\b/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("response", response => {
    const name = new URL(response.url()).pathname.match(/\/pregen\/silk-sample\/(\w+)\.png$/)?.[1];
    if (name && response.ok()) loadedMaps.add(name);
  });
  // Retain the actual committed seed and full-resolution map assets. Only
  // the unrelated library listings are isolated; no 1px renderer stand-ins.
  // All server writes are rejected even if a regression introduces one.
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) {
      attemptedWrites.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 405, json: { error: "read-only regression fixture" } });
    } else if (path === "/api/presets") {
      await route.fulfill({ json: { presets: [seed] } });
    } else if (path === "/api/cache") {
      await route.fulfill({ json: { entries: [] } });
    } else if (path === "/api/samples") {
      await route.fulfill({ json: { samples: [] } });
    } else {
      await route.continue();
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("loom.perf", JSON.stringify({
      quality: "lo", meshRes: "lo", iterations: 1, selfCollide: "off",
      anisotropy: 2, autoQuality: false,
    }));
    localStorage.setItem("loom.room.v1", JSON.stringify({ autoDrift: false }));
  });
  return { seed, attemptedWrites, errors, loadedMaps };
}

async function exportCurrentMaterial(page: Page): Promise<LoomMaterialV3> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "export material ⤓", exact: true }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  const zip = await JSZip.loadAsync(await readFile(path!));
  const documentFiles = zip.file(/(?:^|\/)material\.json$/);
  expect(documentFiles).toHaveLength(1);
  const document = JSON.parse(await documentFiles[0].async("string")) as LoomMaterialV3;
  expect(Object.keys(document.maps).sort()).toEqual([...MAPS].sort());
  return document;
}

async function setClock(time: Locator, value: number) {
  await time.evaluate((element, position) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(position));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(time).toHaveValue(String(value));
}

async function localPresets(page: Page): Promise<MaterialPreset[]> {
  return page.evaluate(() => new Promise<MaterialPreset[]>((resolve, reject) => {
    const request = indexedDB.open("loom-map-cache");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("presets", "readonly");
      const rows = transaction.objectStore("presets").getAll();
      rows.onsuccess = () => resolve(rows.result as MaterialPreset[]);
      rows.onerror = () => reject(rows.error);
      transaction.oncomplete = () => db.close();
    };
  }));
}

test("cheap cloth shadow stays bounded across lighting, mode, and mobile resize", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await installIsolatedSilk(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const shadow = page.locator("[data-room-cloth-shadow]");
  await expect(page.locator(".cloth-scene")).toHaveAttribute("data-cloth-launch", "ready", { timeout: 90_000 });
  await expect(shadow).toHaveAttribute("width", "256");
  await expect(shadow).toHaveAttribute("height", "128");
  await expect.poll(() => shadow.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.1);
  // A mocked context could pass the painter unit tests while an off-canvas
  // blur was clipped in a real browser. Verify the actual tiny alpha plate.
  const alpha = await shadow.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, 256, 128).data;
    let filled = 0;
    let soft = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) filled++;
      if (pixels[index] > 0 && pixels[index] < 255) soft++;
    }
    return { filled, soft, corner: pixels[3] };
  });
  expect(alpha.filled).toBeGreaterThan(1000);
  expect(alpha.soft).toBeGreaterThan(100);
  expect(alpha.corner).toBeLessThan(10);

  await page.getByRole("button", { name: "environment controls", exact: true }).click();
  const panel = page.getByRole("region", { name: "environment controls" });
  await setClock(panel.getByRole("slider", { name: "time of day", exact: true }), 0);
  await expect.poll(() => shadow.evaluate(element => Number(getComputedStyle(element).opacity))).toBeCloseTo(0.1, 2);
  const mesh = panel.getByRole("switch", { name: "mesh preview" });
  await mesh.check();
  // The first mesh transition compiles a different material on software GL.
  await expect.poll(() => shadow.evaluate(element => Number(getComputedStyle(element).opacity)), { timeout: 30_000 }).toBe(0);
  await mesh.uncheck();
  await expect.poll(() => shadow.evaluate(element => Number(getComputedStyle(element).opacity)), { timeout: 30_000 }).toBeCloseTo(0.1, 2);
  await page.getByRole("button", { name: "environment controls", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator(".room-frame__planes").evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(844 * 0.8, 1);
  await expect.poll(() => shadow.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top < 844 * 2 / 3 && rect.right > 0 && rect.left < 390;
  })).toBe(true);
  await expect(shadow).toHaveAttribute("width", "256");
  await expect(shadow).toHaveAttribute("height", "128");
  expect(fixture.attemptedWrites).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("room silk keeps coverage opaque, retains backlighting through openness edits, and renders across the clock", async ({ page }, testInfo) => {
  test.slow();
  const fixture = await installIsolatedSilk(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const scene = page.locator(".cloth-scene");
  const canvas = scene.locator("canvas").first();
  await expect(scene).toHaveAttribute("data-cloth-launch", "ready", { timeout: 90_000 });
  await expect.poll(() => [...fixture.loadedMaps].sort()).toEqual([...MAPS].sort());
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("button", { name: "red silk", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "show material dossier" }).click();
  await expect(page.locator(".cabinet-material-header h2")).toHaveText("red silk");

  const baseline = await exportCurrentMaterial(page);
  expect(baseline.authored.knobs).toMatchObject({
    openness: 0, translucency: 0.48, densityAmount: 0.76,
    alphaFromDensity: 0, alphaBoost: 0,
  });
  // Source data remains historical; the room adapts the effective material
  // before render/export rather than silently rewriting the shared preset.
  expect(fixture.seed.knobs.alphaFromDensity).toBe(0.048);

  const openArea = page.locator('aside[aria-label="material dossier"]')
    .getByRole("slider", { name: /^open area/ });
  await expect(openArea).toHaveValue("0");
  await openArea.focus();
  await openArea.press("ArrowRight");
  await expect.poll(async () => Number(await openArea.inputValue())).toBeCloseTo(1, 10);
  await openArea.press("Home");
  await expect(openArea).toHaveValue("0");
  const shelf = page.locator(".material-edit-shelf");
  // Undo history can keep the shelf open even when the current value equals
  // its baseline. Clean state is its status and disabled save, not geometry.
  await expect(shelf.getByRole("status")).toHaveText("original unchanged");
  await expect(shelf.getByRole("button", { name: "save as new swatch" })).toBeDisabled();
  const roundTrip = await exportCurrentMaterial(page);
  expect(roundTrip.authored.knobs).toEqual(baseline.authored.knobs);

  // A separate deliberate coverage edit, not backlight/density drift from
  // the 0→1→0 round-trip, supplies the new branch for persistence testing.
  await openArea.focus();
  await openArea.press("ArrowRight");
  await expect.poll(async () => Number(await openArea.inputValue())).toBeCloseTo(1, 10);
  await expect(shelf).toHaveAttribute("data-open", "true");
  await shelf.getByRole("button", { name: "save as new swatch" }).click();
  await expect(shelf.getByRole("status")).toHaveText("saved to swatch archive");
  const savedName = (await page.locator(".cabinet-material-header h2").textContent())!.trim();
  const saved = (await localPresets(page)).find(preset => preset.name === savedName);
  expect(saved?.slug).not.toBe(SILK_HASH);
  expect(saved?.knobs).toMatchObject({
    translucency: 0.48, densityAmount: 0.76, alphaBoost: 0,
  });
  expect(saved?.knobs.openness).toBeCloseTo(Math.cbrt(0.01), 10);
  expect(saved?.knobs.alphaFromDensity).toBeCloseTo(0.001, 10);

  // Reopen the actual persisted branch through the archive, then export the
  // live material again. Checking IndexedDB alone would miss hydration loss.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: savedName, exact: true }).click();
  await expect(page.getByRole("button", { name: savedName, exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "show material dossier" }).click();
  await expect(page.locator(".cabinet-material-header h2")).toHaveText(savedName);
  const reopened = await exportCurrentMaterial(page);
  expect(reopened.authored.knobs).toEqual(saved!.knobs);

  await page.getByRole("button", { name: "environment controls" }).click();
  const time = page.getByRole("region", { name: "environment controls" })
    .getByRole("slider", { name: "time of day", exact: true });
  // These are real renderer captures with the same loaded shader/maps. No
  // pixel-perfect baseline: GPU implementations and cloth settling differ.
  for (const [name, position] of [["morning", 0.375], ["dusk", 0.75], ["night", 0.95]] as const) {
    await setClock(time, position);
    await expect(page.locator(".room-frame")).toHaveAttribute("data-room-light-position", String(position));
    await expect(scene).toHaveAttribute("data-cloth-launch", "ready");
    await testInfo.attach(`silk-${name}`, { body: await canvas.screenshot(), contentType: "image/png" });
    expect(fixture.errors).toEqual([]);
  }
  expect(fixture.attemptedWrites).toEqual([]);
});

test("original route retains the historical silk material values", async ({ page }) => {
  test.slow();
  const fixture = await installIsolatedSilk(page);
  await page.goto("/sky", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "red silk", exact: true })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await page.getByRole("tab", { name: "workshop", exact: true }).click();
  const material = await exportCurrentMaterial(page);
  expect(material.authored.knobs).toMatchObject({
    openness: 0, translucency: 0.48, densityAmount: 0.76,
    alphaFromDensity: 0.048, alphaBoost: 0,
  });
  expect(fixture.attemptedWrites).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
