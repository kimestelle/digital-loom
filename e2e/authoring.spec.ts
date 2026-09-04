import { expect, test, type Page } from "playwright/test";

const MAP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function installAuthoringFixtures(page: Page): Promise<void> {
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
            label: "e2e swatch",
            prompt: null,
            hash: "a".repeat(64),
            maps: [
              {
                name: "albedo",
                file: "albedo.png",
                url: "/api/samples/e2e-swatch/albedo.png",
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
    "**/api/samples/e2e-swatch/*.png",
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({ contentType: "image/png", body: MAP_PNG }),
    );
  }
}

async function openAuthoringSurface(
  page: Page,
  options: { openWorkshop?: boolean } = {},
): Promise<void> {
  // Keep the test independent of a developer's existing server cache. Each
  // Playwright test also gets its own fresh browser context and IndexedDB.
  await page.addInitScript(() => {
    // Authoring tests do not need the expensive cloth fidelity path. Keeping
    // the headless WebGL scene light prevents software rendering from starving
    // keyboard and focus events on CI.
    if (!localStorage.getItem("loom.perf")) {
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
    }
  });
  await installAuthoringFixtures(page);
  // The WebGL/WebGPU scene keeps loading large visual assets after React is
  // interactive; authoring controls should not wait for that whole tail.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".nav-brand-sub")).toHaveCount(0);
  const swatchesTab = page.getByRole("tab", { name: "my swatches" });
  await expect(swatchesTab).toHaveAttribute("aria-selected", "true", {
    timeout: 30_000,
  });
  // Samples arrive through a client effect, so this also proves hydration has
  // attached the tab and file-input handlers.
  await expect(
    page.getByRole("button", { name: "duplicate e2e swatch into library" }),
  ).toBeVisible({ timeout: 30_000 });
  if (options.openWorkshop === false) return;

  await page.getByRole("tab", { name: "workshop" }).click();
  await expect(page.getByRole("button", { name: "choose a fabric photo" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "edit albedo map pixels" }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("local-first authoring surface", () => {
  test("reveals the real cloth once and bypasses motion when requested", async ({
    page,
  }) => {
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
    await installAuthoringFixtures(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const launch = page.locator("[data-cloth-launch]");
    await expect(launch).toBeAttached({ timeout: 30_000 });
    await expect(page.locator(".landing")).toHaveCount(0);
    await expect(launch).toHaveAttribute("data-cloth-launch", "shimmering", {
      timeout: 30_000,
    });
    await expect(launch).toHaveAttribute("data-cloth-launch", "ready", {
      timeout: 30_000,
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-cloth-launch]")).toHaveAttribute(
      "data-cloth-launch",
      "ready",
      { timeout: 30_000 },
    );
  });

  test("opens a bundled map in the editor and restores keyboard focus", async ({
    page,
  }) => {
    await openAuthoringSurface(page);

    // This control only exists after the bundled material manifest has loaded.
    const mapButton = page.getByRole("button", {
      name: "edit albedo map pixels",
    });
    await expect(mapButton).toBeVisible({ timeout: 30_000 });
    await mapButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "close albedo map editor" }),
    ).toBeFocused();
    await expect(dialog.getByRole("slider", { name: /brightness/i })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "save as variation" }),
    ).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(mapButton).toBeFocused();
  });

  test("saves a map variation, restores it after reload, and does not publish an orphan preset", async ({
    page,
  }) => {
    let presetPosts = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/presets")
      ) {
        presetPosts += 1;
      }
    });
    await openAuthoringSurface(page);

    const swatchesPane = page.locator(".panel-tab-pane").nth(1);
    const libraryItems = swatchesPane.locator(
      "section[data-dye='mugwort'] li.swatch",
    );
    const countBefore = await libraryItems.count();

    await page.getByRole("button", { name: "edit albedo map pixels" }).click();
    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await dialog.getByRole("slider", { name: /brightness/i }).fill("0.25");
    await dialog.getByRole("button", { name: "save as variation" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await page.getByRole("tab", { name: "my swatches" }).click();
    await expect(libraryItems).toHaveCount(countBefore + 1, {
      timeout: 30_000,
    });
    const variationLabel = swatchesPane
      .locator(".swatch-label", { hasText: "albedo edit" })
      .last();
    await expect(variationLabel).toBeVisible();
    const savedLabel = (await variationLabel.textContent())?.trim();
    expect(savedLabel).toContain("albedo edit");
    expect(presetPosts).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "my swatches" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    await expect(
      page.locator(".swatch-label", { hasText: savedLabel }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("stages a photo through the native chooser without starting extraction", async ({
    page,
  }) => {
    await openAuthoringSurface(page);

    let extractionRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/patina")) extractionRequests += 1;
    });

    const chooserButton = page.getByRole("button", {
      name: "choose a fabric photo",
    });
    await chooserButton.focus();
    await expect(chooserButton).toBeFocused();
    await expect(chooserButton).toHaveJSProperty("type", "button");
    // Set the native input directly. Headless Chromium's OS chooser can block
    // keyboard actions nondeterministically; the visible trigger's native
    // button semantics and focusability are asserted above.
    await page.locator("input[type=file][accept='image/*']").setInputFiles({
      name: "fabric.png",
      mimeType: "image/png",
      buffer: MAP_PNG,
    });

    await expect(
      page.getByRole("button", { name: "replace staged photo fabric" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "submit" })).toBeEnabled();
    expect(extractionRequests).toBe(0);
  });

  test("keeps inactive tab content inert and exposes keyboard duplication", async ({
    page,
  }) => {
    await openAuthoringSurface(page, { openWorkshop: false });

    const panes = page.locator(".panel-tab-pane");
    const workshopPane = panes.nth(0);
    const swatchesPane = panes.nth(1);

    await expect(workshopPane).toHaveAttribute("inert", "");
    await expect(workshopPane).toHaveAttribute("aria-hidden", "true");
    await expect(swatchesPane).not.toHaveAttribute("inert", "");
    await expect(swatchesPane).toHaveAttribute("aria-hidden", "false");

    const workshopTab = page.getByRole("tab", { name: "workshop" });
    await workshopTab.focus();
    await workshopTab.click();
    await expect(workshopPane).not.toHaveAttribute("inert", "");
    await expect(swatchesPane).toHaveAttribute("inert", "");

    const swatchesTab = page.getByRole("tab", { name: "my swatches" });
    await swatchesTab.focus();
    await expect(swatchesTab).toBeFocused();
    await swatchesTab.click();
    await expect(workshopPane).toHaveAttribute("inert", "");
    await expect(workshopPane).toHaveAttribute("aria-hidden", "true");
    await expect(swatchesPane).not.toHaveAttribute("inert", "");
    await expect(swatchesPane).toHaveAttribute("aria-hidden", "false");

    const duplicate = page
      .getByRole("button", { name: /^duplicate .+ into library$/ })
      .first();
    await expect(duplicate).toBeVisible();

    const libraryItems = swatchesPane.locator(
      "section[data-dye='mugwort'] li.swatch",
    );
    const countBefore = await libraryItems.count();
    await duplicate.focus();
    await expect(duplicate).toBeFocused();
    await duplicate.press("Enter");

    await expect(libraryItems).toHaveCount(countBefore + 1);
    await expect(page.locator(".save-status")).toContainText(
      "saved on this device",
      { timeout: 15_000 },
    );
  });

  test("separates fabric and scene controls and restores mouse force locally", async ({
    page,
  }) => {
    test.slow();
    let presetPosts = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/presets")
      ) {
        presetPosts += 1;
      }
    });
    await openAuthoringSurface(page);

    const tuning = page.getByRole("complementary", { name: "tuning" });
    // The WebGPU/WebGL compiler can monopolize headless Chromium after the
    // server-rendered controls first appear. A live meter is the reliable
    // signal that the client and its event loop are actually responsive.
    await expect(tuning.locator(".perf-meter-val").first()).not.toHaveText("—", {
      timeout: 90_000,
    });
    const viewPicker = tuning
      .locator(".side-panel-header")
      .getByRole("group", { name: "tuning view" });
    await expect(viewPicker).toBeVisible();
    await expect(
      tuning
        .locator(".side-panel-scroll")
        .getByRole("group", { name: "tuning view" }),
    ).toBeHidden();
    const fabricView = viewPicker.getByRole("button", { name: "fabric" });
    const sceneView = viewPicker.getByRole("button", { name: "scene" });
    const mouseForce = tuning.getByRole("slider", { name: /mouse force/i });

    await expect(fabricView).toHaveAttribute("aria-pressed", "true");
    await expect(
      tuning.getByRole("group", { name: /^behavior:/i }),
    ).toBeVisible();
    await expect(tuning.getByText("material instrument", { exact: true })).toBeVisible();
    await expect(tuning.getByRole("slider", { name: /sheen/i })).toBeHidden();
    await tuning.getByText("fine tune", { exact: true }).click();
    await expect(tuning.getByRole("slider", { name: /sheen/i })).toBeVisible();
    await expect(mouseForce).toBeHidden();

    await sceneView.click();
    await expect(sceneView).toHaveAttribute("aria-pressed", "true");
    await expect(mouseForce).toBeVisible();
    await expect(
      tuning.getByRole("slider", { name: /from height/i }),
    ).toBeHidden();

    await mouseForce.fill("4.2");
    await expect.poll(async () => {
      return page.evaluate(() =>
        JSON.parse(localStorage.getItem("loom.perf") ?? "{}").mouseForce,
      );
    }).toBe(4.2);

    await fabricView.click();
    await sceneView.click();
    await expect(mouseForce).toHaveValue("4.2");
    expect(presetPosts).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "my swatches" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    const restoredTuning = page.getByRole("complementary", { name: "tuning" });
    await expect(restoredTuning.locator(".perf-meter-val").first()).not.toHaveText(
      "—",
      { timeout: 90_000 },
    );
    await restoredTuning
      .getByRole("group", { name: "tuning view" })
      .getByRole("button", { name: "scene" })
      .click();
    await expect(
      restoredTuning.getByRole("slider", { name: /mouse force/i }),
    ).toHaveValue("4.2");
  });

  test("turns material edits into a recoverable draft and keeps fine controls available", async ({
    page,
  }) => {
    test.slow();
    await openAuthoringSurface(page);

    const tuning = page.getByRole("complementary", { name: "tuning" });
    await expect(tuning.locator(".perf-meter-val").first()).not.toHaveText("—", {
      timeout: 90_000,
    });
    const bench = page.getByLabel("material draft", { exact: true });
    const behavior = tuning.getByRole("group", { name: /^behavior:/i });

    await expect(behavior).toBeVisible();
    await expect(bench).toHaveCount(0);
    await behavior.focus();
    await behavior.press("ArrowRight");

    const activeBench = page.getByLabel("material draft", { exact: true });
    await expect(activeBench.getByText("draft", { exact: true })).toBeVisible();
    await expect(activeBench.getByRole("button", { name: "undo material edit" })).toBeEnabled();
    const compare = activeBench.getByRole("button", { name: "show source" });
    await expect(compare).toBeEnabled();
    await compare.click();
    await expect(
      activeBench.getByRole("button", { name: "show draft" }),
    ).toHaveAttribute("aria-pressed", "true");
    await activeBench.getByRole("button", { name: "show draft" }).click();

    await activeBench.getByRole("button", { name: "undo material edit" }).click();
    await expect(
      activeBench.getByRole("button", { name: "redo material edit" }),
    ).toBeEnabled();
    await expect(
      tuning.getByRole("button", { name: "satin" }),
    ).toBeVisible();
    await expect(tuning.getByText("fine tune", { exact: true })).toBeVisible();
  });
});
