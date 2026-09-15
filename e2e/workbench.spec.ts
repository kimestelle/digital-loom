import { expect, test } from "playwright/test";
import { COMPONENTS } from "../lib/ui/workbench/catalog";

for (const width of [1280, 390]) {
  test(`view swatch slides the shelf down during the ${width}px flip`, async ({ page }) => {
    await page.setViewportSize({ width, height: 832 });
    await page.goto("/room/components/preview?component=changes");
    await page.getByRole("slider", { name: /^sheen/ }).press("ArrowRight");
    const shelf = page.locator(".material-edit-shelf");
    await shelf.getByRole("button", { name: "save as new swatch" }).click();
    await expect(shelf).toHaveAttribute("data-saved", "true");
    const track = page.locator(".material-cabinet__track");
    // Let the shelf's opening finish before capturing its closed-to-open range.
    await shelf.evaluate(async element => {
      await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
    });
    const before = await shelf.boundingBox();
    // Freeze both real transitions at 0: clicking must not jump to full height.
    await track.evaluate(element => {
      element.addEventListener("transitionrun", event => {
        const transition = event as TransitionEvent;
        if (transition.target !== element || transition.propertyName !== "transform") return;
        element.closest(".material-cabinet")!.getAnimations({ subtree: true }).forEach(animation => {
          animation.pause();
          animation.currentTime = 0;
        });
        element.setAttribute("data-test-paused", "true");
      }, { once: true });
    });
    await shelf.getByRole("button", { name: "view swatch" }).click();
    await expect(track).toHaveAttribute("data-test-paused", "true");
    await expect(shelf).toHaveAttribute("data-saved", "true");
    await expect(shelf).toHaveAttribute("data-open", "false");
    expect(Math.abs((await shelf.boundingBox())!.height - before!.height)).toBeLessThan(2);
    const timing = await track.evaluate(element => {
      const shelf = element.closest(".material-cabinet")!.querySelector(".material-edit-shelf")!;
      return [element, shelf].map(node => {
        const style = getComputedStyle(node);
        return [style.transitionDuration, style.transitionTimingFunction];
      });
    });
    expect(timing[0]).toEqual(timing[1]);
    await track.evaluate(element => element.closest(".material-cabinet")!.getAnimations({ subtree: true }).forEach(animation => {
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    }));
    const midway = await shelf.boundingBox();
    expect(midway!.y).toBeGreaterThan(before!.y + 1);
    expect(midway!.height).toBeGreaterThan(0);
    expect(midway!.height).toBeLessThan(before!.height - 1);
    await track.evaluate(element => element.closest(".material-cabinet")!.getAnimations({ subtree: true }).forEach(animation => animation.play()));
    await expect(shelf).toHaveAttribute("data-saved", "false");
    await expect.poll(async () => (await shelf.boundingBox())!.height).toBeLessThan(1);
    await expect(page.locator(".material-cabinet")).toHaveAttribute("data-face", "archive");
    await expect(page.getByRole("button", { name: "show material dossier" })).toBeFocused();
  });
}

test("panel switch keeps its white tab and only rounds the bottom-left corner", async ({ page }) => {
  await page.goto("/room/components/preview?component=changes");
  const button = page.locator(".material-cabinet__flip");
  await expect(button.locator("svg").first()).toHaveCSS("width", "24px");
  await expect(button).toHaveCSS("background-color", "rgba(255, 255, 255, 0.82)");
  await expect(button).toHaveCSS("border-radius", "0px 0px 0px 12px");
  await expect(button).toHaveCSS("border-top-width", "0px");
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgba(255, 255, 255, 0.96)");
  await page.mouse.down();
  await expect(button).toHaveCSS("background-color", "rgba(255, 255, 255, 0.7)");
  await page.mouse.up();
  await expect(button).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("background-color", "rgba(255, 255, 255, 0.82)");
  await expect(button).toHaveCSS("border-radius", "0px 0px 0px 12px");
});

test("view swatch completes with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/room/components/preview?component=changes");
  await page.getByRole("slider", { name: /^sheen/ }).press("ArrowRight");
  const shelf = page.locator(".material-edit-shelf");
  await shelf.getByRole("button", { name: "save as new swatch" }).click();
  await shelf.getByRole("button", { name: "view swatch" }).click();
  await expect(shelf).toHaveAttribute("data-open", "false");
  await expect(page.locator('[data-cabinet-face="archive"]')).toHaveAttribute("data-active", "true");
});

test("edit shelf lifts the dotted panel edge and sits below it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto("/room/components/preview?component=changes");
  const guide = page.locator(".material-cabinet__baseline");
  const shelf = page.locator(".material-edit-shelf");
  const before = await guide.boundingBox();
  await page.getByRole("slider", { name: /^sheen/ }).press("ArrowRight");
  await expect(shelf).toHaveAttribute("data-open", "true");
  await expect.poll(async () => {
    const line = await guide.boundingBox();
    const actions = await shelf.boundingBox();
    const panel = await page.locator(".material-cabinet__track").boundingBox();
    return Boolean(line && actions && panel && before &&
      line.y < before.y - 60 &&
      Math.abs(line.y - panel.y - panel.height) < 2 &&
      Math.abs(actions.y - line.y - line.height) < 2);
  }).toBe(true);
  await expect(guide.locator("line")).toHaveCSS("stroke", "rgb(255, 255, 255)");
  await shelf.getByRole("button", { name: "reset changes" }).click();
  await expect(shelf).toHaveAttribute("data-open", "false");
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch sizing" : "mouse sizing", () => {
    test.use({ hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 832 } });
    test("compact cycle indicator keeps a full hit target and keyboard focus", async ({ page }) => {
      await page.goto("/room/components/preview?component=environment");
      const toggle = page.getByRole("switch", { name: "day / night cycle", exact: true });
      const indicator = page.locator(".room-light-modal__switch-indicator");
      await expect(indicator).toHaveCSS("width", "16px");
      await expect(indicator).toHaveCSS("height", "16px");
      await expect(toggle).toHaveCSS("width", "44px");
      await expect(toggle).toHaveCSS("height", "44px");
      const checked = await toggle.isChecked();
      // Click outside the painted 16px square, inside its native hit area.
      if (touch) await toggle.tap({ position: { x: 3, y: 3 } });
      else await toggle.click({ position: { x: 3, y: 3 } });
      await expect(toggle).toBeChecked({ checked: !checked });
      await toggle.focus();
      await toggle.press("Space");
      await expect(toggle).toBeChecked({ checked });
      await expect(indicator).toHaveCSS("outline-style", "dotted");
      await page.getByText("day / night cycle", { exact: true }).click();
      await expect(toggle).toBeChecked({ checked: !checked });
    });
  });
}

test("every specimen mounts without loading the cloth renderer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const component of COMPONENTS) {
    await page.goto(`/room/components/preview?component=${component.id}`);
    await expect(page.locator(".workbench-preview-document")).toBeVisible();
    await expect(page.locator("canvas[data-engine]")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("isolates component drafts, restores them, and keeps real interactions working", async ({ page }) => {
  await page.goto("/room/components");
  await expect(page.getByRole("heading", { name: "One piece at a time." })).toBeVisible();
  const preview = page.frameLocator("iframe");
  const logo = preview.getByRole("button", { name: "environment controls", exact: true });
  await expect(logo).toHaveCSS("height", "44px");
  await page.getByRole("textbox", { name: "--room-control-size", exact: true }).fill("52px");
  await expect(logo).toHaveCSS("height", "52px");
  await logo.click();
  await expect(logo).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Panel + flip tab" }).click();
  const flip = preview.getByRole("button", { name: "show material dossier" });
  await expect(flip).toHaveCSS("height", "44px");
  await flip.click();
  await expect(preview.getByRole("button", { name: "show swatch archive" })).toBeVisible();
  await page.getByRole("combobox", { name: "Preview width" }).selectOption("390");
  await expect.poll(async () => page.frames().find(f => f.url().includes("/preview?"))?.evaluate(() => innerWidth)).toBe(390);

  await page.getByRole("button", { name: /Logo \+ wordmark/ }).click();
  await expect(logo).toHaveCSS("height", "52px");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "export CSS ↓" }).click();
  expect((await download).suggestedFilename()).toBe("digital-loom-logo.css");
  await page.reload();
  await expect(logo).toHaveCSS("height", "52px");
  await page.getByRole("button", { name: "reset tokens", exact: true }).click();
  await expect(logo).toHaveCSS("height", "44px");
});

test("preview upload never reads or changes stored credentials or calls extraction", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("loom.falKey", "workbench-test-sentinel"));
  let extractionRequests = 0;
  await page.route("**/api/patina", route => { extractionRequests++; return route.abort(); });
  await page.goto("/room/components/preview?component=insert");
  const key = page.getByLabel("fal.ai api key");
  await expect(key).toHaveValue("");
  await key.fill("preview-only-key");
  expect(await page.evaluate(() => localStorage.getItem("loom.falKey"))).toBe("workbench-test-sentinel");
  expect(extractionRequests).toBe(0);
});
