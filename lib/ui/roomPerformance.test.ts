import { describe, expect, it } from "vitest";
import { DEFAULT_KNOBS, fabricKnobsOf, MESH_PRESETS, QUALITY_PRESETS } from "./knobs";
import { roomPerformance } from "./roomPerformance";

describe("room mobile preview budget", () => {
  it("leaves desktop settings untouched", () => {
    expect(roomPerformance(DEFAULT_KNOBS, false)).toBe(DEFAULT_KNOBS);
  });

  it("caps expensive preferences without changing source settings or the material", () => {
    const source = Object.freeze({ ...DEFAULT_KNOBS, autoQuality: true });
    const preview = roomPerformance(source, true);
    expect(preview).toMatchObject({
      quality: "lo", meshRes: "lo", iterations: 3, selfCollide: "half",
      anisotropy: 2, pomMinSteps: 6, pomMaxSteps: 16, autoQuality: false,
    });
    expect(fabricKnobsOf(preview)).toEqual(fabricKnobsOf(source));
    expect(source.quality).toBe("hi");
    expect(source.autoQuality).toBe(true);
    expect(roomPerformance(source, false)).toBe(source);
    expect(QUALITY_PRESETS[preview.quality].pixelScale).toBe(0.5);
    expect(MESH_PRESETS[preview.meshRes]).toEqual({ cols: 32, rows: 32 });
  });

  it("does not increase already cheaper solver and relief settings", () => {
    const preview = roomPerformance({ ...DEFAULT_KNOBS,
      iterations: 2, selfCollide: "off", pomMinSteps: 2, pomMaxSteps: 8,
    }, true);
    expect(preview).toMatchObject({
      iterations: 2, selfCollide: "off", pomMinSteps: 2, pomMaxSteps: 8,
    });
  });
});
