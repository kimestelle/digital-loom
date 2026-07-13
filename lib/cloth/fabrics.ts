import type { FabricCore } from "./fabricCore";
import { derive, type DerivedFabric } from "./derive";

const FALLBACK_ALBEDO_URL = "/pregen/silk-sample/albedo.png";
const FALLBACK_HEIGHT_URL = "/pregen/silk-sample/height.png";

// ─── fabrics.ts ───────────────────────────────────────────────────────────────
// Fabric presets store a FabricCore (physical description) plus a sparse
// override map. Everything the solver and scene consume is produced by
// derive(core), then patched with those overrides via resolveFabric().
//
// The Korean profiles retain a few taste-driven overrides. Jersey and denim
// exercise the knit and twill templates without overrides.
//
// IMPORTANT — the physically-informed ordering is what carries the thesis:
//   - bast fibres (mosi/ramie, sambe/hemp) are far stiffer in bending than
//     myeongju (silk); cotton sits between.
//   - woven fabric is near-inextensible along warp & weft, but gives on the
//     45° bias — so shear compliance is meaningfully higher than structural.
//   - warp (loom-tensioned) is typically a touch stiffer than weft.

export type FabricId =
  | "myeongju"
  | "mosi"
  | "sambe"
  | "mumyeong"
  // Validation fabrics. Deliberately outside the silk family so the
  // derive() constants are exercised against a knit and a twill, not just
  // four plain-weave presets. Their success metric is empty overrides.
  | "jersey"
  | "denim";

/** Storage layer: how each fabric is *authored*. Physical core + sparse
 *  overrides + identity/URL fields. Never handed directly to the solver
 *  or scene — those consume a ResolvedFabric produced by resolveFabric(). */
export interface FabricProfile {
  id: FabricId;
  /** Display names — Hangul + romanization. Surfaced as quiet typography. */
  nameKo: string;
  nameRoman: string;
  nameEn: string;

  albedoURL: string;
  textureURL: string;

  /** Physical description of the textile — areal density, cover, fiber
   *  type, weave, twist. Drives derive(). */
  core: FabricCore;

  /** Sparse overrides applied on top of derive(core) to preserve the
   *  hand-tuned taste of each preset. */
  overrides: Partial<DerivedFabric>;
}

/** Runtime layer: what the solver and scene actually consume. Identity /
 *  URL fields + every field DerivedFabric produces, populated by
 *  resolveFabric(profile, tileScale). */
export interface ResolvedFabric extends DerivedFabric {
  id: FabricId;
  nameKo: string;
  nameRoman: string;
  nameEn: string;
  albedoURL: string;
  textureURL: string;
}

/** Compose the derived values on top of core, then patch with the preset's
 *  hand-set overrides. Also drops in identity + URL fields the presets carry
 *  outside the derived space. Order matters: `overrides` wins over derive(). */
export function resolveFabric(
  profile: FabricProfile,
  tileScale = 1,
): ResolvedFabric {
  return {
    id: profile.id,
    nameKo: profile.nameKo,
    nameRoman: profile.nameRoman,
    nameEn: profile.nameEn,
    albedoURL: profile.albedoURL,
    textureURL: profile.textureURL,
    ...derive(profile.core, tileScale),
    ...profile.overrides,
  };
}

// ── Fabric profiles ────────────────────────────────────────────────────────
// Read these as a comparison: scan a single field across profiles and the
// material logic should be legible. Overrides represent intentional gaps
// between the physical mapping and the desired motion or appearance.

export const FABRICS: Record<FabricId, FabricProfile> = {
  // 명주 — silk. Filament fibre, dense fine weave. Low bend, low stretch,
  // flows and pools, liquid sheen. Status / refinement.
  myeongju: {
    id: "myeongju",
    nameKo: "명주",
    nameRoman: "myeongju",
    nameEn: "silk",
    albedoURL: "/pregen/silk-sample/albedo.png",
    textureURL: "/pregen/silk-sample/height.png",
    // Fine plain-weave silk, ~60 gsm / ~0.15 mm. Continuous filament with
    // modest twist gives the characteristic liquid sheen; the high cover
    // factor (dense weave) offsets the fibre's low modulus so the cloth
    // holds a soft body.
    core: {
      gsm: 60,
      coverFactor: 0.88,
      thicknessMm: 0.15,
      fiberModulus: 0.45,
      fiberType: "filament",
      weaveType: "plain",
      twist: 0.5,
    },
    // Only mass is overridden: silk in the sim is heavier than 60 gsm suggests
    // (taste, not physics). Everything else comes from derive().
    overrides: {
      particleMass: 1.0,
    },
  },

  // 모시 — ramie. Bast fibre, crisp, often open weave. Summer cloth.
  // High bend (creases, billows in large facets), light, airy.
  mosi: {
    id: "mosi",
    nameKo: "모시",
    nameRoman: "mosi",
    nameEn: "ramie",
    albedoURL: FALLBACK_ALBEDO_URL,
    textureURL: FALLBACK_HEIGHT_URL,
    // Ramie: bast fibre, very high fibre modulus. Traditional mosi is spun
    // crisp and hard in an open plain weave around 80 gsm — thin thread,
    // wide gaps, high translucency, sharp folds.
    core: {
      gsm: 80,
      coverFactor: 0.55,
      thicknessMm: 0.25,
      fiberModulus: 0.85,
      fiberType: "staple",
      weaveType: "plain",
      twist: 0.7,
    },
    // Mass remains pinned to taste. Ramie's tuned bend value (0.78) is
    // deliberately higher than a modulus² model produces for its fiber.
    overrides: {
      particleMass: 0.7,
      bendStiffness: 0.78,
    },
  },

  // 삼베 — hemp. Bast fibre, coarse, heaviest hand. Historically the cloth
  // of mourning garments — handle this movement with gravity, not prettiness.
  sambe: {
    id: "sambe",
    nameKo: "삼베",
    nameRoman: "sambe",
    nameEn: "hemp",
    albedoURL: FALLBACK_ALBEDO_URL,
    textureURL: FALLBACK_HEIGHT_URL,
    // Hemp: bast fibre, coarser spinning than ramie. 180–220 gsm plain weave
    // in the sim, thicker than ramie (0.6 mm). Fibre modulus 0.82 (a hair
    // less than ramie's 0.85 because coarser spinning distributes bending
    // over fatter yarn).
    core: {
      gsm: 200,
      coverFactor: 0.7,
      thicknessMm: 0.6,
      fiberModulus: 0.82,
      fiberType: "staple",
      weaveType: "plain",
      twist: 0.75,
    },
    // The remaining overrides preserve the sombre wind response (0.6 vs
    // 0.71 derived — hemp is heavier than its openness suggests) and the
    // matte sheen (0.05 tuned vs 0.25 derived — hemp is deliberately
    // matte, not a fiber-model call).
    overrides: {
      windResponse: 0.6,
      sheen: 0.05,
    },
  },

  // 무명 — cotton. Staple fibre, the everyday cloth of ordinary life.
  // Middle of every axis: moderate bend, fuller body, warm and plain.
  mumyeong: {
    id: "mumyeong",
    nameKo: "무명",
    nameRoman: "mumyeong",
    nameEn: "cotton",
    albedoURL: FALLBACK_ALBEDO_URL,
    textureURL: FALLBACK_HEIGHT_URL,
    // Cotton: staple fibre, moderate modulus. Mumyeong is a mid-weight plain
    // weave around 150 gsm, the reference weight for the derive() mapping.
    // Cover factor 0.75 gives a body-full but still slightly permeable weave.
    core: {
      gsm: 150,
      coverFactor: 0.75,
      thicknessMm: 0.4,
      fiberModulus: 0.55,
      fiberType: "staple",
      weaveType: "plain",
      twist: 0.55,
    },
    // Cotton is stubborn — "middle of the road on every axis" is a taste
    // call, not a physical anchor, so its structural stiffnesses and crease
    // knobs sit meaningfully below what fiberModulus alone would produce.
    // These four survivors are the taste-vs-derive gap for cotton.
    overrides: {
      warpStiffness: 0.9,
      creaseFriction: 0.5,
      creaseThreshold: 0.4,
      windResponse: 0.8,
    },
  },

  // 저지 — cotton jersey. Knit fabric, staple cotton, low twist. Validation
  // preset: exercises the knit weave template (low structural, high shear
  // ratio, low bend multiplier) — the mapping should produce a heavy,
  // stretchy drape with soft creases straight from the core, no overrides.
  jersey: {
    id: "jersey",
    nameKo: "저지",
    nameRoman: "jeoji",
    nameEn: "cotton jersey",
    albedoURL: FALLBACK_ALBEDO_URL,
    textureURL: FALLBACK_HEIGHT_URL,
    // Mid-weight t-shirt jersey around 180 gsm and ~0.8 mm bulk (knit loops
    // give effective thickness above the woven equivalent). Cover factor
    // 0.85 — the loop overlap reads dense, but the knit template supplies
    // the mechanical give.
    core: {
      gsm: 180,
      coverFactor: 0.85,
      thicknessMm: 0.8,
      fiberModulus: 0.55,
      fiberType: "staple",
      weaveType: "knit",
      twist: 0.3,
    },
    overrides: {},
  },

  // 데님 — denim twill. Heavy warp-faced 3/1 cotton twill, high twist.
  // Validation preset for the opposite corner from silk: dense cover, deep
  // thickness, hard-twist yarn. Should hang stiff, barely notice breeze,
  // and read as almost opaque without any override help.
  denim: {
    id: "denim",
    nameKo: "데님",
    nameRoman: "denim",
    nameEn: "denim twill",
    albedoURL: FALLBACK_ALBEDO_URL,
    textureURL: FALLBACK_HEIGHT_URL,
    // 14 oz denim ≈ 400 gsm, ~1 mm thick, cover 0.92 (barely any interstice),
    // twist 0.9 (hard-cabled warp yarn — a big reason denim reads matte and
    // holds its structural body).
    core: {
      gsm: 400,
      coverFactor: 0.92,
      thicknessMm: 1.0,
      fiberModulus: 0.55,
      fiberType: "staple",
      weaveType: "twill",
      twist: 0.9,
    },
    overrides: {},
  },
};

export const FABRIC_ORDER: FabricId[] = [
  "mosi",
  "mumyeong",
  "myeongju",
  "sambe",
  "jersey",
  "denim",
];
// The four Korean fabrics keep their emotional arc for the clothesline —
// bright airy mosi → plain everyday mumyeong → refined myeongju → and sambe
// last, its mourning gravity giving the sequence a quiet, weighted close.
// The two validation fabrics (jersey, denim) come after so they don't
// interrupt the arc; they're picker options for the tuning tool, not
// characters in the piece.
