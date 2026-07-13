// ─── derive.test.ts ──────────────────────────────────────────────────────────
// Ordering-based unit tests for derive(). Deliberately checks direction and
// relative magnitude — not exact numbers — so constant tuning doesn't
// invalidate every assertion.

import { describe, it, expect } from "vitest";
import type { FabricCore } from "./fabricCore";
import { derive } from "./derive";
import { FABRICS } from "./fabrics";

const baseCore: FabricCore = {
  gsm: 150,
  coverFactor: 0.75,
  thicknessMm: 0.4,
  fiberModulus: 0.55,
  fiberType: "staple",
  weaveType: "plain",
  twist: 0.5,
};

const core = (over: Partial<FabricCore>): FabricCore => ({ ...baseCore, ...over });

describe("derive() weave templates", () => {
  it("knit has a higher shear-to-warp ratio than plain (knits shear more freely relative to their structural stiffness)", () => {
    const knit = derive(core({ weaveType: "knit" }));
    const plain = derive(core({ weaveType: "plain" }));
    const knitRatio = knit.shearStiffness / knit.warpStiffness;
    const plainRatio = plain.shearStiffness / plain.warpStiffness;
    expect(knitRatio).toBeGreaterThan(plainRatio);
  });

  it("weftStiffness is a hair less than warpStiffness", () => {
    const d = derive(baseCore);
    expect(d.weftStiffness).toBeLessThan(d.warpStiffness);
    expect(d.weftStiffness / d.warpStiffness).toBeGreaterThan(0.9);
  });
});

describe("derive() bend stiffness", () => {
  it("scales with fiberModulus at fixed thickness", () => {
    const stiff = derive(core({ fiberModulus: 0.85 }));
    const soft = derive(core({ fiberModulus: 0.35 }));
    expect(stiff.bendStiffness).toBeGreaterThan(soft.bendStiffness);
  });

  it("scales as fiberModulus² at fixed weave / fibre type", () => {
    const a = derive(core({ fiberModulus: 0.4 }));
    const b = derive(core({ fiberModulus: 0.8 }));
    // modulus doubled → bend should be ~4× higher
    expect(b.bendStiffness / a.bendStiffness).toBeCloseTo(4, 1);
  });

  it("filaments have lower bend than staples at same modulus (silk shears at fibre level)", () => {
    const filament = derive(core({ fiberType: "filament", fiberModulus: 0.6 }));
    const staple = derive(core({ fiberType: "staple", fiberModulus: 0.6 }));
    expect(filament.bendStiffness).toBeLessThan(staple.bendStiffness);
  });

  it("high-modulus filament plain-weave beats limp cotton knit — thickness no longer dominates the mapping", () => {
    const organza = derive(
      core({
        gsm: 25,
        thicknessMm: 0.15,
        fiberModulus: 0.9,
        fiberType: "filament",
        weaveType: "plain",
        twist: 0.85,
      }),
    );
    const softJersey = derive(
      core({
        gsm: 250,
        thicknessMm: 0.5,
        fiberModulus: 0.35,
        fiberType: "staple",
        weaveType: "knit",
        twist: 0.4,
      }),
    );
    expect(organza.bendStiffness).toBeGreaterThan(softJersey.bendStiffness);
  });
});

describe("derive() sheen", () => {
  it("staple sheen < filament sheen at same twist", () => {
    const filament = derive(core({ fiberType: "filament" }));
    const staple = derive(core({ fiberType: "staple" }));
    expect(staple.sheen).toBeLessThan(filament.sheen);
  });

  it("higher twist reduces sheen for either fiber type", () => {
    const loose = derive(core({ fiberType: "filament", twist: 0.2 }));
    const tight = derive(core({ fiberType: "filament", twist: 0.9 }));
    expect(loose.sheen).toBeGreaterThan(tight.sheen);
  });
});

describe("derive() crease cluster (fiberModulus-driven)", () => {
  it("ramie > cotton > silk in creaseFriction", () => {
    const ramie = derive(FABRICS.mosi.core);
    const cotton = derive(FABRICS.mumyeong.core);
    const silk = derive(FABRICS.myeongju.core);
    expect(ramie.creaseFriction).toBeGreaterThan(cotton.creaseFriction);
    expect(cotton.creaseFriction).toBeGreaterThan(silk.creaseFriction);
  });

  it("silk has the largest creaseRelease of the four presets (creases relax fastest)", () => {
    const silk = derive(FABRICS.myeongju.core);
    const cotton = derive(FABRICS.mumyeong.core);
    const ramie = derive(FABRICS.mosi.core);
    const hemp = derive(FABRICS.sambe.core);
    expect(silk.creaseRelease).toBeGreaterThan(cotton.creaseRelease);
    expect(silk.creaseRelease).toBeGreaterThan(ramie.creaseRelease);
    expect(silk.creaseRelease).toBeGreaterThan(hemp.creaseRelease);
  });

  it("creaseCommitRate is monotone in fiberModulus", () => {
    const low = derive(core({ fiberModulus: 0.3 }));
    const mid = derive(core({ fiberModulus: 0.6 }));
    const hi = derive(core({ fiberModulus: 0.9 }));
    expect(mid.creaseCommitRate).toBeGreaterThan(low.creaseCommitRate);
    expect(hi.creaseCommitRate).toBeGreaterThan(mid.creaseCommitRate);
  });
});

describe("derive() wind + openness", () => {
  it("open weaves have higher windResponse than dense weaves at same weight", () => {
    const open = derive(core({ coverFactor: 0.4 }));
    const dense = derive(core({ coverFactor: 0.9 }));
    expect(open.windResponse).toBeGreaterThan(dense.windResponse);
  });

  it("mosi windResponse > sambe (airy ramie catches wind more than heavy hemp)", () => {
    const mosi = derive(FABRICS.mosi.core);
    const sambe = derive(FABRICS.sambe.core);
    expect(mosi.windResponse).toBeGreaterThan(sambe.windResponse);
  });

  it("translucency is ≥ openness (fibre-family boosts stack on top)", () => {
    const d = derive(baseCore);
    expect(d.translucency).toBeGreaterThanOrEqual(d.openness);
  });

  it("filaments get a translucency boost beyond openness alone", () => {
    const filament = derive(core({ fiberType: "filament" }));
    const staple = derive(core({ fiberType: "staple" }));
    // Same openness for both (they share base cover / thickness), but the
    // filament flag adds a small constant boost.
    expect(filament.translucency - filament.openness).toBeGreaterThan(
      staple.translucency - staple.openness,
    );
  });

  it("high-fiber-modulus bast fabrics transmit more than their openness suggests", () => {
    const bastLike = derive(core({ fiberModulus: 0.85, fiberType: "staple" }));
    // Bast staples multiply openness (up to 1.5× at the top of the bastness ramp).
    expect(bastLike.translucency).toBeGreaterThan(bastLike.openness * 1.2);
  });
});

describe("derive() mass + damping", () => {
  it("particleMass equals weight (both derive from gsm / REFERENCE_GSM)", () => {
    const d = derive(baseCore);
    expect(d.particleMass).toBe(d.weight);
  });

  it("mumyeong core → weight ≈ 1 (150 gsm is the reference point)", () => {
    const d = derive(FABRICS.mumyeong.core);
    expect(d.weight).toBeCloseTo(1, 5);
  });

  it("heavier gsm damps more", () => {
    const light = derive(core({ gsm: 50 }));
    const heavy = derive(core({ gsm: 300 }));
    expect(heavy.damping).toBeGreaterThan(light.damping);
  });
});

describe("derive() POM depth", () => {
  it("pomScale scales linearly with thickness", () => {
    const thin = derive(core({ thicknessMm: 0.1 }));
    const thick = derive(core({ thicknessMm: 0.4 }));
    expect(thick.pomScale / thin.pomScale).toBeCloseTo(4, 5);
  });

  it("tileScale > 1 shrinks pomScale (finer tiling → shallower per-tile relief)", () => {
    const t1 = derive(baseCore, 1);
    const t4 = derive(baseCore, 4);
    expect(t4.pomScale).toBeLessThan(t1.pomScale);
    expect(t1.pomScale / t4.pomScale).toBeCloseTo(4, 5);
  });
});
