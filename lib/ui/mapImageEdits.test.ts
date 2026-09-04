import { describe, expect, it } from "vitest";
import {
  buildMapFilter,
  DEFAULT_MAP_IMAGE_SETTINGS,
  editNormalImageData,
  editNormalPixel,
  mapBakeSafetyError,
  normalEditTileRows,
} from "./mapImageEdits";

describe("map image edits", () => {
  it("builds a neutral pixel filter by default", () => {
    expect(buildMapFilter(DEFAULT_MAP_IMAGE_SETTINGS)).toBe(
      "brightness(1) contrast(1) saturate(1) hue-rotate(0deg) blur(0px) invert(0)",
    );
  });

  it("scales blur to match a downsampled preview", () => {
    expect(
      buildMapFilter({ ...DEFAULT_MAP_IMAGE_SETTINGS, blur: 8 }, 0.25),
    ).toContain("blur(2px)");
  });

  it("renormalizes normal vectors after changing relief strength", () => {
    const [red, green, blue] = editNormalPixel(191, 128, 238, 2, false);
    const x = (red / 255) * 2 - 1;
    const y = (green / 255) * 2 - 1;
    const z = (blue / 255) * 2 - 1;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 2);
    expect(red).toBeGreaterThan(191);
  });

  it("flips only the normal map's y direction", () => {
    const normal = editNormalPixel(128, 170, 240, 1, false);
    const flipped = editNormalPixel(128, 170, 240, 1, true);
    expect(flipped[0]).toBe(normal[0]);
    expect(flipped[1]).toBeCloseTo(255 - normal[1], 0);
    expect(flipped[2]).toBe(normal[2]);
  });

  it("edits tiled normal-map buffers with the same pixel transform", () => {
    const data = new Uint8ClampedArray([191, 170, 238, 77]);
    editNormalImageData({ data } as ImageData, 1.55, true);
    expect(Array.from(data)).toEqual([
      ...editNormalPixel(191, 170, 238, 1.55, true),
      77,
    ]);
  });

  it("keeps standard 4k maps at native resolution", () => {
    expect(mapBakeSafetyError(4096, 4096)).toBeNull();
    expect(mapBakeSafetyError(8192, 2048)).toBeNull();
  });

  it("rejects dangerous canvas allocations before baking", () => {
    expect(mapBakeSafetyError(4097, 4096)).toContain("too large");
    expect(mapBakeSafetyError(8193, 1)).toContain("too large");
    expect(mapBakeSafetyError(0, 4096)).toContain("invalid pixel dimensions");
  });

  it("bounds normal-map pixel buffers to small row tiles", () => {
    expect(normalEditTileRows(2048)).toBe(256);
    expect(normalEditTileRows(4096)).toBe(128);
    expect(4096 * normalEditTileRows(4096) * 4).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
  });
});
