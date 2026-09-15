import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "playwright/test";
import type { MaterialPreset } from "../lib/presets/types";

const ROOM_PATH = "/";

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
  options: { face?: "archive" | "material"; openAddMaterial?: boolean } = {},
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
  await page.goto(ROOM_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".nav-brand-sub")).toHaveCount(0);
  const cabinet = page.locator(".material-cabinet");
  await expect(cabinet).toHaveAttribute("data-face", "archive", {
    timeout: 30_000,
  });
  await expect(page.locator(".room-frame")).toHaveAttribute(
    "data-room-light-position",
    /.+/,
    { timeout: 90_000 },
  );

  if (options.openAddMaterial) {
    await page.getByText("add material", { exact: true }).click({ force: true });
    await expect(
      page.getByRole("button", { name: "choose a fabric photo" }),
    ).toBeVisible({ timeout: 30_000 });
  }

  if (options.face === "archive") return;

  await page
    .getByRole("button", { name: "show material dossier" })
    .click({ force: true });
  await expect(cabinet).toHaveAttribute("data-face", "material");
  await expect(
    page.getByRole("button", { name: "edit albedo map pixels" }),
  ).toBeVisible({ timeout: 90_000 });
}

async function readLocalPresets(page: Page): Promise<MaterialPreset[]> {
  return page.evaluate(() => new Promise<MaterialPreset[]>((resolve, reject) => {
    const request = indexedDB.open("loom-map-cache");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("presets")) {
        db.close();
        resolve([]);
        return;
      }
      const transaction = db.transaction("presets", "readonly");
      const rows = transaction.objectStore("presets").getAll();
      rows.onsuccess = () => resolve(rows.result as MaterialPreset[]);
      rows.onerror = () => reject(rows.error);
      transaction.oncomplete = () => db.close();
    };
  }));
}

function behaviorControl(page: Page): Locator {
  return page.locator('aside[aria-label="material dossier"]')
    .getByRole("group", { name: /^behavior:/i, includeHidden: true });
}

async function editBehavior(page: Page, key = "ArrowRight"): Promise<string> {
  const behavior = behaviorControl(page);
  const original = await behavior.getAttribute("aria-label");
  await behavior.focus();
  await behavior.press(key);
  await expect(behavior).not.toHaveAttribute("aria-label", original ?? "");
  await expect(behavior).not.toHaveAttribute("aria-label", /Preview/);
  return (await behavior.getAttribute("aria-label")) ?? "";
}

async function expectShelfPushesContent(page: Page): Promise<void> {
  const shelf = page.locator(".material-edit-shelf");
  await expect(shelf).toHaveAttribute("data-open", "true");
  await expect.poll(async () => shelf.evaluate((element) => {
    const cabinet = element.closest(".material-cabinet");
    const track = cabinet?.querySelector(".material-cabinet__track");
    if (!cabinet || !track) return false;
    const shellBox = cabinet.getBoundingClientRect();
    const trackBox = track.getBoundingClientRect();
    const shelfBox = element.getBoundingClientRect();
    return element.parentElement === track.parentElement
      && shelfBox.height > 0
      && trackBox.height > 60
      && Math.abs(trackBox.bottom - shelfBox.top) <= 2
      && Math.abs(shellBox.bottom - shelfBox.bottom) <= 2
      && shelfBox.left >= shellBox.left - 1
      && shelfBox.right <= shellBox.right + 1;
  })).toBe(true);
}

async function expectBakedRoomTextures(page: Page): Promise<void> {
  const planes = page.locator("svg.room-frame__planes");
  const room = page.locator(".room-frame");
  await expect(planes).toHaveCount(1);
  expect(
    await room.evaluate((element) => {
      const style = getComputedStyle(element);
      return ["near", "mid", "far"].map((stop) =>
        style.getPropertyValue(`--room-floor-${stop}`).trim(),
      );
    }),
  ).toEqual(["#968576", "#b09e8b", "#cec1ad"]);
  await expect(planes.locator(".room-frame__plane--back")).toHaveAttribute(
    "d",
    "M0.5 0.5H920.5V554.5L0.5 662.5Z",
  );
  await expect(planes.locator(".room-frame__plane--side")).toHaveAttribute(
    "d",
    "M920.5 0.5H1279.5V717.865L920.5 554.5Z",
  );
  await expect(planes.locator(".room-frame__plane--floor")).toHaveAttribute(
    "d",
    "M920.5 554.5L0.5 662.5V831.5H1279.5V717.865L920.5 554.5Z",
  );
  await expect(planes.locator(".room-frame__perspective-seams")).toHaveAttribute(
    "d",
    "M920.5 554.5V0.5M920.5 554.5L0.5 662.5V0.5H920.5M920.5 554.5L1279.5 717.865V0.5H920.5",
  );

  for (const [name, href] of [
    ["walls", "/2d-textures/room-walls-perspective.png"],
    ["floor", "/2d-textures/room-floor-perspective.png"],
  ] as const) {
    const texture = page.locator(`[data-room-texture="${name}"]`);
    await expect(texture).toHaveCount(1);
    await expect(texture).toHaveAttribute("href", href);

    const png = await readFile(
      join(process.cwd(), "public", href.replace(/^\//, "")),
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const decodedSize = {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };

    const state = await texture.evaluate((element) => {
      const plane = element.closest("svg.room-frame__planes");
      if (!plane) throw new Error("Room texture is outside the plane SVG");

      const rect = element.getBoundingClientRect();
      const planeRect = plane.getBoundingClientRect();
      const style = getComputedStyle(element);

      return {
        directChild: element.parentElement === plane,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        planeRect: {
          x: planeRect.x,
          y: planeRect.y,
          width: planeRect.width,
          height: planeRect.height,
        },
        transform: style.transform,
        filter: style.filter,
        perspective: style.perspective,
        transformAttribute: element.getAttribute("transform"),
        filterAttribute: element.getAttribute("filter"),
      };
    });

    expect(decodedSize).toEqual({ width: 1280, height: 832 });
    expect(state.directChild).toBe(true);
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(state.rect[dimension] - state.planeRect[dimension]),
      ).toBeLessThanOrEqual(1);
    }
    expect(state).toMatchObject({
      transform: "none",
      filter: "none",
      perspective: "none",
      transformAttribute: null,
      filterAttribute: null,
    });
    if (name === "floor") await expect(texture).toHaveCSS("opacity", "0.45");
  }
}

async function expectLowPolyRoomWindow(page: Page): Promise<void> {
  const sceneHost = page.locator(".cloth-scene");
  const sharedCanvas = sceneHost.locator("canvas");
  const aperture = page.locator(".room-frame__window");

  await expect(sceneHost).toHaveCount(1);
  await expect(sharedCanvas).toHaveCount(1);
  await expect(aperture.locator("canvas")).toHaveCount(0);
  await expect(sceneHost).toHaveAttribute("data-room-window-model", "ready", {
    timeout: 90_000,
  });
  await expect(sceneHost).toHaveAttribute("data-room-window-form", "single");
  await expect(sceneHost).toHaveAttribute("data-room-window-instances", "1");
  await expect(sceneHost).toHaveAttribute("data-room-window-panels", "5");
  await expect(sceneHost).toHaveAttribute("data-room-window-members", "12");
  await expect(sceneHost).toHaveAttribute("data-room-window-triangles", "24");
  await expect(sceneHost).toHaveAttribute("data-room-window-draw-calls", "1");

  await expect(aperture).toHaveCount(1);
  await expect(aperture).toHaveAttribute(
    "data-room-window-mask",
    "aperture",
  );
  await expect(page.locator(".room-frame__window-light")).toHaveCount(0);
  await expect(page.locator(".room-frame__window-grid")).toHaveCount(0);
  await expect(sharedCanvas).toBeVisible();

  const aperturePaint = await aperture.evaluate((element) => {
    const architecture = element.closest<HTMLElement>(
      ".room-frame__architecture",
    );
    const anchor = element.closest<HTMLElement>(
      ".room-frame__window-anchor",
    );
    const stage = document.querySelector<HTMLElement>(".room-frame__stage");
    if (!architecture || !anchor || !stage) {
      throw new Error("Room aperture is missing a stacking-context ancestor");
    }
    const style = getComputedStyle(element);
    const before = getComputedStyle(element, "::before");
    const after = getComputedStyle(element, "::after");
    const nightBefore = getComputedStyle(architecture, "::before");
    const nightAfter = getComputedStyle(architecture, "::after");
    const parseLayer = (value: string) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const apertureLayer = Math.max(
      parseLayer(getComputedStyle(anchor).zIndex),
      parseLayer(style.zIndex),
    );
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      beforeBackgroundImage: before.backgroundImage,
      afterBackgroundImage: after.backgroundImage,
      apertureLayer,
      nightLayer: Math.max(
        parseLayer(nightBefore.zIndex),
        parseLayer(nightAfter.zIndex),
      ),
      stageLayer: parseLayer(getComputedStyle(stage).zIndex),
    };
  });
  expect(aperturePaint).toMatchObject({
    backgroundColor: "rgb(255, 255, 255)",
    backgroundImage: "none",
    beforeBackgroundImage: "none",
    afterBackgroundImage: "none",
  });
  expect(aperturePaint.apertureLayer).toBeGreaterThan(
    aperturePaint.nightLayer,
  );
  expect(aperturePaint.apertureLayer).toBeLessThan(aperturePaint.stageLayer);

  const geometry = await aperture.evaluate((element) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".cloth-scene canvas",
    );
    const stageElement = document.querySelector<HTMLElement>(
      ".room-frame__stage",
    );
    const room = document.querySelector<HTMLElement>(".room-frame");
    const planes = document.querySelector<SVGSVGElement>(
      "svg.room-frame__planes",
    );
    if (!canvas || !stageElement || !room || !planes) {
      throw new Error(
        "Room window is missing its shared canvas, stage, room, or planes",
      );
    }

    const apertureRect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stageElement.getBoundingClientRect();
    const roomRect = room.getBoundingClientRect();
    const planesRect = planes.getBoundingClientRect();
    const style = getComputedStyle(element);
    const bottomRightPercent = Number.parseFloat(
      style.getPropertyValue("--room-window-right-bottom"),
    );
    if (!Number.isFinite(bottomRightPercent)) {
      throw new Error("Room window is missing its resolved sill position");
    }
    const sillSlope =
      ((bottomRightPercent - 100) * apertureRect.height) /
      (100 * apertureRect.width);
    const floorSeamSlope =
      (((554.5 - 662.5) / 832) * planesRect.height) /
      (((920.5 - 0.5) / 1280) * planesRect.width);
    const vanishingPointX =
      roomRect.left + roomRect.width * (5639.759259 / 1280);
    const expectedBottomRightPercent =
      ((vanishingPointX - apertureRect.right) /
        (vanishingPointX - apertureRect.left)) *
      100;
    const visibleLeft = Math.max(apertureRect.left, canvasRect.left);
    const visibleRight = Math.min(apertureRect.right, canvasRect.right);
    const visibleTop = Math.max(apertureRect.top, canvasRect.top);
    const visibleBottom = Math.min(apertureRect.bottom, canvasRect.bottom);
    const centerElement = document.elementFromPoint(
      (visibleLeft + visibleRight) / 2,
      (visibleTop + visibleBottom) / 2,
    );

    return {
      aperture: {
        left: apertureRect.left,
        top: apertureRect.top,
        right: apertureRect.right,
        bottom: apertureRect.bottom,
        width: apertureRect.width,
        height: apertureRect.height,
      },
      canvas: {
        left: canvasRect.left,
        right: canvasRect.right,
      },
      stage: {
        top: stageRect.top,
        height: stageRect.height,
      },
      room: {
        left: roomRect.left,
        width: roomRect.width,
        height: roomRect.height,
      },
      clipPath: style.clipPath,
      bottomRightPercent,
      expectedBottomRightPercent,
      sillSlope,
      floorSeamSlope,
      pointerEvents: style.pointerEvents,
      centerHitsSharedCanvas: centerElement === canvas,
    };
  });

  expect(geometry.clipPath).not.toBe("none");
  expect(
    Math.abs(
      geometry.bottomRightPercent - geometry.expectedBottomRightPercent,
    ),
  ).toBeLessThanOrEqual(0.05);
  expect(geometry.bottomRightPercent).toBeLessThan(100);
  expect(geometry.bottomRightPercent).toBeGreaterThan(
    35,
  );
  expect(Math.abs(geometry.sillSlope - geometry.floorSeamSlope)).toBeGreaterThan(
    0.02,
  );
  expect(geometry.pointerEvents).toBe("none");
  expect(geometry.centerHitsSharedCanvas).toBe(true);
  // The right jamb stays registered to the wall corner while the height-sized
  // form crops off the left edge on narrow screens.
  expect(
    Math.abs(
      geometry.aperture.height - geometry.room.height * 0.49886899,
    ),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(geometry.aperture.width - geometry.room.height * 1.05769231),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(
      geometry.aperture.width / geometry.aperture.height -
        1.05769231 / 0.49886899,
    ),
  ).toBeLessThanOrEqual(0.015);
  expect(geometry.aperture.right).toBeGreaterThan(geometry.canvas.left);
  expect(geometry.aperture.right).toBeLessThanOrEqual(
    geometry.canvas.right + 2,
  );
  expect(
    Math.abs(
      geometry.aperture.right -
        (geometry.room.left +
          geometry.room.width * 0.719140625 -
          Math.min(
            geometry.room.width * 0.083203125,
            geometry.room.height * 0.128004808,
          )),
    ),
  ).toBeLessThanOrEqual(2);
  if (geometry.room.width <= 820) {
    expect(geometry.aperture.left).toBeLessThan(geometry.canvas.left);
  }
  expect(geometry.aperture.top).toBeLessThanOrEqual(geometry.stage.top + 2);
  expect(geometry.aperture.bottom).toBeLessThanOrEqual(
    geometry.stage.top + geometry.stage.height + 2,
  );
}

async function expectRoomLightField(
  page: Page,
): Promise<{ x: number; y: number; scaleX: number; scaleY: number }> {
  const groundLight = page.locator(".room-frame__ground-light");
  const projection = groundLight.locator(":scope > .room-frame__floor-projection");
  const defined = groundLight.locator(".room-frame__dapple-mask--defined");
  const soft = groundLight.locator(".room-frame__dapple-mask--soft");
  const broadLight = page.locator(".room-frame__angled-light");
  const transmitted = groundLight.locator(".room-frame__transmitted-light");

  await expect(groundLight).toHaveCount(1);
  await expect(projection).toHaveCount(1);
  await expect(defined).toHaveCount(0);
  await expect(soft).toHaveCount(1);
  await expect(broadLight).toHaveCount(1);
  await expect(transmitted).toHaveCount(1);

  const softPaint = await soft.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      insideGroundLight: Boolean(
        element.closest(".room-frame__ground-light"),
      ),
      backgroundImage: style.backgroundImage,
      maskImage: style.maskImage,
      webkitMaskImage: style.getPropertyValue("-webkit-mask-image"),
      filter: style.filter,
    };
  });
  expect(softPaint.insideGroundLight).toBe(true);
  expect(softPaint.maskImage).toBe("none");
  expect(softPaint.webkitMaskImage).toBe("none");
  expect(softPaint.backgroundImage.match(/radial-gradient/g)).toHaveLength(2);
  expect(softPaint.backgroundImage).not.toMatch(/room-(?:window-projection|dapple)/);
  expect(softPaint.filter).toMatch(/blur\(12px\)/);

  await expect(broadLight).not.toHaveCSS("background-image", "none");
  const transmittedPaint = await transmitted.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      insideGroundLight: Boolean(
        element.closest(".room-frame__ground-light"),
      ),
      backgroundImage: style.backgroundImage,
      borderRadius: style.borderRadius,
      filter: style.filter,
    };
  });
  expect(transmittedPaint.insideGroundLight).toBe(true);
  expect(transmittedPaint.backgroundImage).toContain("radial-gradient");
  expect(transmittedPaint.borderRadius).toBe("50%");
  expect(transmittedPaint.filter).toMatch(/blur\(14px\)/);

  const readProjection = () =>
    projection.evaluate((element) => {
      const room = element.closest<HTMLElement>(".room-frame");
      const planes = room?.querySelector<SVGSVGElement>(
        ".room-frame__planes",
      );
      const dapple = element.querySelector<HTMLElement>(
        ":scope > .room-frame__dapple",
      );
      const shadow = element.querySelector<HTMLElement>(
        ":scope > .room-frame__transmitted-light",
      );
      if (!room || !planes || !dapple || !shadow) {
        throw new Error("Floor projection is missing its measured room layers");
      }
      const style = getComputedStyle(element);
      const read = (name: string) =>
        Number.parseFloat(style.getPropertyValue(name));
      const x = read("--room-projection-x");
      const y = read("--room-projection-y");
      const roomRect = room.getBoundingClientRect();
      const planesRect = planes.getBoundingClientRect();
      const point = { x, y };
      const seam = [
        {
          x: planesRect.left - roomRect.left + planesRect.width * (0.5 / 1280),
          y: planesRect.top - roomRect.top + planesRect.height * (662.5 / 832),
        },
        {
          x: planesRect.left - roomRect.left + planesRect.width * (920.5 / 1280),
          y: planesRect.top - roomRect.top + planesRect.height * (554.5 / 832),
        },
        {
          x: planesRect.left - roomRect.left + planesRect.width * (1279.5 / 1280),
          y: planesRect.top - roomRect.top + planesRect.height * (717.865 / 832),
        },
      ];
      const distanceToSegment = (
        start: (typeof seam)[number],
        end: (typeof seam)[number],
      ) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = Math.min(
          1,
          Math.max(
            0,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        );
        return Math.hypot(
          point.x - (start.x + t * dx),
          point.y - (start.y + t * dy),
        );
      };
      return {
        x,
        y,
        angle: read("--room-projection-angle"),
        scaleX: read("--room-projection-scale-x"),
        scaleY: read("--room-projection-scale-y"),
        visible: read("--room-projection-visible"),
        seamDistance: Math.min(
          distanceToSegment(seam[0], seam[1]),
          distanceToSegment(seam[1], seam[2]),
        ),
        directChild:
          element.parentElement?.classList.contains(
            "room-frame__ground-light",
          ) === true,
        transform: style.transform,
        transformOrigin: style.transformOrigin,
        width: style.width,
        height: style.height,
        dappleTransform: getComputedStyle(dapple).transform,
        shadowTransform: getComputedStyle(shadow).transform,
      };
    });

  await expect.poll(async () => (await readProjection()).visible).toBe(1);
  await expect
    .poll(async () => (await readProjection()).seamDistance)
    .toBeLessThanOrEqual(0.75);
  const projectionState = await readProjection();
  for (const value of [
    projectionState.x,
    projectionState.y,
    projectionState.angle,
    projectionState.scaleX,
    projectionState.scaleY,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
  }
  expect(projectionState.scaleX).toBeGreaterThan(0);
  expect(projectionState.scaleY).toBeGreaterThan(0);
  expect(projectionState.directChild).toBe(true);
  expect(projectionState.transform).not.toBe("none");
  expect(projectionState.transformOrigin).toBe("0px 128px");
  expect(projectionState.width).toBe("512px");
  expect(projectionState.height).toBe("256px");
  expect(projectionState.dappleTransform).toBe("none");
  expect(projectionState.shadowTransform).toBe("none");
  return {
    x: projectionState.x,
    y: projectionState.y,
    scaleX: projectionState.scaleX,
    scaleY: projectionState.scaleY,
  };
}

async function expectRailAlignedWithArchive(
  rail: Locator,
  archive: Locator,
  material: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const [railBox, archiveBox] = await Promise.all([
        rail.boundingBox(),
        archive.boundingBox(),
      ]);
      if (!railBox || !archiveBox) return null;
      return Math.abs(
        railBox.y + railBox.height - (archiveBox.y + archiveBox.height),
      );
    })
    .toBeLessThanOrEqual(1);

  const [archivePaint, materialPaint] = await Promise.all(
    [archive, material].map((panel) =>
      panel.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          backgroundSize: style.backgroundSize,
          backgroundBlendMode: style.backgroundBlendMode,
          backdropFilter: style.backdropFilter,
        };
      }),
    ),
  );
  expect(materialPaint).toEqual(archivePaint);

  const reveal = rail.locator("..");
  const railGlass = await rail.evaluate((element) => {
    const style = getComputedStyle(element);
    const reveal = element.parentElement;
    if (!reveal?.classList.contains("room-light-modal__reveal")) {
      throw new Error("Environment controls are missing their reveal wrapper");
    }
    const glass = getComputedStyle(reveal, "::before");
    return {
      dialog: {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        zIndex: style.zIndex,
      },
      wrapper: {
        backgroundColor: glass.backgroundColor,
        backdropFilter: glass.backdropFilter,
        maskImage:
          glass.maskImage || glass.getPropertyValue("-webkit-mask-image"),
        zIndex: glass.zIndex,
      },
    };
  });
  await expect(reveal).toHaveClass(/room-light-modal__reveal/);
  expect(railGlass.dialog).toMatchObject({
    backgroundImage: "none",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backdropFilter: "none",
    borderWidths: ["0px", "0px", "0px", "0px"],
    zIndex: "1",
  });
  expect(railGlass.wrapper.backgroundColor).toBe("rgba(255, 255, 255, 0.5)");
  expect(railGlass.wrapper.backdropFilter).toBe(
    "blur(12px) saturate(0.85)",
  );
  expect(railGlass.wrapper.maskImage).toContain("linear-gradient");
  expect(railGlass.wrapper.zIndex).toBe("0");
}

async function expectEnvironmentControlsRail(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "environment controls" });
  const nav = page.locator(".nav-bar");
  const guide = nav.locator(".nav-environment-guide");
  const guideLine = guide.locator("line");
  const shell = page.locator(".room-light-modal");
  const rail = page.locator("#room-environment-controls");
  const cabinet = page.locator(".material-cabinet");
  const archive = cabinet.locator('[data-cabinet-face="archive"]');
  const material = cabinet.locator('[data-cabinet-face="material"]');
  const canvas = page.locator(".cloth-scene canvas");
  const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
  const closedGuideTransform = await guide.evaluate(
    (element) => getComputedStyle(element).transform,
  );

  await expect(trigger).toHaveAttribute("aria-controls", "room-environment-controls");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(nav).toHaveAttribute("data-controls-open", "false");
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  await expect(rail).toHaveAttribute("inert", "");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".room-light-modal__backdrop")).toHaveCount(0);
  await expect(rail.locator(".room-light-modal__header button")).toHaveCount(0);
  await expect(page.locator(".nav-mode-slot")).toHaveCount(0);
  await expect(guide).toHaveCount(1);
  await expect(guideLine).toHaveCount(1);
  const guideRule = await guideLine.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      stroke: style.stroke,
      width: Number.parseFloat(style.strokeWidth),
      dash: style.strokeDasharray
        .split(/[ ,]+/)
        .filter(Boolean)
        .map(Number.parseFloat),
    };
  });
  expect(guideRule).toEqual({
    stroke: "rgb(255, 255, 255)",
    width: 0.8,
    dash: [1.2, 3.2],
  });

  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(nav).toHaveAttribute("data-controls-open", "true");
  await expect(shell).toHaveAttribute("data-open", "true");
  await expect(rail).toHaveAttribute("aria-hidden", "false");
  await expect(rail).not.toHaveAttribute("inert", "");
  await expect(rail).toHaveAttribute("role", "region");
  await expect(
    page.getByRole("region", { name: "environment controls" }),
  ).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(
    rail.getByRole("slider", { name: "time of day" }),
  ).toBeFocused();
  await expect(
    rail.getByRole("slider", { name: "time of day" }),
  ).toHaveValue("0.375");
  await expect(rail.getByRole("slider", { name: "exposure" })).toHaveValue(
    "0.71",
  );
  await expect(rail.getByRole("slider", { name: "warmth" })).toHaveValue(
    "0.22",
  );
  await expect(
    rail.getByRole("slider", { name: "ambient fill" }),
  ).toHaveValue("0.63");
  await expect(
    rail.getByRole("slider", { name: "cycle speed" }),
  ).toHaveValue("0.02");
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe(
    bodyOverflow,
  );
  await expectRailAlignedWithArchive(rail, archive, material);

  await page.setViewportSize({ width: 1100, height: 760 });
  await expectRailAlignedWithArchive(rail, archive, material);

  const position = rail.getByRole("slider", { name: "time of day" });
  const [positionBox, railBox] = await Promise.all([
    position.boundingBox(),
    rail.boundingBox(),
  ]);
  expect(positionBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  if (positionBox && railBox) {
    await page.mouse.move(
      positionBox.x + positionBox.width / 2,
      positionBox.y + positionBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(railBox.x + railBox.width + 40, railBox.y + 40);
    await page.mouse.up();
    await expect(shell).toHaveAttribute("data-open", "true");
  }

  const groups = await rail.locator(".room-light-modal__group").evaluateAll(
    (elements) =>
      elements.map((element) =>
        getComputedStyle(element).getPropertyValue("--cascade-index").trim(),
      ),
  );
  expect(groups).toEqual(["0", "1", "2", "3", "4"]);
  await expect
    .poll(() => guide.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(closedGuideTransform);

  const projection = rail.locator("details.room-light-modal__group", {
    has: page.getByText("projection", { exact: true }),
  });
  await expect(projection).not.toHaveAttribute("open", "");
  await projection.locator("summary").click();
  await expect(projection).toHaveAttribute("open", "");
  await expect(shell).toHaveAttribute("data-open", "true");
  await expect(
    projection.getByRole("slider", { name: "light patch" }),
  ).toBeVisible();
  await expect(
    projection.getByRole("slider", { name: "edge softness" }),
  ).toBeVisible();
  await expect(projection.getByRole("slider", { name: "beam" })).toHaveValue(
    "0.44",
  );
  await expect(
    projection.getByRole("slider", { name: "light patch" }),
  ).toHaveValue("0.35");
  await expect(
    projection.getByRole("slider", { name: "edge softness" }),
  ).toHaveValue("0.77");

  const cycle = rail.getByRole("switch", { name: "day / night cycle" });
  await expect(cycle).toHaveJSProperty("type", "checkbox");
  await expect(cycle).not.toBeChecked();
  await expect(
    rail.getByRole("switch", { name: "auto drift", exact: true }),
  ).toHaveCount(0);

  const mode = rail.getByRole("switch", { name: "mesh preview" });
  const modePicker = rail.locator(".tx-mode-picker");
  await expect(mode).toHaveJSProperty("type", "checkbox");
  await expect(mode).not.toBeChecked();
  await expect(modePicker).toContainText("cloth");
  await expect(modePicker).toContainText("mesh");
  await expect(canvas).toHaveCount(1);
  const initialCanvas = await canvas.elementHandle();
  if (!initialCanvas) throw new Error("Missing shared cloth canvas");
  await mode.focus();
  await mode.press("Space");
  await expect(mode).toBeChecked();
  expect(
    await canvas.evaluate((current, original) => current === original, initialCanvas),
  ).toBe(true);
  await mode.press("Space");
  await expect(mode).not.toBeChecked();

  const showMaterial = page.getByRole("button", {
    name: "show material dossier",
  });
  await showMaterial.click();
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(cabinet).toHaveAttribute("data-face", "material");
  await page.getByRole("button", { name: "show swatch archive" }).click();
  await expect(cabinet).toHaveAttribute("data-face", "archive");

  await trigger.click();
  await expect(shell).toHaveAttribute("data-open", "true");
  await rail.getByRole("slider", { name: "time of day" }).focus();
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  await expect(rail).toHaveAttribute("inert", "");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(shell).toHaveAttribute("data-open", "true");
  await trigger.click();
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(trigger).toBeFocused();
}

test.describe("separate original surface", () => {
  test("loads the original instrument at /sky without room chrome", async ({
    page,
  }) => {
    test.slow();
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
    await page.goto("/sky", { waitUntil: "domcontentloaded" });

    await expect(page.locator(".nav-brand-name")).toHaveText("digital loom");
    await expect(
      page.getByRole("button", { name: /cloth stage/i }),
    ).toBeVisible();
    await expect(page.locator('aside[aria-label="workshop"]')).toHaveCount(1);
    await expect(page.locator('aside[aria-label="tuning"]')).toHaveCount(1);
    await expect(page.locator(".room-frame")).toHaveCount(0);
    await expect(page.locator(".material-cabinet")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "environment controls" }),
    ).toHaveCount(0);

    const originalStage = page.locator(".app > .stage");
    const originalCanvas = originalStage.locator(":scope > div > canvas");
    await expect(originalStage).toBeVisible();
    await expect(originalCanvas).toHaveCount(1, { timeout: 90_000 });
    await expect(originalCanvas).toBeVisible();
    await expect(originalStage.locator(".cloth-scene")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/sky");
  });
});

test.describe("local-first authoring surface", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    if (!testInfo.titlePath.some(title => title.includes("material changes"))) return;
    // These tests exercise the real authoring state and DOM geometry, not GPU
    // fidelity. Keep 2D map/thumbnail canvases but avoid software cloth rendering.
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
        return Reflect.apply(getContext, this, [kind, ...args]);
      } as typeof getContext;
    });
  });
  test.describe.configure({ timeout: 120_000 });

  test("keeps borderless sandpaper panels and a separately faded environment rail", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.setContent(`
      <main class="room-frame">
        <svg class="room-frame__guides"><path d="M0 0L100 100" /></svg>
        <section class="material-cabinet" style="width: 394px; height: var(--room-cabinet-height)">
          <div class="material-cabinet__track" data-face="material">
            <section class="material-cabinet__face material-cabinet__face--material" data-active="true">
              <div style="height: 1200px">
                <div class="section-label">material</div>
                <section class="panel-section">controls</section>
                <div class="instrument-action-row probe-strip">tests</div>
                <details class="fine-tune"><summary>fine tune</summary></details>
                <dl class="cabinet-material-meta"><div><dt>source</dt><dd>sample</dd></div></dl>
                <details class="cabinet-disclosure"><summary>more</summary></details>
              </div>
            </section>
            <section class="material-cabinet__face material-cabinet__face--archive" data-active="false">
              <div style="height: 1200px">
                <div class="section-label">archive</div>
                <details class="cabinet-disclosure"><summary>add material</summary></details>
              </div>
            </section>
          </div>
        </section>
      </main>
      <header class="nav-bar" data-controls-open="true">
        <svg class="nav-environment-guide"><line x1="0.5" y1="0" x2="0.5" y2="100%" /></svg>
      </header>
      <div class="room-light-modal" data-open="true">
        <div class="room-light-modal__reveal">
          <section class="room-light-modal__dialog">
            <div class="room-light-modal__body" style="height: 1200px">
              <fieldset class="room-light-modal__group"><legend>light</legend></fieldset>
              <details class="room-light-modal__group room-light-modal__response" open>
                <summary>response</summary>
                <dl><div><dt>transmission</dt><dd>low</dd></div></dl>
              </details>
              <footer class="room-light-modal__actions"><button>reset</button></footer>
            </div>
          </section>
        </div>
      </div>
    `);
    await page.addStyleTag({
      path: join(process.cwd(), "app/styles/layout.css"),
    });
    await page.addStyleTag({
      path: join(process.cwd(), "app/styles/panels.css"),
    });
    await page.addStyleTag({
      path: join(process.cwd(), "app/styles/room.css"),
    });

    const texture = await readFile(
      join(process.cwd(), "public/2d-textures/sandpaper.png"),
    );
    expect({
      width: texture.readUInt32BE(16),
      height: texture.readUInt32BE(20),
    }).toEqual({ width: 348, height: 500 });

    const material = page.locator(".material-cabinet__face--material");
    const archive = page.locator(".material-cabinet__face--archive");
    const rail = page.locator(".room-light-modal__dialog");
    const reveal = page.locator(".room-light-modal__reveal");
    const surfaces = [material, archive];
    const finishes = await Promise.all(
      surfaces.map((surface) =>
        surface.evaluate((element) => {
          const style = getComputedStyle(element);
          const grain = getComputedStyle(element, "::before");
          const child = element.firstElementChild;
          const numeric = (value: string) => Number.parseFloat(value);
          return {
            base: {
              backgroundImage: style.backgroundImage,
              backgroundColor: style.backgroundColor,
              backdropFilter: style.backdropFilter,
            },
            borderWidths: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            boxShadow: style.boxShadow,
            paddingTop: numeric(style.paddingTop),
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            childPosition: child ? getComputedStyle(child).position : null,
            childZIndex: child ? getComputedStyle(child).zIndex : null,
            grain: {
              backgroundImage: grain.backgroundImage,
              backgroundSize: grain.backgroundSize,
              backgroundRepeat: grain.backgroundRepeat,
              opacity: grain.opacity,
              mixBlendMode: grain.mixBlendMode,
              pointerEvents: grain.pointerEvents,
              position: grain.position,
              top: numeric(grain.top),
              height: numeric(grain.height),
              netFlow:
                numeric(grain.height) +
                numeric(grain.marginTop) +
                numeric(grain.marginBottom),
            },
          };
        }),
      ),
    );

    for (const finish of finishes) {
      expect(finish.base).toEqual(finishes[0].base);
      expect(finish.base.backgroundImage).toContain("linear-gradient");
      expect(finish.base.backgroundColor).toBe("rgba(255, 255, 255, 0.3)");
      expect(finish.base.backdropFilter).toBe(
        "blur(12px) saturate(0.85)",
      );
      expect(finish.boxShadow).toBe("none");
      expect(finish.grain.backgroundImage).toContain(
        "/2d-textures/sandpaper.png",
      );
      expect(finish.grain.backgroundSize).toBe("208.8px 300px");
      expect(finish.grain.backgroundRepeat).toBe("repeat");
      expect(finish.grain.opacity).toBe("0.6");
      expect(finish.grain.mixBlendMode).toBe("multiply");
      expect(finish.grain.pointerEvents).toBe("none");
      expect(finish.grain.position).toBe("sticky");
      expect(Math.abs(finish.grain.top + finish.paddingTop)).toBeLessThanOrEqual(
        0.01,
      );
      expect(finish.grain.height).toBeGreaterThanOrEqual(
        finish.clientHeight - 1,
      );
      expect(Math.abs(finish.grain.netFlow)).toBeLessThanOrEqual(0.01);
      expect(finish.scrollHeight).toBeGreaterThan(finish.clientHeight);
      expect(finish.childPosition).toBe("relative");
      expect(finish.childZIndex).toBe("1");
    }
    for (const finish of finishes) {
      expect(finish.borderWidths).toEqual(["0px", "0px", "0px", "0px"]);
    }

    for (const surface of [...surfaces, rail]) {
      const scroll = await surface.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          scrollTop: element.scrollTop,
          grainPosition: getComputedStyle(element, "::before").position,
          grainTop: getComputedStyle(element, "::before").top,
        };
      });
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(scroll.grainPosition).toBe("sticky");
      expect(Number.parseFloat(scroll.grainTop)).toBeLessThan(0);
    }

    const railRule = await rail.evaluate((element) => {
      const style = getComputedStyle(element);
      const reveal = element.parentElement;
      if (!reveal?.classList.contains("room-light-modal__reveal")) {
        throw new Error("Environment controls are missing their reveal wrapper");
      }
      const glass = getComputedStyle(reveal, "::before");
      return {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        backdropFilter: style.backdropFilter,
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        zIndex: style.zIndex,
        glassBackgroundColor: glass.backgroundColor,
        glassBackdropFilter: glass.backdropFilter,
        glassMaskImage:
          glass.maskImage || glass.getPropertyValue("-webkit-mask-image"),
        glassZIndex: glass.zIndex,
      };
    });
    expect(railRule).toMatchObject({
      backgroundImage: "none",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backdropFilter: "none",
      borderWidths: ["0px", "0px", "0px", "0px"],
      zIndex: "1",
      glassBackgroundColor: "rgba(255, 255, 255, 0.5)",
      glassBackdropFilter: "blur(12px) saturate(0.85)",
      glassZIndex: "0",
    });
    expect(railRule.glassMaskImage).toContain("linear-gradient");
    await expect(reveal).toHaveCSS("isolation", "isolate");
    const internalDividers = page.locator(
      [
        ".material-cabinet .section-label",
        ".material-cabinet .panel-section",
        ".material-cabinet .probe-strip",
        ".material-cabinet .fine-tune",
        ".material-cabinet .cabinet-material-meta",
        ".material-cabinet .cabinet-disclosure",
        ".room-light-modal__group",
        ".room-light-modal__response dl > div",
        ".room-light-modal__actions",
      ].join(", "),
    );
    expect(await internalDividers.count()).toBeGreaterThan(9);
    const internalBorders = await internalDividers.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ];
      }),
    );
    for (const borderWidths of internalBorders) {
      expect(borderWidths).toEqual(["0px", "0px", "0px", "0px"]);
    }
    const navRule = await page.locator(".nav-environment-guide line").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        stroke: style.stroke,
        width: Number.parseFloat(style.strokeWidth),
        dash: style.strokeDasharray
          .split(/[ ,]+/)
          .filter(Boolean)
          .map(Number.parseFloat),
      };
    });
    expect(navRule).toEqual({
      stroke: "rgb(255, 255, 255)",
      width: 0.8,
      dash: [1.2, 3.2],
    });
    await expect(page.locator(".room-frame__guides path")).toHaveCSS(
      "stroke",
      "rgb(255, 255, 255)",
    );
  });

  test("keeps the living logo pixel bounded while the logo remains the environment control", async ({
    page,
  }) => {
    const mark = await readFile(
      join(process.cwd(), "public/loom-mark.svg"),
      "utf8",
    );
    const pathData = mark.match(/\sd="([^"]+)"/)?.[1] ?? "";
    expect(mark).toContain('fill-rule="evenodd"');
    expect(mark).toContain('clip-rule="evenodd"');
    expect(pathData.match(/[Qq]/g)).toHaveLength(16);
    expect(pathData.match(/[Mm]/g)).toHaveLength(4);

    await page.emulateMedia({ reducedMotion: "no-preference" });
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
    await page.goto(ROOM_PATH, { waitUntil: "domcontentloaded" });

    const trigger = page.getByRole("button", {
      name: "environment controls",
    });
    const symbol = trigger.locator(".nav-logo-symbol");
    const home = trigger.locator(".nav-logo-pixel-home");
    const pixel = home.locator("canvas.nav-logo-pixel.pixel-play-over");
    const wordmark = trigger.locator(".nav-logo-wordmark");
    const characters = wordmark.locator(".nav-logo-letter");
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    const logoMark = trigger.locator("span.nav-logo-mark");
    await expect(symbol).toHaveCount(1);
    await expect(logoMark).toHaveCount(1);
    await expect(logoMark).toHaveAttribute("aria-hidden", "true");
    await expect(wordmark).toHaveAttribute("aria-hidden", "true");
    await expect(wordmark).toHaveText("digital loom");
    await expect(characters).toHaveCount(12);
    expect(
      await characters.evaluateAll((letters) =>
        letters.filter((letter) => letter.textContent?.trim()).length,
      ),
    ).toBe(11);
    expect(
      await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.status;
      }),
    ).toBe("loaded");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(home).toHaveAttribute("data-pressed", "false");
    await expect(home).toHaveAttribute("aria-hidden", "true");
    await expect(pixel).toHaveCount(1);
    await expect(pixel).toHaveAttribute("aria-hidden", "true");
    await expect
      .poll(
        () =>
          pixel.evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            return `${canvas.width}x${canvas.height}`;
          }),
        { timeout: 30_000 },
      )
      .not.toBe("300x150");
    // The non-default canvas size above is this client tree's hydration
    // signal. Only then require the layout effect's measured letter offsets.
    await expect
      .poll(() =>
        characters.evaluateAll((letters) =>
          letters.every((letter) =>
            getComputedStyle(letter).getPropertyValue("--logo-collapse-x").trim(),
          ),
        ),
      )
      .toBe(true);

    const geometry = await trigger.evaluate((button) => {
      const symbol = button.querySelector<HTMLElement>(".nav-logo-symbol");
      const mark = button.querySelector<HTMLElement>(".nav-logo-mark");
      const home = button.querySelector<HTMLElement>(".nav-logo-pixel-home");
      const pixel = home?.querySelector<HTMLCanvasElement>("canvas");
      if (!symbol || !mark || !home || !pixel) {
        throw new Error("Living logo is incomplete");
      }
      const buttonRect = button.getBoundingClientRect();
      const symbolRect = symbol.getBoundingClientRect();
      const markRect = mark.getBoundingClientRect();
      const homeRect = home.getBoundingClientRect();
      const buttonStyle = getComputedStyle(button);
      const markStyle = getComputedStyle(mark);
      const homeStyle = getComputedStyle(home);
      const pixelStyle = getComputedStyle(pixel);
      return {
        button: {
          width: buttonRect.width,
          height: buttonRect.height,
          position: buttonStyle.position,
          isolation: buttonStyle.isolation,
          borderRadius: buttonStyle.borderRadius,
          overflowX: buttonStyle.overflowX,
          overflowY: buttonStyle.overflowY,
        },
        symbol: {
          left: symbolRect.left - buttonRect.left,
          top: symbolRect.top - buttonRect.top,
          width: symbolRect.width,
          height: symbolRect.height,
        },
        mark: {
          left: markRect.left - buttonRect.left,
          top: markRect.top - buttonRect.top,
          width: markRect.width,
          height: markRect.height,
          maskImage:
            markStyle.maskImage ||
            markStyle.getPropertyValue("-webkit-mask-image"),
          maskPosition:
            markStyle.maskPosition ||
            markStyle.getPropertyValue("-webkit-mask-position"),
          maskRepeat:
            markStyle.maskRepeat ||
            markStyle.getPropertyValue("-webkit-mask-repeat"),
          maskSize:
            markStyle.maskSize ||
            markStyle.getPropertyValue("-webkit-mask-size"),
          backgroundImage: markStyle.backgroundImage,
          pointerEvents: markStyle.pointerEvents,
        },
        home: {
          left: homeRect.left - buttonRect.left,
          top: homeRect.top - buttonRect.top,
          width: homeRect.width,
          height: homeRect.height,
          right: buttonRect.right - homeRect.right,
          bottom: buttonRect.bottom - homeRect.bottom,
          overflowX: homeStyle.overflowX,
          overflowY: homeStyle.overflowY,
        },
        pixel: {
          width: pixel.width,
          height: pixel.height,
          pointerEvents: pixelStyle.pointerEvents,
          filter: pixelStyle.filter,
        },
        dpr: Math.min(2, window.devicePixelRatio || 1),
      };
    });
    expect(geometry.button).toMatchObject({
      width: 44,
      height: 44,
      position: "relative",
      isolation: "isolate",
      borderRadius: "0px",
      overflowX: "clip",
      overflowY: "clip",
    });
    expect(geometry.symbol).toMatchObject({
      left: 0,
      top: 2,
      width: 40,
      height: 40,
    });
    expect(geometry.mark).toMatchObject({
      left: 0,
      top: 2,
      width: 40,
      height: 40,
      maskPosition: "50% 50%",
      maskRepeat: "no-repeat",
      maskSize: "contain",
      pointerEvents: "none",
    });
    expect(geometry.mark.maskImage).toContain("/loom-mark.svg?v=2");
    expect(geometry.mark.backgroundImage).toContain("linear-gradient");
    expect(geometry.home.left).toBeCloseTo(12, 1);
    expect(geometry.home.top).toBeCloseTo(17.2, 1);
    expect(geometry.home.width).toBeCloseTo(16, 1);
    expect(geometry.home.height).toBeCloseTo(13.6, 1);
    expect(geometry.home.right).toBeGreaterThan(0);
    expect(geometry.home.bottom).toBeGreaterThan(0);
    expect(geometry.home.overflowX).toBe("hidden");
    expect(geometry.home.overflowY).toBe("hidden");
    expect(geometry.pixel).toMatchObject({
      width: Math.round(geometry.home.width * geometry.dpr),
      height: Math.round(geometry.home.height * geometry.dpr),
      pointerEvents: "none",
      filter: "brightness(0) invert(1)",
    });

    const readWordmarkState = () =>
      trigger.evaluate((button) => {
        const symbol = button.querySelector<HTMLElement>(".nav-logo-symbol");
        const wordmark = button.querySelector<HTMLElement>(".nav-logo-wordmark");
        const rail = document.querySelector<HTMLElement>(".room-light-modal");
        const letters = Array.from(
          button.querySelectorAll<HTMLElement>(".nav-logo-letter"),
        );
        if (!symbol || !wordmark || !rail || !letters.length) {
          throw new Error("Expandable wordmark is incomplete");
        }
        const buttonRect = button.getBoundingClientRect();
        const symbolRect = symbol.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const paintedLetters = letters.filter((letter) =>
          letter.textContent?.trim(),
        );
        const letterRects = paintedLetters.map((letter) =>
          letter.getBoundingClientRect(),
        );
        const firstStyle = getComputedStyle(letters[0]);
        return {
          button: {
            left: buttonRect.left,
            right: buttonRect.right,
            top: buttonRect.top,
            bottom: buttonRect.bottom,
            width: buttonRect.width,
            height: buttonRect.height,
          },
          symbol: {
            left: symbolRect.left,
            top: symbolRect.top,
            width: symbolRect.width,
            height: symbolRect.height,
          },
          rail: {
            left: railRect.left,
            right: railRect.right,
            width: railRect.width,
          },
          glyphs: {
            left: Math.min(...letterRects.map((rect) => rect.left)),
            right: Math.max(...letterRects.map((rect) => rect.right)),
          },
          characters: letters.map((letter) => {
            const style = getComputedStyle(letter);
            const matrix =
              style.transform === "none"
                ? new DOMMatrixReadOnly()
                : new DOMMatrixReadOnly(style.transform);
            return {
              text: letter.textContent ?? "",
              left: letter.getBoundingClientRect().left,
              opacity: Number.parseFloat(style.opacity),
              translateX: matrix.m41,
              offset: Number.parseFloat(
                style.getPropertyValue("--logo-collapse-x"),
              ),
            };
          }),
          motion: {
            durations: firstStyle.transitionDuration
              .split(",")
              .map((value) => Number.parseFloat(value)),
            delays: firstStyle.transitionDelay
              .split(",")
              .map((value) => Number.parseFloat(value)),
          },
          fontStatus: document.fonts.status,
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });

    await page.waitForTimeout(360);
    const collapsed = await readWordmarkState();
    expect(collapsed.fontStatus).toBe("loaded");
    expect(collapsed.motion.durations).toEqual([0.34, 0.17]);
    expect(collapsed.characters.every(({ opacity }) => opacity === 0)).toBe(
      true,
    );
    expect(
      collapsed.characters.every(({ offset }) => Number.isFinite(offset)),
    ).toBe(true);
    for (const { left } of collapsed.characters) {
      expect(left).toBeCloseTo(
        collapsed.symbol.left + collapsed.symbol.width / 2,
        0,
      );
    }

    const bitmap = () =>
      pixel.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context) return { ink: 0, hash: 0 };
        const rgba = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let ink = 0;
        let hash = 2166136261;
        for (let index = 0; index < rgba.length; index += 1) {
          if (index % 4 === 3 && rgba[index] > 0) ink += 1;
          hash ^= rgba[index];
          hash = Math.imul(hash, 16777619);
        }
        return { ink, hash: hash >>> 0 };
      });
    await expect.poll(async () => (await bitmap()).ink).toBeGreaterThan(0);
    const moving = new Set<number>();
    for (let frame = 0; frame < 6; frame += 1) {
      moving.add((await bitmap()).hash);
      await page.waitForTimeout(180);
    }
    expect(moving.size).toBeGreaterThan(1);

    await home.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        () => {
          element.setAttribute("data-test-pointerdown", "true");
        },
        { once: true },
      );
    });
    const homeBox = await home.boundingBox();
    if (!homeBox) throw new Error("Logo pixel home is not rendered");
    await page.mouse.click(
      homeBox.x + homeBox.width / 2,
      homeBox.y + homeBox.height / 2,
    );
    await expect(home).toHaveAttribute("data-test-pointerdown", "true");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(home).toHaveAttribute("data-pressed", "true");

    await expect
      .poll(async () => (await readWordmarkState()).button.width)
      .toBe(216);
    await expect
      .poll(async () =>
        (await readWordmarkState()).characters.every(
          ({ opacity, translateX }) =>
            opacity === 1 && Math.abs(translateX) <= 0.01,
        ),
      )
      .toBe(true);
    const expanded = await readWordmarkState();
    expect(expanded.motion.delays).toEqual([0, 0.17]);
    expect(expanded.button.left).toBeCloseTo(expanded.rail.left, 0);
    expect(expanded.button.right).toBeCloseTo(expanded.rail.right, 0);
    expect(expanded.glyphs.left).toBeGreaterThanOrEqual(expanded.button.left);
    expect(expanded.glyphs.right).toBeLessThanOrEqual(
      expanded.button.right + 1,
    );
    expect(expanded.symbol).toMatchObject({
      left: expanded.button.left,
      top: expanded.button.top + 2,
      width: 40,
      height: 40,
    });
    expect(expanded.documentWidth).toBeLessThanOrEqual(expanded.viewportWidth);
    // Reverse while the shared 340 ms travel is still in flight. State follows
    // the last click; there is no queued timeout or stale letter visibility.
    await trigger.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(45);
    await trigger.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(45);
    await trigger.evaluate((button: HTMLButtonElement) => button.click());
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(home).toHaveAttribute("data-pressed", "false");
    await expect
      .poll(async () => (await readWordmarkState()).button.width)
      .toBe(44);
    await expect
      .poll(async () =>
        (await readWordmarkState()).characters.every(
          ({ opacity }) => opacity === 0,
        ),
      )
      .toBe(true);

    await trigger.focus();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(home).toHaveAttribute("data-pressed", "false");
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(home).toHaveAttribute("data-pressed", "true");

    await page.setViewportSize({ width: 320, height: 720 });
    await expect
      .poll(async () => (await readWordmarkState()).button.width)
      .toBe(224);
    await expect
      .poll(async () =>
        (await readWordmarkState()).characters.every(
          ({ opacity }) => opacity === 1,
        ),
      )
      .toBe(true);
    const compact = await readWordmarkState();
    expect(compact.button.left).toBeCloseTo(compact.rail.left, 0);
    expect(compact.button.right).toBeCloseTo(compact.rail.right, 0);
    expect(compact.button.right).toBeLessThanOrEqual(compact.viewportWidth);
    expect(compact.glyphs.right).toBeLessThanOrEqual(compact.button.right + 1);
    expect(compact.documentWidth).toBeLessThanOrEqual(compact.viewportWidth);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await readWordmarkState()).button.width)
      .toBe(44);
    const reducedCollapsed = await readWordmarkState();
    expect(reducedCollapsed.motion.durations.every((duration) => duration === 0)).toBe(
      true,
    );
    expect(
      reducedCollapsed.characters.every(({ opacity }) => opacity === 0),
    ).toBe(true);
    await trigger.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(home).toHaveAttribute("data-pressed", "true");
    await expect
      .poll(async () => (await readWordmarkState()).button.width)
      .toBe(224);
    expect(
      (await readWordmarkState()).characters.every(
        ({ opacity, translateX }) =>
          opacity === 1 && Math.abs(translateX) <= 0.01,
      ),
    ).toBe(true);

    await page.waitForTimeout(400);
    const still = new Set<number>();
    for (let frame = 0; frame < 4; frame += 1) {
      still.add((await bitmap()).hash);
      await page.waitForTimeout(120);
    }
    expect(still.size).toBe(1);
  });

  test("keeps dossier pixels live while the control chrome stays flat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
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
    await page.goto(ROOM_PATH, { waitUntil: "domcontentloaded" });

    const cabinet = page.locator(".material-cabinet");
    await expect(cabinet).toHaveAttribute("data-face", "archive", {
      timeout: 30_000,
    });
    // Sample hydration is enough to prove the cabinet's React handlers are
    // attached; this deliberately does not wait for the cloth renderer.
    await expect(
      page.getByRole("button", {
        name: "duplicate e2e swatch into library",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "show material dossier" })
      .click({ force: true });
    await expect(cabinet).toHaveAttribute("data-face", "material");

    const dossier = page.locator('aside[aria-label="material dossier"]');
    const tuning = dossier.getByRole("group", { name: "tuning view" });
    const construction = dossier.getByRole("group", {
      name: "cloth construction",
    });
    await expect(tuning).toBeVisible({ timeout: 30_000 });
    await expect(construction).toBeVisible();

    const pixels = dossier.locator("canvas.pixel-play.pixel-play-over");
    const tuningPixel = tuning.locator("canvas.pixel-play.pixel-play-over");
    const constructionPixel = construction.locator(
      "canvas.pixel-play.pixel-play-over",
    );
    // Five existing fine/scene pickers plus the tuning and construction
    // surfaces all use the same live ink pixel. Hidden views stay mounted so
    // their selection state is preserved.
    await expect(pixels).toHaveCount(7);
    await expect(tuningPixel).toHaveCount(1);
    await expect(constructionPixel).toHaveCount(1);

    const bitmap = (pixel: Locator) =>
      pixel.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context) {
          return {
            ink: 0,
            hash: 0,
            rgb: [0, 0, 0] as [number, number, number],
            centroidX: 0,
            maxAlpha: 0,
          };
        }
        const rgba = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let ink = 0;
        let hash = 2166136261;
        let maxAlpha = -1;
        let rgb: [number, number, number] = [0, 0, 0];
        let weightedX = 0;
        let alphaTotal = 0;
        for (let index = 0; index < rgba.length; index += 4) {
          const alpha = rgba[index + 3];
          if (alpha > 0) {
            ink += 1;
            const x = (index / 4) % canvas.width;
            weightedX += x * alpha;
            alphaTotal += alpha;
          }
          if (alpha > maxAlpha) {
            maxAlpha = alpha;
            rgb = [rgba[index], rgba[index + 1], rgba[index + 2]];
          }
          for (let channel = 0; channel < 4; channel += 1) {
            hash ^= rgba[index + channel];
            hash = Math.imul(hash, 16777619);
          }
        }
        return {
          ink,
          hash: hash >>> 0,
          rgb,
          centroidX: alphaTotal ? weightedX / alphaTotal : 0,
          maxAlpha,
        };
      });

    const waitForInkPixel = async (pixel: Locator) => {
      let sample = await bitmap(pixel);
      await expect
        .poll(
          async () => {
            sample = await bitmap(pixel);
            return (
              sample.maxAlpha >= 200 &&
              sample.rgb.every(
                (value, index) => Math.abs(value - [48, 51, 47][index]) <= 1,
              )
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      return sample;
    };

    for (const pixel of [tuningPixel, constructionPixel]) {
      const { rgb } = await waitForInkPixel(pixel);
      expect(rgb.map((value) => Math.round(value))).toEqual(rgb);
    }

    await page.screenshot({
      path: "/tmp/digital-loom-dossier-after-polish.png",
      animations: "disabled",
    });

    await page.setViewportSize({ width: 393, height: 851 });
    await expect(tuning).toBeVisible();
    await tuning.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => (await bitmap(tuningPixel)).ink)
      .toBeGreaterThan(0);
    await page.screenshot({
      path: "/tmp/digital-loom-dossier-after-polish-mobile.png",
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "environment controls" })
      .click({ force: true });
    await expect(page.locator(".room-light-modal")).toHaveAttribute(
      "data-open",
      "true",
    );
    const compactPanels = await Promise.all(
      [
        cabinet.locator('[data-cabinet-face="archive"]'),
        cabinet.locator('[data-cabinet-face="material"]'),
        page.locator(".room-light-modal__dialog"),
      ].map((panel) =>
        panel.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            backdropFilter: style.backdropFilter,
          };
        }),
      ),
    );
    for (const panel of compactPanels) {
      expect(panel).toEqual({
        backgroundColor: "rgb(248, 249, 246)",
        backgroundImage: "none",
        backdropFilter: "none",
      });
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".room-light-modal")).toHaveAttribute(
      "data-open",
      "false",
    );
    await page.setViewportSize({ width: 1280, height: 832 });
    await tuning.scrollIntoViewIfNeeded();
    await expect(tuning).toBeVisible();

    const fabricTab = tuning.getByRole("button", { name: "fabric" });
    const sceneTab = tuning.getByRole("button", { name: "scene" });
    await expect(fabricTab).toHaveAttribute("data-active", "true");
    const initialHash = (await bitmap(tuningPixel)).hash;
    await sceneTab.click();
    await expect(sceneTab).toHaveAttribute("data-active", "true");
    await expect
      .poll(async () => (await bitmap(tuningPixel)).hash)
      .not.toBe(initialHash);
    await fabricTab.click();
    await expect(fabricTab).toHaveAttribute("data-active", "true");
    await expect(construction).toBeVisible();

    const paint = await dossier.evaluate((root) => {
      const one = <T extends Element>(selector: string) => {
        const element = root.querySelector<T>(selector);
        if (!element) throw new Error(`Missing dossier control: ${selector}`);
        return element;
      };
      const snapshot = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          width: style.width,
          height: style.height,
        };
      };
      const tuning = one<HTMLElement>(".tuning-view-picker");
      const construction = one<HTMLElement>(".construction-options");
      const option = one<HTMLElement>(".construction-option");
      const activeTab = one<HTMLElement>('.tuning-view-picker [data-active="true"]');
      const pad = one<HTMLElement>(".instrument-pad-surface");
      const handle = one<HTMLElement>(".instrument-pad-handle");
      const range = one<HTMLInputElement>('.instrument-sliders input[type="range"]');
      return {
        tuning: snapshot(tuning),
        construction: snapshot(construction),
        option: snapshot(option),
        activeTab: snapshot(activeTab),
        pad: snapshot(pad),
        handle: snapshot(handle),
        range: snapshot(range),
        inlineCats: [
          tuning.style.getPropertyValue("--cat"),
          construction.style.getPropertyValue("--cat"),
        ],
        fg: getComputedStyle(range).getPropertyValue("--fg").trim(),
      };
    });
    expect(paint.tuning).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
      backgroundColor: "rgba(255, 255, 255, 0.9)",
      backgroundImage: "none",
    });
    expect(paint.construction.borderRadius).toBe("0px");
    expect(paint.option).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
      backgroundImage: "none",
    });
    expect(paint.activeTab.color).toBe("rgb(48, 51, 47)");
    expect(paint.pad).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
    });
    expect(paint.handle).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
      backgroundColor: "rgb(48, 51, 47)",
      width: "8px",
      height: "8px",
    });
    expect(paint.range).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
      backgroundImage: "none",
    });
    expect(paint.inlineCats).toEqual(["", ""]);
    expect(paint.fg).toBe("#30332f");

    const rangeRules = await page.evaluate(() => {
      const found: Record<string, Record<string, string>> = {};
      const wanted = {
        track:
          '.cabinet-pane--material .slider input[type="range"]::-webkit-slider-runnable-track',
        thumb:
          '.cabinet-pane--material .slider input[type="range"]::-webkit-slider-thumb',
      };
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          for (const [name, selector] of Object.entries(wanted)) {
            if (rule.selectorText !== selector) continue;
            found[name] = {
              height: rule.style.height,
              width: rule.style.width,
              borderRadius: rule.style.borderRadius,
              background: rule.style.background,
            };
          }
        }
      }
      return found;
    });
    expect(rangeRules.track).toEqual({
      height: "2px",
      width: "",
      borderRadius: "0px",
      background: "rgba(48, 51, 47, 0.28)",
    });
    expect(rangeRules.thumb).toEqual({
      height: "8px",
      width: "8px",
      borderRadius: "0px",
      background: "var(--fg)",
    });

    const moving = new Set<number>();
    for (let frame = 0; frame < 6; frame += 1) {
      moving.add((await bitmap(tuningPixel)).hash);
      await page.waitForTimeout(180);
    }
    expect(moving.size).toBeGreaterThan(1);

    const tuningBox = await tuning.boundingBox();
    if (!tuningBox) throw new Error("Tuning pixel host is not rendered");
    await page.mouse.move(
      tuningBox.x + tuningBox.width * 0.82,
      tuningBox.y + tuningBox.height * 0.5,
    );
    await waitForInkPixel(tuningPixel);
    expect(
      await tuning.evaluate((element) =>
        (element as HTMLElement).style.getPropertyValue("--cat"),
      ),
    ).toBe("");
    await expect(fabricTab).toHaveCSS("color", "rgb(48, 51, 47)");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(400);
    const still = new Set<number>();
    for (let frame = 0; frame < 4; frame += 1) {
      still.add((await bitmap(tuningPixel)).hash);
      await page.waitForTimeout(120);
    }
    expect(still.size).toBe(1);
    expect((await bitmap(tuningPixel)).ink).toBeGreaterThan(0);

    const rightCentroid = (await bitmap(tuningPixel)).centroidX;
    await page.mouse.move(
      tuningBox.x + tuningBox.width * 0.18,
      tuningBox.y + tuningBox.height * 0.5,
    );
    const tuningPixelWidth = await tuningPixel.evaluate(
      (element) => (element as HTMLCanvasElement).width,
    );
    await expect
      .poll(async () => (await bitmap(tuningPixel)).centroidX)
      .toBeLessThan(rightCentroid - tuningPixelWidth * 0.2);

  });

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
    await page.goto(ROOM_PATH, { waitUntil: "domcontentloaded" });

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

  test("uses prewarped room texture plates without runtime projection", async ({
    page,
  }) => {
    test.slow();
    await page.addInitScript(() => {
      localStorage.setItem(
        "loom.room.v1",
        JSON.stringify({
          position: 0,
          exposure: 0.71,
          warmth: 0.22,
          ambient: 0.63,
          beam: 0.44,
          dapple: 0.35,
          dappleSoftness: 0.77,
          autoDrift: false,
          driftRate: 0.02,
        }),
      );
    });
    await openAuthoringSurface(page, { face: "archive" });
    await expect(page.locator(".room-frame")).toHaveAttribute(
      "data-room-light-position",
      "0.375",
    );
    await expectBakedRoomTextures(page);
    await expectLowPolyRoomWindow(page);
    const initialProjection = await expectRoomLightField(page);
    await page.setViewportSize({ width: 1100, height: 760 });
    const resizedProjection = await expectRoomLightField(page);
    expect(
      Math.hypot(
        resizedProjection.x - initialProjection.x,
        resizedProjection.y - initialProjection.y,
      ),
    ).toBeGreaterThan(1);
    await expectEnvironmentControlsRail(page);
  });

  test("bounds the fine-pointer loupe to the projected specimen", async ({
    page,
  }) => {
    await openAuthoringSurface(page, { face: "archive" });

    const sceneHost = page.locator(".stage > div").first();
    const canvas = sceneHost.locator("canvas").first();
    await expect(sceneHost).toHaveAttribute("data-cloth-launch", "ready", {
      timeout: 90_000,
    });
    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const inside = {
      x: box.x + box.width * 0.5,
      y: box.y + box.height * 0.48,
    };

    // Stay inside the renderer while moving well clear of the projected cloth.
    // This proves the hit region comes from the specimen, not the whole canvas.
    const outside = {
      x: box.x + box.width * 0.03,
      y: box.y + box.height * 0.94,
    };
    const cursor = () =>
      canvas.evaluate((element) => getComputedStyle(element).cursor);

    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    expect(await cursor()).not.toBe("none");

    // Hover alone is still the material interaction. The loupe toggles only
    // once a short primary press is released, never on pointerdown.
    await page.mouse.move(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    await page.mouse.down();
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    await page.mouse.up();
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    expect(await cursor()).toBe("none");

    // A second completed click switches inspection off and restores the cursor.
    await page.mouse.click(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    expect(await cursor()).not.toBe("none");

    // Material drags and secondary clicks retain their existing meanings.
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.down();
    await page.mouse.move(inside.x + 24, inside.y + 12);
    await page.mouse.up();
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await page.mouse.click(inside.x, inside.y, { button: "right" });
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );

    await page.mouse.click(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    await page.mouse.click(inside.x, inside.y, { button: "right" });
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    await page.mouse.move(outside.x, outside.y);
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    expect(await cursor()).not.toBe("none");

    await page.mouse.move(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    expect(await cursor()).toBe("none");

    await page.keyboard.press("Escape");
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    expect(await cursor()).not.toBe("none");

    await page.mouse.click(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");

    // Mesh mode keeps its drag-to-rotate gesture while the loupe is off; its
    // completed short click follows the same explicit inspection toggle.
    const controls = page.getByRole("button", {
      name: "environment controls",
    });
    await controls.click();
    const meshPreview = page.getByRole("switch", { name: "mesh preview" });
    await meshPreview.check({ force: true });
    await expect(meshPreview).toBeChecked();
    await controls.click();
    await page.waitForTimeout(1_250);

    await page.mouse.move(inside.x, inside.y);
    await page.mouse.down();
    await page.mouse.move(inside.x + 24, inside.y + 12);
    await page.mouse.up();
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
    await page.mouse.click(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "true",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
    await page.mouse.click(inside.x, inside.y);
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
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

    const archiveFace = page.locator('[data-cabinet-face="archive"]');
    const libraryItems = archiveFace.locator(
      "section[data-dye='mugwort'] li.swatch",
    );
    const countBefore = await libraryItems.count();

    await page.getByRole("button", { name: "edit albedo map pixels" }).click();
    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await dialog.getByRole("slider", { name: /brightness/i }).fill("0.25");
    await dialog.getByRole("button", { name: "save as variation" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await page.getByRole("button", { name: "show swatch archive" }).click();
    await expect(libraryItems).toHaveCount(countBefore + 1, {
      timeout: 30_000,
    });
    const variationLabel = archiveFace
      .locator(".swatch-label", { hasText: "albedo edit" })
      .last();
    await expect(variationLabel).toBeVisible();
    const savedLabel = (await variationLabel.textContent())?.trim();
    expect(savedLabel).toContain("albedo edit");
    expect(presetPosts).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".material-cabinet")).toHaveAttribute(
      "data-face",
      "archive",
      { timeout: 30_000 },
    );
    await expect(
      page.locator(".swatch-label", { hasText: savedLabel }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("stages a photo through the native chooser without starting extraction", async ({
    page,
  }) => {
    await openAuthoringSurface(page, {
      face: "archive",
      openAddMaterial: true,
    });

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

  test("keeps the inactive cabinet face inert and exposes keyboard duplication", async ({
    page,
  }) => {
    await openAuthoringSurface(page, { face: "archive" });

    const cabinet = page.locator(".material-cabinet");
    const archiveFace = cabinet.locator('[data-cabinet-face="archive"]');
    const materialFace = cabinet.locator('[data-cabinet-face="material"]');
    const flip = cabinet.locator(".material-cabinet__flip");
    const materialIcon = flip.locator(
      '.material-cabinet__flip-icon[data-destination="material"]',
    );
    const archiveIcon = flip.locator(
      '.material-cabinet__flip-icon[data-destination="archive"]',
    );

    await expect(archiveFace).not.toHaveAttribute("inert", "");
    await expect(archiveFace).toHaveAttribute("aria-hidden", "false");
    await expect(materialFace).toHaveAttribute("inert", "");
    await expect(materialFace).toHaveAttribute("aria-hidden", "true");
    await expect(flip).toHaveAttribute("aria-label", "show material dossier");
    await expect(flip).toHaveCSS("width", "44px");
    await expect(flip).toHaveCSS("height", "44px");
    await expect(flip).toHaveCSS("top", "0px");
    await expect(flip).toHaveCSS("left", "-44px");
    await expect(flip).toHaveCSS("border-width", "0px");
    await expect(flip).toHaveCSS("border-radius", "0px 0px 0px 12px");
    await expect(page.locator(".material-cabinet__aperture")).toHaveCount(0);
    await expect(flip.locator("svg")).toHaveCount(2);
    await expect(materialIcon).toHaveCount(1);
    await expect(archiveIcon).toHaveCount(1);
    await expect(materialIcon).toHaveAttribute("viewBox", "0 0 24 24");
    await expect(archiveIcon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(
      await materialIcon.locator("line").evaluateAll((lines) =>
        lines.map((line) =>
          ["x1", "y1", "x2", "y2"].map((name) => line.getAttribute(name)),
        ),
      ),
    ).toEqual([
      ["4", "21", "4", "14"],
      ["4", "10", "4", "3"],
      ["12", "21", "12", "12"],
      ["12", "8", "12", "3"],
      ["20", "21", "20", "16"],
      ["20", "12", "20", "3"],
      ["1", "14", "7", "14"],
      ["9", "8", "15", "8"],
      ["17", "16", "23", "16"],
    ]);
    expect(
      await archiveIcon.locator("rect").evaluateAll((rects) =>
        rects.map((rect) =>
          ["x", "y", "width", "height"].map((name) =>
            rect.getAttribute(name),
          ),
        ),
      ),
    ).toEqual([
      ["3", "3", "7", "7"],
      ["14", "3", "7", "7"],
      ["14", "14", "7", "7"],
      ["3", "14", "7", "7"],
    ]);
    await expect(materialIcon).toHaveAttribute("aria-hidden", "true");
    await expect(archiveIcon).toHaveAttribute("aria-hidden", "true");
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(materialIcon).toHaveCSS("filter", "blur(0px)");
    await expect(archiveIcon).toHaveCSS("opacity", "0");
    await expect(archiveIcon).toHaveCSS("filter", "blur(2px)");
    const [cabinetBox, flipBox] = await Promise.all([
      cabinet.boundingBox(),
      flip.boundingBox(),
    ]);
    expect(cabinetBox).not.toBeNull();
    expect(flipBox).not.toBeNull();
    if (cabinetBox && flipBox) {
      expect(Math.abs(flipBox.x + flipBox.width - cabinetBox.x)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(flipBox.y - cabinetBox.y)).toBeLessThanOrEqual(1);
    }
    const initialIconMotion = await Promise.all(
      [materialIcon, archiveIcon].map((icon) =>
        icon.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            properties: style.transitionProperty,
            durations: style.transitionDuration,
            delays: style.transitionDelay,
          };
        }),
      ),
    );
    expect(initialIconMotion[0].properties).toBe("opacity, filter");
    expect(
      initialIconMotion[0].durations
        .split(",")
        .every((duration) => Number.parseFloat(duration) === 0.18),
    ).toBe(true);
    expect(
      initialIconMotion[0].delays
        .split(",")
        .every((delay) => Number.parseFloat(delay) === 0.16),
    ).toBe(true);
    expect(initialIconMotion[1].properties).toBe("opacity, filter");
    expect(
      initialIconMotion[1].durations
        .split(",")
        .every((duration) => Number.parseFloat(duration) === 0.14),
    ).toBe(true);
    expect(
      initialIconMotion[1].delays
        .split(",")
        .every((delay) => Number.parseFloat(delay) === 0),
    ).toBe(true);

    await flip.focus();
    await flip.press("Enter");
    await expect(materialFace).not.toHaveAttribute("inert", "");
    await expect(materialFace).toHaveAttribute("aria-hidden", "false");
    await expect(archiveFace).toHaveAttribute("inert", "");
    await expect(archiveFace).toHaveAttribute("aria-hidden", "true");
    await expect(flip).toHaveAttribute("aria-label", "show swatch archive");
    await expect(flip).toBeFocused();
    await expect(materialIcon).toHaveCSS("opacity", "0");
    await expect(archiveIcon).toHaveCSS("opacity", "1");

    await flip.press("Enter");
    await expect(archiveFace).not.toHaveAttribute("inert", "");
    await expect(archiveFace).toHaveAttribute("aria-hidden", "false");
    await expect(materialFace).toHaveAttribute("inert", "");
    await expect(materialFace).toHaveAttribute("aria-hidden", "true");
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(archiveIcon).toHaveCSS("opacity", "0");

    // The button and both glyphs remain mounted through quick reversals. The
    // last requested face owns the one visible destination icon.
    for (const face of ["material", "archive", "material", "archive"]) {
      await flip.press("Enter");
      await expect(cabinet).toHaveAttribute("data-face", face);
    }
    await expect(flip).toHaveCount(1);
    await expect(materialIcon).toHaveCount(1);
    await expect(archiveIcon).toHaveCount(1);
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(archiveIcon).toHaveCSS("opacity", "0");

    const duplicate = page
      .getByRole("button", { name: /^duplicate .+ into library$/ })
      .first();
    await expect(duplicate).toBeVisible({ timeout: 90_000 });

    const libraryItems = archiveFace.locator(
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

    const tuning = page.locator('aside[aria-label="material dossier"]');
    const viewPicker = tuning.getByRole("group", { name: "tuning view" });
    await expect(viewPicker).toBeVisible();
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
    await expect(page.locator(".material-cabinet")).toHaveAttribute(
      "data-face",
      "archive",
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "show material dossier" }).click();
    const restoredTuning = page.locator('aside[aria-label="material dossier"]');
    await restoredTuning
      .getByRole("group", { name: "tuning view" })
      .getByRole("button", { name: "scene" })
      .click();
    await expect(
      restoredTuning.getByRole("slider", { name: /mouse force/i }),
    ).toHaveValue("4.2");
  });

  test("material changes shelf pushes the dossier up and supports keyboard compare, undo, redo, and reset", async ({
    page,
  }) => {
    test.slow();
    await openAuthoringSurface(page);

    const tuning = page.locator('aside[aria-label="material dossier"]');
    const shelf = page.locator(".material-edit-shelf");
    const track = page.locator(".material-cabinet__track");
    const baseline = await behaviorControl(page).getAttribute("aria-label");
    await expect(shelf).toHaveAttribute("data-open", "false");
    await expect(page.getByRole("region", { name: "material changes" })).toHaveCount(0);
    const before = await track.boundingBox();

    const firstEdit = await editBehavior(page);
    const secondEdit = await editBehavior(page, "ArrowUp");
    await expectShelfPushesContent(page);
    const after = await track.boundingBox();
    expect(before!.height - after!.height).toBeGreaterThan(70);
    await expect(shelf.getByRole("status")).toHaveText("unsaved changes · original unchanged");
    await expect(tuning.locator(".material-edit-shelf")).toHaveCount(0);

    const compare = shelf.getByRole("group", { name: "compare appearance" });
    const original = compare.getByRole("button", { name: "original", exact: true });
    const edited = compare.getByRole("button", { name: "edited", exact: true });
    await original.focus();
    await original.press("Enter");
    await expect(original).toHaveAttribute("aria-pressed", "true");
    await edited.focus();
    await edited.press("Space");
    await expect(edited).toHaveAttribute("aria-pressed", "true");

    const undo = shelf.getByRole("button", { name: "undo", exact: true });
    const redo = shelf.getByRole("button", { name: "redo", exact: true });
    await undo.focus();
    await undo.press("Enter");
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", firstEdit);
    await expect(redo).toBeEnabled();
    await redo.focus();
    await redo.press("Enter");
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", secondEdit);

    const reset = shelf.getByRole("button", { name: "reset changes" });
    await reset.focus();
    await reset.press("Enter");
    await expect(shelf).toHaveAttribute("data-open", "false");
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", baseline!);
    await expect.poll(() => shelf.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await expect(tuning.getByText("fine tune", { exact: true })).toBeVisible();
  });

  test("material changes recover after reload and save as a new swatch without changing the original", async ({ page }) => {
    test.slow();
    await openAuthoringSurface(page);
    const originalName = (await page.locator(".cabinet-material-header h2").textContent())!.trim();
    const baseline = await behaviorControl(page).getAttribute("aria-label");
    const originalPresets = await readLocalPresets(page);
    const editedBehavior = await editBehavior(page);
    const shelf = page.locator(".material-edit-shelf");
    await expect(shelf.getByRole("status")).toContainText("unsaved changes");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(shelf).toHaveAttribute("data-open", "true", { timeout: 30_000 });
    if (await page.locator(".material-cabinet").getAttribute("data-face") === "archive") {
      await page.getByRole("button", { name: "show material dossier" }).click();
    }
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", editedBehavior);
    await expect(shelf.getByRole("status")).toContainText("unsaved changes");
    expect(await readLocalPresets(page)).toEqual(originalPresets);

    await shelf.getByRole("button", { name: "save as new swatch" }).click();
    await expect(shelf.getByRole("status")).toHaveText("saved to swatch archive", { timeout: 30_000 });
    const savedName = (await page.locator(".cabinet-material-header h2").textContent())!.trim();
    expect(savedName).not.toBe(originalName);
    const savedPresets = await readLocalPresets(page);
    expect(savedPresets).toHaveLength(originalPresets.length + 1);
    for (const preset of originalPresets) {
      expect(savedPresets.find((candidate) => candidate.slug === preset.slug)).toEqual(preset);
    }
    expect(savedPresets.some((preset) => preset.name === savedName)).toBe(true);

    await shelf.getByRole("button", { name: "view swatch" }).click();
    const archive = page.locator('[data-cabinet-face="archive"]');
    await expect(archive.getByRole("button", { name: savedName, exact: true })).toHaveAttribute("aria-pressed", "true");
    await archive.getByRole("button", { name: originalName, exact: true }).click();
    await page.getByRole("button", { name: "show material dossier" }).click();
    await expect(page.locator(".cabinet-material-header h2")).toHaveText(originalName);
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", baseline!);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: savedName, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(shelf).toHaveAttribute("data-open", "false");
  });

  test("material changes stay unsaved when unrelated copies and swatch reorders finish saving", async ({ page }) => {
    test.slow();
    await openAuthoringSurface(page);
    const editedBehavior = await editBehavior(page);
    await page.getByRole("button", { name: "show swatch archive" }).click();
    const library = page.locator('[data-cabinet-face="archive"] section[data-dye="mugwort"]');
    const count = await library.locator("li.swatch").count();
    const clone = page.getByRole("button", { name: "duplicate e2e swatch into library", exact: true });
    await clone.click();
    await expect(library.locator("li.swatch")).toHaveCount(count + 1, { timeout: 30_000 });
    await clone.click();
    await expect(library.locator("li.swatch")).toHaveCount(count + 2, { timeout: 30_000 });
    const grip = library.getByRole("button", { name: /^reorder / }).last();
    await grip.focus();
    await grip.press("ArrowUp");
    await expect(page.locator(".save-status")).toHaveAttribute("data-status", "dirty");
    await expect(page.locator(".material-edit-shelf").getByRole("status")).toHaveText("unsaved changes · original unchanged");
    await page.getByRole("button", { name: "show material dossier" }).click();
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", editedBehavior);
  });

  test("material changes guard lets users cancel or discard before switching swatches", async ({ page }) => {
    test.slow();
    await openAuthoringSurface(page);
    const originalName = (await page.locator(".cabinet-material-header h2").textContent())!.trim();
    const editedBehavior = await editBehavior(page);
    await page.getByRole("button", { name: "show swatch archive" }).click();
    const target = page.getByRole("button", { name: "e2e swatch", exact: true });
    await target.click();
    const dialog = page.getByRole("dialog", { name: "save changes before leaving" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "save & switch", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(target).toBeFocused();
    await expect(page.locator(".cabinet-material-header h2")).toHaveText(originalName);
    await expect(behaviorControl(page)).toHaveAttribute("aria-label", editedBehavior);
    await target.click();
    await dialog.getByRole("button", { name: "discard & switch", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(target).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    await expect(page.locator(".material-edit-shelf")).toHaveAttribute("data-open", "false");
  });

  test("material changes guard saves a new swatch before switching", async ({ page }) => {
    test.slow();
    await openAuthoringSurface(page);
    const originalName = (await page.locator(".cabinet-material-header h2").textContent())!.trim();
    const initialPresets = await readLocalPresets(page);
    await editBehavior(page);
    await page.getByRole("button", { name: "show swatch archive" }).click();
    const target = page.getByRole("button", { name: "e2e swatch", exact: true });
    await target.click();
    const dialog = page.getByRole("dialog", { name: "save changes before leaving" });
    await dialog.getByRole("button", { name: "save & switch", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(target).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    const saved = (await readLocalPresets(page)).find((preset) =>
      !initialPresets.some((initial) => initial.slug === preset.slug)
      && preset.name.startsWith(originalName),
    );
    expect(saved).toBeDefined();
    await expect(page.getByRole("button", { name: saved!.name, exact: true })).toBeVisible();
    await expect(page.locator(".material-edit-shelf")).toHaveAttribute("data-open", "false");
  });

  test.describe("compact material changes shelf", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("keeps touch controls above the bottom edge and removes reveal motion when reduced motion is requested", async ({ page }) => {
      test.slow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openAuthoringSurface(page);
      const behavior = behaviorControl(page);
      await behavior.scrollIntoViewIfNeeded();
      await behavior.tap({ position: { x: 32, y: 32 } });
      const shelf = page.locator(".material-edit-shelf");
      await expectShelfPushesContent(page);
      const save = shelf.getByRole("button", { name: "save as new swatch" });
      const box = await save.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(await shelf.evaluate((element) => getComputedStyle(element).transitionDuration))
        .toMatch(/^(0s|0s,\s*0s)$/);
      const compare = shelf.getByRole("group", { name: "compare appearance" });
      await compare.getByRole("button", { name: "original", exact: true }).tap();
      await expect(compare.getByRole("button", { name: "original", exact: true })).toHaveAttribute("aria-pressed", "true");
      await compare.getByRole("button", { name: "edited", exact: true }).tap();
      await shelf.getByRole("button", { name: "reset changes" }).tap();
      await expect(shelf).toHaveAttribute("data-open", "false");
    });
  });
});
