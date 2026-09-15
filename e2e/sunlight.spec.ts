import { expect, test, type Locator } from "playwright/test";

const FIXTURE = "/room/components/preview?component=sunlight";
const IMAGE = /\/2d-textures\/room-sunlight-[^/?]+\.png(?:\?|$)/;
const FLOOR_RECEIVER = '.room-frame__sunlight-receiver[data-receiver="floor"]';
const WALL_RECEIVER = '.room-frame__sunlight-receiver[data-receiver="right-wall"]';

// Sample the whole clock through the real input event path. Hundreds of
// individual key presses would dominate these optical tests; separate checks
// below exercise actual keyboard, mouse, and touch contact with the controls.
async function setClock(time: Locator, position: number) {
  const ticks = Math.round(position * 1000);
  await time.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, ticks / 1000);
  await expect(time).toHaveValue(String(ticks / 1000));
}

async function expectFrames(root: Locator, indices: number[], weights?: number[]) {
  for (const receiver of [FLOOR_RECEIVER, WALL_RECEIVER]) {
    const layer = root.locator(receiver);
    await expect(layer.locator("img")).toHaveCount(indices.length);
    await expect.poll(() => layer.locator("img").evaluateAll(images => images.map(image =>
      Number(image.getAttribute("data-sunlight-frame"))))).toEqual(indices);
    if (weights) {
      await expect.poll(async () => {
        const opacities = await layer.locator("img").evaluateAll(images => images.map(image =>
          Number(getComputedStyle(image.closest(".room-frame__sunlight-plate")!).opacity)));
        return Math.max(...opacities.map((opacity, index) => Math.abs(opacity - weights[index])));
      }).toBeLessThan(0.00001);
      const actual = await layer.locator("img").evaluateAll(images => images.map(image => ({
        opacity: Number(getComputedStyle(image.closest(".room-frame__sunlight-plate")!).opacity),
        weight: Number(getComputedStyle(image).getPropertyValue(
          `--room-bake-mix-${image.getAttribute("data-sunlight-frame")}`)),
      })));
      actual.forEach((image, index) => {
        expect(image.opacity).toBeCloseTo(weights[index], 5);
        expect(image.weight).toBeCloseTo(weights[index], 5);
      });
      expect(actual.reduce((sum, image) => sum + image.opacity, 0)).toBeCloseTo(1, 5);
    }
  }
}

async function lightState(root: Locator) {
  return root.evaluate(element => {
    const style = getComputedStyle(element);
    const floor = element.querySelector('.room-frame__sunlight-receiver[data-receiver="floor"]');
    const wall = element.querySelector('.room-frame__sunlight-receiver[data-receiver="right-wall"]');
    const dapple = element.querySelector(".room-frame__dapple")!;
    const shade = element.querySelector(".room-frame__sunlight-shade")!;
    const windowBloom = element.querySelector(".room-frame__window-bloom")!;
    const windowNight = getComputedStyle(element.querySelector("[data-room-window-mask]")!, "::after");
    return {
      weight: Number(style.getPropertyValue("--room-bake-weight")),
      active: Number(style.getPropertyValue("--room-bake-active")),
      dappleAmount: Number(style.getPropertyValue("--room-dapple-opacity")),
      fallbackOpacity: Number(getComputedStyle(dapple).opacity),
      receiverOpacity: floor ? Number(getComputedStyle(floor).opacity) : null,
      wallReceiverOpacity: wall ? Number(getComputedStyle(wall).opacity) : null,
      shadeOpacity: Number(getComputedStyle(shade).opacity),
      windowBloomOpacity: Number(getComputedStyle(windowBloom).opacity),
      windowNightOpacity: Number(windowNight.opacity),
      windowNightPaint: windowNight.backgroundImage,
    };
  });
}

async function expectWindowGeometry(root: Locator, viewport: { width: number; height: number }) {
  const vector = root.locator(".room-frame__window-vector");
  await expect(vector).toHaveAttribute("data-frame-renderer", "vector");
  for (const kind of ["frame", "sill", "aperture"]) {
    await expect(vector.locator(`[data-window-path="${kind}"]`)).toHaveAttribute("d", /^M.+Z$/);
  }
  await expect.poll(() => vector.evaluate(element => element.getBoundingClientRect().width))
    .toBeCloseTo(viewport.height * 1.05769231, 1);
  await expect.poll(() => root.evaluate(element => {
    const aperture = element.querySelector("[data-room-window-mask]")!;
    const bounds = aperture.getBoundingClientRect();
    const room = element.getBoundingClientRect();
    const vanishingX = room.left + room.width * (5639.759259 / 1280);
    const expected = Math.min(0.98, Math.max(0.35,
      (vanishingX - bounds.right) / (vanishingX - bounds.left)));
    const numbers = element.querySelector('[data-window-path="aperture"]')!.getAttribute("d")!
      .match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi)!.map(Number);
    return Math.abs(numbers[5] / bounds.height - expected);
  })).toBeLessThan(0.00001);
  const geometry = await root.evaluate(element => {
    const vector = element.querySelector<SVGSVGElement>(".room-frame__window-vector")!;
    const aperture = element.querySelector("[data-room-window-mask]")!;
    const bounds = aperture.getBoundingClientRect();
    const room = element.getBoundingClientRect();
    const transform = vector.getScreenCTM()!;
    const paths = (kind: string) => {
      const d = vector.querySelector(`[data-window-path="${kind}"]`)!.getAttribute("d")!;
      return d.split(/(?=M)/).map(subpath => {
        const numbers = (subpath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
        const points = [];
        for (let index = 0; index < numbers.length; index += 2) {
          const point = new DOMPoint(numbers[index], numbers[index + 1]).matrixTransform(transform);
          points.push({ x: point.x, y: point.y });
        }
        return points;
      });
    };
    return {
      room: { left: room.left, width: room.width },
      bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      frame: paths("frame"), sill: paths("sill"), aperture: paths("aperture"),
      clip: getComputedStyle(aperture).clipPath.replace(/^polygon\(|\)$/g, "")
        .split(",").map(point => point.trim().split(/\s+/).map(Number.parseFloat)),
    };
  });
  // Independent vanishing-point oracle: the DOM clip and both render adapters
  // must use the same room perspective, not the old fixed 84.5% fallback.
  const { bounds, room } = geometry;
  const vanishingX = room.left + room.width * (5639.759259 / 1280);
  const scale = Math.min(0.98, Math.max(0.35,
    (vanishingX - bounds.left - bounds.width) / (vanishingX - bounds.left)));
  const expectedAperture = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top + bounds.height * scale },
    { x: bounds.left, y: bounds.top + bounds.height },
  ];
  const expectPoint = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
    expect(actual.x).toBeCloseTo(expected.x, 2);
    expect(actual.y).toBeCloseTo(expected.y, 2);
  };
  expect(geometry.frame).toHaveLength(11);
  expect(geometry.sill).toHaveLength(1);
  expect(geometry.aperture).toHaveLength(1);
  for (const quad of [...geometry.frame, ...geometry.sill, ...geometry.aperture]) {
    expect(quad).toHaveLength(4);
    expect(quad.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  }
  geometry.aperture[0].forEach((point, index) => expectPoint(point, expectedAperture[index]));
  expect(geometry.clip).toHaveLength(4);
  geometry.clip.forEach((point, index) => expectPoint({
    x: bounds.left + point[0] / 100 * bounds.width,
    y: bounds.top + point[1] / 100 * bounds.height,
  }, expectedAperture[index]));
  // One flush sill joins both jambs and the aperture's lower edge exactly.
  const sill = geometry.sill[0];
  expectPoint(sill[0], geometry.frame[0][1]);
  expectPoint(sill[3], geometry.frame[5][2]);
  expectPoint(sill[1], expectedAperture[3]);
  expectPoint(sill[2], expectedAperture[2]);
  expect(sill[3].y).toBeLessThan(sill[2].y);
  expect(sill[2].x).toBeGreaterThan(0);
  expect(sill[2].x).toBeLessThan(viewport.width);
  expect(sill[2].y).toBeGreaterThan(0);
  expect(sill[2].y).toBeLessThan(viewport.height);
}

for (const viewport of [{ width: 1280, height: 832 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px sunlight fixture`, () => {
    test.use({ viewport, hasTouch: viewport.width === 390 });

    test("loads the morning plate onto the measured room and switches treatments", async ({ page }) => {
      const errors: string[] = [];
      const requestedPlates = new Set<string>();
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (IMAGE.test(request.url())) requestedPlates.add(new URL(request.url()).pathname);
      });
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      const image = root.locator(".room-frame__sunlight-bake");
      const wallImage = root.locator(".room-frame__wall-sunlight-bake");
      const wallLight = root.locator(".room-frame__wall-light");
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight", "baked");
      await expectFrames(root, [1], [1]);
      // Both receivers share one fetched plate. Other times are not preloaded.
      expect([...requestedPlates]).toEqual([new URL((await image.getAttribute("src"))!, page.url()).pathname]);
      await expect(wallLight).toHaveCSS("visibility", "visible");
      await expect.poll(async () => (await lightState(root)).active).toBe(1);
      expect(await image.evaluate((element: HTMLImageElement) => ({
        complete: element.complete,
        width: element.naturalWidth,
        height: element.naturalHeight,
      }))).toEqual({ complete: true, width: 1024, height: 512 });
      expect(await wallImage.evaluate((element: HTMLImageElement) => ({
        complete: element.complete,
        width: element.naturalWidth,
        height: element.naturalHeight,
      }))).toEqual({ complete: true, width: 1024, height: 512 });
      expect(await wallImage.getAttribute("src")).toBe(await image.getAttribute("src"));
      const floorFilterId = await root.locator(".room-frame__ground-light filter").getAttribute("id");
      const wallFilterId = await wallLight.locator("filter").getAttribute("id");
      expect(floorFilterId).toBeTruthy();
      expect(wallFilterId).toBeTruthy();
      expect(wallFilterId).not.toBe(floorFilterId);
      expect(await wallImage.evaluate(element => getComputedStyle(element).filter)).toContain(`#${wallFilterId}`);

      const geometry = await root.evaluate(element => {
        const rect = (selector: string) => {
          const bounds = element.querySelector(selector)!.getBoundingClientRect();
          return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
        };
        const bounds = element.getBoundingClientRect();
        const transform = getComputedStyle(element.querySelector(".room-frame__sunlight-bake")!.closest(".room-frame__sunlight-plate")!).transform;
        const wallTransform = getComputedStyle(element.querySelector(".room-frame__wall-sunlight-bake")!.closest(".room-frame__sunlight-plate")!).transform;
        const clipPoints = (selector: string) => getComputedStyle(element.querySelector(selector)!).clipPath
          .replace(/^polygon\(|\)$/g, "").split(",").map(point => point.trim().split(/\s+/).map(Number.parseFloat));
        return {
          room: { width: bounds.width, height: bounds.height },
          planes: rect(".room-frame__planes"),
          aperture: rect("[data-room-window-mask]"),
          transform,
          matrix: Array.from(new DOMMatrixReadOnly(transform).toFloat64Array()),
          wallTransform,
          wallMatrix: Array.from(new DOMMatrixReadOnly(wallTransform).toFloat64Array()),
          floorClip: clipPoints(".room-frame__ground-light"),
          wallClip: clipPoints(".room-frame__wall-light"),
        };
      });
      expect(geometry.room).toEqual(viewport);
      expect(geometry.planes.height).toBeCloseTo(viewport.height * (viewport.width === 390 ? 0.8 : 1), 1);
      expect(geometry.aperture.height).toBeCloseTo(viewport.height * 0.49886899, 1);
      expect(geometry.aperture.width).toBeCloseTo(viewport.height * 1.05769231, 1);
      expect(geometry.aperture.left + geometry.aperture.width).toBeCloseTo(
        viewport.width * 0.719140625 - Math.min(viewport.width * 0.083203125, viewport.height * 0.128004808),
        1,
      );
      expect(geometry.transform).toMatch(/^matrix3d\(/);
      expect(geometry.matrix).toHaveLength(16);
      expect(geometry.matrix.every(Number.isFinite)).toBe(true);
      expect(Math.abs(geometry.matrix[3]) + Math.abs(geometry.matrix[7])).toBeGreaterThan(1e-5);
      expect(geometry.wallTransform).toMatch(/^matrix3d\(/);
      expect(geometry.wallMatrix).toHaveLength(16);
      expect(geometry.wallMatrix.every(Number.isFinite)).toBe(true);
      expect(geometry.wallTransform).not.toBe(geometry.transform);
      // The two receiver clips meet at precisely the same floor/wall seam.
      // On mobile, both follow the room drawing's 80%-height crop.
      expect(geometry.wallClip).toHaveLength(4);
      expect(geometry.floorClip).toHaveLength(5);
      expect(geometry.wallClip[3]).toEqual(geometry.floorClip[0]);
      expect(geometry.wallClip[2]).toEqual(geometry.floorClip[1]);
      expect(geometry.wallClip[3][0]).toBeCloseTo(71.9140625, 3);
      expect(geometry.wallClip[3][1]).toBeCloseTo(66.6466346 * (viewport.width === 390 ? 0.8 : 1), 3);
      expect(geometry.wallClip[2][1]).toBeCloseTo(86.3091981 * (viewport.width === 390 ? 0.8 : 1), 3);
      expect(await lightState(root)).toMatchObject({ weight: 1, active: 1, fallbackOpacity: 0 });
      expect((await lightState(root)).receiverOpacity).toBeGreaterThan(0);
      expect((await lightState(root)).wallReceiverOpacity).toBeGreaterThan(0);
      expect((await lightState(root)).windowBloomOpacity).toBeGreaterThan(0);
      await expect(page.locator("canvas")).toHaveCount(0);
      await expectWindowGeometry(root, viewport);

      // Resize both across the mobile breakpoint and to a wider desktop. The
      // height-driven window keeps its scale; only its anchored position moves.
      const resized = { width: viewport.width === 390 ? 900 : 1600, height: viewport.height };
      await page.setViewportSize(resized);
      await expectWindowGeometry(root, resized);
      await page.setViewportSize(viewport);
      await expectWindowGeometry(root, viewport);

      await page.getByRole("button", { name: "previous light", exact: true }).click();
      await expect(root).toHaveAttribute("data-room-sunlight", "legacy");
      await expect(page.getByRole("button", { name: "previous light", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(image).toHaveCount(0);
      await expect(wallImage).toHaveCount(0);
      await expect(wallLight).toHaveCSS("visibility", "hidden");
      const previous = await lightState(root);
      expect(previous.active).toBe(0);
      expect(previous.fallbackOpacity).toBeGreaterThan(0);
      expect(previous.fallbackOpacity).toBeCloseTo(previous.dappleAmount, 5);
      expect(previous.shadeOpacity).toBe(0);
      expect(previous.windowBloomOpacity).toBe(0);
      await expect(page.getByRole("button", { name: "reference contrast", exact: true })).toBeDisabled();

      await page.getByRole("button", { name: "baked glass", exact: true }).click();
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      await expect(page.getByRole("button", { name: "baked glass", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await lightState(root)).active).toBe(1);
      await expect(page.getByRole("button", { name: "reference contrast", exact: true })).toBeEnabled();
      expect(errors).toEqual([]);
    });

    test("compares reference exposure without changing the bake or room geometry", async ({ page }) => {
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      const image = root.locator('.room-frame__sunlight-bake[data-sunlight-frame="1"]');
      const contrast = page.getByRole("button", { name: "reference contrast", exact: true });
      const bloom = page.getByRole("slider", { name: "bloom", exact: true });
      const floorLight = root.locator(".room-frame__ground-light");
      const directAlpha = floorLight.locator('feComponentTransfer[result="direct"] feFuncA');
      const nearBloom = floorLight.locator('feComponentTransfer[result="near-bloom"] feFuncA');
      const wideBloom = floorLight.locator('feComponentTransfer[result="wide-bloom"] feFuncA');
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect.poll(async () => (await lightState(root)).active).toBe(1);
      await expect(root).toHaveAttribute("data-room-sunlight-tone", "sunlit");
      await expect(contrast).toHaveAttribute("aria-pressed", "true");
      await expect(image).toHaveCSS("filter", /^url\(.+room-sunlight-exposure-.+\) blur\(4px\)$/);
      const exposureFilter = await image.evaluate(element => getComputedStyle(element).filter);
      const plate = await image.evaluate((element: HTMLImageElement) => ({
        source: element.currentSrc,
        transform: getComputedStyle(element).transform,
        bounds: element.getBoundingClientRect().toJSON(),
      }));
      const reference = await lightState(root);
      expect(reference.receiverOpacity).toBeCloseTo(Math.min(0.92, reference.dappleAmount * 1.5), 5);
      expect(reference.shadeOpacity).toBeGreaterThan(0);
      await expect(directAlpha).toHaveAttribute("slope", "2.85");
      await expect(bloom).toBeEnabled();
      await expect(bloom).toHaveValue("1");
      await expect(page.getByRole("slider", { name: "edge softness", exact: true })).toHaveValue("1");
      expect(reference.windowBloomOpacity).toBeGreaterThan(0);
      const bloomBounds = (await bloom.boundingBox())!;
      const contact = { position: { x: bloomBounds.width / 2, y: bloomBounds.height / 2 } };
      if (viewport.width === 390) await bloom.tap(contact);
      else await bloom.click(contact);
      await expect.poll(async () => Number(await bloom.inputValue())).toBeCloseTo(0.5, 1);
      await bloom.press("Home");
      await expect(bloom).toHaveValue("0");
      await expect(nearBloom).toHaveAttribute("slope", "0");
      await expect(wideBloom).toHaveAttribute("slope", "0");
      await expect.poll(async () => (await lightState(root)).windowBloomOpacity).toBe(0);
      await bloom.press("End");
      await expect(bloom).toHaveValue("1");
      await expect(nearBloom).toHaveAttribute("slope", "1.1");
      await expect(wideBloom).toHaveAttribute("slope", "1.25");
      await expect(directAlpha).toHaveAttribute("slope", "2.85");
      await expect.poll(async () => (await lightState(root)).windowBloomOpacity).toBeGreaterThan(0);
      await expect(image).toHaveCSS("filter", exposureFilter);
      expect(await image.evaluate((element: HTMLImageElement) => ({
        source: element.currentSrc,
        transform: getComputedStyle(element).transform,
        bounds: element.getBoundingClientRect().toJSON(),
      }))).toEqual(plate);

      await contrast.click();
      await expect(root).toHaveAttribute("data-room-sunlight-tone", "neutral");
      await expect(contrast).toHaveAttribute("aria-pressed", "false");
      await expect(bloom).toBeDisabled();
      await expect(image).toHaveCSS("filter", "blur(2px)");
      const neutral = await lightState(root);
      expect(neutral.receiverOpacity).toBeCloseTo(neutral.dappleAmount, 5);
      expect(neutral.shadeOpacity).toBe(0);
      expect(neutral.windowBloomOpacity).toBe(0);
      expect(await image.evaluate((element: HTMLImageElement) => ({
        source: element.currentSrc,
        transform: getComputedStyle(element).transform,
        bounds: element.getBoundingClientRect().toJSON(),
      }))).toEqual(plate);

      await contrast.click();
      await expect(bloom).toBeEnabled();
      await expect(image).toHaveCSS("filter", exposureFilter);
      const strength = page.getByRole("slider", { name: "light patch strength", exact: true });
      await strength.press("End");
      await expect(strength).toHaveValue("1");
      await expect.poll(async () => (await lightState(root)).receiverOpacity).toBe(0.92);
      // Display exposure is static: moving the source updates only its
      // existing projective transform / opacity, never filter parameters.
      await page.getByRole("slider", { name: "time of day", exact: true }).press("ArrowRight");
      await expect(image).toHaveCSS("filter", exposureFilter);
      await expect(directAlpha).toHaveAttribute("slope", "2.85");
      await expect(page.locator("canvas")).toHaveCount(0);
    });

    test("uses distinct daylight frames, fades only the active interval, and turns off at night", async ({ page }) => {
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      await expect.poll(async () => (await lightState(root)).weight).toBe(1);
      const time = page.getByRole("slider", { name: "time of day", exact: true });
      const windowNightPaint = (await lightState(root)).windowNightPaint;
      expect(windowNightPaint).toContain("linear-gradient");
      await expect(root.locator("[data-room-window-mask]")).toHaveCSS("background-color", "rgb(255, 255, 255)");
      const sources = new Set<string>();
      for (const [index, position] of [0.25, 0.375, 0.5, 0.625, 0.75].entries()) {
        await setClock(time, position);
        await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
        await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
        await expectFrames(root, [index], [1]);
        sources.add((await root.locator(".room-frame__sunlight-bake").getAttribute("src"))!);
        await expect.poll(async () => (await lightState(root)).active).toBe(1);
        expect((await lightState(root)).fallbackOpacity).toBe(0);
        expect((await lightState(root)).windowNightOpacity).toBe(index === 0 || index === 4 ? 0.72 : 0);
        expect((await lightState(root)).windowNightPaint).toBe(windowNightPaint);
        // Bloom / softness are display controls, unchanged by interval swaps.
        await expect(root.locator(".room-frame__sunlight-bake")).toHaveCSS("filter", /^url\(.+\) blur\(4px\)$/);
        const transforms = await root.locator(".room-frame__sunlight-plate").evaluateAll(plates =>
          plates.map(plate => Array.from(new DOMMatrixReadOnly(getComputedStyle(plate).transform).toFloat64Array())));
        expect(transforms.every(matrix => matrix.every(Number.isFinite))).toBe(true);
      }
      expect(sources.size).toBe(5);

      // The native clock has a .001-day step: .438 is the nearest selectable
      // value to 10:30. Complementary premultiplied weights sum to one.
      await setClock(time, 0.438);
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      const nextWeight = (0.438 - 0.375) / (0.5 - 0.375);
      await expectFrames(root, [1, 2], [1 - nextWeight, nextWeight]);
      for (const selector of [FLOOR_RECEIVER, WALL_RECEIVER]) {
        const receiver = root.locator(selector);
        await expect(receiver).toHaveCSS("isolation", "isolate");
        expect(await receiver.locator("img").evaluateAll(images => images.every(image => {
          let layer: Element | null = image;
          while (layer && !layer.matches(".room-frame__sunlight-receiver")) {
            if (getComputedStyle(layer).mixBlendMode === "plus-lighter") return true;
            layer = layer.parentElement;
          }
          return false;
        }))).toBe(true);
      }
      expect((await lightState(root)).fallbackOpacity).toBe(0);
      expect((await lightState(root)).receiverOpacity).toBeGreaterThan(0);
      expect((await lightState(root)).wallReceiverOpacity).toBeGreaterThan(0);
      await time.press("Home");
      await expect(time).toHaveValue("0");
      await expect.poll(async () => (await lightState(root)).receiverOpacity).toBe(0);
      const night = await lightState(root);
      expect(night).toMatchObject({ receiverOpacity: 0, wallReceiverOpacity: 0, shadeOpacity: 0, windowBloomOpacity: 0, fallbackOpacity: 0 });
      expect(night.windowNightOpacity).toBe(1);
      expect(night.windowNightPaint).toBe(windowNightPaint);
      await time.press("End");
      await expect(time).toHaveValue("1");
      await expect.poll(async () => (await lightState(root)).receiverOpacity).toBe(0);
      expect((await lightState(root)).windowNightOpacity).toBe(1);
      await expect(root.locator(`${FLOOR_RECEIVER} img`)).toHaveCount(1);
      await expect(root.locator(`${WALL_RECEIVER} img`)).toHaveCount(1);

      await page.getByRole("button", { name: "return to 09:00", exact: true }).click();
      await expect(time).toHaveValue("0.375");
      await expect.poll(async () => (await lightState(root)).windowNightOpacity).toBe(0);
      await expect.poll(async () => (await lightState(root)).active).toBe(1);
      const image = root.locator(".room-frame__sunlight-bake");
      const softness = page.getByRole("slider", { name: "edge softness", exact: true });
      await expect(image).toHaveCSS("filter", /^url\(.+\) blur\(4px\)$/);
      await softness.press("Home");
      await expect(softness).toHaveValue("0");
      await expect(image).toHaveCSS("filter", /^url\(.+\) blur\(0px\)$/);
      await softness.press("End");
      await expect(softness).toHaveValue("1");
      await expect(image).toHaveCSS("filter", /^url\(.+\) blur\(4px\)$/);
      const strength = page.getByRole("slider", { name: "light patch strength", exact: true });
      await strength.press("Home");
      await expect(strength).toHaveValue("0");
      await expect.poll(async () => (await lightState(root)).receiverOpacity).toBe(0);
      await expect.poll(async () => (await lightState(root)).wallReceiverOpacity).toBe(0);
      await expect.poll(async () => (await lightState(root)).shadeOpacity).toBe(0);
      await expect.poll(async () => (await lightState(root)).windowBloomOpacity).toBe(0);
    });

    test("keeps the previous light active when the bake image fails", async ({ page }) => {
      let aborted = false;
      await page.route(IMAGE, async route => { aborted = true; await route.abort(); });
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      const image = root.locator(".room-frame__sunlight-bake");
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "false");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "false");
      await expect(root.locator(".room-frame__wall-light")).toHaveCSS("visibility", "hidden");
      await expect.poll(async () => (await lightState(root)).weight).toBe(1);
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete)).toBe(true);
      expect(aborted).toBe(true);
      expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(0);
      const failed = await lightState(root);
      expect(failed).toMatchObject({ active: 0, receiverOpacity: 0, wallReceiverOpacity: 0, shadeOpacity: 0, windowBloomOpacity: 0 });
      expect(failed.fallbackOpacity).toBeGreaterThan(0);
      expect(failed.fallbackOpacity).toBeCloseTo(failed.dappleAmount, 5);
      await expect(page.locator("canvas")).toHaveCount(0);
    });

    test("holds a decoded neighbor during a partial failure and falls back only without a valid plate", async ({ page }) => {
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      const morningPath = new URL((await root.locator(".room-frame__sunlight-bake").getAttribute("src"))!, page.url()).pathname;
      let failedRequests = 0;
      await page.route(IMAGE, async route => {
        if (new URL(route.request().url()).pathname === morningPath) await route.continue();
        else { failedRequests++; await route.abort(); }
      });
      await setClock(page.getByRole("slider", { name: "time of day", exact: true }), 0.438);
      await expectFrames(root, [1, 2]);
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      await expect.poll(() => failedRequests).toBeGreaterThan(0);
      for (const receiver of [FLOOR_RECEIVER, WALL_RECEIVER]) {
        await expect(root.locator(`${receiver} .room-frame__sunlight-plate[data-sunlight-frame="1"]`)).toHaveCSS("opacity", "1");
        await expect(root.locator(`${receiver} .room-frame__sunlight-plate[data-sunlight-frame="2"]`)).toHaveCSS("opacity", "0");
      }
      expect((await lightState(root)).active).toBe(1);
      expect((await lightState(root)).fallbackOpacity).toBe(0);

      await setClock(page.getByRole("slider", { name: "time of day", exact: true }), 0.5);
      await expectFrames(root, [2]);
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "false");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "false");
      const failed = await lightState(root);
      expect(failed.active).toBe(0);
      expect(failed.receiverOpacity).toBe(0);
      expect(failed.wallReceiverOpacity).toBe(0);
      expect(failed.fallbackOpacity).toBeCloseTo(failed.dappleAmount, 5);
      expect(failed.fallbackOpacity).toBeGreaterThan(0);

      await page.getByRole("button", { name: "return to 09:00", exact: true }).click();
      await expectFrames(root, [1], [1]);
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
      await expect.poll(async () => (await lightState(root)).active).toBe(1);
      expect((await lightState(root)).fallbackOpacity).toBe(0);
    });

    test("rapid seeks cannot let a stale image load replace the current interval", async ({ page }) => {
      await page.goto(FIXTURE, { timeout: 30_000 });
      const root = page.locator(".room-frame");
      await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
      const morningPath = new URL((await root.locator(".room-frame__sunlight-bake").getAttribute("src"))!, page.url()).pathname;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const pending: Promise<void>[] = [];
      await page.route(IMAGE, async route => {
        if (new URL(route.request().url()).pathname === morningPath) {
          await route.continue();
          return;
        }
        // Navigation away from an interval may cancel its fetch. Both success
        // and cancellation must leave the newly selected interval untouched.
        const request = gate.then(() => route.continue()).catch(() => undefined);
        pending.push(request);
        await request;
      });
      try {
        const time = page.getByRole("slider", { name: "time of day", exact: true });
        await setClock(time, 0.438);
        await expectFrames(root, [1, 2]);
        await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
        await expect.poll(() => pending.length).toBeGreaterThan(0);
        expect((await lightState(root)).fallbackOpacity).toBe(0);
        await expect(root.locator(`${FLOOR_RECEIVER} .room-frame__sunlight-plate[data-sunlight-frame="1"]`)).toHaveCSS("opacity", "1");
        await expect(root.locator(`${FLOOR_RECEIVER} .room-frame__sunlight-plate[data-sunlight-frame="2"]`)).toHaveCSS("opacity", "0");
        await setClock(time, 0.625);
        await expectFrames(root, [3]);
        await expect(root).toHaveAttribute("data-room-sunlight-ready", "false");
        await page.getByRole("button", { name: "return to 09:00", exact: true }).click();
        await expectFrames(root, [1], [1]);
        await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
        await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
        release();
        await Promise.all(pending);
        await expectFrames(root, [1], [1]);
        await expect(root).toHaveAttribute("data-room-sunlight-ready", "true");
        await expect(root).toHaveAttribute("data-room-sunlight-wall-ready", "true");
        await expect.poll(async () => (await lightState(root)).active).toBe(1);
        await expect(page.locator("canvas")).toHaveCount(0);
      } finally {
        release();
        await Promise.all(pending);
      }
    });
  });
}
