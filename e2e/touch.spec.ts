import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "playwright/test";

const ROOM_PATH = "/";

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
  await page.goto(ROOM_PATH, { waitUntil: "domcontentloaded" });

  const cabinet = page.locator(".material-cabinet");
  await expect(cabinet).toHaveAttribute("data-face", "archive", {
    timeout: 30_000,
  });
  // The light controller writes this attribute after hydration. It is a much
  // earlier signal than sample/map loading when headless Chromium is compiling
  // the cloth shaders through its software WebGL fallback.
  await expect(page.locator(".room-frame")).toHaveAttribute(
    "data-room-light-position",
    /.+/,
    { timeout: 90_000 },
  );
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
      expectNear(state.rect[dimension], state.planeRect[dimension], 1);
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
    const stage = document.querySelector<HTMLElement>(".room-frame__stage");
    const room = document.querySelector<HTMLElement>(".room-frame");
    const planes = document.querySelector<SVGSVGElement>(
      "svg.room-frame__planes",
    );
    if (!canvas || !stage || !room || !planes) {
      throw new Error(
        "Room window is missing its shared canvas, stage, room, or planes",
      );
    }

    const apertureRect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
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

  const [railPaint, archivePaint, materialPaint] = await Promise.all(
    [rail, archive, material].map((panel) =>
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
  expect(railPaint).toEqual(archivePaint);
  expect(materialPaint).toEqual(archivePaint);
  expect(railPaint).toMatchObject({
    backgroundImage: "none",
    backgroundColor: "rgb(248, 249, 246)",
    backdropFilter: "none",
  });
}

async function expectEnvironmentControlsRail(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "environment controls" });
  const logoHome = trigger.locator(".nav-logo-pixel-home");
  const logoPixel = logoHome.locator("canvas.nav-logo-pixel.pixel-play-over");
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
  await expect(logoHome).toHaveAttribute("aria-hidden", "true");
  await expect(logoPixel).toHaveAttribute("aria-hidden", "true");
  await expect(logoPixel).toHaveCSS("pointer-events", "none");
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
  await logoHome.evaluate((element) => {
    element.addEventListener(
      "pointerdown",
      () => {
        element.setAttribute("data-test-touchdown", "true");
      },
      { once: true },
    );
  });
  const logoHomeBox = await logoHome.boundingBox();
  if (!logoHomeBox) throw new Error("Logo pixel home is not rendered");
  await page.touchscreen.tap(
    logoHomeBox.x + logoHomeBox.width / 2,
    logoHomeBox.y + logoHomeBox.height / 2,
  );
  await expect(logoHome).toHaveAttribute("data-test-touchdown", "true");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(logoHome).toHaveAttribute("data-pressed", "true");
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
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe(
    bodyOverflow,
  );

  const [railBox, archiveBox] = await Promise.all([
    rail.boundingBox(),
    archive.boundingBox(),
  ]);
  expect(railBox).not.toBeNull();
  expect(archiveBox).not.toBeNull();
  if (railBox && archiveBox) {
    expect(
      Math.abs(railBox.y + railBox.height - page.viewportSize()!.height),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(archiveBox.y + archiveBox.height - page.viewportSize()!.height),
    ).toBeLessThanOrEqual(1);
    expect(railBox.y).toBeLessThan(
      archiveBox.y + archiveBox.height,
    );
  }
  await expectRailAlignedWithArchive(rail, archive, material);

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

  for (const name of [
    "time of day",
    "exposure",
    "warmth",
    "ambient fill",
    "cycle speed",
  ]) {
    await expect(rail.getByRole("slider", { name, exact: true })).toHaveCount(1);
  }
  const projection = rail.locator("details.room-light-modal__group", {
    has: page.getByText("projection", { exact: true }),
  });
  const response = rail.locator("details.room-light-modal__group", {
    has: page.getByText("fabric response", { exact: true }),
  });
  await expect(projection).not.toHaveAttribute("open", "");
  await expect(response).not.toHaveAttribute("open", "");
  await projection.locator("summary").tap({ force: true });
  await expect(projection).toHaveAttribute("open", "");
  await expect(shell).toHaveAttribute("data-open", "true");
  await expect(
    projection.getByRole("slider", { name: "light patch" }),
  ).toBeVisible();
  await expect(
    projection.getByRole("slider", { name: "edge softness" }),
  ).toBeVisible();

  const cycle = rail.getByRole("switch", { name: "day / night cycle" });
  await expect(cycle).toHaveJSProperty("type", "checkbox");
  await expect(cycle).toBeChecked();
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
  await showMaterial.tap();
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(cabinet).toHaveAttribute("data-face", "material");
  await page.getByRole("button", { name: "show swatch archive" }).tap();
  await expect(cabinet).toHaveAttribute("data-face", "archive");

  await trigger.tap({ force: true });
  await expect(shell).toHaveAttribute("data-open", "true");
  await rail.getByRole("slider", { name: "time of day" }).focus();
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(rail).toHaveAttribute("aria-hidden", "true");
  await expect(rail).toHaveAttribute("inert", "");
  await expect(trigger).toBeFocused();
  await trigger.tap({ force: true });
  await expect(shell).toHaveAttribute("data-open", "true");
  await trigger.tap({ force: true });
  await expect(shell).toHaveAttribute("data-open", "false");
  await expect(trigger).toBeFocused();
}

async function showMaterialFace(page: Page): Promise<Locator> {
  const cabinet = page.locator(".material-cabinet");
  await page
    .getByRole("button", { name: "show material dossier" })
    .tap({ force: true });
  await expect(cabinet).toHaveAttribute("data-face", "material");
  const materialFace = cabinet.locator('[data-cabinet-face="material"]');
  await expect(materialFace).toHaveAttribute("data-active", "true");
  await expect(materialFace).toHaveAttribute("aria-hidden", "false");
  await expect(materialFace).not.toHaveAttribute("inert", "");
  return materialFace;
}

function expectNear(actual: number, expected: number, tolerance = 2): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function relativeX(parent: Locator, child: Locator): Promise<number | null> {
  const [parentBox, childBox] = await Promise.all([
    parent.boundingBox(),
    child.boundingBox(),
  ]);
  if (!parentBox || !childBox) return null;
  return Math.round(childBox.x - parentBox.x);
}

async function expectCabinetFaceOwnsScroll(face: Locator): Promise<void> {
  const inner = face.locator(".cabinet-pane__scroll");
  await expect(face).toHaveAttribute("data-active", "true");
  await expect(face).toHaveCSS("overflow-y", "auto");
  await expect(inner).toHaveCount(1);
  await expect(inner).toHaveCSS("overflow-y", "visible");

  const innerScrollTop = await inner.evaluate((element) => {
    element.scrollTop = 48;
    return element.scrollTop;
  });
  expect(innerScrollTop).toBe(0);

  const outerScroll = await face.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(outerScroll.scrollHeight).toBeGreaterThan(outerScroll.clientHeight);
  expect(outerScroll.scrollTop).toBeGreaterThan(0);
  await face.evaluate((element) => {
    element.scrollTop = 0;
  });
}

test.describe("coarse-pointer room instrument", () => {
  test.describe.configure({ timeout: 120_000 });

  test("keeps prewarped room texture plates registered to the mobile planes", async ({
    page,
  }) => {
    test.slow();
    await openTouchSurface(page);
    await expectBakedRoomTextures(page);
    await expectLowPolyRoomWindow(page);
    await expectRoomLightField(page);
  });

  test("keeps the archive as the default lower-third cabinet and slides mounted faces side by side", async ({
    page,
  }) => {
    await openTouchSurface(page);

    const viewport = page.viewportSize();
    const stage = page.locator(".room-frame__stage");
    const cabinetSlot = page.locator(".room-frame__cabinet");
    const cabinet = page.locator(".material-cabinet");
    const track = cabinet.locator(".material-cabinet__track");
    const archiveFace = cabinet.locator('[data-cabinet-face="archive"]');
    const materialFace = cabinet.locator('[data-cabinet-face="material"]');
    const flip = cabinet.locator(".material-cabinet__flip");
    const materialIcon = flip.locator(
      '.material-cabinet__flip-icon[data-destination="material"]',
    );
    const archiveIcon = flip.locator(
      '.material-cabinet__flip-icon[data-destination="archive"]',
    );
    const [stageBox, cabinetBox, cabinetInnerBox, flipBox] = await Promise.all([
      stage.boundingBox(),
      cabinetSlot.boundingBox(),
      cabinet.boundingBox(),
      flip.boundingBox(),
    ]);

    expect(viewport).not.toBeNull();
    expect(stageBox).not.toBeNull();
    expect(cabinetBox).not.toBeNull();
    expect(cabinetInnerBox).not.toBeNull();
    expect(flipBox).not.toBeNull();
    const cabinetWidth = Math.round(cabinetBox?.width ?? viewport?.width ?? 0);
    if (viewport && stageBox && cabinetBox) {
      expectNear(cabinetBox.height, viewport.height / 3);
      expectNear(cabinetBox.y, viewport.height * (2 / 3));
      expectNear(cabinetBox.y + cabinetBox.height, viewport.height);
      expectNear(stageBox.y, 0);
      expectNear(stageBox.height, viewport.height * (2 / 3));
      expectNear(stageBox.y + stageBox.height, cabinetBox.y);
    }
    if (cabinetInnerBox && flipBox) {
      expectNear(flipBox.width, 44, 0.5);
      expectNear(flipBox.height, 44, 0.5);
      expectNear(flipBox.x, cabinetInnerBox.x, 1);
      expectNear(flipBox.y, cabinetInnerBox.y, 1);
    }

    await expect(cabinet).toHaveAttribute("data-face", "archive");
    await expect(flip).toHaveCSS("top", "0px");
    await expect(flip).toHaveCSS("left", "0px");
    await expect(flip).toHaveCSS("border-width", "0px");
    await expect(flip).toHaveCSS("border-radius", "0px 0px 0px 12px");
    await expect(page.locator(".material-cabinet__aperture")).toHaveCount(0);
    await expect(flip.locator("svg")).toHaveCount(2);
    await expect(materialIcon).toHaveCount(1);
    await expect(archiveIcon).toHaveCount(1);
    await expect(materialIcon).toHaveAttribute("viewBox", "0 0 24 24");
    await expect(archiveIcon).toHaveAttribute("viewBox", "0 0 24 24");
    await expect(materialIcon.locator("line")).toHaveCount(9);
    await expect(archiveIcon.locator("rect")).toHaveCount(4);
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(archiveIcon).toHaveCSS("opacity", "0");
    await expect(archiveFace).toHaveAttribute("data-active", "true");
    await expect(archiveFace).toHaveAttribute("aria-hidden", "false");
    await expect(archiveFace).not.toHaveAttribute("inert", "");
    await expect(archiveFace).toHaveCSS(
      "background-color",
      "rgb(248, 249, 246)",
    );
    await expect(archiveFace).toHaveCSS("background-image", "none");
    await expect(archiveFace).toHaveCSS("backdrop-filter", "none");
    await expect(archiveFace).toHaveCSS("border-top-width", "0px");
    await expect(archiveFace).toHaveCSS("box-shadow", "none");
    await expect(materialFace).toHaveAttribute("data-active", "false");
    await expect(materialFace).toHaveAttribute("aria-hidden", "true");
    await expect(materialFace).toHaveAttribute("inert", "");
    await expect(cabinet).toHaveCSS("overflow", "hidden");
    await expectCabinetFaceOwnsScroll(archiveFace);
    expect(
      await track.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      ),
    ).toContain("transform");
    expect(
      Number.parseFloat(
        await track.evaluate(
          (element) => getComputedStyle(element).transitionDuration,
        ),
      ),
    ).toBeGreaterThan(0);
    await expect
      .poll(() =>
        track.evaluate((element) => {
          const parent = element.parentElement;
          if (!parent?.clientWidth) return null;
          return Math.round((element.clientWidth / parent.clientWidth) * 100);
        }),
      )
      .toBe(200);
    await expect.poll(() => relativeX(cabinet, archiveFace)).toBe(0);
    await expect
      .poll(() => relativeX(cabinet, materialFace))
      .toBe(cabinetWidth);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await showMaterialFace(page);
    await expect(materialIcon).toHaveCSS("opacity", "0");
    await expect(archiveIcon).toHaveCSS("opacity", "1");
    await expectCabinetFaceOwnsScroll(materialFace);
    await expect(archiveFace).toHaveAttribute("data-active", "false");
    await expect(archiveFace).toHaveAttribute("aria-hidden", "true");
    await expect(archiveFace).toHaveAttribute("inert", "");
    await expect.poll(() => relativeX(cabinet, materialFace)).toBe(0);
    await expect
      .poll(async () => {
        const x = await relativeX(cabinet, archiveFace);
        return x === null ? null : x <= -cabinetWidth * 0.9;
      })
      .toBe(true);
    await expect(
      materialFace.getByRole("group", { name: "tuning view" }),
    ).toBeVisible();

    const switchFace = page.getByRole("button", {
      name: "show swatch archive",
    });
    await switchFace.tap({ force: true });
    await expect(cabinet).toHaveAttribute("data-face", "archive");
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(archiveIcon).toHaveCSS("opacity", "0");
    await expect.poll(() => relativeX(cabinet, archiveFace)).toBe(0);
    await expect.poll(() => relativeX(cabinet, materialFace)).toBe(cabinetWidth);
    await expect(page.getByText("swatch archive", { exact: true })).toBeVisible();

    // Reduced motion keeps the same spatial model but moves the rail without
    // interpolation, so the selected face never gets stranded off-canvas.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await showMaterialFace(page);
    expect(
      Number.parseFloat(
        await track.evaluate(
          (element) => getComputedStyle(element).transitionDuration,
        ),
      ),
    ).toBeLessThan(0.001);
    for (const icon of [materialIcon, archiveIcon]) {
      const reducedIconMotion = await icon.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          durations: style.transitionDuration
            .split(",")
            .map((duration) => Number.parseFloat(duration)),
          delays: style.transitionDelay
            .split(",")
            .map((delay) => Number.parseFloat(delay)),
          filter: style.filter,
        };
      });
      expect(reducedIconMotion.durations.every((duration) => duration < 0.001)).toBe(
        true,
      );
      expect(reducedIconMotion.delays.every((delay) => delay < 0.001)).toBe(true);
      expect(reducedIconMotion.filter).toBe("none");
    }
    await expect(materialIcon).toHaveCSS("opacity", "0");
    await expect(archiveIcon).toHaveCSS("opacity", "1");
    await expect.poll(() => relativeX(cabinet, materialFace)).toBe(0);
    await expect
      .poll(async () => {
        const x = await relativeX(cabinet, archiveFace);
        return x === null ? null : Math.abs(x + cabinetWidth) <= 10;
      })
      .toBe(true);
    await page
      .getByRole("button", { name: "show swatch archive" })
      .tap({ force: true });
    await expect(materialIcon).toHaveCSS("opacity", "1");
    await expect(archiveIcon).toHaveCSS("opacity", "0");
    await expect.poll(() => relativeX(cabinet, archiveFace)).toBe(0);
    await expect
      .poll(() => relativeX(cabinet, materialFace))
      .toBe(cabinetWidth);
    await expect(archiveFace).toHaveCSS("backdrop-filter", "none");
  });

  test("opens the nonmodal environment rail and preserves the shared preview", async ({
    page,
  }) => {
    test.slow();
    await openTouchSurface(page);
    await expectEnvironmentControlsRail(page);
  });

  test("keeps swatches, map editing, one-finger cloth, and two-finger loupe reachable", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openTouchSurface(page);

    const duplicate = page.getByRole("button", {
      name: "duplicate touch swatch into library",
    });
    await expect(duplicate).toBeVisible({ timeout: 90_000 });
    await duplicate.tap({ force: true });
    await expect(
      page.getByRole("button", {
        name: "duplicate touch swatch copy",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });

    const materialFace = await showMaterialFace(page);
    const mapButton = materialFace.getByRole("button", {
      name: "edit albedo map pixels",
    });
    await expect(mapButton).toBeVisible({ timeout: 90_000 });
    // The cabinet face completes its physical flip while the software renderer
    // is still warming up. Scroll directly so Playwright does not mistake that
    // intentional transform for an indefinitely unstable button.
    await mapButton.evaluate((button: HTMLButtonElement) =>
      button.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await mapButton.tap({ force: true });

    const mapDialog = page.getByRole("dialog", { name: "albedo map" });
    await expect(mapDialog).toBeVisible();
    const close = mapDialog.getByRole("button", {
      name: "close albedo map editor",
    });
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    await mapDialog.getByRole("button", { name: "faded" }).tap({ force: true });
    await expect(mapDialog.getByRole("button", { name: "faded" })).toHaveAttribute(
      "data-active",
      "true",
    );
    await close.tap({ force: true });
    await expect(mapDialog).toHaveCount(0);

    const sceneHost = page.locator(".stage > div").first();
    const canvas = sceneHost.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect(sceneHost).toHaveAttribute(
      "data-material-loupe-enabled",
      "false",
    );
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    if (canvasBox) {
      const cdp = await page.context().newCDPSession(page);
      const x = canvasBox.x + canvasBox.width * 0.5;
      const y = canvasBox.y + canvasBox.height * 0.45;

      // One contact belongs to the cloth solver and must not invoke the loupe.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 0 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + 34, y: y - 18, id: 0 }],
      });
      await expect(sceneHost).not.toHaveAttribute("data-material-loupe", "visible");
      await expect(sceneHost).toHaveAttribute(
        "data-material-loupe-enabled",
        "false",
      );
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });

      // Two contacts switch to the bounded renderer-native inspection pass.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: x - 30, y, id: 0 },
          { x: x + 30, y, id: 1 },
        ],
      });
      await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
      await expect(sceneHost).toHaveAttribute(
        "data-material-loupe-enabled",
        "false",
      );
      const loupeRing = sceneHost.locator(".cloth-scene__loupe-ring");
      await expect(loupeRing).toBeVisible();
      await expect(loupeRing).toHaveCSS("opacity", "1");
      expect(
        await loupeRing.evaluate(
          (element) => getComputedStyle(element).pointerEvents,
        ),
      ).toBe("none");
      await expect(sceneHost).toHaveCSS("overflow", "visible");
      await expect(page.locator(".room-frame__stage > .stage")).toHaveCSS(
        "overflow",
        "visible",
      );
      await expect(page.locator(".room-frame__stage")).toHaveCSS(
        "overflow",
        "visible",
      );
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: canvasBox.x + 8, y: y - 10, id: 0 },
          { x: canvasBox.x + 24, y: y + 8, id: 1 },
        ],
      });
      await expect(sceneHost).toHaveAttribute("data-material-loupe", "visible");
      const ringBox = await loupeRing.boundingBox();
      expect(ringBox).not.toBeNull();
      if (ringBox) {
        // The renderer content stops at the canvas. Its one-pixel DOM rim is
        // deliberately allowed to cross that edge instead of being clipped.
        expect(ringBox.x).toBeLessThan(canvasBox.x);
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(sceneHost).toHaveAttribute("data-material-loupe", "hidden");
      await expect(loupeRing).toHaveCSS("opacity", "0");

      // A fresh one-finger tap still works after the two-finger handoff.
      await page.touchscreen.tap(x, y);
    }

    expect(pageErrors).toEqual([]);
  });

  test("keeps the map editor save action reachable in phone landscape", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 390 });
    await openTouchSurface(page);
    const materialFace = await showMaterialFace(page);
    const mapButton = materialFace.getByRole("button", {
      name: "edit albedo map pixels",
    });
    await expect(mapButton).toBeVisible({ timeout: 90_000 });
    await mapButton.evaluate((button: HTMLButtonElement) =>
      button.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    // In a 130px landscape sheet the element can be clipped between touch
    // actionability samples even after scrolling; invoke its native button
    // activation, then verify the resulting dialog is fully reachable.
    await mapButton.evaluate((button: HTMLButtonElement) => button.click());
    const dialog = page.getByRole("dialog", { name: "albedo map" });
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole("button", { name: "save as variation" });
    await expect(save).toBeVisible();
    const box = await save.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.y + box.height).toBeLessThanOrEqual(390);
  });
});
