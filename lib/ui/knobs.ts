// ─── knobs.ts ─────────────────────────────────────────────────────────────────
// Interactive parameter surface for the cloth scene. Shared between the page
// component (which owns the state and renders sliders) and future consumers
// (tuning tool, serialization, presets). Kept as plain data — no React —
// so tests and non-UI code can consume it too.
//
// The surface is split along a physical/rendering seam:
//   FabricKnobs — properties of the material itself (weave stiffness, sheen,
//                 edge fray, transmission, POM depth, ...). These are what
//                 will eventually derive from a smaller FabricCore.
//   SceneKnobs  — properties of the rendered environment / view (mesh + frag
//                 resolution, pin mode, ambient breeze, sky backdrop, POM
//                 step counts which are a perf axis coupled to `quality`).
//
// Kept together as `type Knobs = FabricKnobs & SceneKnobs` so every existing
// consumer that reads/writes `Knobs` continues to compile unchanged.

// ── Fabric ────────────────────────────────────────────────────────────────────

export interface FabricKnobs {
  // Material / lighting
  sheen: number;

  /** Rainbow refraction (0 = off): spectral dispersion of the backlit
   *  transmission, grating iridescence riding the sheen, the sky's
   *  circumsolar ring, and the object's physical iridescence. */
  iridescence: number;

  /** Single transparency scalar (0 = opaque denim, 1 = organza-sheer). Drives
   *  translucency, densityAmount, and alphaFromDensity via the step-3 formulas
   *  inside ClothScene's tick loop. It replaces the three deprecated fields
   *  below with one material control. */
  openness: number;

  /** @deprecated derive from openness. Kept on the interface so preset
   *  serialization and derive() output continue to type-check; if explicitly
   *  set on ClothScene's props it still wins over the openness-derived value
   *  for one release. */
  translucency: number;
  /** @deprecated derive from openness. See translucency. */
  densityAmount: number;
  /** @deprecated derive from openness. See translucency. */
  alphaFromDensity: number;

  /** Additive boost on top of the openness-derived alphaFromDensity. Lets you
   *  crank the density-map's dark-region hole-punching independently of the
   *  main transparency scalar — the effect that used to live on the old
   *  "openness → α" slider (default 0.06). At 0 the openness knob drives
   *  everything; push this up for organza-slub see-through. */
  alphaBoost: number;

  /** Which map weights the threadbare boost: 0 = height (dark weave
   *  valleys go sheer), 1 = albedo, 2 = roughness, 3 = metalness. Dark regions
   *  of the chosen map wear thin; a source with no loaded map falls back to
   *  height. Lets alphaBoost target e.g. the non-metal ground between sequins
   *  instead of the weave relief. */
  alphaBoostSource: 0 | 1 | 2 | 3;

  albedoAmount: number;

  // POM depth. Step counts live on SceneKnobs (a perf axis coupled to
  // `quality`); depth stays here because it's a material property — it
  // will eventually derive from a FabricCore relief field.
  pomScale: number;

  /** Normal-map strength: how hard the Patina normal map perturbs the
   *  shading normal (0 = smooth vertex normal, 1 = full micro-relief).
   *  Material property — it's the same relief signal POM marches. */
  normalAmount: number;

  /** POM self-shadow strength: how much raised threads occlude the sun for
   *  their neighbours (0 = off). Costs a second, shorter height-field march
   *  per fragment when enabled. */
  pomShadow: number;

  /** Stretch response (0 = off): where the fabric is under tension it goes
   *  sheer, flattens its weave relief, and catches a sharper sheen. Gates the
   *  per-particle strain computation, so 0 is free. */
  stretch: number;

  // Edge fray
  edgeInset: number;
  edgeFray: number;
  edgeSharpness: number;
  edgeDetail: number;

  // Texture tiling
  tileScale: number;

  // Transmission / opacity. The fabric's density (→ openness → sheerness &
  // backlit glow) is a weighted blend of up to three source maps. Each weight
  // is independent: set one to 0 to drop that map's contribution entirely, or
  // mix them. All three at 0 → opaque (no map-driven transmission variation).
  //   txHeight    ← weave relief (bright height = dense thread crossing)
  //   txAlbedo    ← albedo luminance (dark = gap/thin, reads as sheer)
  //   txRoughness ← roughness (rough/matte = dense weave, smooth = sheer)
  txHeight: number;
  txAlbedo: number;
  txRoughness: number;
  transmissionContrast: number;

  /** Multiplier on the fabric profile's particleMass. Heavier = drapes
   *  harder, damps wind more; lighter = floats. */
  weight: number;

  // Weave stiffness (structural constraints)
  warpStiffness: number;
  weftStiffness: number;
  shearStiffness: number;
  bendStiffness: number;
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export interface SceneKnobs {
  wireframe: boolean;
  pinMode: "line" | "pegs";

  // POM step counts are a quality axis, coupled to `quality` preset. Depth
  // (pomScale) is a fabric property and lives on FabricKnobs.
  pomMinSteps: number;
  pomMaxSteps: number;
  pomDebug: 0 | 1 | 2;

  /** Debug view: heatmap the fabric's strain field (slate→amber→white) instead
   *  of shading it. Slate = slack, white = taut. */
  stretchDebug: boolean;

  /** Frag shader / canvas backing-store resolution. */
  quality: "lo" | "mid" | "hi";
  /** Cloth mesh subdivision (cols × rows). Changing this re-inits the solver. */
  meshRes: "lo" | "mid" | "hi";

  /** Ambient breeze strength. 0 = still air, ~0.05 = gentle drift,
   *  0.1+ = clearly windy. */
  breeze: number;

  /** Skybox appearance. "sky" is the default gradient with sun; "black"
   *  replaces the visible sphere with a flat dark neutral (leans slightly
   *  gray so it reads as "unlit backdrop" rather than pure void). Lighting
   *  (sun DirectionalLight + ambient hemisphere + cloth uniforms) is
   *  unaffected — only what the background sphere renders changes. */
  skyMode: "sky" | "black";

  // ── Performance (device prefs, not material) ──────────────────────────────
  /** Solver relaxation iterations per step. XPBD stays stable as this drops,
   *  so it's the cleanest sim-cost dial — 6 is crisp, 3 is fine on weak GPUs. */
  iterations: number;
  /** Self-collision cadence: "full" every step, "half" every other, "off"
   *  never. The priciest CPU stage; halving is imperceptible in normal drape. */
  selfCollide: "full" | "half" | "off";
  /** Texture anisotropy (2 | 4 | 8). Texture-bandwidth lever for old mobiles. */
  anisotropy: 2 | 4 | 8;
  /** When on, frag-res auto-steps down (hi→mid→lo) if FPS sags, and back up
   *  when it recovers. Degrades rendering only — never the solver. */
  autoQuality: boolean;
}

// ── Merged surface ────────────────────────────────────────────────────────────

export type Knobs = FabricKnobs & SceneKnobs;

// ── Presets ───────────────────────────────────────────────────────────────────

// Resolution / quality preset. Toggling `quality` writes the pom step counts
// into the knobs (so the sliders show the preset) and derives `pixelScale`
// separately (not a knob — quality is the single control for that axis).
export const QUALITY_PRESETS: Record<
  SceneKnobs["quality"],
  { pixelScale: number; pomMinSteps: number; pomMaxSteps: number }
> = {
  // lo min was 4 — visible stair-swimming even head-on. 6/16 is still cheap
  // and keeps the march from falling apart at moderate angles.
  lo: { pixelScale: 0.5, pomMinSteps: 6, pomMaxSteps: 16 },
  mid: { pixelScale: 1.0, pomMinSteps: 8, pomMaxSteps: 32 },
  hi: { pixelScale: 2.0, pomMinSteps: 16, pomMaxSteps: 48 },
};

// Cloth vertex count. Higher = smoother drape at the cost of physics work
// per frame (constraint projection is O(N × iterations) with N the particle
// count). Changing this re-inits the solver.
export const MESH_PRESETS: Record<
  SceneKnobs["meshRes"],
  { cols: number; rows: number }
> = {
  lo: { cols: 32, rows: 32 },
  mid: { cols: 48, rows: 48 },
  hi: { cols: 72, rows: 72 },
};

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_FABRIC_KNOBS: FabricKnobs = {
  sheen: 0.9,
  // Subtle by default — visible when backlit or at grazing angles without
  // repainting materials saved before the knob existed.
  iridescence: 0.35,
  // openness 0.55 preserves the pre-step-6 look — translucency was 0.55,
  // densityAmount was 0.75 (≈ 1 − 0.5·0.55), alphaFromDensity was 0.06
  // (≈ 0.1·0.55). Sweeping this slider now covers the whole denim→organza
  // range with the other three moving in lockstep.
  openness: 0.55,
  translucency: 0.55,
  densityAmount: 0.75,
  alphaFromDensity: 0.06,
  alphaBoost: 0,
  alphaBoostSource: 0,
  albedoAmount: 1.0,
  pomScale: 0.015,
  normalAmount: 1.0,
  pomShadow: 0.55,
  stretch: 0,
  edgeInset: 0.008,
  edgeFray: 0.12,
  edgeSharpness: 0.15,
  edgeDetail: 1,
  tileScale: 1,
  // Height-driven only by default — preserves the original single-mode look.
  txHeight: 1,
  txAlbedo: 0,
  txRoughness: 0,
  transmissionContrast: 0.3,
  weight: 1,
  warpStiffness: 0.95,
  weftStiffness: 0.92,
  shearStiffness: 0.55,
  bendStiffness: 0.06,
};

export const DEFAULT_SCENE_KNOBS: SceneKnobs = {
  wireframe: false,
  pinMode: "pegs",
  // Defaults match the "hi" quality preset — the fabric close-up IS the
  // product, so the frag path defaults to full resolution. Older devices
  // drop to mid/lo via the frag-res picker.
  pomMinSteps: 16,
  pomMaxSteps: 48,
  pomDebug: 0,
  stretchDebug: false,
  quality: "hi",
  meshRes: "mid",
  breeze: 0.06,
  skyMode: "sky",
  iterations: 6,
  selfCollide: "full",
  anisotropy: 8,
  autoQuality: false,
};

/** Merged defaults. Keeps the old import path working for callers that don't
 *  yet care about the fabric/scene split. */
export const DEFAULT_KNOBS: Knobs = {
  ...DEFAULT_FABRIC_KNOBS,
  ...DEFAULT_SCENE_KNOBS,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The FabricKnobs slice of the merged knob state — scene/quality knobs are
 *  viewing prefs and never travel with a material. */
export function fabricKnobsOf(k: Knobs): FabricKnobs {
  return Object.fromEntries(
    (Object.keys(DEFAULT_FABRIC_KNOBS) as (keyof FabricKnobs)[]).map((key) => [
      key,
      k[key],
    ]),
  ) as unknown as FabricKnobs;
}

/** Stable signature of a material's saved params. Autosave fires only when
 *  this changes, so dragging a scene-only knob (quality, mesh) never writes. */
export function paramSig(
  fabricId: string,
  metalness: number,
  k: FabricKnobs,
): string {
  const vals = (Object.keys(DEFAULT_FABRIC_KNOBS) as (keyof FabricKnobs)[]).map(
    (key) => k[key],
  );
  return JSON.stringify([fabricId, Math.round(metalness * 1000), vals]);
}
