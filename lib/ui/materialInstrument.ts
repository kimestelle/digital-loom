// A compact authoring layer over FabricKnobs.
//
// The instrument is deliberately relative to a captured baseline. Moving one
// macro only changes the fields named by that macro; the rest of the material
// package remains byte-for-byte untouched. This makes it safe to put in front
// of imported, hand-tuned, or future FabricKnobs without flattening them into a
// generic preset.

import type { WeaveType } from "../cloth/fabricCore";
import { WEAVE_TEMPLATES } from "../cloth/derive";
import type { FabricKnobs } from "./knobs";

export type Construction = WeaveType;

/** Explicit construction choices. These are weave values, never FabricIds:
 * choosing twill changes the structural relationship only; it cannot silently
 * swap the material's maps, fibre family, weight, sheen, or provenance. */
export const CONSTRUCTION_OPTIONS = [
  { value: "plain", label: "plain" },
  { value: "twill", label: "twill" },
  { value: "satin", label: "satin" },
  { value: "knit", label: "knit" },
] as const satisfies readonly { value: Construction; label: string }[];

/** Recover the nearest structural family from serialized raw knobs.
 *
 * Weave templates define shear as a ratio of warp stiffness, so the absolute
 * stiffness (which hand tuning may change) cancels out. Ties resolve in the
 * declared CONSTRUCTION_OPTIONS order; a missing/degenerate ratio falls back
 * to plain rather than inventing a material profile. */
export function inferConstruction(knobs: FabricKnobs): Construction {
  const { warpStiffness: warp, shearStiffness: shear } = knobs;
  if (!Number.isFinite(warp) || !Number.isFinite(shear) || Math.abs(warp) <= EPSILON) {
    return CONSTRUCTION_OPTIONS[0].value;
  }

  const ratio = shear / warp;
  let closest: Construction = CONSTRUCTION_OPTIONS[0].value;
  let closestDistance = Math.abs(ratio - WEAVE_TEMPLATES[closest].shearRatio);

  for (const option of CONSTRUCTION_OPTIONS.slice(1)) {
    const distance = Math.abs(ratio - WEAVE_TEMPLATES[option.value].shearRatio);
    // Deliberately strict: equal distances keep the earlier declared option.
    if (distance < closestDistance) {
      closest = option.value;
      closestDistance = distance;
    }
  }

  return closest;
}

export interface MaterialInstrumentState {
  construction: Construction;

  /** 0 = fluid, 1 = crisp. Bend carries most of the change; warp and weft
   * move together so their authored directional ratio is preserved. */
  hand: number;

  /** 0 = floating, 1 = grounded. A perceptual/logarithmic view of weight. */
  response: number;

  /** 0 = matte, 1 = lustrous. */
  luster: number;

  /** 0 = flat, 1 = deep. Coordinates POM, normal strength, and self-shadow. */
  relief: number;

  /** What the renderer actually receives after its cubic openness curve,
   * expressed as an honest 0..100 percent rather than the raw cube root. */
  opennessPercent: number;

  /** Actual texture repeats across the cloth. Use tileScaleToSlider() and
   * tileScaleFromSlider() for a logarithmic range control. */
  tileScale: number;

  /** 0 = clean cut, 1 = loose/raw. Coordinates edge carve, fray, boundary
   * softness, and detail. */
  edgeFinish: number;
}

export interface MaterialInstrumentBaseline {
  readonly knobs: FabricKnobs;
  readonly state: MaterialInstrumentState;
}

export interface MaterialInstrumentResult {
  knobs: FabricKnobs;
  state: MaterialInstrumentState;
  construction: Construction;
}

export const MATERIAL_INSTRUMENT_LIMITS = {
  weight: { min: 0.2, max: 3 },
  sheen: { min: 0, max: 1.2 },
  pomScale: { min: 0, max: 0.08 },
  tileScale: { min: 0.5, max: 16 },
  edgeInset: { min: 0, max: 0.15 },
  edgeDetail: { min: 1, max: 8 },
} as const;

const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

const finiteOr = (value: number, fallback: number): number =>
  Number.isNaN(value) ? fallback : value;

const differs = (a: number, b: number): boolean => Math.abs(a - b) > EPSILON;

const isConstruction = (value: unknown): value is Construction =>
  value === "plain" || value === "twill" || value === "satin" || value === "knit";

const logPosition = (value: number, min: number, max: number): number =>
  clamp01(Math.log(clamp(value, min, max) / min) / Math.log(max / min));

const valueAtLogPosition = (position: number, min: number, max: number): number =>
  min * Math.pow(max / min, clamp01(position));

/** Slider position (0..1) for an actual tile repeat. Equal travel means equal
 * multiplicative change: 0.5 → 1 occupies the same distance as 8 → 16. */
export function tileScaleToSlider(tileScale: number): number {
  const { min, max } = MATERIAL_INSTRUMENT_LIMITS.tileScale;
  return logPosition(tileScale, min, max);
}

/** Actual tile repeat for a logarithmic slider position (0..1). */
export function tileScaleFromSlider(position: number): number {
  const { min, max } = MATERIAL_INSTRUMENT_LIMITS.tileScale;
  return valueAtLogPosition(position, min, max);
}

/** Convert the stored cube-root control to the percentage the renderer sees. */
export function effectiveOpennessPercent(openness: number): number {
  return Math.pow(clamp01(openness), 3) * 100;
}

/** Convert the displayed effective percentage back to FabricKnobs.openness. */
export function opennessFromEffectivePercent(percent: number): number {
  return Math.cbrt(clamp(finiteOr(percent, 0), 0, 100) / 100);
}

function responseFromWeight(weight: number): number {
  const { min, max } = MATERIAL_INSTRUMENT_LIMITS.weight;
  return logPosition(weight, min, max);
}

function weightFromResponse(response: number): number {
  const { min, max } = MATERIAL_INSTRUMENT_LIMITS.weight;
  return valueAtLogPosition(response, min, max);
}

function handFromBend(bendStiffness: number, construction: Construction): number {
  const weaveBend = WEAVE_TEMPLATES[construction].bendMul;
  return Math.sqrt(clamp01(bendStiffness / weaveBend));
}

function reliefFromPom(pomScale: number): number {
  const { max } = MATERIAL_INSTRUMENT_LIMITS.pomScale;
  return Math.sqrt(clamp01(pomScale / max));
}

/** Read the compact controls represented by any legal FabricKnobs object.
 * Construction is explicit because FabricKnobs intentionally contains no
 * fabric/profile identity. */
export function readMaterialInstrument(
  knobs: FabricKnobs,
  construction: Construction,
): MaterialInstrumentState {
  return {
    construction,
    hand: handFromBend(knobs.bendStiffness, construction),
    response: responseFromWeight(knobs.weight),
    luster: clamp01(knobs.sheen / MATERIAL_INSTRUMENT_LIMITS.sheen.max),
    relief: reliefFromPom(knobs.pomScale),
    opennessPercent: effectiveOpennessPercent(knobs.openness),
    tileScale: clamp(
      knobs.tileScale,
      MATERIAL_INSTRUMENT_LIMITS.tileScale.min,
      MATERIAL_INSTRUMENT_LIMITS.tileScale.max,
    ),
    edgeFinish: clamp01(knobs.edgeFray),
  };
}

/** Capture a stable reference for a tuning session or slider gesture. */
export function createMaterialInstrumentBaseline(
  knobs: FabricKnobs,
  construction: Construction,
): MaterialInstrumentBaseline {
  const snapshot = { ...knobs };
  return {
    knobs: snapshot,
    state: readMaterialInstrument(snapshot, construction),
  };
}

function sanitizeState(
  candidate: MaterialInstrumentState,
  fallback: MaterialInstrumentState,
): MaterialInstrumentState {
  const tile = MATERIAL_INSTRUMENT_LIMITS.tileScale;
  return {
    construction: isConstruction(candidate.construction)
      ? candidate.construction
      : fallback.construction,
    hand: clamp01(finiteOr(candidate.hand, fallback.hand)),
    response: clamp01(finiteOr(candidate.response, fallback.response)),
    luster: clamp01(finiteOr(candidate.luster, fallback.luster)),
    relief: clamp01(finiteOr(candidate.relief, fallback.relief)),
    opennessPercent: clamp(
      finiteOr(candidate.opennessPercent, fallback.opennessPercent),
      0,
      100,
    ),
    tileScale: clamp(finiteOr(candidate.tileScale, fallback.tileScale), tile.min, tile.max),
    edgeFinish: clamp01(finiteOr(candidate.edgeFinish, fallback.edgeFinish)),
  };
}

/** Scale warp and weft by one factor and cap them together. A shared cap is
 * important: clamping each direction independently would destroy the
 * material's authored warp/weft ratio at the crisp end of the control. */
function scaleStructuralPair(
  warp: number,
  weft: number,
  requestedFactor: number,
): [warp: number, weft: number] {
  const largest = Math.max(warp, weft);
  const cap = largest > 0 ? 1 / largest : requestedFactor;
  const factor = clamp(requestedFactor, 0, cap);
  return [warp * factor, weft * factor];
}

/** Move a coordinated secondary field around its real baseline. This reaches
 * zero/max at the macro endpoints while guaranteeing target === baseline is
 * an exact no-op. */
function moveAroundBaseline(
  baselineValue: number,
  baselineMacro: number,
  targetMacro: number,
  max: number,
  exponent: number,
): number {
  if (!differs(targetMacro, baselineMacro)) return baselineValue;
  if (targetMacro < baselineMacro) {
    if (baselineMacro <= EPSILON) return baselineValue;
    return baselineValue * Math.pow(targetMacro / baselineMacro, exponent);
  }
  if (baselineMacro >= 1 - EPSILON) return baselineValue;
  const progress = (targetMacro - baselineMacro) / (1 - baselineMacro);
  return baselineValue + (max - baselineValue) * Math.pow(progress, exponent);
}

/** Apply a full or partial compact state against the captured baseline.
 *
 * Keep the same baseline while a user edits a patch. Capturing a new baseline
 * is an explicit commit/rebase operation; doing it on every pointer event
 * would make macro effects compound and become non-deterministic. */
export function applyMaterialInstrument(
  baseline: MaterialInstrumentBaseline,
  patch: Partial<MaterialInstrumentState>,
): MaterialInstrumentResult {
  const base = baseline.state;
  const state = sanitizeState({ ...base, ...patch }, base);
  const knobs: FabricKnobs = { ...baseline.knobs };

  const fromWeave = WEAVE_TEMPLATES[base.construction];
  const toWeave = WEAVE_TEMPLATES[state.construction];
  const constructionChanged = state.construction !== base.construction;
  const handChanged = differs(state.hand, base.hand);

  if (constructionChanged || handChanged) {
    const constructionFactor = toWeave.structural / fromWeave.structural;
    // Hand affects structural constraints gently; bend below carries the
    // visible fluid/crisp response. The exponential is symmetric in travel.
    const handFactor = Math.pow(2, (state.hand - base.hand) * 0.5);
    [knobs.warpStiffness, knobs.weftStiffness] = scaleStructuralPair(
      baseline.knobs.warpStiffness,
      baseline.knobs.weftStiffness,
      constructionFactor * handFactor,
    );

    // Derive shear from the *applied* warp value so the construction ratio
    // survives the shared structural cap at 1. A requested multiplier can be
    // larger than the one actually applied to a nearly-maxed warp.
    const baselineShearRatio =
      Math.abs(baseline.knobs.warpStiffness) > EPSILON
        ? baseline.knobs.shearStiffness / baseline.knobs.warpStiffness
        : fromWeave.shearRatio;
    knobs.shearStiffness = clamp(
      knobs.warpStiffness *
        (constructionChanged ? toWeave.shearRatio : baselineShearRatio),
      0,
      1,
    );

    // Bend is the defining hand signal. Removing/reapplying the weave's bend
    // multiplier makes the authored hand value stable across constructions.
    knobs.bendStiffness = handChanged
      ? clamp01(state.hand * state.hand * toWeave.bendMul)
      : clamp01(
          baseline.knobs.bendStiffness * (toWeave.bendMul / fromWeave.bendMul),
        );
  }

  if (differs(state.response, base.response)) {
    knobs.weight = weightFromResponse(state.response);
  }

  if (differs(state.luster, base.luster)) {
    knobs.sheen = state.luster * MATERIAL_INSTRUMENT_LIMITS.sheen.max;
  }

  if (differs(state.relief, base.relief)) {
    knobs.pomScale =
      MATERIAL_INSTRUMENT_LIMITS.pomScale.max * state.relief * state.relief;
    knobs.normalAmount = clamp(
      moveAroundBaseline(
        baseline.knobs.normalAmount,
        base.relief,
        state.relief,
        1,
        0.6,
      ),
      0,
      1,
    );
    knobs.pomShadow = clamp(
      moveAroundBaseline(
        baseline.knobs.pomShadow,
        base.relief,
        state.relief,
        1,
        0.8,
      ),
      0,
      1,
    );
  }

  if (differs(state.opennessPercent, base.opennessPercent)) {
    knobs.openness = opennessFromEffectivePercent(state.opennessPercent);
  }

  if (differs(state.tileScale, base.tileScale)) {
    knobs.tileScale = state.tileScale;
  }

  if (differs(state.edgeFinish, base.edgeFinish)) {
    const edge = state.edgeFinish;
    const baseEdge = base.edgeFinish;
    knobs.edgeFray = edge;
    knobs.edgeInset = clamp(
      moveAroundBaseline(
        baseline.knobs.edgeInset,
        baseEdge,
        edge,
        MATERIAL_INSTRUMENT_LIMITS.edgeInset.max,
        0.9,
      ),
      MATERIAL_INSTRUMENT_LIMITS.edgeInset.min,
      MATERIAL_INSTRUMENT_LIMITS.edgeInset.max,
    );
    knobs.edgeDetail = clamp(
      moveAroundBaseline(
        baseline.knobs.edgeDetail,
        baseEdge,
        edge,
        MATERIAL_INSTRUMENT_LIMITS.edgeDetail.max,
        0.75,
      ),
      MATERIAL_INSTRUMENT_LIMITS.edgeDetail.min,
      MATERIAL_INSTRUMENT_LIMITS.edgeDetail.max,
    );
    // Boundary crispness travels opposite rawness: a clean cut is defined,
    // while a loose edge has a softer density threshold.
    knobs.edgeSharpness = clamp(
      moveAroundBaseline(
        baseline.knobs.edgeSharpness,
        1 - baseEdge,
        1 - edge,
        1,
        0.75,
      ),
      0,
      1,
    );
  }

  return { knobs, state, construction: state.construction };
}
