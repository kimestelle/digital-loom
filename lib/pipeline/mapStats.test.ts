import { beforeEach, describe, expect, it } from "vitest";
import {
  MAP_STATS_SAMPLE_SIZE,
  NEUTRAL_MAP_STATS,
  clearMapStatsCache,
  getMapStats,
  hasCachedMapStats,
  mapStatsFromRgba,
  readMapStats,
  type MapStatsPixelLoader,
} from "./mapStats";

const rgba = (...pixels: [number, number, number, number][]) =>
  new Uint8ClampedArray(pixels.flat());

describe("map statistics", () => {
  beforeEach(() => clearMapStatsCache());

  it("preserves the estimator's luminance statistics and adds mean RGB", () => {
    const stats = mapStatsFromRgba(
      rgba([0, 0, 0, 255], [255, 255, 255, 0]),
    );
    expect(stats).not.toBeNull();
    expect(stats?.mean).toBeCloseTo(0.5, 10);
    expect(stats?.std).toBeCloseTo(0.5, 10);
    expect(stats?.darkFrac).toBe(0.5);
    expect(stats?.sat).toBe(0);
    expect(stats?.meanRgb).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("uses the same HSV-style saturation calculation as estimateParams", () => {
    const stats = mapStatsFromRgba(
      rgba([255, 0, 0, 255], [128, 64, 64, 255]),
    );
    expect(stats?.sat).toBeCloseTo(0.75, 8);
    expect(stats?.meanRgb.r).toBeCloseTo((1 + 128 / 255) / 2, 8);
    expect(stats?.meanRgb.g).toBeCloseTo(32 / 255, 8);
    expect(stats?.meanRgb.b).toBeCloseTo(32 / 255, 8);
  });

  it("samples at a bounded 64 by 64 size and caches successes by URL", async () => {
    let calls = 0;
    const loader: MapStatsPixelLoader = async (_url, size) => {
      calls++;
      expect(size).toBe(MAP_STATS_SAMPLE_SIZE);
      return { data: rgba([64, 128, 192, 255]) };
    };

    const first = await getMapStats("blob:stable", loader);
    const second = await getMapStats("blob:stable", loader);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(hasCachedMapStats("blob:stable")).toBe(true);
  });

  it("does not cache failures, allowing a temporarily unavailable map to retry", async () => {
    let calls = 0;
    const loader: MapStatsPixelLoader = async () => {
      calls++;
      return calls === 1 ? null : { data: rgba([255, 255, 255, 255]) };
    };
    expect(await getMapStats("blob:retry", loader)).toBeNull();
    expect(await getMapStats("blob:retry", loader)).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("shares concurrent reads of the same URL", async () => {
    let calls = 0;
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const loader: MapStatsPixelLoader = async () => {
      calls++;
      await gate;
      return { data: rgba([80, 100, 120, 255]) };
    };
    const first = getMapStats("blob:concurrent", loader);
    const second = getMapStats("blob:concurrent", loader);
    finish?.();
    await expect(first).resolves.toBe(await second);
    expect(calls).toBe(1);
  });

  it("marks late reads stale and never leaks their tint to the caller", async () => {
    let activeUrl = "blob:first";
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = readMapStats("blob:first", {
      loadPixels: async () => {
        await gate;
        return { data: rgba([255, 0, 0, 255]) };
      },
      isCurrent: (url) => url === activeUrl,
    });
    activeUrl = "blob:second";
    finish?.();

    await expect(pending).resolves.toEqual({
      url: "blob:first",
      status: "stale",
      stats: NEUTRAL_MAP_STATS,
    });
  });

  it("returns a neutral failure result instead of throwing", async () => {
    const result = await readMapStats("https://invalid.example/map.png", {
      loadPixels: async () => {
        throw new Error("cors");
      },
    });
    expect(result).toEqual({
      url: "https://invalid.example/map.png",
      status: "fallback",
      stats: NEUTRAL_MAP_STATS,
    });
    expect(hasCachedMapStats(result.url)).toBe(false);
  });
});
