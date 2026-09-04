import { describe, expect, it } from "vitest";
import {
  CLOTH_LAUNCH_MAP_SIZE,
  createClothLaunchShimmerData,
  seedClothLaunchDrape,
  seedShimmerMap,
} from "./clothLaunchShimmer";

describe("cloth launch shimmer map", () => {
  it("is deterministic and fills an RGBA texture", () => {
    const first = createClothLaunchShimmerData();
    const second = createClothLaunchShimmerData();
    expect(first).toEqual(second);
    expect(first).toHaveLength(CLOTH_LAUNCH_MAP_SIZE ** 2 * 4);
  });

  it("seeds a stable vertical drape while preserving snapped pegs", () => {
    const cols = 7;
    const rows = 4;
    const spacing = 10;
    const pos = new Float32Array(cols * rows * 3);
    const prev = new Float32Array(pos.length);
    const pinned = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < cols; column++) {
        const index = (row * cols + column) * 3;
        pos[index] = column * spacing;
        pos[index + 1] = row * spacing;
      }
    }
    pinned[1] = 1;
    pinned[5] = 1;
    pos[1 * 3 + 1] = -20;
    pos[5 * 3 + 1] = -16;

    seedClothLaunchDrape({ cols, rows, pos, prev, pinned }, spacing);

    expect(pos[1 * 3 + 1]).toBe(-20);
    expect(pos[5 * 3 + 1]).toBe(-16);
    expect(pos[3 * 3 + 1]).toBeGreaterThan(-18);
    for (let column = 0; column < cols; column++) {
      for (let row = 1; row < rows; row++) {
        const here = (row * cols + column) * 3 + 1;
        const above = ((row - 1) * cols + column) * 3 + 1;
        expect(pos[here] - pos[above]).toBeCloseTo(spacing, 5);
      }
    }
    expect(prev).toEqual(pos);
  });

  it("normalizes the reveal order across the full byte range", () => {
    const data = createClothLaunchShimmerData(16);
    const order = Array.from({ length: 16 ** 2 }, (_, index) => data[index * 4]);
    expect(Math.min(...order)).toBe(0);
    expect(Math.max(...order)).toBe(255);
    expect(new Set(order).size).toBeGreaterThan(64);
  });

  it("changes coherently with its seed and rejects invalid map sizes", () => {
    const first = createClothLaunchShimmerData(8, seedShimmerMap("first"));
    const second = createClothLaunchShimmerData(8, seedShimmerMap("second"));
    expect(first).not.toEqual(second);
    expect(() => createClothLaunchShimmerData(1)).toThrow(/integer >= 2/);
  });
});
