import { describe, expect, it } from "vitest";
import daylightAtlas from "../../public/2d-textures/room-sunlight-day.json";
import type { RoomFloorProjectionLayout } from "./roomFloorProjection";
import { resolveRoomLight, type ResolvedRoomLight } from "./roomLight";
import {
  morningSunlightWeight,
  resolveRoomSunlightProjection,
  type RoomSunlightBake,
} from "./roomSunlightProjection";

const BAKE: RoomSunlightBake = {
  width: 1024,
  height: 512,
  bounds: { minX: 0.8, maxX: 6.2, minY: 0.8, maxY: 2.9 },
  aperture: { width: 3.2, bottom: 1, top: 2.65 },
  direction: { x: 0.597701043, y: 0.563470066, z: -0.570311273 },
  pathPosition: 0.375,
  image: "/room/sunlight-morning.png",
};

// The bake uses Z up / +Y into the room; the live light uses Y up / -Z in.
const MORNING: Pick<ResolvedRoomLight, "pathPosition" | "lightDirection"> = {
  pathPosition: 9 / 24,
  lightDirection: {
    x: BAKE.direction.x,
    y: BAKE.direction.z,
    z: -BAKE.direction.y,
  },
};

function responsiveLayout(width: number, height: number): RoomFloorProjectionLayout {
  const apertureHeight = height * 0.49886899;
  const apertureWidth = height * 1.05769231;
  const apertureRight = width * 0.719140625 - Math.min(width * 0.083203125, height * 0.128004808);
  return {
    room: { left: 0, top: 0, width, height },
    planes: { left: 0, top: 0, width, height: height * (width <= 820 ? 0.8 : 1) },
    aperture: { left: apertureRight - apertureWidth, top: 0, width: apertureWidth, height: apertureHeight },
    apertureRightBottom: 0.846,
  };
}

const FIXTURES = [
  {
    name: "1280 × 832 desktop",
    layout: responsiveLayout(1280, 832),
    calibratedAperture: { left: -0.20326992949912784, width: 3.1433346319055797, bottom: 1.0090905758635285, top: 2.6499766902001904 },
    expectedLandings: [
      { x: 302.58870672467526, y: 675.2142231239869 },
      { x: 1032.0120822688664, y: 621.8477540845466 },
      { x: 1654.505689158005, y: 576.3045388365922 },
    ],
  },
  {
    name: "390 × 844 narrow room with 80% planes",
    layout: responsiveLayout(390, 844),
    calibratedAperture: { left: -4.759246375067059, width: 7.699311077473511, bottom: 1.1404682066635212, top: 2.649454237621274 },
    expectedLandings: [
      { x: -478.5286736067468, y: 747.6144342286217 },
      { x: 125.99904186648328, y: 575.3941426068384 },
      { x: 504.0558838640135, y: 467.6917860201646 },
    ],
  },
] as const;

function matrixValues(transform: string): number[] {
  expect(transform).toMatch(/^matrix3d\(.+\)$/);
  const matrix = transform.slice("matrix3d(".length, -1).split(",").map(Number);
  expect(matrix).toHaveLength(16);
  expect(matrix.every(Number.isFinite)).toBe(true);
  return matrix;
}

function project(matrix: number[], x: number, y: number) {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  expect(w).toBeGreaterThan(0);
  return {
    x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
    y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w,
  };
}

function expectNear(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  // CSS serializes coefficients to 9 decimal places; allow 0.005 CSS px.
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(0.005);
}

function expectHidden(result: ReturnType<typeof resolveRoomSunlightProjection>) {
  expect(result).toEqual({ transform: "scale(0)", weight: 0, corners: [] });
}

describe("morning sunlight weight", () => {
  it("uses the approved 9am bake and leaves noon and night unlit", () => {
    expect(morningSunlightWeight(9 / 24)).toBe(1);
    for (const position of [0, 6 / 24, 12 / 24, 18 / 24, 23 / 24, 1]) {
      expect(morningSunlightWeight(position)).toBe(0);
    }
  });

  it("holds the center and fades symmetrically to zero around it", () => {
    for (const sign of [-1, 1]) {
      expect(morningSunlightWeight(0.375 + sign * 0.01)).toBe(1);
      expect(morningSunlightWeight(0.375 + sign * 0.03125)).toBeCloseTo(0.5, 12);
      expect(morningSunlightWeight(0.375 + sign * 0.051)).toBe(0);
    }
    expect(morningSunlightWeight(0.3, 0.3)).toBe(1);
    for (const position of [NaN, Infinity, -Infinity]) {
      expect(morningSunlightWeight(position)).toBe(0);
    }
  });
});

describe.each(FIXTURES)("room sunlight projection: $name", ({ layout, expectedLandings }) => {
  it("returns a finite perspective transform whose CSS corners match its geometry", () => {
    const result = resolveRoomSunlightProjection(BAKE, MORNING, layout);
    const matrix = matrixValues(result.transform);
    expect(result.weight).toBe(1);
    expect(result.corners).toHaveLength(4);
    const pixelCorners = [[0, 0], [BAKE.width, 0], [BAKE.width, BAKE.height], [0, BAKE.height]];
    pixelCorners.forEach(([x, y], index) => expectNear(project(matrix, x, y), result.corners[index]));

    // A rotated/scaled rectangle cannot produce this projective midpoint.
    const midpoint = project(matrix, BAKE.width / 2, 0);
    const affineMidpoint = {
      x: (result.corners[0].x + result.corners[1].x) / 2,
      y: (result.corners[0].y + result.corners[1].y) / 2,
    };
    expect(Math.hypot(midpoint.x - affineMidpoint.x, midpoint.y - affineMidpoint.y)).toBeGreaterThan(1);
    expect(Math.abs(matrix[3]) + Math.abs(matrix[7])).toBeGreaterThan(1e-5);
  });

  it("lands rays from the sill, aperture center, and upper right at their calibrated floor positions", () => {
    const matrix = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout).transform);
    // These expected screen positions were calculated directly: unproject the
    // measured wall opening, cast each source ray to z=0, then project the floor
    // with the drawing's 3.4m wall / 4m depth calibration. They do not use the
    // resolver's matrix or its returned corners as their oracle.
    for (const [index, sourceFraction] of [0, 0.5, 1].entries()) {
      const sourceHeight = BAKE.aperture.bottom + sourceFraction * (BAKE.aperture.top - BAKE.aperture.bottom);
      const rayTime = sourceHeight / -BAKE.direction.z;
      const bakedFloorX = sourceFraction * BAKE.aperture.width + rayTime * BAKE.direction.x;
      const bakedFloorY = rayTime * BAKE.direction.y;
      const pixelX = (bakedFloorX - BAKE.bounds.minX) / (BAKE.bounds.maxX - BAKE.bounds.minX) * BAKE.width;
      const pixelY = (bakedFloorY - BAKE.bounds.minY) / (BAKE.bounds.maxY - BAKE.bounds.minY) * BAKE.height;
      expectNear(project(matrix, pixelX, pixelY), expectedLandings[index]);
    }
  });

  it("uses room-local coordinates regardless of the viewport origin", () => {
    const shifted = structuredClone(layout);
    for (const rect of [shifted.room, shifted.planes, shifted.aperture]) {
      rect.left += 73;
      rect.top += 119;
    }
    expect(resolveRoomSunlightProjection(BAKE, MORNING, shifted))
      .toEqual(resolveRoomSunlightProjection(BAKE, MORNING, layout));
  });

  it("preserves a plane's offset inside the room", () => {
    const shifted = structuredClone(layout);
    for (const rect of [shifted.planes, shifted.aperture]) {
      rect.left += 24;
      rect.top += 35;
    }
    const original = resolveRoomSunlightProjection(BAKE, MORNING, layout);
    const moved = resolveRoomSunlightProjection(BAKE, MORNING, shifted);
    expect(moved.weight).toBe(1);
    moved.corners.forEach((point, index) => expectNear(point, {
      x: original.corners[index].x + 24,
      y: original.corners[index].y + 35,
    }));
  });
});

describe("room sunlight projection guards", () => {
  const layout = FIXTURES[0].layout;

  it.each([0, 0.5, 0.9, NaN, Infinity])("hides the bake outside the morning study at %s", (pathPosition) => {
    expectHidden(resolveRoomSunlightProjection(BAKE, { ...MORNING, pathPosition }, layout));
  });

  it.each([
    ["zero room width", (value: RoomFloorProjectionLayout) => { value.room.width = 0; }],
    ["negative plane height", (value: RoomFloorProjectionLayout) => { value.planes.height = -1; }],
    ["zero aperture width", (value: RoomFloorProjectionLayout) => { value.aperture.width = 0; }],
    ["nonfinite aperture origin", (value: RoomFloorProjectionLayout) => { value.aperture.left = NaN; }],
    ["nonfinite plane origin", (value: RoomFloorProjectionLayout) => { value.planes.top = Infinity; }],
    ["aperture below the floor", (value: RoomFloorProjectionLayout) => { value.aperture.top = 832; }],
  ] as const)("hides invalid layout: %s", (_name, invalidate) => {
    const invalid = structuredClone(layout);
    invalidate(invalid);
    expectHidden(resolveRoomSunlightProjection(BAKE, MORNING, invalid));
  });

  it.each([
    ["zero image width", (value: RoomSunlightBake) => { value.width = 0; }],
    ["nonfinite image height", (value: RoomSunlightBake) => { value.height = Infinity; }],
    ["empty bounds", (value: RoomSunlightBake) => { value.bounds.maxX = value.bounds.minX; }],
    ["reversed bounds", (value: RoomSunlightBake) => { value.bounds.maxY = value.bounds.minY - 1; }],
    ["nonfinite bounds", (value: RoomSunlightBake) => { value.bounds.minX = NaN; }],
    ["zero aperture width", (value: RoomSunlightBake) => { value.aperture.width = 0; }],
    ["reversed aperture height", (value: RoomSunlightBake) => { value.aperture.top = value.aperture.bottom - 1; }],
    ["nonfinite aperture height", (value: RoomSunlightBake) => { value.aperture.bottom = NaN; }],
    ["nonfinite path position", (value: RoomSunlightBake) => { value.pathPosition = NaN; }],
    ["nonfinite ray depth", (value: RoomSunlightBake) => { value.direction.y = Infinity; }],
    ["ray parallel to the floor", (value: RoomSunlightBake) => { value.direction.z = 0; }],
    ["upward ray", (value: RoomSunlightBake) => { value.direction.z = 1; }],
    ["ray along the wall", (value: RoomSunlightBake) => { value.direction.y = 0; }],
    ["outward ray", (value: RoomSunlightBake) => { value.direction.y = -1; }],
  ] as const)("hides invalid bake: %s", (_name, invalidate) => {
    const invalid = structuredClone(BAKE);
    invalidate(invalid);
    expectHidden(resolveRoomSunlightProjection(invalid, MORNING, layout));
  });

  it.each([
    { x: 0, y: 0, z: 0 },
    { x: 0.6, y: 0, z: -0.5 },
    { x: 0.6, y: 0.5, z: -0.5 },
    { x: 0.6, y: -0.5, z: 0 },
    { x: 0.6, y: -0.5, z: 0.5 },
    { x: NaN, y: -0.5, z: -0.5 },
    { x: 0.6, y: -0.5, z: -Infinity },
  ])("hides degenerate live rays: %j", (lightDirection) => {
    expectHidden(resolveRoomSunlightProjection(BAKE, { ...MORNING, lightDirection }, layout));
  });
});

describe("daylight projection envelope", () => {
  it("retains the original morning gate unless the atlas explicitly supplies a weight", () => {
    const noon = resolveRoomLight(0.5);
    expectHidden(resolveRoomSunlightProjection(BAKE, noon, FIXTURES[0].layout));
    expect(resolveRoomSunlightProjection(BAKE, noon, FIXTURES[0].layout, "floor", { temporalWeight: 1 }).weight).toBe(1);
    expect(resolveRoomSunlightProjection(BAKE, noon, FIXTURES[0].layout, "floor", { temporalWeight: 0.25 }).weight).toBe(0.25);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0])("rejects invalid or inactive atlas weight %s", temporalWeight => {
    expectHidden(resolveRoomSunlightProjection(BAKE, MORNING, FIXTURES[0].layout, "floor", { temporalWeight }));
  });

  it("clamps a positive atlas weight and still rejects an invalid live time", () => {
    expect(resolveRoomSunlightProjection(BAKE, MORNING, FIXTURES[0].layout, "floor", { temporalWeight: 2 }).weight).toBe(1);
    expectHidden(resolveRoomSunlightProjection(BAKE, { ...MORNING, pathPosition: NaN }, FIXTURES[0].layout, "floor", { temporalWeight: 1 }));
  });

  it.each(FIXTURES)("bounds both receiver layers throughout daylight: $name", ({ layout }) => {
    for (let minute = 6 * 60; minute <= 18 * 60; minute += 15) {
      const light = resolveRoomLight(minute / 1440);
      for (const receiver of ["floor", "right-wall"] as const) {
        const result = resolveRoomSunlightProjection(BAKE, light, layout, receiver, { temporalWeight: 1, cropToReceiver: true });
        const matrix = matrixValues(result.transform);
        expect(result.weight).toBe(1);
        const bounds = result.sourceBounds!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(BAKE.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(BAKE.height);
        const pixels = [[0, 0], [bounds.width, 0], [bounds.width, bounds.height], [0, bounds.height]];
        pixels.forEach(([x, y], index) => expectNear(project(matrix, x, y), result.corners[index]));
        for (const point of result.corners) {
          expect(point.x).toBeGreaterThanOrEqual(-layout.room.width * 2);
          expect(point.x).toBeLessThanOrEqual(layout.room.width * 3);
          expect(point.y).toBeGreaterThanOrEqual(-layout.room.height * 2);
          expect(point.y).toBeLessThanOrEqual(layout.room.height * 3);
        }
      }
    }
  });

  it.each(FIXTURES)("cropping preserves the approved morning's visible pixel positions: $name", ({ layout }) => {
    for (const receiver of ["floor", "right-wall"] as const) {
      const original = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout, receiver).transform);
      const result = resolveRoomSunlightProjection(BAKE, MORNING, layout, receiver, { temporalWeight: 1, cropToReceiver: true });
      const cropped = matrixValues(result.transform);
      const bounds = result.sourceBounds!;
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const x = bounds.width * fraction;
        const y = bounds.height * fraction;
        expectNear(project(cropped, x, y), project(original, bounds.x + x, bounds.y + y));
      }
    }
  });

  it("keeps the visible dusk wall when the uncropped image crosses the drawing horizon", () => {
    const light = resolveRoomLight(18 / 24);
    const layout = FIXTURES[1].layout;
    expectHidden(resolveRoomSunlightProjection(BAKE, light, layout, "right-wall", { temporalWeight: 1 }));
    const cropped = resolveRoomSunlightProjection(BAKE, light, layout, "right-wall", { temporalWeight: 1, cropToReceiver: true });
    expect(cropped.weight).toBe(1);
    expect(cropped.corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it("does not manufacture right-wall light from a source pointing away from that wall", () => {
    const light = { ...MORNING, lightDirection: { ...MORNING.lightDirection, x: -0.25 } };
    expectHidden(resolveRoomSunlightProjection(BAKE, light, FIXTURES[0].layout, "right-wall", { temporalWeight: 1, cropToReceiver: true }));
    expect(resolveRoomSunlightProjection(BAKE, light, FIXTURES[0].layout, "floor", { temporalWeight: 1, cropToReceiver: true }).weight).toBe(1);
  });
});

describe.each(FIXTURES)("daylight atlas geometry: $name", ({ layout, calibratedAperture }) => {
  const options = { temporalWeight: 1, cropToReceiver: true };

  it("uses actual resolver directions in every baked frame", () => {
    expect(daylightAtlas.frames.map(frame => frame.pathPosition)).toEqual([6, 9, 12, 15, 18].map(hour => hour / 24));
    for (const bake of daylightAtlas.frames) {
      const light = resolveRoomLight(bake.pathPosition);
      expect(bake.direction.x).toBeCloseTo(light.lightDirection.x, 9);
      expect(bake.direction.y).toBeCloseTo(-light.lightDirection.z, 9);
      expect(bake.direction.z).toBeCloseTo(light.lightDirection.y, 9);
    }
  });

  it("keeps both adjacent samples finite and bounded every quarter hour", () => {
    for (let minute = 360; minute <= 1080; minute += 15) {
      const position = minute / 1440;
      const light = resolveRoomLight(position);
      const relevant = daylightAtlas.frames.filter(frame => Math.abs(frame.pathPosition - position) <= 3 / 24);
      for (const bake of relevant) for (const receiver of ["floor", "right-wall"] as const) {
        const result = resolveRoomSunlightProjection(bake, light, layout, receiver, options);
        matrixValues(result.transform);
        expect(result.weight).toBe(1);
        expect(result.sourceBounds).toBeDefined();
        for (const point of result.corners) {
          expect(point.x).toBeGreaterThanOrEqual(-layout.room.width * 2);
          expect(point.x).toBeLessThanOrEqual(layout.room.width * 3);
          expect(point.y).toBeGreaterThanOrEqual(-layout.room.height * 2);
          expect(point.y).toBeLessThanOrEqual(layout.room.height * 3);
        }
      }
    }
  });

  it("registers adjacent pane edges to independent current-time ray intersections", () => {
    // The measured window was unprojected once into this drawing's 3.4m wall
    // calibration. This oracle casts individual 3D rays, not image matrices.
    const groundToScreen = (s: number, t: number, z = 0) => {
      const denominator = 0.194946 * s - 0.272124 * t + 1;
      return {
        x: (1099.447653 * s + 80.802732 * t + 0.5) / denominator * layout.planes.width / 1280,
        y: (0.097473 * s - 0.136062 * t + 662.5 - 250 * z) / denominator * layout.planes.height / 832,
      };
    };
    for (let index = 0; index < daylightAtlas.frames.length - 1; index++) {
      const pair = daylightAtlas.frames.slice(index, index + 2);
      for (const fraction of [0.25, 0.5, 0.75]) {
        const light = resolveRoomLight(pair[0].pathPosition * (1 - fraction) + pair[1].pathPosition * fraction);
        const ray = light.lightDirection;
        for (const heightFraction of [0.2, 0.5, 0.8]) {
          const widthFraction = 0.9;
          const sourceX = calibratedAperture.left + calibratedAperture.width * widthFraction;
          const sourceZ = calibratedAperture.bottom + (calibratedAperture.top - calibratedAperture.bottom) * heightFraction;
          const floorTime = sourceZ / -ray.y;
          const wallTime = (3.4 - sourceX) / ray.x;
          const expected = {
            floor: groundToScreen((sourceX + floorTime * ray.x) / 3.4, -floorTime * ray.z / 4),
            "right-wall": groundToScreen(1, -wallTime * ray.z / 4, sourceZ + wallTime * ray.y),
          };
          for (const bake of pair) {
            const sourceHeight = bake.aperture.bottom + (bake.aperture.top - bake.aperture.bottom) * heightFraction;
            const bakeTime = sourceHeight / -bake.direction.z;
            const pixelX = (bake.aperture.width * widthFraction + bakeTime * bake.direction.x - bake.bounds.minX)
              / (bake.bounds.maxX - bake.bounds.minX) * bake.width;
            const pixelY = (bakeTime * bake.direction.y - bake.bounds.minY) / (bake.bounds.maxY - bake.bounds.minY) * bake.height;
            for (const receiver of ["floor", "right-wall"] as const) {
              const result = resolveRoomSunlightProjection(bake, light, layout, receiver, options);
              const bounds = result.sourceBounds!;
              const actual = project(matrixValues(result.transform), pixelX - bounds.x, pixelY - bounds.y);
              expectNear(actual, expected[receiver]);
            }
          }
        }
      }
    }
  });

  it("keeps the floor/right-wall seam coincident throughout every interval", () => {
    for (let minute = 360; minute <= 1080; minute += 30) {
      const position = minute / 1440;
      const light = resolveRoomLight(position);
      const ray = light.lightDirection;
      for (const bake of daylightAtlas.frames.filter(frame => Math.abs(frame.pathPosition - position) <= 3 / 24)) {
        const floor = resolveRoomSunlightProjection(bake, light, layout, "floor", options);
        const wall = resolveRoomSunlightProjection(bake, light, layout, "right-wall", options);
        for (const fraction of [0.25, 0.5, 0.75]) {
          const height = calibratedAperture.bottom + (calibratedAperture.top - calibratedAperture.bottom) * fraction;
          const floorTime = height / -ray.y;
          // Find the source ray that reaches the 3.4m room corner at z=0.
          const sourceX = 3.4 - floorTime * ray.x;
          const u = (sourceX - calibratedAperture.left) / calibratedAperture.width;
          const bakedHeight = bake.aperture.bottom + (bake.aperture.top - bake.aperture.bottom) * fraction;
          const bakedTime = bakedHeight / -bake.direction.z;
          const pixel = {
            x: (u * bake.aperture.width + bakedTime * bake.direction.x - bake.bounds.minX)
              / (bake.bounds.maxX - bake.bounds.minX) * bake.width,
            y: (bakedTime * bake.direction.y - bake.bounds.minY) / (bake.bounds.maxY - bake.bounds.minY) * bake.height,
          };
          const floorScreen = project(matrixValues(floor.transform), pixel.x - floor.sourceBounds!.x, pixel.y - floor.sourceBounds!.y);
          const wallScreen = project(matrixValues(wall.transform), pixel.x - wall.sourceBounds!.x, pixel.y - wall.sourceBounds!.y);
          expectNear(floorScreen, wallScreen);
          // The calibrated corner projects onto the same architectural seam.
          const t = -floorTime * ray.z / 4;
          const denominator = 1.194946 - 0.272124 * t;
          expectNear(floorScreen, {
            x: (1099.947653 + 80.802732 * t) / denominator * layout.planes.width / 1280,
            y: (662.597473 - 0.136062 * t) / denominator * layout.planes.height / 832,
          });
        }
      }
    }
  });
});
