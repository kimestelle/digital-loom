import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "playwright/test";

// Contract checks, not a phone FPS benchmark. Exercise real maps/shaders at hi
// fragment resolution, with a small simulation so software CI can compile.
test.use({ trace: "off" });

test("keeps hi pixels, responsive pattern scale, coverage switching and mobile controls", async ({ page, isMobile }, testInfo) => {
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
      quality: "hi", meshRes: "lo", iterations: 1, selfCollide: "off",
      anisotropy: 2, autoQuality: false,
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
  // Headless Chromium may compile the hi POM shader through software GL after
  // the first frame has published its coverage flag. Allow that one-time work.
  await expect.poll(() => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    return canvas.width / canvas.getBoundingClientRect().width;
  }), { timeout: 90_000 }).toBe(2);

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
  expect(errors).toEqual([]);
});
