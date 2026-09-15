import { expect, test } from "playwright/test";

const FIXTURE = "/room/components/preview?component=sunlight";
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, trace: "off" });

test("bounds mobile background caches, keeps geometry and rebuilds after resize", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(FIXTURE);
  const root = page.locator(".room-frame");
  const surface = root.locator(".room-frame__surface-cache");
  const window = root.locator("[data-room-window-vector]");
  await expect(root).toHaveAttribute("data-room-surface-cached", "true");
  await expect(window).toHaveAttribute("data-window-bloom", "cached");
  await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
  await expect(root.locator(".room-frame__sunlight-bake")).toHaveCSS("filter", "none");
  await expect(window.locator("[data-window-bloom-source]")).toHaveCSS("display", "none");
  await expect(root.locator(".room-frame__planes")).toHaveCSS("visibility", "hidden");
  const dimensions = await surface.evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width }));
  expect(dimensions.width).toBeLessThanOrEqual(585);
  expect(dimensions.cssWidth).toBeCloseTo(390, 0);
  expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(1_500_000);
  const phoneWindow = await window.locator("[data-window-bloom-cache]").getAttribute("href");
  expect(phoneWindow).toMatch(/^blob:/);
  const cacheWidth = Number(await window.locator("[data-window-bloom-cache]").getAttribute("width"));
  expect(cacheWidth).toBeLessThan(await window.evaluate(el => el.getBoundingClientRect().width));

  // Opacity/time changes must not rebuild the window's fixed optical shape.
  await page.getByRole("slider", { name: "time of day", exact: true }).press("Home");
  await expect(window.locator("[data-window-bloom-cache]")).toHaveAttribute("href", phoneWindow!);
  await page.getByRole("button", { name: "return to 09:00", exact: true }).click();
  await expect(root).toHaveAttribute("data-room-surface-cached", "true");

  await page.setViewportSize({ width: 1280, height: 832 });
  await expect(window).toHaveAttribute("data-window-bloom", "cached");
  await expect.poll(() => window.locator("[data-window-bloom-cache]").getAttribute("href")).not.toBe(phoneWindow);
  // A real phone remains coarse in landscape; a desktop-width mouse viewport
  // returns to the original vector path and releases the substrate bitmap.
  const stillMobile = await page.evaluate(() => matchMedia("(max-width: 820px), (hover: none) and (pointer: coarse)").matches);
  if (stillMobile) {
    await expect(root).toHaveAttribute("data-room-surface-cached", "true");
    await expect.poll(() => surface.evaluate(canvas => canvas.getBoundingClientRect().width)).toBeCloseTo(1280, 0);
  } else {
    await expect(root).not.toHaveAttribute("data-room-surface-cached", "true");
    await expect(root.locator(".room-frame__planes")).toHaveCSS("visibility", "visible");
    expect(await surface.evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(root).toHaveAttribute("data-room-surface-cached", "true");
  await expect(window).toHaveAttribute("data-window-bloom", "cached");
  await expect.poll(() => surface.evaluate(canvas => canvas.getBoundingClientRect().width)).toBeCloseTo(390, 0);
  expect(errors).toEqual([]);
});

test("retains the vector substrate when its cache textures cannot load", async ({ page }) => {
  await page.route(/\/2d-textures\/room-(walls|floor)-perspective\.png/, route => route.abort());
  await page.goto(FIXTURE);
  const root = page.locator(".room-frame");
  await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
  await expect(root).not.toHaveAttribute("data-room-surface-cached", "true");
  await expect(root.locator(".room-frame__planes")).toHaveCSS("visibility", "visible");
  await expect(root.locator(".room-frame__surface-cache")).toHaveCSS("display", "none");
});
