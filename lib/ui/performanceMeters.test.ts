import { describe, expect, it } from "vitest";
import { advanceAutoQuality } from "./performanceMeters";

const initialState = () => ({ lowSince: 0, highSince: 0, lastStep: 0 });

describe("performance meter auto quality", () => {
  it("keeps fragment quality during a short frame-rate dip", () => {
    const state = initialState();
    expect(advanceAutoQuality(state, 30, "hi", 20_000)).toBeUndefined();
    expect(advanceAutoQuality(state, 30, "hi", 23_000)).toBeUndefined();
    expect(advanceAutoQuality(state, 30, "hi", 23_001)).toBe("mid");
  });

  it("waits ten seconds between downward steps, even under sustained load", () => {
    const state = initialState();
    advanceAutoQuality(state, 30, "hi", 20_000);
    expect(advanceAutoQuality(state, 30, "hi", 23_001)).toBe("mid");
    advanceAutoQuality(state, 30, "mid", 23_001);
    expect(advanceAutoQuality(state, 30, "mid", 33_001)).toBeUndefined();
    expect(advanceAutoQuality(state, 30, "mid", 33_002)).toBe("lo");
  });

  it("restores quality only after more than ten seconds above 58 fps", () => {
    const state = initialState();
    expect(advanceAutoQuality(state, 60, "lo", 20_000)).toBeUndefined();
    expect(advanceAutoQuality(state, 60, "lo", 30_000)).toBeUndefined();
    expect(advanceAutoQuality(state, 60, "lo", 30_001)).toBe("mid");
  });

  it.each([45, 50, 58])("breaks a sustained dip or recovery at %s fps", fps => {
    const low = initialState();
    advanceAutoQuality(low, 30, "hi", 20_000);
    advanceAutoQuality(low, fps, "hi", 22_500);
    expect(advanceAutoQuality(low, 30, "hi", 23_001)).toBeUndefined();

    const high = initialState();
    advanceAutoQuality(high, 60, "lo", 20_000);
    advanceAutoQuality(high, fps, "lo", 29_500);
    expect(advanceAutoQuality(high, 60, "lo", 30_001)).toBeUndefined();
  });

  it("starts a new recovery when frame rate crosses from low to high", () => {
    const state = initialState();
    advanceAutoQuality(state, 60, "mid", 20_000);
    advanceAutoQuality(state, 30, "mid", 29_000);
    expect(advanceAutoQuality(state, 60, "mid", 30_001)).toBeUndefined();
    expect(advanceAutoQuality(state, 60, "mid", 40_002)).toBe("hi");
  });

  it("never steps outside the available quality presets", () => {
    const low = initialState();
    advanceAutoQuality(low, 30, "lo", 20_000);
    expect(advanceAutoQuality(low, 30, "lo", 40_000)).toBeUndefined();
    const high = initialState();
    advanceAutoQuality(high, 60, "hi", 20_000);
    expect(advanceAutoQuality(high, 60, "hi", 40_000)).toBeUndefined();
  });
});
