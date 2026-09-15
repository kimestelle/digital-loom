import { describe, expect, it } from "vitest";
import { clothNeedsBlending } from "./clothCompositing";

describe("cloth coverage render path", () => {
  it("uses opaque depth rendering for a settled, covered sheet", () => {
    expect(clothNeedsBlending(0, 0, 1, 1, 1)).toBe(false);
  });

  it.each([
    [Number.EPSILON, 0, 1, 1, 1],
    [0, Number.EPSILON, 1, 1, 1],
    [0, 0, 0.999999, 1, 1],
    [0, 0, 1, 0.999999, 1],
    [0, 0, 1, 1, 0.999999],
    [0, 0, 0, 1, 1],
    [0, 0, 1, 0, 1],
    [0, 0, 1, 1, 0],
    [NaN, 0, 1, 1, 1],
  ])("retains blending for partial coverage or an unfinished transition: %j", (...values) => {
    expect(clothNeedsBlending(...values as [number, number, number, number, number])).toBe(true);
  });

  it("returns to the original path immediately when coverage changes", () => {
    const phases = [
      clothNeedsBlending(0, 0, 1, 1, 0),
      clothNeedsBlending(0, 0, 1, 1, 1),
      clothNeedsBlending(0.05, 0, 1, 1, 1),
      clothNeedsBlending(0, 0, 1, 1, 1),
      clothNeedsBlending(0, 0, 0.5, 1, 1),
    ];
    expect(phases).toEqual([true, false, true, false, true]);
  });
});
