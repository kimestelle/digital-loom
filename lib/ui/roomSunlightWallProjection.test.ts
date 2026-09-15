import { describe, expect, it } from "vitest";
import type { RoomFloorProjectionLayout } from "./roomFloorProjection";
import type { ResolvedRoomLight } from "./roomLight";
import {
  resolveRoomSunlightProjection,
  type RoomSunlightBake,
  type RoomSunlightProjection,
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

const MORNING: Pick<ResolvedRoomLight, "pathPosition" | "lightDirection"> = {
  pathPosition: 9 / 24,
  lightDirection: { x: BAKE.direction.x, y: BAKE.direction.z, z: -BAKE.direction.y },
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

// Independent ray/plane intersections, not results copied from the resolver.
// For each seam point: choose the aperture's bottom/middle/top height, solve
// sourceX = 3.4m - rayX * sourceHeight, cast to the floor, then use the drawing
// homography. The wall and floor must meet at precisely these source pixels.
const FIXTURES = [
  {
    name: "1280 × 832 desktop",
    layout: responsiveLayout(1280, 832),
    upperRight: { x: 951.3135000100726, y: 94.21544800289186 },
    seam: [
      { pixel: { x: 538.4788935573657, y: 45.837271320628986 }, screen: { x: 993.7605602684077, y: 587.8376142847934 } },
      { pixel: { x: 536.4451588397684, y: 244.56730587443363 }, screen: { x: 1060.1582917463056, y: 618.0522765919301 } },
      { pixel: { x: 534.4114241221713, y: 443.2973404282383 }, screen: { x: 1133.7579703974197, y: 651.5442255916848 } },
    ],
  },
  {
    name: "390 × 844 narrow room with 80% planes",
    layout: responsiveLayout(390, 844),
    upperRight: { x: 289.853332034319, y: 76.55040979553347 },
    seam: [
      { pixel: { x: 595.8954371753719, y: 45.837271320628986 }, screen: { x: 305.8917729655651, y: 480.8166617916128 } },
      { pixel: { x: 697.5326879440835, y: 244.56730587443363 }, screen: { x: 324.72028128372574, y: 503.6376731734069 } },
      { pixel: { x: 799.1699387127952, y: 443.2973404282383 }, screen: { x: 345.4268276455765, y: 528.7349523745245 } },
    ],
  },
] as const;

function matrixValues(result: RoomSunlightProjection): number[] {
  expect(result.weight).toBe(1);
  expect(result.transform).toMatch(/^matrix3d\(.+\)$/);
  const matrix = result.transform.slice("matrix3d(".length, -1).split(",").map(Number);
  expect(matrix).toHaveLength(16);
  expect(matrix.every(Number.isFinite)).toBe(true);
  return matrix;
}

function project(matrix: number[], { x, y }: { x: number; y: number }) {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  expect(w).toBeGreaterThan(1e-5);
  return {
    x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
    y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w,
  };
}

function expectNear(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  // Coefficients serialize to nine decimals; tolerate 0.005 CSS px.
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(0.005);
}

function expectHidden(result: RoomSunlightProjection) {
  expect(result).toEqual({ transform: "scale(0)", weight: 0, corners: [] });
}

describe.each(FIXTURES)("right-wall sunlight: $name", ({ layout, upperRight, seam }) => {
  it("keeps the entire source rectangle finite, including its perspective denominators", () => {
    const result = resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall");
    const matrix = matrixValues(result);
    expect(result.corners).toHaveLength(4);
    const pixels = [
      { x: 0, y: 0 }, { x: BAKE.width, y: 0 },
      { x: BAKE.width, y: BAKE.height }, { x: 0, y: BAKE.height },
    ];
    pixels.forEach((point, index) => expectNear(project(matrix, point), result.corners[index]));
  });

  it("joins the floor at the same image pixels without a gap or a shifted pane", () => {
    const floor = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout));
    const wall = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall"));
    for (const { pixel, screen } of seam) {
      expectNear(project(floor, pixel), screen);
      expectNear(project(wall, pixel), screen);
      expectNear(project(wall, pixel), project(floor, pixel));
    }
  });

  it("lands the upper-right aperture ray at an independently calculated wall point", () => {
    const rayTime = BAKE.aperture.top / -BAKE.direction.z;
    const floorX = BAKE.aperture.width + rayTime * BAKE.direction.x;
    const floorY = rayTime * BAKE.direction.y;
    const pixel = {
      x: (floorX - BAKE.bounds.minX) / (BAKE.bounds.maxX - BAKE.bounds.minX) * BAKE.width,
      y: (floorY - BAKE.bounds.minY) / (BAKE.bounds.maxY - BAKE.bounds.minY) * BAKE.height,
    };
    const matrix = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall"));
    expectNear(project(matrix, pixel), upperRight);
  });

  it("puts rays on opposite sides of the seam when their floor landing crosses the wall", () => {
    const matrix = matrixValues(resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall"));
    const center = seam[1].pixel;
    // Side-wall boundary from the same architectural vertices, extrapolated
    // across the viewport. Negative-height wall hits belong below this edge
    // and will be clipped, not painted upward onto the wall.
    const floorBoundaryY = (x: number) => {
      const sourceX = (x - layout.planes.left + layout.room.left) * 1280 / layout.planes.width;
      const sourceY = 554.5 + (sourceX - 920.5) * (717.865 - 554.5) / (1279.5 - 920.5);
      return sourceY * layout.planes.height / 832 + layout.planes.top - layout.room.top;
    };
    const above = project(matrix, { x: center.x + 12, y: center.y });
    const below = project(matrix, { x: center.x - 12, y: center.y });
    expect(above.y).toBeLessThan(floorBoundaryY(above.x) - 1);
    expect(below.y).toBeGreaterThan(floorBoundaryY(below.x) + 1);
  });

  it("uses room-local coordinates regardless of viewport origin", () => {
    const moved = structuredClone(layout);
    for (const rect of [moved.room, moved.planes, moved.aperture]) {
      rect.left += 73;
      rect.top += 119;
    }
    expect(resolveRoomSunlightProjection(BAKE, MORNING, moved, "right-wall"))
      .toEqual(resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall"));
  });

  it("preserves the architecture's offset inside the room", () => {
    const moved = structuredClone(layout);
    for (const rect of [moved.planes, moved.aperture]) {
      rect.left += 24;
      rect.top += 35;
    }
    const original = resolveRoomSunlightProjection(BAKE, MORNING, layout, "right-wall");
    const result = resolveRoomSunlightProjection(BAKE, MORNING, moved, "right-wall");
    expect(result.weight).toBe(1);
    result.corners.forEach((point, index) => expectNear(point, {
      x: original.corners[index].x + 24,
      y: original.corners[index].y + 35,
    }));
  });
});

describe("right-wall sunlight guards", () => {
  const layout = FIXTURES[0].layout;

  it.each([-0.3, 0, 1e-7, 1e-6])("hides a ray facing away from or parallel to the wall at x=%s", (x) => {
    const light = { ...MORNING, lightDirection: { ...MORNING.lightDirection, x } };
    expectHidden(resolveRoomSunlightProjection(BAKE, light, layout, "right-wall"));
    // Rejecting one receiving plane must not disable valid floor light.
    matrixValues(resolveRoomSunlightProjection(BAKE, light, layout));
  });

  it.each([0, 0.5, 0.9, NaN, Infinity])("keeps both receivers gated outside the morning at %s", (pathPosition) => {
    const light = { ...MORNING, pathPosition };
    expectHidden(resolveRoomSunlightProjection(BAKE, light, layout, "right-wall"));
    expectHidden(resolveRoomSunlightProjection(BAKE, light, layout));
  });

  it("rejects nonfinite wall rays", () => {
    for (const x of [NaN, Infinity, -Infinity]) {
      const light = { ...MORNING, lightDirection: { ...MORNING.lightDirection, x } };
      expectHidden(resolveRoomSunlightProjection(BAKE, light, layout, "right-wall"));
    }
  });
});
