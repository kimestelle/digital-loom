import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "playwright/test";

// Contract checks with real maps/shaders, not a phone FPS benchmark.
test.use({ trace: "off" });

test("caps mobile rendering without overwriting preferences and keeps touch controls", async ({ page, isMobile }, testInfo) => {
  test.setTimeout(240_000);
  const seed = JSON.parse(await readFile(join(process.cwd(),
    "fabrics/presets/71871d958aa681541baf9159cbf98bc4.json"), "utf8"));
  const errors: string[] = [];
  const activate = (name: string) => {
    const button = page.getByRole("button", { name, exact: true });
    return isMobile ? button.tap() : button.click();
  };
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /shader|webgl|webgpu|renderer|\btsl\b/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) {
      await route.fulfill({ status: 405, json: { error: "read-only test" } });
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
      quality: "hi", meshRes: "hi", iterations: 6, selfCollide: "full",
      anisotropy: 8, autoQuality: true,
    }));
    localStorage.setItem("loom.room.v1", JSON.stringify({ autoDrift: false }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const scene = page.locator(".cloth-scene");
  await expect(scene).toHaveAttribute("data-cloth-launch", "ready", { timeout: 90_000 });
  await expect(scene).toHaveAttribute("data-cloth-compositing", "opaque", { timeout: 90_000 });
  testInfo.annotations.push({ type: "renderer", description: (await scene.getAttribute("data-renderer-backend")) ?? "unknown" });
  await expect(page.locator(".stage")).toHaveAttribute("data-pattern-magnification", "1.5");
  const canvas = scene.locator("canvas").first();
  await expect(scene).toHaveAttribute("data-mesh-cols", "32");
  await expect(scene).toHaveAttribute("data-mesh-rows", "32");
  await expect.poll(() => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return canvas.width / canvas.getBoundingClientRect().width;
  }), { timeout: 90_000 }).toBeCloseTo(0.5, 2);

  await activate("show material dossier");
  const area = page.getByRole("slider", { name: /^open area/ });
  await area.focus();
  await area.press("ArrowRight");
  await expect(scene).toHaveAttribute("data-cloth-compositing", "blended", { timeout: 30_000 });
  await area.press("Home");
  await expect(scene).toHaveAttribute("data-cloth-compositing", "opaque", { timeout: 30_000 });

  await activate("environment controls");
  const env = page.getByRole("region", { name: "environment controls" });
  const time = env.getByRole("slider", { name: "time of day", exact: true });
  await time.focus();
  await time.press("Home");
  await expect(time).toHaveValue("0");
  // Night compiles/runs the sun-shadow early-out while ambient cloth remains.
  await expect(scene).toHaveAttribute("data-cloth-compositing", "opaque");
  await activate("environment controls");
  // Closed/inert content is intentionally absent from the accessibility tree.
  await expect(page.locator("#room-environment-controls")).toHaveAttribute("inert", "");
  await activate("show swatch archive");
  await expect(page.locator(".material-cabinet")).toHaveAttribute("data-face", "archive");
  await page.setViewportSize({ width: 960, height: 720 });
  await expect(page.locator(".stage")).toHaveAttribute("data-pattern-magnification", "1");
  await expect(scene).toHaveAttribute("data-cloth-compositing", "opaque");
  // A landscape phone remains capped even beyond the narrow layout breakpoint.
  await expect(scene).toHaveAttribute("data-mesh-cols", "32");
  await expect.poll(() => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return canvas.width / canvas.getBoundingClientRect().width;
  })).toBeCloseTo(0.5, 2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("loom.perf")!))).toMatchObject({
    quality: "hi", meshRes: "hi", iterations: 6, selfCollide: "full",
    anisotropy: 8, autoQuality: true,
  });
  expect(errors).toEqual([]);
});
