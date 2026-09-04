import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_KNOBS, type FabricKnobs } from "./knobs";
import {
  applyMaterialInstrument,
  createMaterialInstrumentBaseline,
  effectiveOpennessPercent,
  inferConstruction,
  opennessFromEffectivePercent,
  readMaterialInstrument,
  tileScaleFromSlider,
  tileScaleToSlider,
} from "./materialInstrument";

const knobs = (over: Partial<FabricKnobs> = {}): FabricKnobs => ({
  ...DEFAULT_FABRIC_KNOBS,
  ...over,
});

describe("material instrument baseline", () => {
  it("is an exact identity at the state derived from an arbitrary baseline", () => {
    const source = knobs({
      sheen: 0.37,
      weight: 1.73,
      bendStiffness: 0.19,
      pomScale: 0.027,
      normalAmount: 0.64,
      pomShadow: 0.31,
      edgeFray: 0.43,
      edgeDetail: 5.25,
      tileScale: 3.7,
      txAlbedo: 0.87,
    });
    const baseline = createMaterialInstrumentBaseline(source, "twill");
    const result = applyMaterialInstrument(baseline, baseline.state);

    expect(result.knobs).toEqual(source);
    expect(result.state).toEqual(baseline.state);
    expect(result.construction).toBe("twill");
    expect(source).toEqual(knobs({
      sheen: 0.37,
      weight: 1.73,
      bendStiffness: 0.19,
      pomScale: 0.027,
      normalAmount: 0.64,
      pomShadow: 0.31,
      edgeFray: 0.43,
      edgeDetail: 5.25,
      tileScale: 3.7,
      txAlbedo: 0.87,
    }));
  });

  it("reads an applied baseline back without drift on directly invertible macros", () => {
    const baseline = createMaterialInstrumentBaseline(
      knobs({ normalAmount: 0.45, pomShadow: 0.35 }),
      "plain",
    );
    const target = {
      hand: 0.72,
      response: 0.81,
      luster: 0.28,
      relief: 0.67,
      opennessPercent: 34,
      tileScale: 6.5,
      edgeFinish: 0.74,
    };
    const result = applyMaterialInstrument(baseline, target);
    const readBack = readMaterialInstrument(result.knobs, result.construction);

    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      expect(readBack[key]).toBeCloseTo(target[key], 8);
    }
  });
});

describe("material instrument mappings", () => {
  it("infers the nearest construction from the shear-to-warp relationship", () => {
    expect(
      inferConstruction(knobs({ warpStiffness: 0.8, shearStiffness: 0.44 })),
    ).toBe("plain");
    expect(
      inferConstruction(knobs({ warpStiffness: 0.8, shearStiffness: 0.56 })),
    ).toBe("twill");
    expect(
      inferConstruction(knobs({ warpStiffness: 0.8, shearStiffness: 0.64 })),
    ).toBe("satin");
    expect(
      inferConstruction(knobs({ warpStiffness: 0.8, shearStiffness: 0.76 })),
    ).toBe("knit");
  });

  it("uses declaration order for construction ties and plain for a degenerate ratio", () => {
    // 0.625 sits exactly between plain (0.55) and twill (0.7).
    expect(
      inferConstruction(knobs({ warpStiffness: 0.8, shearStiffness: 0.5 })),
    ).toBe("plain");
    expect(
      inferConstruction(knobs({ warpStiffness: 0, shearStiffness: 0.5 })),
    ).toBe("plain");
  });

  it("maps hand monotonically, preserves warp/weft ratio, and gives bend the strongest response", () => {
    const baseline = createMaterialInstrumentBaseline(
      knobs({
        warpStiffness: 0.72,
        weftStiffness: 0.48,
        shearStiffness: 0.42,
        bendStiffness: 0.16,
      }),
      "plain",
    );
    const fluid = applyMaterialInstrument(baseline, { hand: 0.15 }).knobs;
    const crisp = applyMaterialInstrument(baseline, { hand: 0.85 }).knobs;

    expect(crisp.warpStiffness).toBeGreaterThan(fluid.warpStiffness);
    expect(crisp.weftStiffness).toBeGreaterThan(fluid.weftStiffness);
    expect(crisp.shearStiffness).toBeGreaterThan(fluid.shearStiffness);
    expect(crisp.bendStiffness).toBeGreaterThan(fluid.bendStiffness);
    expect(fluid.warpStiffness / fluid.weftStiffness).toBeCloseTo(1.5, 10);
    expect(crisp.warpStiffness / crisp.weftStiffness).toBeCloseTo(1.5, 10);
    expect(fluid.shearStiffness / fluid.warpStiffness).toBeCloseTo(
      0.42 / 0.72,
      10,
    );
    expect(crisp.shearStiffness / crisp.warpStiffness).toBeCloseTo(
      0.42 / 0.72,
      10,
    );
    expect(inferConstruction(fluid)).toBe("plain");
    expect(inferConstruction(crisp)).toBe("plain");

    const capped = applyMaterialInstrument(
      createMaterialInstrumentBaseline(DEFAULT_FABRIC_KNOBS, "plain"),
      { hand: 1 },
    ).knobs;
    expect(capped.warpStiffness).toBeCloseTo(1, 12);
    expect(inferConstruction(capped)).toBe("plain");

    const bendRange = crisp.bendStiffness - fluid.bendStiffness;
    expect(bendRange).toBeGreaterThan(crisp.warpStiffness - fluid.warpStiffness);
    expect(bendRange).toBeGreaterThan(crisp.shearStiffness - fluid.shearStiffness);
  });

  it("changes construction structurally without swapping a material profile", () => {
    const source = knobs({
      sheen: 0.63,
      weight: 1.41,
      warpStiffness: 0.8,
      weftStiffness: 0.6,
      shearStiffness: 0.5,
      bendStiffness: 0.2,
    });
    const baseline = createMaterialInstrumentBaseline(source, "plain");
    const knit = applyMaterialInstrument(baseline, { construction: "knit" });

    expect(knit.construction).toBe("knit");
    expect(knit.knobs.warpStiffness).toBeLessThan(source.warpStiffness);
    expect(knit.knobs.weftStiffness).toBeLessThan(source.weftStiffness);
    expect(knit.knobs.bendStiffness).toBeLessThan(source.bendStiffness);
    expect(knit.knobs.warpStiffness / knit.knobs.weftStiffness).toBeCloseTo(
      source.warpStiffness / source.weftStiffness,
      10,
    );
    expect(knit.knobs.sheen).toBe(source.sheen);
    expect(knit.knobs.weight).toBe(source.weight);
  });

  it("encodes every construction in the serialized stiffness ratio", () => {
    for (const sourceRatio of [0.625, 0.749, 0.875]) {
      const source = knobs({
        warpStiffness: 0.8,
        shearStiffness: 0.8 * sourceRatio,
      });
      const sourceConstruction = inferConstruction(source);
      const baseline = createMaterialInstrumentBaseline(
        source,
        sourceConstruction,
      );
      for (const construction of ["plain", "twill", "satin", "knit"] as const) {
        const applied = applyMaterialInstrument(baseline, { construction });
        expect(inferConstruction(applied.knobs)).toBe(construction);
      }
    }
  });

  it("moves response, luster, and every relief component monotonically", () => {
    const baseline = createMaterialInstrumentBaseline(
      knobs({ pomScale: 0.02, normalAmount: 0.42, pomShadow: 0.36 }),
      "plain",
    );
    const low = applyMaterialInstrument(baseline, {
      response: 0.1,
      luster: 0.1,
      relief: 0.1,
    }).knobs;
    const high = applyMaterialInstrument(baseline, {
      response: 0.9,
      luster: 0.9,
      relief: 0.9,
    }).knobs;

    expect(high.weight).toBeGreaterThan(low.weight);
    expect(high.sheen).toBeGreaterThan(low.sheen);
    expect(high.pomScale).toBeGreaterThan(low.pomScale);
    expect(high.normalAmount).toBeGreaterThan(low.normalAmount);
    expect(high.pomShadow).toBeGreaterThan(low.pomShadow);
  });

  it("coordinates a rawer edge while softening its boundary", () => {
    const baseline = createMaterialInstrumentBaseline(
      knobs({ edgeInset: 0.02, edgeFray: 0.4, edgeSharpness: 0.6, edgeDetail: 3 }),
      "plain",
    );
    const clean = applyMaterialInstrument(baseline, { edgeFinish: 0.1 }).knobs;
    const raw = applyMaterialInstrument(baseline, { edgeFinish: 0.9 }).knobs;

    expect(raw.edgeFray).toBeGreaterThan(clean.edgeFray);
    expect(raw.edgeInset).toBeGreaterThan(clean.edgeInset);
    expect(raw.edgeDetail).toBeGreaterThan(clean.edgeDetail);
    expect(raw.edgeSharpness).toBeLessThan(clean.edgeSharpness);
  });
});

describe("material instrument display semantics", () => {
  it("round-trips the renderer's cubic openness as an effective percentage", () => {
    expect(effectiveOpennessPercent(0.5)).toBeCloseTo(12.5, 10);
    expect(opennessFromEffectivePercent(12.5)).toBeCloseTo(0.5, 10);

    const baseline = createMaterialInstrumentBaseline(knobs(), "plain");
    const result = applyMaterialInstrument(baseline, { opennessPercent: 64 });
    expect(result.knobs.openness).toBeCloseTo(Math.cbrt(0.64), 10);
    expect(effectiveOpennessPercent(result.knobs.openness)).toBeCloseTo(64, 10);
  });

  it("uses logarithmic slider travel for tile scale", () => {
    const midpointScale = Math.sqrt(0.5 * 16);
    expect(tileScaleToSlider(0.5)).toBe(0);
    expect(tileScaleToSlider(midpointScale)).toBeCloseTo(0.5, 10);
    expect(tileScaleToSlider(16)).toBe(1);
    expect(tileScaleFromSlider(0.5)).toBeCloseTo(midpointScale, 10);
  });
});

describe("material instrument safety", () => {
  it("clamps every macro to its supported range", () => {
    const baseline = createMaterialInstrumentBaseline(knobs(), "plain");
    const high = applyMaterialInstrument(baseline, {
      hand: 4,
      response: Infinity,
      luster: 2,
      relief: 3,
      opennessPercent: 900,
      tileScale: 100,
      edgeFinish: 8,
    });
    expect(high.state).toMatchObject({
      hand: 1,
      response: 1,
      luster: 1,
      relief: 1,
      opennessPercent: 100,
      tileScale: 16,
      edgeFinish: 1,
    });

    const low = applyMaterialInstrument(baseline, {
      hand: -4,
      response: -Infinity,
      luster: -2,
      relief: -3,
      opennessPercent: -900,
      tileScale: -100,
      edgeFinish: -8,
    });
    expect(low.state).toMatchObject({
      hand: 0,
      response: 0,
      luster: 0,
      relief: 0,
      opennessPercent: 0,
      tileScale: 0.5,
      edgeFinish: 0,
    });
  });

  it("preserves every field outside the macro being moved", () => {
    const source = knobs({
      iridescence: 0.91,
      openness: 0.38,
      alphaBoost: 0.27,
      alphaBoostSource: 2,
      albedoAmount: 0.44,
      txHeight: 0.2,
      txAlbedo: 0.7,
      txRoughness: 0.4,
      transmissionContrast: 0.81,
      stretch: 0.66,
      tileScale: 7,
      edgeFray: 0.33,
    });
    const baseline = createMaterialInstrumentBaseline(source, "satin");
    const result = applyMaterialInstrument(baseline, { luster: 0.95 }).knobs;

    for (const key of Object.keys(source) as (keyof FabricKnobs)[]) {
      if (key === "sheen") continue;
      expect(result[key]).toBe(source[key]);
    }
    expect(result.sheen).not.toBe(source.sheen);
  });
});
