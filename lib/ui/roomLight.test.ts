import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DAYLIGHT_POSITION,
  DEFAULT_ROOM_LIGHT_SETTINGS,
  ROOM_AMBIENT_INTENSITY_FLOOR,
  ROOM_LIGHT_MAX_DRIFT_RATE,
  resolveRoomLight,
  resolveTransmittedAmount,
  restoreRoomLightSettings,
  roomLightCssVariables,
  sanitizeRoomLightSettings,
  type RoomLightSettings,
  writeRoomLightCompositeCssVariables,
} from "./roomLight";
import {
  type DaylightAdvance,
  ROOM_LIGHT_DOM_MIN_INTERVAL_MS,
  ROOM_LIGHT_MAX_FRAME_DELTA_SECONDS,
  advanceDaylight,
  advanceDaylightInto,
  clampRoomLightFrameDelta,
  createRoomLightController,
  shouldPublishRoomLightCss,
} from "./useRoomLightController";

afterEach(() => vi.unstubAllGlobals());

describe("room light resolver", () => {
  it("uses neutral settings that preserve the original numeric path", () => {
    expect(resolveRoomLight(DEFAULT_ROOM_LIGHT_SETTINGS)).toEqual(
      resolveRoomLight(DEFAULT_ROOM_LIGHT_SETTINGS.position),
    );
    expect(DEFAULT_DAYLIGHT_POSITION).toBe(9 / 24);
    expect(DEFAULT_ROOM_LIGHT_SETTINGS.position).toBe(9 / 24);
    expect(DEFAULT_ROOM_LIGHT_SETTINGS.driftRate).toBeCloseTo(1 / 120, 12);
  });

  it("starts a restored page at 09:00 without dropping saved light settings", () => {
    const persisted: RoomLightSettings = {
      position: 0,
      exposure: 0.82,
      warmth: 0.17,
      ambient: 0.91,
      beam: 0.23,
      dapple: 0.77,
      dappleSoftness: 0.12,
      autoDrift: false,
      driftRate: 0.02,
    };

    expect(restoreRoomLightSettings(persisted)).toEqual({
      ...persisted,
      position: 9 / 24,
    });
    expect(persisted.position).toBe(0);
  });

  it("sanitizes partial or untrusted room settings field by field", () => {
    expect(sanitizeRoomLightSettings(null)).toEqual(
      DEFAULT_ROOM_LIGHT_SETTINGS,
    );
    expect(
      sanitizeRoomLightSettings({
        position: 4,
        exposure: -2,
        warmth: Number.NaN,
        ambient: "bright",
        beam: 0.75,
        dapple: Number.POSITIVE_INFINITY,
        dappleSoftness: 0.2,
        autoDrift: false,
        driftRate: 20,
      }),
    ).toEqual({
      ...DEFAULT_ROOM_LIGHT_SETTINGS,
      position: 1,
      exposure: 0,
      beam: 0.75,
      dappleSoftness: 0.2,
      autoDrift: false,
      driftRate: ROOM_LIGHT_MAX_DRIFT_RATE,
    });
  });

  it("clamps the authored path and remains deterministic", () => {
    expect(resolveRoomLight(-10)).toEqual(resolveRoomLight(0));
    expect(resolveRoomLight(10)).toEqual(resolveRoomLight(1));
    expect(resolveRoomLight(Number.NaN)).toEqual(resolveRoomLight(0));
    expect(resolveRoomLight(0.37)).toEqual(resolveRoomLight(0.37));
  });

  it("resolves midnight, sunrise, noon, and sunset as one smooth atmosphere", () => {
    expect(resolveRoomLight(0).atmosphere).toEqual({
      daylight: 0,
      night: 1,
      twilight: 0,
    });
    expect(resolveRoomLight(0.25).atmosphere).toEqual({
      daylight: 0,
      night: 0,
      twilight: 1,
    });
    expect(resolveRoomLight(0.5).atmosphere).toEqual({
      daylight: 1,
      night: 0,
      twilight: 0,
    });
    expect(resolveRoomLight(0.75).atmosphere).toEqual({
      daylight: 0,
      night: 0,
      twilight: 1,
    });
    expect(resolveRoomLight(1).atmosphere).toEqual(
      resolveRoomLight(0).atmosphere,
    );

    for (let step = 0; step <= 100; step += 1) {
      const atmosphere = resolveRoomLight(step / 100).atmosphere;
      expect(
        atmosphere.daylight + atmosphere.night + atmosphere.twilight,
      ).toBeCloseTo(1, 12);
    }
  });

  it("keeps visible solar cues continuous and dark across the midnight wrap", () => {
    const material = {
      openness: 0.82,
      cover: 0.14,
      thickness: 0.12,
      transmission: 0.9,
    };
    const before = resolveRoomLight(1 - 1e-6, material);
    const midnight = resolveRoomLight(0, material);
    const after = resolveRoomLight(1e-6, material);

    for (const light of [before, midnight, after]) {
      expect(light.direct.intensity).toBe(0);
      expect(light.window.glow).toBe(0);
      expect(light.beam.opacity).toBe(0);
      expect(light.dapple.opacity).toBe(0);
      expect(light.transmitted.amount).toBeGreaterThan(0);
      expect(
        Number(roomLightCssVariables(light)["--room-transmitted-amount"]),
      ).toBe(0);
    }
    expect(before.ambient).toEqual(after.ambient);
  });

  it("keeps a minimum ambient fill across the full day and control range", () => {
    for (let step = 0; step <= 100; step += 1) {
      for (const ambient of [0, 0.25, 0.5, 0.75, 1]) {
        for (const exposure of [0, 0.5, 1]) {
          const resolved = resolveRoomLight({
            ...DEFAULT_ROOM_LIGHT_SETTINGS,
            position: step / 100,
            ambient,
            exposure,
          });
          expect(resolved.ambient.intensity).toBeGreaterThanOrEqual(
            ROOM_AMBIENT_INTENSITY_FLOOR,
          );
        }
      }
    }
  });

  it("preserves the authored cycle at neutral ambient and increases strictly", () => {
    const expectedNeutral = new Map([
      [0, 0.32],
      [0.25, 0.34],
      [0.5, 0.58],
      [0.75, 0.34],
      [1, 0.32],
    ]);

    for (const [position, cycleIntensity] of expectedNeutral) {
      const intensities = [0, 0.25, 0.5, 0.75, 1].map(
        (ambient) =>
          resolveRoomLight({
            ...DEFAULT_ROOM_LIGHT_SETTINGS,
            position,
            ambient,
          }).ambient.intensity,
      );
      expect(intensities[0]).toBe(ROOM_AMBIENT_INTENSITY_FLOOR);
      expect(intensities[2]).toBeCloseTo(cycleIntensity, 12);
      for (let index = 1; index < intensities.length; index += 1) {
        expect(intensities[index]).toBeGreaterThan(intensities[index - 1]);
      }
    }
  });

  it("keeps midnight solar cues dark while exposure cannot remove its fill", () => {
    const midnightAt = (exposure: number) =>
      resolveRoomLight({
        ...DEFAULT_ROOM_LIGHT_SETTINGS,
        position: 0,
        ambient: 0,
        exposure,
        beam: 1,
        dapple: 1,
      });

    for (const exposure of [0, 0.5, 1]) {
      const midnight = midnightAt(exposure);
      expect(midnight.ambient.intensity).toBe(
        ROOM_AMBIENT_INTENSITY_FLOOR,
      );
      expect(midnight.ambient.skyTint).toEqual({ r: 0.56, g: 0.61, b: 0.7 });
      expect(midnight.ambient.groundTint).toEqual({
        r: 0.32,
        g: 0.3,
        b: 0.29,
      });
      expect(midnight.direct.intensity).toBe(0);
      expect(midnight.window.glow).toBe(0);
      expect(midnight.beam.opacity).toBe(0);
      expect(midnight.dapple.opacity).toBe(0);
    }
  });

  it("travels within the wide left window and never crosses the specimen", () => {
    const left = resolveRoomLight(0);
    const center = resolveRoomLight(0.5);
    const right = resolveRoomLight(1);

    expect(left.sourcePosition).toEqual({ x: -1520, y: 540, z: 1180 });
    expect(center.sourcePosition).toEqual({ x: -1120, y: 1220, z: 1300 });
    expect(right.sourcePosition).toEqual({ x: -720, y: 540, z: 1180 });
    expect(left.specimenTarget).toEqual({ x: 110, y: -105, z: 0 });
    expect(center.specimenTarget).toEqual(left.specimenTarget);
    expect(right.specimenTarget).toEqual(left.specimenTarget);
    expect([left.window.hotspotX, left.window.hotspotY]).toEqual([0.12, 0.72]);
    expect([center.window.hotspotX, center.window.hotspotY]).toEqual([0.5, 0.25]);
    expect([right.window.hotspotX, right.window.hotspotY]).toEqual([0.88, 0.72]);
    expect(left.beam.rotation).toBeCloseTo(21.5889790738, 8);
    expect(center.beam.rotation).toBeCloseTo(47.1293905164, 8);
    expect(right.beam.rotation).toBeCloseTo(37.8510805321, 8);
    expect(left.sourcePosition.x).toBeLessThan(center.sourcePosition.x);
    expect(center.sourcePosition.x).toBeLessThan(right.sourcePosition.x);
    expect(center.sourcePosition.y).toBeGreaterThan(left.sourcePosition.y);
    expect(center.sourcePosition.y).toBeGreaterThan(right.sourcePosition.y);
    for (const resolved of [left, center, right]) {
      expect(resolved.sourcePosition.x).toBeLessThan(
        resolved.specimenTarget.x,
      );
      expect(resolved.sourcePosition.z).toBeGreaterThan(0);
      expect(resolved.lightDirection.x).toBeGreaterThan(0);
      expect(resolved.lightDirection.y).toBeLessThan(0);
      expect(resolved.lightDirection.z).toBeLessThan(0);
      expect(
        Math.hypot(
          resolved.lightDirection.x,
          resolved.lightDirection.y,
          resolved.lightDirection.z,
        ),
      ).toBeCloseTo(1, 10);
    }
  });

  it("keeps an obvious right-and-down screen angle across the full path", () => {
    for (let step = 0; step <= 100; step += 10) {
      const resolved = resolveRoomLight(step / 100);
      const beam = resolved.beam;
      expect(beam.screenDirectionX).toBeGreaterThan(0);
      expect(beam.screenDirectionY).toBeGreaterThan(0);
      expect(
        Math.hypot(beam.screenDirectionX, beam.screenDirectionY),
      ).toBeCloseTo(1, 10);
      expect(beam.rotation).toBeGreaterThan(20);
      expect(beam.rotation).toBeLessThan(55);
      expect(resolved.dapple.rotation).toBeCloseTo(
        beam.rotation * 0.52,
        10,
      );
      expect(resolved.dapple.translateX).toBeGreaterThan(0);
      expect(resolved.dapple.translateY).toBeGreaterThan(0);
    }
  });

  it("keeps every authored room cue finite and bounded", () => {
    for (let step = 0; step <= 100; step += 10) {
      const resolved = resolveRoomLight(step / 100, {
        openness: step / 100,
        cover: 1 - step / 100,
        thickness: step / 100,
        transmission: 1 - step / 100,
        transmissionContrast: step / 100,
        albedoTint: { r: 2, g: -1, b: Number.NaN },
      });
      expect(resolved.window.hotspotX).toBeGreaterThanOrEqual(0);
      expect(resolved.window.hotspotX).toBeLessThanOrEqual(1);
      expect(resolved.window.hotspotY).toBeGreaterThanOrEqual(0);
      expect(resolved.window.hotspotY).toBeLessThanOrEqual(1);
      expect(resolved.beam.reach).toBeGreaterThanOrEqual(0);
      expect(resolved.beam.reach).toBeLessThanOrEqual(1);
      expect(resolved.beam.opacity).toBeGreaterThanOrEqual(0);
      expect(resolved.beam.opacity).toBeLessThanOrEqual(0.58);
      expect(resolved.dapple.opacity).toBeGreaterThanOrEqual(0);
      expect(resolved.dapple.opacity).toBeLessThanOrEqual(0.9);
      expect(resolved.dapple.softnessMix).toBeGreaterThanOrEqual(0);
      expect(resolved.dapple.softnessMix).toBeLessThanOrEqual(1);
      for (const weight of Object.values(resolved.atmosphere)) {
        expect(Number.isFinite(weight)).toBe(true);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
      for (const color of [
        resolved.direct.tint,
        resolved.ambient.skyTint,
        resolved.ambient.groundTint,
        resolved.window.tint,
        resolved.dapple.tint,
        resolved.transmitted.tint,
      ]) {
        for (const channel of [color.r, color.g, color.b]) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("moves the ground dapple opposite the source", () => {
    const left = resolveRoomLight(0.18);
    const right = resolveRoomLight(0.82);
    expect(left.sourcePosition.x).toBeLessThan(right.sourcePosition.x);
    expect(left.dapple.translateX).toBeGreaterThan(right.dapple.translateX);
  });

  it("makes the midpoint cooler, brighter, shorter, and crisper", () => {
    const endpoint = resolveRoomLight(0);
    const midpoint = resolveRoomLight(0.5);
    expect(midpoint.direct.tint.b).toBeGreaterThan(endpoint.direct.tint.b);
    expect(midpoint.direct.intensity).toBeGreaterThan(
      endpoint.direct.intensity,
    );
    expect(midpoint.dapple.scaleY).toBeLessThan(endpoint.dapple.scaleY);
    expect(midpoint.dapple.softnessMix).toBeLessThan(
      endpoint.dapple.softnessMix,
    );
  });

  it("conditions transmitted light monotonically within its bounds", () => {
    const base = {
      openness: 0.4,
      cover: 0.4,
      thickness: 0.4,
      transmission: 0.4,
      transmissionContrast: 0.4,
    };
    const at = (overrides: Partial<typeof base>) =>
      resolveTransmittedAmount({ ...base, ...overrides });

    expect(at({ openness: 0.8 })).toBeGreaterThanOrEqual(
      at({ openness: 0.2 }),
    );
    expect(at({ transmission: 0.8 })).toBeGreaterThanOrEqual(
      at({ transmission: 0.2 }),
    );
    expect(at({ transmissionContrast: 0.8 })).toBeGreaterThanOrEqual(
      at({ transmissionContrast: 0.2 }),
    );
    expect(at({ cover: 0.8 })).toBeLessThanOrEqual(at({ cover: 0.2 }));
    expect(at({ thickness: 0.8 })).toBeLessThanOrEqual(
      at({ thickness: 0.2 }),
    );

    for (const profile of [
      { openness: -20, cover: 20, thickness: 20, transmission: -20 },
      { openness: 20, cover: -20, thickness: -20, transmission: 20 },
    ]) {
      const amount = resolveTransmittedAmount(profile);
      expect(Number.isFinite(amount)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(0.08);
      expect(amount).toBeLessThanOrEqual(0.92);
    }
  });

  it("uses albedo only for the transmitted cue", () => {
    const red = resolveRoomLight(0.4, {
      albedoTint: { r: 1, g: 0, b: 0 },
    });
    const blue = resolveRoomLight(0.4, {
      albedoTint: { r: 0, g: 0, b: 1 },
    });
    expect(red.direct).toEqual(blue.direct);
    expect(red.ambient).toEqual(blue.ambient);
    expect(red.transmitted.tint).not.toEqual(blue.transmitted.tint);
  });

  it("keeps the floor-window projection tint on resolved daylight", () => {
    const lowDaylight = {
      ...DEFAULT_ROOM_LIGHT_SETTINGS,
      position: 0.08,
    };
    const denseRed = resolveRoomLight(lowDaylight, {
      openness: 0,
      cover: 1,
      thickness: 1,
      transmission: 0,
      transmissionContrast: 0,
      albedoTint: { r: 1, g: 0, b: 0 },
    });
    const sheerBlue = resolveRoomLight(lowDaylight, {
      openness: 1,
      cover: 0,
      thickness: 0,
      transmission: 1,
      transmissionContrast: 1,
      albedoTint: { r: 0, g: 0, b: 1 },
    });
    const highDaylight = resolveRoomLight(
      { ...lowDaylight, position: 0.5 },
      {
        openness: 0,
        cover: 1,
        thickness: 1,
        transmission: 0,
        transmissionContrast: 0,
        albedoTint: { r: 1, g: 0, b: 0 },
      },
    );

    expect(denseRed.transmitted.amount).toBeLessThan(
      sheerBlue.transmitted.amount,
    );
    expect(denseRed.transmitted.tint).not.toEqual(
      sheerBlue.transmitted.tint,
    );
    expect(denseRed.dapple.tint).toEqual(sheerBlue.dapple.tint);
    for (const resolved of [denseRed, sheerBlue, highDaylight]) {
      expect(resolved.dapple.tint).toEqual(resolved.window.tint);
      expect(resolved.window.tint).toEqual(resolved.direct.tint);
    }
    expect(highDaylight.dapple.tint).not.toEqual(denseRed.dapple.tint);
  });

  it("keeps room modifiers independent while preserving material transmission", () => {
    const withSettings = (
      overrides: Partial<typeof DEFAULT_ROOM_LIGHT_SETTINGS>,
    ) =>
      resolveRoomLight(
        { ...DEFAULT_ROOM_LIGHT_SETTINGS, ...overrides },
        {
          openness: 0.72,
          cover: 0.22,
          thickness: 0.18,
          transmission: 0.81,
          transmissionContrast: 0.64,
          albedoTint: { r: 0.76, g: 0.12, b: 0.18 },
        },
      );
    const base = withSettings({});
    const dim = withSettings({ exposure: 0 });
    const bright = withSettings({ exposure: 1 });
    const cool = withSettings({ warmth: 0 });
    const warm = withSettings({ warmth: 1 });
    const lowAmbient = withSettings({ ambient: 0 });
    const highAmbient = withSettings({ ambient: 1 });
    const noBeam = withSettings({ beam: 0 });
    const fullBeam = withSettings({ beam: 1 });
    const noDapple = withSettings({ dapple: 0 });
    const fullDapple = withSettings({ dapple: 1 });
    const crisp = withSettings({ dappleSoftness: 0 });
    const soft = withSettings({ dappleSoftness: 1 });

    expect(bright.direct.intensity).toBeGreaterThan(dim.direct.intensity);
    expect(bright.window.glow).toBeGreaterThan(dim.window.glow);
    expect(warm.direct.tint.r - warm.direct.tint.b).toBeGreaterThan(
      cool.direct.tint.r - cool.direct.tint.b,
    );
    expect(highAmbient.ambient.intensity).toBeGreaterThan(
      lowAmbient.ambient.intensity,
    );
    expect(lowAmbient.direct).toEqual(base.direct);
    expect(fullBeam.beam.opacity).toBeGreaterThan(noBeam.beam.opacity);
    expect(fullDapple.dapple.opacity).toBeGreaterThan(
      noDapple.dapple.opacity,
    );
    expect(soft.dapple.softnessMix).toBeGreaterThan(
      crisp.dapple.softnessMix,
    );

    for (const light of [
      dim,
      bright,
      cool,
      warm,
      lowAmbient,
      highAmbient,
      noBeam,
      fullBeam,
      noDapple,
      fullDapple,
      crisp,
      soft,
    ]) {
      expect(light.transmitted).toEqual(base.transmitted);
    }
  });

  it("publishes window and dapple variables from the same snapshot", () => {
    const variables = roomLightCssVariables(resolveRoomLight(0.25));
    expect(variables["--room-window-x"]).toMatch(/%$/);
    expect(variables["--room-window-y"]).toMatch(/%$/);
    expect(variables["--room-beam-angle"]).toMatch(/deg$/);
    expect(variables["--room-beam-reach"]).toBeTruthy();
    expect(variables["--room-beam-opacity"]).toBeTruthy();
    expect(variables["--room-dapple-x"]).toMatch(/px$/);
    expect(variables["--room-dapple-rotation"]).toMatch(/deg$/);
    expect(variables["--room-dapple-opacity"]).toBeTruthy();
    expect(variables["--room-transmitted-amount"]).toBeTruthy();
    expect(variables["--room-night-opacity"]).toBe("0");
    expect(variables["--room-twilight-opacity"]).toBe("1");
    expect(variables["--room-window-color"]).toMatch(/^rgb\(/);
    expect(variables["--room-dapple-color"]).toMatch(/^rgb\(/);
    expect(variables["--room-ambient-sky"]).toBeUndefined();
  });

  it("keeps autonomous CSS writes on the transform and opacity contract", () => {
    const variables = new Map<string, string>();
    writeRoomLightCompositeCssVariables(
      {
        setProperty(name, value) {
          variables.set(name, value);
        },
      },
      resolveRoomLight(0.75),
    );

    expect([...variables.keys()].sort()).toEqual(
      [
        "--room-beam-angle",
        "--room-beam-opacity",
        "--room-beam-reach",
        "--room-dapple-opacity",
        "--room-dapple-rotation",
        "--room-dapple-scale-x",
        "--room-dapple-scale-y",
        "--room-dapple-softness",
        "--room-dapple-x",
        "--room-dapple-y",
        "--room-night-opacity",
        "--room-transmitted-amount",
        "--room-twilight-opacity",
        "--room-window-glow",
        "--room-window-x",
        "--room-window-y",
      ].sort(),
    );
    expect(variables.get("--room-window-x")).toMatch(/%$/);
    expect(variables.get("--room-window-y")).toMatch(/%$/);
    expect(variables.has("--room-transmitted-color")).toBe(false);
    expect(variables.has("--room-wall-top")).toBe(false);
    expect(variables.has("--room-floor-near")).toBe(false);
  });
});

describe("room light drift", () => {
  it("limits autonomous DOM publication to the baked-room cadence", () => {
    expect(shouldPublishRoomLightCss(1000, null)).toBe(true);
    expect(shouldPublishRoomLightCss(1016, 1000)).toBe(false);
    expect(
      shouldPublishRoomLightCss(
        1000 + ROOM_LIGHT_DOM_MIN_INTERVAL_MS,
        1000,
      ),
    ).toBe(true);
    expect(shouldPublishRoomLightCss(Number.NaN, 1000)).toBe(true);
  });

  it("mutates one resolved snapshot instead of allocating per update", () => {
    const controller = createRoomLightController({
      initialDaylight: 0.2,
      autoDrift: false,
    });
    const snapshot = controller.resolvedRef.current;
    const settings = controller.settingsRef.current;
    const sourcePosition = snapshot.sourcePosition;
    const directTint = snapshot.direct.tint;

    controller.setSettings({ position: 0.8, exposure: 0.75 });

    expect(controller.resolvedRef.current).toBe(snapshot);
    expect(controller.settingsRef.current).toBe(settings);
    expect(controller.resolvedRef.current.sourcePosition).toBe(sourcePosition);
    expect(controller.resolvedRef.current.direct.tint).toBe(directTint);
    expect(snapshot.pathPosition).toBe(0.8);
    expect(controller.daylightRef.current).toBe(0.8);
    expect(controller.getSettings()).not.toBe(settings);
    expect(controller.getSettings()).toEqual(settings);
  });

  it("sanitizes explicit patches and keeps legacy daylight access coherent", () => {
    const controller = createRoomLightController({ autoDrift: false });
    controller.setSettings({
      position: 8,
      exposure: -1,
      driftRate: Number.POSITIVE_INFINITY,
    });
    expect(controller.getSettings()).toMatchObject({
      position: 1,
      exposure: 0,
      driftRate: DEFAULT_ROOM_LIGHT_SETTINGS.driftRate,
    });
    expect(controller.getDaylight()).toBe(1);

    controller.setDaylight(0.24);
    expect(controller.settingsRef.current.position).toBe(0.24);
    expect(controller.daylightRef.current).toBe(0.24);
  });

  it("wraps at either endpoint without reversing the day clock", () => {
    const atRight = advanceDaylight(0.98, 1, 0.05);
    expect(atRight.position).toBeCloseTo(0.03, 10);
    expect(atRight.direction).toBe(1);
    const atLeft = advanceDaylight(0.02, -1, 0.05);
    expect(atLeft.position).toBeCloseTo(0.97, 10);
    expect(atLeft.direction).toBe(-1);
  });

  it("handles distances spanning several complete paths", () => {
    const advanced = advanceDaylight(0.2, 1, 4.1);
    expect(advanced.position).toBeCloseTo(0.3, 10);
    expect(advanced.direction).toBe(1);
  });

  it("can advance into one allocation-free animation scratch value", () => {
    const scratch: DaylightAdvance = { position: 0, direction: 1 };
    const advanced = advanceDaylightInto(scratch, 0.98, 1, 0.05);
    expect(advanced).toBe(scratch);
    expect(scratch.position).toBeCloseTo(0.03, 10);
    expect(scratch.direction).toBe(1);
  });

  it("clamps hidden-tab-sized frame deltas", () => {
    expect(clampRoomLightFrameDelta(16)).toBeCloseTo(0.016);
    expect(clampRoomLightFrameDelta(60_000)).toBe(
      ROOM_LIGHT_MAX_FRAME_DELTA_SECONDS,
    );
    expect(clampRoomLightFrameDelta(-20)).toBe(0);
    expect(clampRoomLightFrameDelta(Number.NaN)).toBe(0);
  });

  it("measures the floor receiver only on mount/resize and disconnects it", () => {
    const events = new EventTarget();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    let onResize = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { onResize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    let width = 1280;
    const roomBounds = vi.fn(() => ({ left: 0, top: 0, width, height: 832 }));
    const planeBounds = vi.fn(() => ({ left: 0, top: 0, width, height: 832 }));
    const apertureBounds = vi.fn(() => ({
      left: width * (0.719140625 - 0.083203125) - 880,
      top: 0,
      width: 880,
      height: 415.059,
    }));
    const css = new Map<string, string>();
    const aperture = { getBoundingClientRect: apertureBounds };
    const planes = { getBoundingClientRect: planeBounds };
    const root = {
      getBoundingClientRect: roomBounds,
      querySelector: (selector: string) =>
        selector === "[data-room-window-mask]" ? aperture : planes,
      style: { setProperty: (key: string, value: string) => css.set(key, value) },
      dataset: {},
    } as unknown as HTMLElement;
    const controller = createRoomLightController({
      initialDaylight: 0.375,
      autoDrift: false,
      roomRootRef: { current: root },
    });
    const dispose = controller.mount();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(roomBounds).toHaveBeenCalledTimes(1);
    expect(css.get("--room-projection-visible")).toBe("1");
    const initialX = css.get("--room-projection-x");
    controller.setDaylight(0.5);
    expect(roomBounds).toHaveBeenCalledTimes(1);
    expect(apertureBounds).toHaveBeenCalledTimes(1);
    expect(planeBounds).toHaveBeenCalledTimes(1);
    expect(css.get("--room-projection-x")).not.toBe(initialX);
    const beforeResize = css.get("--room-projection-x");
    width = 1000;
    onResize();
    expect(roomBounds).toHaveBeenCalledTimes(2);
    expect(css.get("--room-projection-x")).not.toBe(beforeResize);
    dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("composes modal, visibility, reduced-motion, and data-saver pauses", () => {
    class FakeMediaQueryList extends EventTarget {
      matches = false;
      readonly media = "(prefers-reduced-motion: reduce)";
      onchange = null;
      addListener(listener: (event: MediaQueryListEvent) => void) {
        this.addEventListener("change", listener as EventListener);
      }
      removeListener(listener: (event: MediaQueryListEvent) => void) {
        this.removeEventListener("change", listener as EventListener);
      }
    }
    class FakeConnection extends EventTarget {
      saveData = false;
    }

    const media = new FakeMediaQueryList();
    const connection = new FakeConnection();
    const documentEvents = new EventTarget();
    const fakeDocument = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener:
        documentEvents.removeEventListener.bind(documentEvents),
    };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const fakeWindow = {
      matchMedia: () => media as unknown as MediaQueryList,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("navigator", { connection });
    vi.stubGlobal("window", fakeWindow);

    const css = new Map<string, string>();
    const writtenCssNames: string[] = [];
    let cssWriteCount = 0;
    const root = {
      style: {
        setProperty: (name: string, value: string) => {
          cssWriteCount += 1;
          writtenCssNames.push(name);
          css.set(name, value);
        },
      },
      dataset: {} as Record<string, string>,
    } as unknown as HTMLElement;
    const controller = createRoomLightController({
      initialDaylight: 0.4,
      roomRootRef: { current: root },
    });
    const liveSettings = controller.settingsRef.current;
    const runFrame = (timestamp: number) => {
      const next = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!next) throw new Error("no frame scheduled");
      frames.delete(next[0]);
      next[1](timestamp);
    };

    const dispose = controller.mount();
    const mountedCssWrites = cssWriteCount;
    expect(frames.size).toBe(1);
    writtenCssNames.length = 0;
    runFrame(50_000);
    expect(controller.getDaylight()).toBe(0.4);
    expect(cssWriteCount).toBe(mountedCssWrites);
    runFrame(50_016);
    expect(controller.getDaylight()).toBeGreaterThan(0.4);
    expect(controller.settingsRef.current).toBe(liveSettings);
    expect(cssWriteCount).toBeGreaterThan(mountedCssWrites);
    expect(writtenCssNames).toContain("--room-window-x");
    expect(writtenCssNames).toContain("--room-window-y");
    expect(writtenCssNames).toContain("--room-night-opacity");
    expect(writtenCssNames).toContain("--room-twilight-opacity");
    expect(writtenCssNames).not.toContain("--room-window-color");
    expect(writtenCssNames).not.toContain("--room-dapple-color");
    expect(writtenCssNames).not.toContain("--room-transmitted-color");
    const firstDriftCssWrites = cssWriteCount;
    runFrame(50_024);
    expect(cssWriteCount).toBe(firstDriftCssWrites);
    expect(root.dataset.lightPosition).toBeTruthy();
    expect(css.has("--room-dapple-x")).toBe(true);

    controller.setSettings({ autoDrift: false });
    expect(frames.size).toBe(0);
    controller.setSettings({ autoDrift: true, driftRate: 0.03 });
    expect(frames.size).toBe(1);
    expect(controller.settingsRef.current.driftRate).toBe(0.03);

    controller.pause("modal");
    expect(frames.size).toBe(0);
    const beforeDirectUpdate = cssWriteCount;
    writtenCssNames.length = 0;
    controller.setDaylight(0.73);
    expect(cssWriteCount).toBeGreaterThan(beforeDirectUpdate);
    expect(writtenCssNames).toContain("--room-window-x");
    expect(writtenCssNames).toContain("--room-window-y");
    expect(writtenCssNames).toContain("--room-window-color");
    expect(writtenCssNames).toContain("--room-dapple-color");
    expect(writtenCssNames).toContain("--room-transmitted-color");
    expect(root.dataset.lightPosition).toBe("0.73");
    controller.resume("modal");
    runFrame(5_000_000);
    expect(controller.getDaylight()).toBe(0.73);
    runFrame(5_000_016);
    expect(controller.getDaylight()).toBeGreaterThan(0.73);

    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(controller.isPaused("reduced-motion")).toBe(true);
    expect(frames.size).toBe(0);
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);

    connection.saveData = true;
    connection.dispatchEvent(new Event("change"));
    expect(controller.isPaused("data-saver")).toBe(true);
    expect(frames.size).toBe(0);
    connection.saveData = false;
    connection.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);

    fakeDocument.visibilityState = "hidden";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(controller.isPaused("document-hidden")).toBe(true);
    expect(frames.size).toBe(0);
    fakeDocument.visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1);

    dispose();
    expect(frames.size).toBe(0);
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(controller.isPaused("reduced-motion")).toBe(false);
  });
});
