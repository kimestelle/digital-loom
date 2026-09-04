import { expect, test, type Page } from "playwright/test";

const MAP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function installFixtures(page: Page): Promise<void> {
  await page.route("**/api/cache", (route) =>
    route.fulfill({ json: { entries: [] } }),
  );
  await page.route("**/api/presets", (route) =>
    route.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/samples", (route) =>
    route.fulfill({
      json: {
        samples: [
          {
            label: "touch swatch",
            prompt: null,
            hash: "b".repeat(64),
            maps: [
              {
                name: "albedo",
                file: "albedo.png",
                url: "/api/samples/touch-swatch/albedo.png",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/pregen/silk-sample/manifest.json", (route) =>
    route.fulfill({
      json: {
        hash: "71871d958aa681541baf9159cbf98bc4",
        createdAt: "2026-07-10T03:52:26.890Z",
        maps: ["albedo", "normal", "roughness", "height"].map((name) => ({
          name,
          file: `${name}.png`,
        })),
      },
    }),
  );
  for (const pattern of [
    "**/pregen/silk-sample/*.png",
    "**/api/samples/touch-swatch/*.png",
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({ contentType: "image/png", body: MAP_PNG }),
    );
  }
}

async function openTouchSurface(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "loom.perf",
      JSON.stringify({
        quality: "lo",
        meshRes: "lo",
        iterations: 1,
        selfCollide: "off",
        anisotropy: 2,
        autoQuality: false,
      }),
    );
  });
  await installFixtures(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('nav[aria-label="editor tabs"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    page
      .locator('nav[aria-label="editor tabs"] .mobile-nav-tab')
      .filter({ hasText: "my swatches" }),
  ).toHaveAttribute("data-active", "true", { timeout: 30_000 });
  // Samples only appear after client hydration, making this a reliable signal
  // that the default swatch surface and its first tap are ready.
  await expect(
    page.getByRole("button", { name: "duplicate touch swatch into library" }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("coarse-pointer authoring", () => {
  test.describe.configure({ timeout: 120_000 });
  test("keeps one reachable mobile sheet and pages to the correct swatch pane", async ({
    page,
  }) => {
    await openTouchSurface(page);

    const tabs = page.getByRole("navigation", { name: "editor tabs" });
    const workshop = page.locator('aside[aria-label="workshop"]');
    const tuning = page.locator('aside[aria-label="tuning"]');
    const modeButton = page.getByRole("button", { name: /cloth stage/i });

    await expect(page.locator(".save-status")).toBeHidden();
    const modeBox = await modeButton.boundingBox();
    const viewport = page.viewportSize();
    expect(modeBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (modeBox && viewport) {
      expect(
        Math.abs(modeBox.x + modeBox.width / 2 - viewport.width / 2),
      ).toBeLessThanOrEqual(1);
    }

    await expect(page.locator(".stage-instrument")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    await tabs.getByRole("button", { name: "tuning" }).tap();
    await expect(tuning).toBeVisible();
    await expect(workshop).toBeHidden();
    const mobileViewPicker = tuning
      .locator(".side-panel-scroll")
      .getByRole("group", { name: "tuning view" });
    await expect(mobileViewPicker).toBeVisible();
    await mobileViewPicker.getByRole("button", { name: "scene" }).tap();
    const tests = tuning.getByRole("group", { name: "repeatable cloth tests" });
    await expect(tests).toBeVisible();
    for (const name of ["drape", "gust", "pull", "reset"]) {
      await tests.getByRole("button", { name }).tap();
    }

    // Re-tapping the active tab collapses the sheet without leaving hidden
    // controls reachable; a second tap restores it.
    await tabs.getByRole("button", { name: "tuning" }).tap();
    await expect(tuning).toBeHidden();
    await tabs.getByRole("button", { name: "tuning" }).tap();
    await expect(tuning).toBeVisible();

    // Exercise the real TouchEvent pager. Swiping from tuning to swatches must
    // also update the left panel's inner pane, not reopen Workshop by mistake.
    await tuning.evaluate((element) => {
      const touch = (x: number) =>
        new Touch({ identifier: 1, target: element, clientX: x, clientY: 500 });
      element.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [touch(50)],
        }),
      );
      element.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          changedTouches: [touch(330)],
        }),
      );
    });
    await expect(tabs.getByRole("button", { name: "my swatches" })).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(workshop).toBeVisible();
    await expect(
      workshop.locator(".panel-tab-pane").nth(1),
    ).toHaveAttribute("aria-hidden", "false");
    await expect(tuning).toBeHidden();
  });

  test("previews field motion locally, intensifies its glow, and commits on release", async ({
    page,
  }) => {
    await openTouchSurface(page);
    await page
      .getByRole("navigation", { name: "editor tabs" })
      .getByRole("button", { name: "tuning" })
      .tap();

    const tuning = page.locator('aside[aria-label="tuning"]');
    const fineTune = tuning.getByText("fine tune", { exact: true });
    await fineTune.tap();
    const bend = tuning.getByRole("slider", { name: /bend/i });
    const initialBend = await bend.inputValue();
    const behavior = tuning.getByRole("group", { name: /^behavior:/i });
    await behavior.scrollIntoViewIfNeeded();
    const box = await behavior.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const cdp = await page.context().newCDPSession(page);
    const start = { x: box.x + 24, y: box.y + box.height - 22 };
    const finish = { x: box.x + box.width - 22, y: box.y + 22 };

    // Cancellation settles the preview without opening a transaction or
    // changing the material.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [finish],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await expect(behavior).toHaveAttribute("data-active", "false");
    expect(await bend.inputValue()).toBe(initialBend);
    await expect(page.getByLabel("material draft", { exact: true })).toHaveCount(0);

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [finish],
    });

    await expect(behavior).toHaveAttribute("data-active", "true");
    await page.waitForTimeout(280);
    expect(
      Number(
        await behavior.evaluate(
          (element) => getComputedStyle(element, "::after").opacity,
        ),
      ),
    ).toBeGreaterThan(0.8);
    expect(await bend.inputValue()).toBe(initialBend);
    await expect(page.getByLabel("material draft", { exact: true })).toHaveCount(0);

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(behavior).toHaveAttribute("data-active", "false");
    await expect.poll(() => bend.inputValue()).not.toBe(initialBend);
    await expect(page.getByLabel("material draft", { exact: true })).toBeVisible();
    await page.waitForTimeout(280);
    expect(
      Number(
        await behavior.evaluate(
          (element) => getComputedStyle(element, "::after").opacity,
        ),
      ),
    ).toBeLessThan(0.35);

    const openArea = tuning.getByRole("slider", { name: /open area/i });
    await openArea.scrollIntoViewIfNeeded();
    const beforeOpenArea = await openArea.inputValue();
    const sliderBox = await openArea.boundingBox();
    expect(sliderBox).not.toBeNull();
    if (sliderBox) {
      await page.touchscreen.tap(
        sliderBox.x + sliderBox.width * 0.82,
        sliderBox.y + sliderBox.height / 2,
      );
      await expect.poll(() => openArea.inputValue()).not.toBe(beforeOpenArea);
      expect(sliderBox.height).toBeGreaterThanOrEqual(44);
    }

    const satin = tuning.getByRole("button", { name: "satin" });
    await satin.tap();
    await expect(satin).toHaveAttribute("aria-pressed", "true");
  });

  test("supports touch on maps, swatches, and the cloth after sheet collapse", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openTouchSurface(page);

    await page
      .getByRole("navigation", { name: "editor tabs" })
      .getByRole("button", { name: "workshop" })
      .tap();
    const mapButton = page.getByRole("button", { name: "edit albedo map pixels" });
    await expect(mapButton).toBeVisible({ timeout: 30_000 });
    await mapButton.tap();
    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "close albedo map editor" });
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    await dialog.getByRole("button", { name: "faded" }).tap();
    await expect(dialog.getByRole("button", { name: "faded" })).toHaveAttribute(
      "data-active",
      "true",
    );
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "use another image" }).tap(),
    ]);
    await chooser.setFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: MAP_PNG,
    });
    await expect(dialog.locator(".map-studio-source span").first()).toHaveText(
      "replacement.png",
    );
    await close.tap();
    await expect(dialog).toBeHidden();

    const tabs = page.getByRole("navigation", { name: "editor tabs" });
    await tabs.getByRole("button", { name: "my swatches" }).tap();
    const duplicate = page
      .getByRole("button", { name: "duplicate touch swatch into library" });
    await duplicate.tap();
    await expect(
      page.getByRole("button", {
        name: "duplicate touch swatch copy",
        exact: true,
      }),
    ).toBeVisible();

    // At the narrowest supported phone width, destructive and copy actions
    // remain separate touch targets instead of overlapping over the swatch.
    await page.setViewportSize({ width: 320, height: 851 });
    const copyAction = page.getByRole("button", {
      name: "duplicate touch swatch copy",
      exact: true,
    });
    const deleteAction = page.getByRole("button", {
      name: "delete touch swatch copy",
      exact: true,
    });
    const [copyBox, deleteBox] = await Promise.all([
      copyAction.boundingBox(),
      deleteAction.boundingBox(),
    ]);
    expect(copyBox).not.toBeNull();
    expect(deleteBox).not.toBeNull();
    if (copyBox && deleteBox) {
      expect(deleteBox.y + deleteBox.height).toBeLessThanOrEqual(copyBox.y);
    }

    // Collapse the sheet, then send real one- and two-finger streams through
    // Chromium's touch input path. The second finger hands off to orbit; a new
    // one-finger gesture must recover without a stale direct-contact state.
    await tabs.getByRole("button", { name: "my swatches" }).tap();
    const canvas = page.locator(".stage canvas").first();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    if (canvasBox) {
      const cdp = await page.context().newCDPSession(page);
      const x = canvasBox.x + canvasBox.width * 0.5;
      const y = canvasBox.y + canvasBox.height * 0.45;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 0 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + 45, y: y - 20, id: 0 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x, y, id: 0 },
          { x: x + 60, y, id: 1 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: x - 15, y, id: 0 },
          { x: x + 75, y, id: 1 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.touchscreen.tap(x, y);
    }
    expect(pageErrors).toEqual([]);
  });

  test("keeps the map editor save action reachable in phone landscape", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 390 });
    await openTouchSurface(page);
    await page
      .getByRole("navigation", { name: "editor tabs" })
      .getByRole("button", { name: "workshop" })
      .tap();
    await page.getByRole("button", { name: "edit albedo map pixels" }).tap();
    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole("button", { name: "save as variation" });
    await expect(save).toBeVisible();
    const box = await save.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.y + box.height).toBeLessThanOrEqual(390);
  });

  test("keeps primary controls at touch size on a coarse tablet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openTouchSurface(page);
    await page.getByRole("tab", { name: "workshop" }).click();

    const targets = [
      page.getByRole("button", { name: /cloth stage/i }),
      page.getByRole("button", { name: "choose a fabric photo" }),
      page.locator('aside[aria-label="workshop"] .side-panel-toggle'),
      page.locator('aside[aria-label="tuning"] .side-panel-toggle'),
      page.locator('aside[aria-label="tuning"] .fine-tune > summary'),
      page.locator(".prompt-input").first(),
      page.locator(".insert-submit"),
    ];

    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  });
});
