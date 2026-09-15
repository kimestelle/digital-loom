import { describe, expect, it } from "vitest";
import { resolveRoomSunlightInterval } from "./roomSunlightTimeline";

const FRAMES = [6, 9, 12, 15, 18].map(hour => ({ pathPosition: hour / 24 }));

describe("daylight optical intervals", () => {
  it.each(FRAMES.map((frame, index) => [frame.pathPosition, index] as const))(
    "uses only the exact sample at %s",
    (position, index) => {
      expect(resolveRoomSunlightInterval(FRAMES, position)).toEqual({
        lowerIndex: index, upperIndex: index, lowerWeight: 1, upperWeight: 0,
      });
    },
  );

  it.each([0, 1, 2, 3])("blends only the two samples bounding interval %s", lowerIndex => {
    const position = (FRAMES[lowerIndex].pathPosition + FRAMES[lowerIndex + 1].pathPosition) / 2;
    expect(resolveRoomSunlightInterval(FRAMES, position)).toEqual({
      lowerIndex, upperIndex: lowerIndex + 1, lowerWeight: 0.5, upperWeight: 0.5,
    });
  });

  it("has no temporal easing or brightness dip in its numerical weights", () => {
    for (let minute = 0; minute <= 1440; minute++) {
      const interval = resolveRoomSunlightInterval(FRAMES, minute / 1440)!;
      expect(interval.lowerWeight + interval.upperWeight).toBe(1);
      expect(interval.lowerWeight).toBeGreaterThanOrEqual(0);
      expect(interval.upperWeight).toBeGreaterThanOrEqual(0);
      expect(interval.lowerWeight).toBeLessThanOrEqual(1);
      expect(interval.upperWeight).toBeLessThanOrEqual(1);
      expect(interval.upperIndex - interval.lowerIndex).toBeLessThanOrEqual(1);
      if (interval.lowerIndex !== interval.upperIndex) {
        const reconstructedTime = FRAMES[interval.lowerIndex].pathPosition * interval.lowerWeight
          + FRAMES[interval.upperIndex].pathPosition * interval.upperWeight;
        expect(reconstructedTime).toBeCloseTo(minute / 1440, 14);
      }
    }
  });

  it("supports nonuniform bake intervals", () => {
    expect(resolveRoomSunlightInterval([{ pathPosition: 0.2 }, { pathPosition: 0.4 }, { pathPosition: 0.7 }], 0.25))
      .toEqual({ lowerIndex: 0, upperIndex: 1, lowerWeight: 0.75, upperWeight: 0.24999999999999994 });
  });

  it.each([-100, 0, 0.1])("clamps %s to dawn without extrapolation", position => {
    expect(resolveRoomSunlightInterval(FRAMES, position))
      .toEqual({ lowerIndex: 0, upperIndex: 0, lowerWeight: 1, upperWeight: 0 });
  });

  it.each([0.8, 1, 100])("clamps %s to dusk without midnight wrap", position => {
    expect(resolveRoomSunlightInterval(FRAMES, position))
      .toEqual({ lowerIndex: 4, upperIndex: 4, lowerWeight: 1, upperWeight: 0 });
  });

  it("can hold a single available optical sample", () => {
    for (const position of [0, 0.375, 1]) {
      expect(resolveRoomSunlightInterval([FRAMES[1]], position))
        .toEqual({ lowerIndex: 0, upperIndex: 0, lowerWeight: 1, upperWeight: 0 });
    }
  });

  it.each([[], [0.4, 0.2], [0.2, 0.2], [0.2, NaN], [0.2, Infinity], [-0.1], [1.1]])(
    "rejects an invalid atlas %j",
    (...positions) => {
      const frames = (positions as number[]).map(pathPosition => ({ pathPosition }));
      expect(resolveRoomSunlightInterval(frames, 0.375)).toBeNull();
    },
  );

  it.each([NaN, Infinity, -Infinity])("rejects invalid time %s", position => {
    expect(resolveRoomSunlightInterval(FRAMES, position)).toBeNull();
  });

  it("does not reorder or mutate authored samples", () => {
    const frames = Object.freeze(FRAMES.map(frame => Object.freeze({ ...frame })));
    const before = JSON.stringify(frames);
    resolveRoomSunlightInterval(frames, 0.45);
    expect(JSON.stringify(frames)).toBe(before);
  });
});
