import { describe, expect, it } from "vitest";
import { resolveRoomLight } from "./roomLight";
import {
  ROOM_CLOTH_SHADOW_SAMPLES_PER_EDGE,
  resolveRoomClothShadow,
  type ResolvedRoomClothShadow,
  type RoomClothShadowLayout,
  type RoomClothShadowPoint,
} from "./roomClothShadow";

const DAY = resolveRoomLight(9 / 24);
const NIGHT = resolveRoomLight(0);
const DESKTOP: RoomClothShadowLayout = {
  room: { left: 0, top: 0, width: 1280, height: 832 },
  planes: { left: 0, top: 0, width: 1280, height: 832 },
};
const MOBILE: RoomClothShadowLayout = {
  room: { left: 0, top: 0, width: 390, height: 844 },
  planes: { left: 0, top: 0, width: 390, height: 675.2 },
};
const CLOTH = [
  { x: 200, y: 190 }, { x: 440, y: 205 },
  { x: 425, y: 550 }, { x: 285, y: 580 }, { x: 205, y: 530 },
];
const MOBILE_CLOTH = [
  { x: 65, y: 150 }, { x: 255, y: 150 },
  { x: 250, y: 385 }, { x: 90, y: 395 },
];

function pixels(result: ResolvedRoomClothShadow): RoomClothShadowPoint[] {
  return result.points.map(point => ({
    x: result.left + point.x * result.width,
    y: result.top + point.y * result.height,
  }));
}

function expectFinite(result: ResolvedRoomClothShadow | null): asserts result is ResolvedRoomClothShadow {
  expect(result).not.toBeNull();
  if (!result) throw new Error("Missing projection");
  expect([result.left, result.top, result.width, result.height, result.opacity].every(Number.isFinite)).toBe(true);
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
  expect(result.opacity).toBeGreaterThan(0);
  expect(result.opacity).toBeLessThanOrEqual(0.2);
  expect(result.points.length).toBeGreaterThanOrEqual(3);
  for (const point of result.points) {
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(1);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(1);
  }
}

describe("room cloth shadow", () => {
  it("uses a small fixed perimeter sampling budget", () => {
    expect(ROOM_CLOTH_SHADOW_SAMPLES_PER_EDGE * 4).toBe(20);
  });

  it("anchors the desktop silhouette just inside the measured floor", () => {
    const result = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 1);
    expectFinite(result);
    const expectedSeam = 662.5 + (554.5 - 662.5) * (440 - 0.5) / (920.5 - 0.5);
    expect(Math.min(...pixels(result).map(point => point.y))).toBeCloseTo(expectedSeam + 832 * 0.025);
    expect(Math.max(...pixels(result).map(point => point.y))).toBeLessThan(832);
    expect(result.width).toBeLessThan(512);
    expect(result.height).toBeLessThan(256);
  });

  it("measures mobile's 80%-height planes rather than the shortened canvas or whole room", () => {
    const result = resolveRoomClothShadow(MOBILE_CLOTH, DAY, MOBILE, 1, 1);
    expectFinite(result);
    const sourceX = 255 / 390 * 1280;
    const seam = (662.5 - 108 * (sourceX - 0.5) / 920) / 832 * 675.2;
    expect(Math.min(...pixels(result).map(point => point.y))).toBeCloseTo(seam + 675.2 * 0.025);
    // The cue begins above the lower-third mobile cabinet.
    expect(result.top).toBeLessThan(844 * 2 / 3);
  });

  it("uses the descending right-wall seam beyond the room corner", () => {
    const cloth = CLOTH.map(point => ({ ...point, x: point.x + 760, y: point.y - 150 }));
    const result = resolveRoomClothShadow(cloth, DAY, DESKTOP, 1, 1);
    expectFinite(result);
    const seam = 554.5 + (717.865 - 554.5) * (960 - 920.5) / (1279.5 - 920.5);
    expect(Math.min(...pixels(result).map(point => point.y))).toBeCloseTo(seam + 832 * 0.025);
  });

  it("does not move room-local geometry when its client-coordinate origin changes", () => {
    const shifted = {
      room: { ...MOBILE.room, left: 71, top: 99 },
      planes: { ...MOBILE.planes, left: 71, top: 99 },
    };
    expect(resolveRoomClothShadow(MOBILE_CLOTH, DAY, shifted, 1, 1)).toEqual(
      resolveRoomClothShadow(MOBILE_CLOTH, DAY, MOBILE, 1, 1),
    );
  });

  it("does not recenter the cloth when the room width changes", () => {
    const resized = {
      room: { ...DESKTOP.room, width: 1120 },
      planes: { ...DESKTOP.planes, width: 1120 },
    };
    const before = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 1);
    const after = resolveRoomClothShadow(CLOTH, DAY, resized, 1, 1);
    expectFinite(before);
    expectFinite(after);
    expect(after.left).toBeCloseTo(before.left);
    expect(after.width).toBeCloseTo(before.width);
  });

  it("follows the shared beam direction and ignores its vector magnitude", () => {
    const rectangle = [{ x: 200, y: 200 }, { x: 420, y: 200 }, { x: 420, y: 500 }, { x: 200, y: 500 }];
    const vertical = { ...DAY, beam: { ...DAY.beam, screenDirectionX: 0, screenDirectionY: 1 } };
    const diagonal = { ...DAY, beam: { ...DAY.beam, screenDirectionX: 1, screenDirectionY: 1 } };
    const straight = resolveRoomClothShadow(rectangle, vertical, DESKTOP, 1, 1);
    const slanted = resolveRoomClothShadow(rectangle, diagonal, DESKTOP, 1, 1);
    expectFinite(straight);
    expectFinite(slanted);
    expect(Math.max(...pixels(straight).map(point => point.x))).toBeCloseTo(420);
    expect(Math.max(...pixels(slanted).map(point => point.x))).toBeGreaterThan(420);
    const scaled = { ...diagonal, beam: { ...diagonal.beam, screenDirectionX: 4, screenDirectionY: 4 } };
    expect(resolveRoomClothShadow(rectangle, scaled, DESKTOP, 1, 1)).toEqual(slanted);
  });

  it("tracks cloth translation and changes shape with its actual hem", () => {
    const original = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 1);
    const moved = resolveRoomClothShadow(CLOTH.map(point => ({ x: point.x + 35, y: point.y })), DAY, DESKTOP, 1, 1);
    const deformed = resolveRoomClothShadow(CLOTH.map((point, index) => index === 3 ? { x: point.x + 45, y: point.y + 35 } : point), DAY, DESKTOP, 1, 1);
    expectFinite(original);
    expectFinite(moved);
    expectFinite(deformed);
    expect(moved.left - original.left).toBeCloseTo(35);
    expect(moved.width).toBeCloseTo(original.width);
    expect(deformed.points).not.toEqual(original.points);
  });

  it("keeps a raised right hem connected instead of flattening every base to the lowest left hem", () => {
    const cloth = [{ x: 300, y: 220 }, { x: 700, y: 240 }, { x: 700, y: 590 }, { x: 300, y: 647 }];
    const result = resolveRoomClothShadow(cloth, DAY, DESKTOP, 1, 1);
    expectFinite(result);
    const cast = pixels(result);
    const rightHem = cast.find(point => Math.abs(point.x - 700) < 1e-6 && point.y < 650);
    const leftHem = cast.find(point => Math.abs(point.x - 300) < 1e-6);
    expect(rightHem).toBeDefined();
    expect(leftHem).toBeDefined();
    expect(rightHem!.y).toBeCloseTo(590 + (647 - 220) * 0.035);
    expect(leftHem!.y).toBeCloseTo(647 + (647 - 220) * 0.035);
    expect(leftHem!.y - rightHem!.y).toBeGreaterThan(50);
  });

  it("keeps only a shorter, faint ambient cue at night", () => {
    const day = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 1);
    const night = resolveRoomClothShadow(CLOTH, NIGHT, DESKTOP, 1, 1);
    expectFinite(day);
    expectFinite(night);
    expect(day.opacity).toBe(0.2);
    expect(night.opacity).toBe(0.1);
    expect(night.height).toBeLessThan(day.height);
  });

  it("fades with the specimen and material coverage, bounded at full opacity", () => {
    const result = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 0.5, 0.3);
    expectFinite(result);
    expect(result.opacity).toBeCloseTo(0.03);
    expect(resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 0, 1)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 0)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 100, 100)?.opacity).toBe(0.2);
  });

  it("produces the same convex hull for duplicate or self-crossing perimeter order", () => {
    const original = resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, 1);
    const folded = [CLOTH[2], CLOTH[0], CLOTH[4], CLOTH[1], CLOTH[3], CLOTH[0]];
    expect(resolveRoomClothShadow(folded, DAY, DESKTOP, 1, 1)).toEqual(original);
    expect(folded[0]).toEqual(CLOTH[2]);
  });

  it("fits a low-hanging cloth's cast depth to the remaining floor", () => {
    const cloth = CLOTH.map(point => ({ ...point, y: point.y + 215 }));
    const result = resolveRoomClothShadow(cloth, DAY, DESKTOP, 1, 1);
    expectFinite(result);
    expect(Math.max(...pixels(result).map(point => point.y))).toBeLessThanOrEqual(832 + 1e-6);
    const lowestHem = pixels(result).find(point => Math.abs(point.x - 285) < 1e-6);
    expect(lowestHem).toBeDefined();
    expect(lowestHem!.y).toBeCloseTo(795 + 390 * 0.035);
  });

  it("hides offscreen cloth instead of pinning it to the viewport", () => {
    expect(resolveRoomClothShadow(CLOTH.map(point => ({ ...point, x: point.x + 2500 })), DAY, DESKTOP, 1, 1)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH.map(point => ({ ...point, y: point.y + 1000 })), DAY, DESKTOP, 1, 1)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH.map(point => ({ ...point, y: point.y - 10000 })), DAY, DESKTOP, 1, 1)).toBeNull();
  });

  it("rejects degenerate, nonfinite, unbounded, or unreasonably large input", () => {
    for (const points of [[], CLOTH.slice(0, 2), CLOTH.map(() => ({ x: 1, y: 1 })),
      [{ x: NaN, y: 0 }, ...CLOTH], [{ x: 1e300, y: 0 }, ...CLOTH],
      [{ x: 0, y: Infinity }, ...CLOTH], Array.from({ length: 257 }, () => CLOTH[0])]) {
      expect(resolveRoomClothShadow(points, DAY, DESKTOP, 1, 1)).toBeNull();
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(resolveRoomClothShadow(CLOTH, DAY, DESKTOP, value, 1)).toBeNull();
      expect(resolveRoomClothShadow(CLOTH, DAY, DESKTOP, 1, value)).toBeNull();
    }
    expect(resolveRoomClothShadow(CLOTH, DAY, { ...DESKTOP, room: { ...DESKTOP.room, width: 0 } }, 1, 1)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH, DAY, { ...DESKTOP, room: { ...DESKTOP.room, width: 1e300 } }, 1, 1)).toBeNull();
    expect(resolveRoomClothShadow(CLOTH, DAY, { ...DESKTOP, planes: { ...DESKTOP.planes, top: NaN } }, 1, 1)).toBeNull();
    for (const [x, y] of [[0, 0], [1, -1], [NaN, 1], [Infinity, 1]]) {
      expect(resolveRoomClothShadow(CLOTH, { ...DAY, beam: { ...DAY.beam, screenDirectionX: x, screenDirectionY: y } }, DESKTOP, 1, 1)).toBeNull();
    }
    expect(resolveRoomClothShadow(CLOTH, { ...DAY, direct: { ...DAY.direct, intensity: NaN } }, DESKTOP, 1, 1)).toBeNull();
  });
});
