// ─── motion.ts ────────────────────────────────────────────────────────────────
// The interface's ONE motion curve. Every discrete state-A → state-B
// transition in the app — panel slides, tab tracks, the drawer collapse, the
// cloth↔object transition, the mesh-resolution slide-swap, and the material
// pixel-dissolve reveal — eases through this same curve, so the whole
// interface reads as one coherent hand moving it, not several unrelated
// timing functions layered by accident.
//
// Two representations of the identical curve, kept in sync deliberately:
//   - CSS: --ease-motion in app/styles/tokens.css (same 4 numbers).
//   - JS:  EASE_MOTION here, for code driving its own rAF loop (cloth scene,
//     canvas pixel-dissolve) rather than a CSS transition.
// If you retune the curve, change both.
//
// (Continuous, target-seeking motion — PixelPlay's orbit chase and burst
// physics — is deliberately NOT on this curve. Those are ongoing simulations
// with no fixed start/end, not discrete transitions, and forcing a slow-start
// symmetric ease onto a "particles exploding outward" burst would read as
// sluggish rather than uniform.)

export const EASE_MOTION: readonly [number, number, number, number] = [
  0.65, 0, 0.35, 1,
];

/** Cubic-bezier easing (CSS-style control points), Newton-solved. Returns
 *  eased y for a linear x in [0,1]. */
export function makeCubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 5; i++) {
      const err = sampleX(t) - x;
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(Math.min(1, Math.max(0, t)));
  };
}

/** The interface's one motion curve, ready to call: easeMotion(0.5) → eased y. */
export const easeMotion = makeCubicBezier(...EASE_MOTION);
