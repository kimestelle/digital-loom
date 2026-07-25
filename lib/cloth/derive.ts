// ─── derive.ts ────────────────────────────────────────────────────────────────
// Pure mapping: FabricCore → solver + renderer parameters. This is the ONLY
// module that decides how physical fabric properties translate into the
// numbers the rest of the pipeline uses. Nothing in here imports React,
// Three, or WebGL — the file is trivially unit-testable in isolation.
//
// Fabric resolution calls derive() before applying a profile's sparse,
// taste-driven overrides.

import type { FabricCore, WeaveType } from "./fabricCore";
import type { FabricKnobs } from "@/lib/ui/knobs";

/** Solver-side params not on FabricKnobs. */
export interface SolverDerived {
  creaseFriction: number;
  creaseThreshold: number;
  creaseCommitRate: number;
  creaseRelease: number;
  particleMass: number;
  damping: number;
  windResponse: number;
  /** Single transparency scalar shared by rendering and porosity. */
  openness: number;
}

export type DerivedFabric = FabricKnobs & SolverDerived;

// ── Named constants ──────────────────────────────────────────────────────────
// Exported so the mapping can be tuned and tested without hunting through
// function bodies.

/** gsm → weight scale. 150 gsm (mumyeong / cotton) → weight 1.0.
 *  Uses a compressed `0.5 + gsm / 300` mapping so very light silks and very
 *  heavy hemps both land near the tuned values without per-fabric overrides. */
export const WEIGHT_BASE = 0.5;
export const WEIGHT_GSM_DIVISOR = 300;

/** Bend coefficient. Bending is dominated by fibre modulus
 *  and (for filaments) the reduced inter-fibre friction. Thickness is dropped
 *  because thickness³ overpowered every other axis and made bast fibres like
 *  ramie underpredict badly while overshooting hemp. Formula:
 *      bend = K_BEND · fiberModulus² · fiberBendMul · tmpl.bendMul
 *  Cotton (mod 0.55, staple) → 1.0 · 0.3025 · 1.0 · 1.0 = 0.3025. */
export const K_BEND = 1.0;
/** Filaments (silk) shear over each other more freely than staples, so their
 *  bulk bend stiffness is a fraction of what fibre modulus alone would give. */
export const FILAMENT_BEND_MUL = 0.3;

/** How much twist shifts warp stiffness. warp = tmpl.structural · (1 − (1 − twist) · TWIST_BIAS). */
export const TWIST_BIAS = 0.1;

/** Weft is typically a touch less stiff than warp. */
export const WEFT_TO_WARP = 0.97;

/** Sheen baselines by fiber family (before the twist reduction). These values
 *  keep cotton (0.4 · 0.725 = 0.29) near 0.3 and silk
 *  (1.2 · 0.75 = 0.9) near 0.9. */
export const FILAMENT_SHEEN = 1.2;
export const STAPLE_SHEEN = 0.4;

/** Edge fray baselines by fiber family (staple sheds more). */
export const STAPLE_EDGE_FRAY = 0.15;
export const FILAMENT_EDGE_FRAY = 0.03;

/** Bast fibers (fiberModulus > BAST_MOD_START) shed a fraction of their shear
 *  stiffness because open bast weaves give more freely on the bias than the
 *  weave template alone predicts. */
export const BAST_MOD_START = 0.6;
export const BAST_MOD_RANGE = 0.3;
export const BAST_SHEAR_PENALTY = 0.25;

/** Fabrics containing high-modulus filaments (silk-like) or high-modulus
 *  bast staples (ramie/hemp) transmit meaningfully more light than plain
 *  `openness` predicts. Fibre-family boosts stacked on top. */
export const FILAMENT_TRANSLUCENCY_BOOST = 0.2;
export const BAST_TRANSLUCENCY_MUL = 1.7;

/** Crease-release: silk creases relax fastest, bast fibres hold them
 *  indefinitely. Formula is `RELEASE_COEF · (1 − fiberModulus)²`.
 *  The coefficient places silk (0.45) near 0.03. */
export const RELEASE_COEF = 0.1;

/** Fraction of wind force that "leaks through" fully porous cloth. Applied
 *  per-particle as `force *= 1 − porosity · WIND_LEAK`, so at porosity 1
 *  the fabric catches only 30 % of the wind (organza billows lightly),
 *  and at porosity 0 it catches all of it (denim inflates like a sail).
 *  Used by ClothSolver.applyWind. */
export const WIND_LEAK = 0.7;

/** Weave template — the shear-ratio and bendMul carry the personality of
 *  each weave family. Plain is the reference. */
export interface WeaveTemplate {
  /** Scales warp / weft structural stiffness. Plain 1.0, knit 0.35, etc. */
  structural: number;
  /** shearStiffness = shearRatio · warpStiffness. Higher on knits (more free
   *  bias give relative to their structural resistance). */
  shearRatio: number;
  /** Multiplier on the raw beam-theory bend stiffness. Plain 1.0, knit ~0.5. */
  bendMul: number;
}

export const WEAVE_TEMPLATES: Record<WeaveType, WeaveTemplate> = {
  plain: { structural: 1.0, shearRatio: 0.55, bendMul: 1.0 },
  twill: { structural: 0.95, shearRatio: 0.7, bendMul: 0.9 },
  satin: { structural: 0.9, shearRatio: 0.8, bendMul: 0.8 },
  knit: { structural: 0.35, shearRatio: 0.95, bendMul: 0.5 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number): number => clamp(x, 0, 1);

// ── derive() ─────────────────────────────────────────────────────────────────

export function derive(core: FabricCore, tileScale = 1): DerivedFabric {
  const tmpl = WEAVE_TEMPLATES[core.weaveType];
  const isFilament = core.fiberType === "filament";
  const bastness = clamp01((core.fiberModulus - BAST_MOD_START) / BAST_MOD_RANGE);

  // ── Physics ────────────────────────────────────────────────────────
  // Weight and particleMass share the compressed gsm mapping so per-fabric
  // mass overrides shrink to the cases where tuned taste diverges from
  // physical weight (mainly silk, which is heavier than 60gsm suggests).
  const weight = WEIGHT_BASE + core.gsm / WEIGHT_GSM_DIVISOR;
  const particleMass = weight;
  const damping = 0.8 + 0.15 * clamp01(core.gsm / 300);

  // ── Weave (warp / weft / shear / bend) ─────────────────────────────
  const s = 1 - (1 - core.twist) * TWIST_BIAS;
  const warpStiffness = tmpl.structural * s;
  const weftStiffness = warpStiffness * WEFT_TO_WARP;
  // Bast fibres shed some of the template's shear resistance — the open
  // bast weave gives more freely on the bias than plain / twill / satin
  // alone predicts.
  const shearStiffness =
    warpStiffness * tmpl.shearRatio * (1 - BAST_SHEAR_PENALTY * bastness);
  // Bend: fibre modulus squared × filament reduction × weave family.
  const fiberBendMul = isFilament ? FILAMENT_BEND_MUL : 1;
  const bendStiffness =
    K_BEND * core.fiberModulus * core.fiberModulus * fiberBendMul * tmpl.bendMul;

  // ── Openness → transparency + porosity signals ─────────────────────
  const openness =
    (1 - core.coverFactor) * clamp(1.5 - core.thicknessMm, 0.3, 1.0);
  const translucency =
    openness * (1 + (BAST_TRANSLUCENCY_MUL - 1) * bastness) +
    (isFilament ? FILAMENT_TRANSLUCENCY_BOOST : 0);
  const densityAmount = 0.5 + 0.5 * core.coverFactor;
  const alphaFromDensity = 0.1 * openness;

  // ── Optical ────────────────────────────────────────────────────────
  const sheen =
    (isFilament ? FILAMENT_SHEEN : STAPLE_SHEEN) * (1 - 0.5 * core.twist);

  // ── Edge fray ──────────────────────────────────────────────────────
  const edgeFray =
    (isFilament ? FILAMENT_EDGE_FRAY : STAPLE_EDGE_FRAY) *
    (1 + (1 - core.coverFactor));
  const edgeSharpness = 0.1 + 0.3 * core.twist;
  const edgeInset = 0.008;
  const edgeDetail = 1;

  // ── POM ────────────────────────────────────────────────────────────
  const pomScale = (0.01 * core.thicknessMm) / tileScale;

  // ── Crease cluster — bast-fibre plasticity, anchored on fiberModulus:
  //    silk 0.45 / cotton 0.55 / hemp 0.82 / ramie 0.85.
  const creaseFriction = clamp01(1.875 * core.fiberModulus - 0.69);
  const creaseThreshold = 0.99 - 0.875 * core.fiberModulus;
  const creaseCommitRate = Math.max(0, 0.2 * core.fiberModulus - 0.07);
  const creaseRelease = RELEASE_COEF * Math.pow(1 - core.fiberModulus, 2);

  // ── Wind ───────────────────────────────────────────────────────────
  const windResponse = clamp(
    0.5 + 0.9 * openness + 0.2 * (1 - weight),
    0.2,
    1.2,
  );

  // ── Pipeline pass-throughs (not physics) ───────────────────────────
  // Transmission source weights. Height-only by default (the original single
  // mode); albedo/roughness contributions are authored taste, dialed in per
  // fabric. No physical derivation from FabricCore yet.
  const txHeight = 1;
  const txAlbedo = 0;
  const txRoughness = 0;
  const transmissionContrast = 0.3;
  const albedoAmount = 1;
  // Micro-relief shading defaults. The captured normal map is the measured
  // truth of the surface, so it applies at full strength; self-shadow sits at
  // the tuned scene default. Neither has a physical derivation from
  // FabricCore yet — candidates once a relief-depth field lands.
  const normalAmount = 1;
  const pomShadow = 0.55;
  // Stretch response is a viewing/interaction effect, not a physical fabric
  // constant — default off; the user dials it in.
  const stretch = 0;
  // alphaBoost is a UI-side additive knob; derive() has no physical value
  // to contribute, so it defaults to 0 and only the user's slider moves it.
  // Its source map likewise defaults to height (the original weave-valley
  // weighting) — which map a fabric wears thin along is authored taste.
  const alphaBoost = 0;
  const alphaBoostSource: 0 | 1 | 2 | 3 = 0;
  // Rainbow refraction is a viewing effect with no derivation from
  // FabricCore (thread-scale diffraction would need fiber metrology) —
  // ship the app-wide subtle default and let the slider own it.
  const iridescence = 0.35;

  return {
    // FabricKnobs
    sheen,
    iridescence,
    translucency,
    densityAmount,
    alphaFromDensity,
    alphaBoost,
    alphaBoostSource,
    albedoAmount,
    pomScale,
    normalAmount,
    pomShadow,
    stretch,
    edgeInset,
    edgeFray,
    edgeSharpness,
    edgeDetail,
    tileScale,
    txHeight,
    txAlbedo,
    txRoughness,
    transmissionContrast,
    weight,
    warpStiffness,
    weftStiffness,
    shearStiffness,
    bendStiffness,
    // SolverDerived
    creaseFriction,
    creaseThreshold,
    creaseCommitRate,
    creaseRelease,
    particleMass,
    damping,
    windResponse,
    openness,
  };
}
