import { describe, expect, it } from "vitest";
import {
  buildMapFilter,
  DEFAULT_MAP_IMAGE_SETTINGS,
  editNormalPixel,
} from "./mapImageEdits";

describe("map image edits", () => {
  it("builds a neutral pixel filter by default", () => {
    expect(buildMapFilter(DEFAULT_MAP_IMAGE_SETTINGS)).toBe(
      "brightness(1) contrast(1) saturate(1) hue-rotate(0deg) blur(0px) invert(0)",
    );
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
});

