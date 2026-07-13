// ─── fabricCore.ts ────────────────────────────────────────────────────────────
// A small physically-motivated description of a woven textile. The intent is
// that everything the renderer and solver need (bend stiffness, translucency,
// sheen, tile density, etc.) can be *derived* from this ~7-field core rather
// than tuned as 20 loose sliders.
//
// Fabric profiles author this compact shape; derive() expands it into the
// complete solver and renderer parameter surface.

export type FiberType = "filament" | "staple";
export type WeaveType = "plain" | "twill" | "satin" | "knit";

export interface FabricCore {
  /** Areal density in g/m² — the single number most fabric datasheets list.
   *  Silk 40–80, cotton 100–200, denim 300+, upholstery 400+. */
  gsm: number;

  /** 0..1. Fraction of the plane actually covered by thread when viewed
   *  head-on. Governs how see-through / opaque the weave reads. Sheers ~0.4,
   *  ordinary plain weave ~0.75, dense twill ~0.9. */
  coverFactor: number;

  /** Cloth thickness in millimetres, front to back. Sub-millimetre for
   *  fine silks and gauzes; several millimetres for heavy hemp / felt. */
  thicknessMm: number;

  /** 0..1 normalized fiber-scale bending stiffness. Wool ~0.2 (limp),
   *  silk ~0.45 (fluid), cotton ~0.55 (medium), flax / ramie ~0.85 (crisp).
   *  Combined with weave and twist to yield the macroscopic bend
   *  stiffness the solver actually uses. */
  fiberModulus: number;

  /** Filament vs staple fiber. Filaments (silk, synthetics) run continuous
   *  through the yarn — smoother, cooler sheen. Staples (cotton, wool, bast)
   *  are short fibers spun together — more surface fuzz, warmer sheen. */
  fiberType: FiberType;

  /** Structural pattern of the weave. Affects drape (satin > twill > plain
   *  in flexibility), shear response, and specular anisotropy. */
  weaveType: WeaveType;

  /** 0..1. Yarn twist: 0 = loose slub-prone spinning, 1 = hard-twisted
   *  cabled yarn. Higher twist → firmer hand, less fuzz, sharper edges. */
  twist: number;
}
