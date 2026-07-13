// ─── ClothSolver.ts ───────────────────────────────────────────────────────────
// A real cloth solver, not a soft body.
//
// The crucial difference from the old paper sim: there are NO rest-position
// springs. A soft body is pulled back toward a fixed shape (restX/Y/Z); cloth
// has no rest shape at all. Cloth = a grid of point masses + distance
// CONSTRAINTS between neighbours, fighting gravity. Drape is what emerges.
//
// Integration: Verlet (position-based). We never store velocity explicitly —
// velocity is implied by (current position - previous position). This is what
// makes stiff, near-inextensible constraints stable; explicit-Euler springs
// would explode here.
//
// Solver: XPBD (Extended Position-Based Dynamics). Each frame we run several
// relaxation iterations; each iteration projects every constraint, nudging
// particle positions to satisfy it. Stiffness is expressed as "compliance"
// (inverse stiffness) so it stays stable regardless of iteration count.
//
// This module is intentionally pure simulation. It knows nothing about WebGL,
// WebGPU, React, or canvases. It exposes typed-array buffers; a renderer reads
// them. That boundary is what would let the solver later move to a WebGPU
// compute shader WITHOUT any renderer or UI change — only this file.

import type { ResolvedFabric } from "./fabrics";
import { WIND_LEAK } from "./derive";

// ── Constraint typing ──────────────────────────────────────────────────────
// Every constraint is tagged. The solver picks its stiffness by tag from the
// active FabricProfile. This tagging is the single most important structural
// decision: woven-vs-knit, anisotropy, and all four fabrics become parameter
// lookups instead of rewrites.
export const enum ConstraintType {
  Warp = 0,  // structural, lengthwise  (grain)
  Weft = 1,  // structural, crosswise   (grain)
  Shear = 2, // diagonal — the bias; looser on a woven fabric
  Bend = 3,  // two cells apart — fold resistance; separates the 4 fabrics
}

interface Constraint {
  a: number; // particle index
  b: number; // particle index
  restLength: number; // CURRENT rest length — for bend constraints this
                      // migrates as creases set (plastic deformation).
  origRestLength: number; // the flat-state rest length, never changes.
                          // Plastic migration is clamped relative to this.
  type: ConstraintType;
  /** Bend constraints only: index of the particle midway between a and b
   *  (one cell in). Its bow away from the a–b line is a true fold measure,
   *  sensitive to gentle folds in a way the a–b distance is not. -1 for
   *  non-bend constraints. */
  mid: number;
  /** Bend constraints only: flat-state bow of the mid particle off the
   *  a–b line. The reference the live bow is compared against. */
  flatBow: number;
}

export interface ClothConfig {
  cols: number;
  rows: number;
  /** World-space spacing between adjacent particles at rest. */
  spacing: number;
  /** World-space origin (top-left of the sheet). */
  originX: number;
  originY: number;
  /** Gravity in world units / step^2 (positive = downward). */
  gravity: number;
  /** Relaxation iterations per frame. 4–8 is typical. More = stiffer/stabler,
   *  but linearly more expensive. A key knob for the perf gate. */
  iterations: number;
}

export const DEFAULT_CONFIG: ClothConfig = {
  cols: 48,
  rows: 48,
  spacing: 9,
  originX: 0,
  originY: 0,
  gravity: 0.4,
  iterations: 6,
};

export class ClothSolver {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;

  // Particle state as flat Float32Arrays (x,y,z interleaved). Flat typed
  // arrays — not an array of objects — because this is the exact memory
  // layout a GPU compute port would want, and it's faster on the CPU too.
  pos: Float32Array;      // current positions
  prev: Float32Array;     // previous positions (Verlet => implicit velocity)
  readonly pinned: Uint8Array;
  private invMass: Float32Array; // 1/mass per particle; 0 == pinned/static
  /** Per-particle porosity (0 = dense/solid, 1 = fully open). Modulates
   *  wind pickup via `force *= 1 − porosity·WIND_LEAK`. Populated from a
   *  transmission map (per-vertex UV sample) when available, otherwise
   *  filled with the fabric's resolved openness scalar. */
  readonly porosity: Float32Array;

  private constraints: Constraint[] = [];
  private cfg: ClothConfig;
  private fabric: ResolvedFabric;

  /** Run self-collision every Nth step; 0 disables it. A perf lever — the
   *  push is soft either way, so halving the rate is invisible in ordinary
   *  breeze and off is fine for a flat-hanging sheet. */
  selfCollisionEvery = 1;
  private stepCount = 0;

  // External forces accumulated per-frame by the host (wind, cursor).
  private accel: Float32Array;

  constructor(cfg: ClothConfig, fabric: ResolvedFabric) {
    this.cfg = { ...cfg };
    this.fabric = fabric;
    this.cols = cfg.cols;
    this.rows = cfg.rows;
    this.count = cfg.cols * cfg.rows;

    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.accel = new Float32Array(this.count * 3);
    this.pinned = new Uint8Array(this.count);
    this.invMass = new Float32Array(this.count);
    // Init porosity to the fabric's resolved openness — sensible default
    // when no transmission map is loaded. Callers (ClothScene) can replace
    // it via setPorosity() once the map is sampled at each UV.
    this.porosity = new Float32Array(this.count);
    this.porosity.fill(fabric.openness);

    this.reset();
    this.buildConstraints();
  }

  /** Bulk-write per-particle porosity from a caller-supplied buffer
   *  (typically produced by sampling a transmission map at each vertex UV).
   *  Length must equal `count`. */
  setPorosity(values: Float32Array): void {
    if (values.length !== this.count) {
      throw new Error(
        `setPorosity: expected ${this.count} entries, got ${values.length}`,
      );
    }
    this.porosity.set(values);
  }

  /** Scalar fallback — fill every particle with the same porosity. Used when
   *  there is no transmission map, so the whole cloth catches wind uniformly
   *  according to the fabric's inherent openness. */
  fillPorosity(v: number): void {
    this.porosity.fill(v);
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  /** Lay the sheet out flat, hanging from its top edge. */
  reset(): void {
    const { cols, rows, spacing, originX, originY } = this.cfg;
    const m = this.fabric.particleMass;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = originX + c * spacing;
        const y = originY + r * spacing;
        const z = 0;
        this.pos[i * 3] = this.prev[i * 3] = x;
        this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = y;
        this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = z;
        this.invMass[i] = 1 / m;
        this.pinned[i] = 0;
      }
    }
  }

  /** Pin the entire top row — the clothesline. Pinned points have invMass 0,
   *  so constraints and gravity simply never move them. */
  pinTopEdge(): void {
    for (let c = 0; c < this.cols; c++) this.setPinned(c, true);
  }

  /** Pin at intervals instead — as if pegged to a line at a few points,
   *  which gives the characteristic scalloped droop between pegs. */
  pinAtPegs(pegEvery = 8): void {
    for (let c = 0; c < this.cols; c += pegEvery) this.setPinned(c, true);
    this.setPinned(this.cols - 1, true); // always peg the trailing corner
  }

  setPinned(index: number, pinned: boolean): void {
    this.pinned[index] = pinned ? 1 : 0;
    this.invMass[index] = pinned ? 0 : 1 / this.fabric.particleMass;
  }

  // ── Constraint construction ───────────────────────────────────────────────
  // Built ONCE. Warp/weft/shear/bend are all generated here and tagged.
  // Swapping fabrics later does NOT rebuild this — only the stiffness lookup
  // in projectConstraints() changes.
  private buildConstraints(): void {
    const { cols, rows } = this;
    const idx = (r: number, c: number) => r * cols + c;
    const add = (a: number, b: number, type: ConstraintType, mid = -1) => {
      const len = this.dist(a, b);
      this.constraints.push({
        a, b, type,
        restLength: len,
        origRestLength: len,
        mid,
        flatBow: mid >= 0 ? this.bow(a, b, mid) : 0,
      });
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Structural — weft (horizontal neighbour, crosswise yarn)
        if (c < cols - 1) add(idx(r, c), idx(r, c + 1), ConstraintType.Weft);
        // Structural — warp (vertical neighbour, lengthwise yarn)
        if (r < rows - 1) add(idx(r, c), idx(r + 1, c), ConstraintType.Warp);
        // Shear — both diagonals of each cell (the bias directions)
        if (c < cols - 1 && r < rows - 1) {
          add(idx(r, c), idx(r + 1, c + 1), ConstraintType.Shear);
          add(idx(r, c + 1), idx(r + 1, c), ConstraintType.Shear);
        }
        // Bend — skip one neighbour. The MIDDLE particle (idx r,c+1) is
        // recorded so plasticity can measure the true fold angle via its
        // bow off the endpoint line, not the weak endpoint distance.
        if (c < cols - 2)
          add(idx(r, c), idx(r, c + 2), ConstraintType.Bend, idx(r, c + 1));
        if (r < rows - 2)
          add(idx(r, c), idx(r + 2, c), ConstraintType.Bend, idx(r + 1, c));
      }
    }
  }

  /** Perpendicular distance of particle `m` from the line through a–b.
   *  Zero when the three points are colinear (flat); grows as the cloth
   *  folds at m. This is the fold measure plasticity uses. */
  private bow(a: number, b: number, m: number): number {
    const ax = a * 3, bx = b * 3, mx = m * 3;
    const abx = this.pos[bx] - this.pos[ax];
    const aby = this.pos[bx + 1] - this.pos[ax + 1];
    const abz = this.pos[bx + 2] - this.pos[ax + 2];
    const amx = this.pos[mx] - this.pos[ax];
    const amy = this.pos[mx + 1] - this.pos[ax + 1];
    const amz = this.pos[mx + 2] - this.pos[ax + 2];
    // |AM x AB| / |AB|  = perpendicular distance
    const cx = amy * abz - amz * aby;
    const cy = amz * abx - amx * abz;
    const cz = amx * aby - amy * abx;
    const abLen = Math.hypot(abx, aby, abz) || 1e-6;
    return Math.hypot(cx, cy, cz) / abLen;
  }

  private dist(a: number, b: number): number {
    const dx = this.pos[a * 3] - this.pos[b * 3];
    const dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
    const dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
    return Math.hypot(dx, dy, dz);
  }

  // ── Per-fabric stiffness lookup ───────────────────────────────────────────
  // The one place fabric identity enters the physics. Stiffness (0..1) is
  // mapped to XPBD compliance: compliance = (1 - stiffness) * scale.
  // stiffness 1 => compliance 0 => perfectly rigid constraint.
  private complianceFor(type: ConstraintType): number {
    const f = this.fabric;
    let stiffness: number;
    switch (type) {
      case ConstraintType.Warp:  stiffness = f.warpStiffness;  break;
      case ConstraintType.Weft:  stiffness = f.weftStiffness;  break;
      case ConstraintType.Shear: stiffness = f.shearStiffness; break;
      case ConstraintType.Bend:  stiffness = f.bendStiffness;  break;
    }
    // COMPLIANCE_SCALE tunes how soft "stiffness 0" actually is. Adjust by eye.
    const COMPLIANCE_SCALE = 0.02;
    return (1 - stiffness) * COMPLIANCE_SCALE;
  }

  /** Relaxation iterations per step. XPBD's compliance formulation keeps the
   *  solve stable as this drops, so it's a clean cost dial — fewer iterations
   *  just converge a touch softer, they don't destabilise. Clamped to [1, 12]. */
  setIterations(n: number): void {
    this.cfg.iterations = Math.max(1, Math.min(12, Math.round(n)));
  }

  /** Hot-swap the fabric without rebuilding geometry or constraints. This is
   *  what makes the clothesline cheap: slide to the next bay, swap the
   *  profile, the same solver now behaves like a different textile. */
  setFabric(fabric: ResolvedFabric): void {
    this.fabric = fabric;
    for (let i = 0; i < this.count; i++) {
      if (!this.pinned[i]) this.invMass[i] = 1 / fabric.particleMass;
    }
  }

  // ── External forces ───────────────────────────────────────────────────────
  /** Host calls these before step(). Cleared automatically each step(). */
  addAcceleration(index: number, ax: number, ay: number, az: number): void {
    this.accel[index * 3] += ax;
    this.accel[index * 3 + 1] += ay;
    this.accel[index * 3 + 2] += az;
  }

  /** Convenience: a radial cursor push, scaled by the fabric's wind response
   *  AND by 1/mass per particle so a heavier fabric visibly resists the
   *  cursor even at the same strength. Smoothstep falloff (not linear) so
   *  the affected region has a soft boundary — no visible ring where the
   *  effect suddenly stops. Pinned particles are skipped (invMass = 0). */
  applyCursor(cx: number, cy: number, radius: number, strength: number): void {
    const r2 = radius * radius;
    const s = strength * this.fabric.windResponse;
    for (let i = 0; i < this.count; i++) {
      const w = this.invMass[i];
      if (w === 0) continue;
      const dx = this.pos[i * 3] - cx;
      const dy = this.pos[i * 3 + 1] - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      // Smoothstep-inverted: 1 at cursor, 0 at radius, cubic ease at both.
      const falloff = 1 - t * t * (3 - 2 * t);
      const sw = s * w;
      this.addAcceleration(
        i,
        dx * 0.02 * falloff * sw,
        dy * 0.02 * falloff * sw,
        -falloff * sw,
      );
    }
  }

  /** Directional drag — nearby vertices move in the direction of pointer
   *  motion (dx, dy), scaled by smoothstep falloff so the affected region
   *  blends smoothly with the rest of the mesh. When the pointer is
   *  stationary this contributes no force, so holding the button down
   *  without moving doesn't crumple the cloth inward.
   *  cx, cy: pointer position (world coords)
   *  dx, dy: pointer motion this frame (world coords)
   *  radius, strength: as usual. */
  applyDrag(
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    radius: number,
    strength: number,
  ): void {
    if (dx === 0 && dy === 0) return;
    const r2 = radius * radius;
    const s = strength * this.fabric.windResponse;
    for (let i = 0; i < this.count; i++) {
      const rx = this.pos[i * 3] - cx;
      const ry = this.pos[i * 3 + 1] - cy;
      const d2 = rx * rx + ry * ry;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      const falloff = 1 - t * t * (3 - 2 * t);
      // In-plane push in the direction of pointer motion; small forward Z
      // keeps the pulled patch from folding under itself under fast sweeps.
      this.addAcceleration(
        i,
        dx * falloff * s,
        dy * falloff * s,
        -falloff * s * 0.15,
      );
    }
  }

  /** Single-frame impulse — a pluck / twang. Wide radius, strong forward
   *  Z-push and modest in-plane radial spread. Called once per
   *  pointerdown; cloth builds velocity from the impulse and swings back
   *  through Verlet + constraints. */
  applyPluck(cx: number, cy: number, radius: number, strength: number): void {
    const r2 = radius * radius;
    const s = strength * this.fabric.windResponse;
    for (let i = 0; i < this.count; i++) {
      const dx = this.pos[i * 3] - cx;
      const dy = this.pos[i * 3 + 1] - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      const falloff = 1 - t * t * (3 - 2 * t);
      this.addAcceleration(
        i,
        dx * 0.05 * falloff * s,
        dy * 0.05 * falloff * s,
        -falloff * s * 4.0,
      );
    }
  }

  /** Position-spring grab on the single closest non-pinned particle. The
   *  spring pulls that particle toward (cx, cy) each frame; force
   *  naturally decays to zero as it catches up, so holding the pointer
   *  still doesn't accumulate anything. Only one vertex is affected
   *  directly — neighbors follow through the cloth constraints, which
   *  keeps the mesh from crumpling into a point. Higher spring = less
   *  lag; lower = more visible trail. */
  applyGrab(cx: number, cy: number, spring: number): void {
    let closest = -1;
    let closestD2 = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue;
      const dx = this.pos[i * 3] - cx;
      const dy = this.pos[i * 3 + 1] - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < closestD2) {
        closestD2 = d2;
        closest = i;
      }
    }
    if (closest < 0) return;
    const dx = cx - this.pos[closest * 3];
    const dy = cy - this.pos[closest * 3 + 1];
    this.addAcceleration(closest, dx * spring, dy * spring, 0);
  }

  /** Ambient noise-generated breeze — directional, laundry-blowing.
   *  Three-tier structure:
   *    1. GUST ENVELOPE: three slow sinusoids beat against each other to
   *       produce quiet stretches punctuated by strong bursts. Clamped
   *       positive so wind never reverses direction — that's the trick
   *       that separates "flapping laundry" from "random fluttering."
   *    2. DIRECTION: a dominant forward billow (into the material,
   *       toward the viewer) with lateral X drift that slowly shifts
   *       side to side. Cloth moves coherently rather than in patches.
   *    3. TURBULENCE: per-particle noise breaks up the wavefront so
   *       adjacent threads don't march in perfect lockstep.
   *  windResponse scales coupling per fabric; invMass makes heavier
   *  fabrics physically less affected by the same wind. */
  applyWind(time: number, baseStrength: number): void {
    const s = baseStrength * this.fabric.windResponse;

    // Gust envelope — three sines at incommensurate periods (~4s / ~5s /
    // ~2.5s at 60fps) beat against each other. Peaks sharpened via pow so
    // gusts feel like discrete puffs rather than smooth undulation.
    const g1 = Math.sin(time * 0.015);
    const g2 = Math.sin(time * 0.021 + 2.1);
    const g3 = Math.sin(time * 0.038 + 0.7);
    const rawEnvelope = 0.55 + g1 * 0.5 + g2 * 0.45 + g3 * 0.3;
    const gustEnvelope =
      Math.max(0.12, Math.pow(Math.max(0.05, rawEnvelope), 1.4)) * 1.35;

    // Dominant wind direction shifts over ~8-15 seconds — fast enough
    // to see the fabric change its lean without turning into chaos.
    const dirX =
      Math.sin(time * 0.008) * 0.6 +
      Math.sin(time * 0.014 + 1.2) * 0.25;
    const dirZ = -1.0;

    for (let i = 0; i < this.count; i++) {
      const w = this.invMass[i];
      if (w === 0) continue;
      const r = (i / this.cols) | 0;
      const c = i % this.cols;
      const depth = r / (this.rows - 1);

      // Per-particle flap turbulence at ~0.5-1.5 Hz. Spatial frequency
      // kept low (`c * ~0.1` instead of `c * 0.5`) so each phase wave
      // spans many particles — the wind field varies over a scale
      // several times larger than the cell size, which is what makes
      // the fabric read as a big sheet rather than a small swatch.
      const turbX = Math.sin(time * 0.055 + c * 0.09 + r * 0.06) * 0.22;
      const turbY = Math.cos(time * 0.07 + c * 0.07 + r * 0.11) * 0.12;
      const turbZ = Math.sin(time * 0.088 + c * 0.06 + r * 0.05) * 0.32;

      // Per-particle porosity attenuates wind pickup. Slub-dense regions
      // (low porosity) inflate; open weave (high porosity) leaks. windResponse
      // is the fabric-wide coupling; porosity is the local modulation on top.
      const leak = 1 - this.porosity[i] * WIND_LEAK;
      const sw = s * depth * w * gustEnvelope * leak;

      this.addAcceleration(
        i,
        (dirX + turbX) * sw,
        turbY * sw,
        (dirZ + turbZ) * sw,
      );
    }
  }

  // ── The step ──────────────────────────────────────────────────────────────
  // 1. Verlet integrate (gravity + accumulated forces + implicit velocity).
  // 2. Relaxation: N iterations projecting every constraint.
  // 3. Plasticity: ONCE per frame, let sustained bend folds set as creases.
  // 4. Clear forces.
  step(dt = 1): void {
    this.stepCount++;
    this.integrate(dt);
    for (let it = 0; it < this.cfg.iterations; it++) this.projectConstraints();
    // Self-collision: push non-adjacent particle pairs apart so folded
    // sections of the cloth can't sail through each other. Thickness is a
    // fraction of spacing — big enough to matter, small enough not to
    // interfere with the ordinary drape. Rate-gated: it's the priciest CPU
    // stage, and a soft push every other step is imperceptible.
    if (
      this.selfCollisionEvery > 0 &&
      this.stepCount % this.selfCollisionEvery === 0
    ) {
      this.selfCollide(this.cfg.spacing * 0.55);
    }
    this.updatePlasticity(); // once per frame, NOT per iteration — see below
    this.accel.fill(0);
  }

  // ── Self-collision ────────────────────────────────────────────────────────
  // Cheap position-based repulsion between particle pairs that are
  // (a) NOT direct grid neighbours (already governed by warp/weft/shear/bend
  //     constraints, so they'd fight each other), and
  // (b) within `thickness` world units of each other.
  //
  // Spatial hash on world coords — only pairs in the same or an adjacent
  // cell are compared. Cell size lives between spacing and 2× spacing:
  // bigger = fewer buckets, smaller = fewer false candidates. Runs once
  // after regular constraint projection; not iterated further, so it's a
  // soft push rather than a hard barrier — the cloth can still fold, just
  // not intersect itself.
  //
  // Cell keys are packed integers rather than strings: three signed 20-bit
  // coordinates (biased) into a single number. Avoids allocating per-key
  // template strings each frame and per-cell get/set hashing. The
  // per-frame Map itself is reused (cleared instead of reallocated).
  private static readonly HASH_BIAS = 1 << 19; // 524288 — fits ±524287 cells
  private static readonly HASH_MOD = 1 << 20; // 1048576
  private collisionCells: Map<number, number[]> = new Map();
  private collisionBuckets: number[][] = []; // pool, reused across frames
  private collisionBucketCount = 0;
  selfCollide(thickness: number): void {
    const cs = Math.max(6, thickness * 2.0);
    const cells = this.collisionCells;
    const bucketPool = this.collisionBuckets;
    cells.clear();
    this.collisionBucketCount = 0;

    const HASH_BIAS = ClothSolver.HASH_BIAS;
    const HASH_MOD = ClothSolver.HASH_MOD;

    // Populate buckets.
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      const cx = Math.floor(this.pos[ix] / cs);
      const cy = Math.floor(this.pos[ix + 1] / cs);
      const cz = Math.floor(this.pos[ix + 2] / cs);
      const key =
        ((cx + HASH_BIAS) * HASH_MOD + (cy + HASH_BIAS)) * HASH_MOD +
        (cz + HASH_BIAS);
      let arr = cells.get(key);
      if (!arr) {
        arr = bucketPool[this.collisionBucketCount++] ?? [];
        arr.length = 0;
        bucketPool[this.collisionBucketCount - 1] = arr;
        cells.set(key, arr);
      }
      arr.push(i);
    }

    const t2 = thickness * thickness;
    const cols = this.cols;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      const pxi = this.pos[ix];
      const pyi = this.pos[ix + 1];
      const pzi = this.pos[ix + 2];
      const cx = Math.floor(pxi / cs);
      const cy = Math.floor(pyi / cs);
      const cz = Math.floor(pzi / cs);
      const ri = (i / cols) | 0;
      const ci = i % cols;
      const wA = this.invMass[i];

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key =
              ((cx + dx + HASH_BIAS) * HASH_MOD + (cy + dy + HASH_BIAS)) *
                HASH_MOD +
              (cz + dz + HASH_BIAS);
            const bucket = cells.get(key);
            if (!bucket) continue;

            for (let k = 0; k < bucket.length; k++) {
              const j = bucket[k];
              if (j <= i) continue;

              // Skip pairs already handled by constraints — grid
              // Chebyshev distance ≤ 2 covers warp/weft/shear/bend.
              const rj = (j / cols) | 0;
              const cj = j % cols;
              const drr = ri - rj;
              const dcc = ci - cj;
              if (drr <= 2 && drr >= -2 && dcc <= 2 && dcc >= -2) continue;

              const jx = j * 3;
              const px = this.pos[jx] - pxi;
              const py = this.pos[jx + 1] - pyi;
              const pz = this.pos[jx + 2] - pzi;
              const d2 = px * px + py * py + pz * pz;
              if (d2 >= t2 || d2 < 1e-6) continue;

              const wB = this.invMass[j];
              const sum = wA + wB;
              if (sum === 0) continue;

              const d = Math.sqrt(d2);
              const overlap = thickness - d;
              const invD = 1 / d;
              // Split correction by inverse mass — pinned/heavier particles
              // move less, lighter give way.
              const scale = overlap * invD;
              const shareA = (wA / sum) * scale;
              const shareB = (wB / sum) * scale;
              this.pos[ix] = pxi - px * shareA;
              this.pos[ix + 1] = pyi - py * shareA;
              this.pos[ix + 2] = pzi - pz * shareA;
              this.pos[jx] += px * shareB;
              this.pos[jx + 1] += py * shareB;
              this.pos[jx + 2] += pz * shareB;
            }
          }
        }
      }
    }
  }

  // ── Plasticity: how creases form and fade ─────────────────────────────────
  // Elastic bending (projectConstraints) always pulls a fold back toward the
  // constraint's restLength. Plasticity is the slow migration of that
  // restLength ITSELF, so a fold can acquire a new, set shape — a crease.
  //
  // Runs once per frame, not once per relaxation iteration: a crease is the
  // result of a fold being *held* over time, so it must integrate at frame
  // rate, not get multiplied by the iteration count.
  //
  // STRICTLY bend constraints only. If a warp/weft (structural) rest length
  // migrated, the cloth would permanently STRETCH and the entire
  // inextensible-woven thesis would collapse. The type guard below is
  // load-bearing — do not remove it.
  private updatePlasticity(): void {
    const f = this.fabric;
    const yieldBow = f.creaseThreshold;
    const setRate = f.creaseCommitRate;
    const relaxRate = f.creaseRelease;
    if (setRate <= 0 && relaxRate <= 0) return;

    const MIGRATE_CLAMP = 0.5;

    const cs = this.constraints;
    for (let n = 0; n < cs.length; n++) {
      const con = cs[n];
      if (con.type !== ConstraintType.Bend) continue; // ← load-bearing guard
      if (con.mid < 0) continue;

      // True fold measure: how far the mid particle has bowed off the
      // endpoint line, RELATIVE to its flat-state bow, normalised by the
      // constraint's span. Sensitive to gentle folds — unlike endpoint
      // distance, which barely moves until the fold is extreme.
      const liveBow = this.bow(con.a, con.b, con.mid);
      const foldAmount = (liveBow - con.flatBow) / con.origRestLength;

      if (foldAmount > yieldBow && setRate > 0) {
        // YIELDED. The crease sets: shorten restLength toward the chord
        // length the folded cloth currently has, so the bend constraint
        // now actively HOLDS the fold instead of resisting it.
        const chord = this.dist(con.a, con.b);
        con.restLength += (chord - con.restLength) * setRate;
      } else if (relaxRate > 0) {
        // Not folded enough — slowly hang back out toward flat. Transient
        // gust-folds fade here instead of accumulating (the entropy valve).
        con.restLength += (con.origRestLength - con.restLength) * relaxRate;
      }

      const lo = con.origRestLength * (1 - MIGRATE_CLAMP);
      const hi = con.origRestLength * (1 + MIGRATE_CLAMP);
      if (con.restLength < lo) con.restLength = lo;
      else if (con.restLength > hi) con.restLength = hi;
    }
  }

  // ── Pre-baked creases ─────────────────────────────────────────────────────
  // A preset: stamp set fold lines into the cloth before simulation, as if
  // the fabric had been folded and stored (a bojagi keeps its wrapping
  // creases). Call after construction, before the first step(). Works by
  // directly shortening the rest length of bend constraints that straddle
  // the given grid line — pre-loading the plastic state the automatic
  // system would otherwise have to earn.
  //
  // `axis`: "row" creases horizontally at grid row `index`; "col" vertically.
  // `depth`: 0..1, how sharp the pre-set fold is (fraction of rest length
  //          removed, within the same MIGRATE_CLAMP envelope).
  bakeCrease(axis: "row" | "col", index: number, depth = 0.3): void {
    const d = Math.min(0.5, Math.max(0, depth));
    for (const con of this.constraints) {
      if (con.type !== ConstraintType.Bend) continue;
      const ar = (con.a / this.cols) | 0, ac = con.a % this.cols;
      const br = (con.b / this.cols) | 0, bc = con.b % this.cols;
      // A bend constraint straddles the crease line if the line sits between
      // its two endpoints.
      const straddles =
        axis === "row"
          ? (ar < index && br > index) || (br < index && ar > index)
          : (ac < index && bc > index) || (bc < index && ac > index);
      // Only the bend constraints aligned ACROSS the fold should set —
      // a horizontal crease sets vertical (warp-direction) bend constraints.
      const aligned =
        axis === "row" ? ac === bc /* vertical span */ : ar === br;
      if (straddles && aligned) {
        con.restLength = con.origRestLength * (1 - d);
      }
    }
  }

  private integrate(dt: number): void {
    const g = this.cfg.gravity;
    const damp = this.fabric.damping;
    const dt2 = dt * dt;
    for (let i = 0; i < this.count; i++) {
      if (this.pinned[i]) continue;
      const ix = i * 3;
      for (let k = 0; k < 3; k++) {
        const j = ix + k;
        const cur = this.pos[j];
        // Implicit velocity = (cur - prev), damped.
        const vel = (cur - this.prev[j]) * damp;
        const a = this.accel[j] + (k === 1 ? g : 0); // gravity on +Y
        this.prev[j] = cur;
        this.pos[j] = cur + vel + a * dt2;
      }
    }
  }

  // XPBD constraint projection. For each distance constraint, compute how far
  // it is from its rest length and move both particles to correct it, split
  // by inverse mass (heavier particle moves less; pinned particle invMass 0
  // moves not at all). Compliance softens the correction per constraint type.
  private projectConstraints(): void {
    const cs = this.constraints;
    for (let n = 0; n < cs.length; n++) {
      const con = cs[n];
      const a = con.a, b = con.b;
      const wA = this.invMass[a], wB = this.invMass[b];
      const wSum = wA + wB;
      if (wSum === 0) continue; // both pinned

      const ax = a * 3, bx = b * 3;
      let dx = this.pos[bx] - this.pos[ax];
      let dy = this.pos[bx + 1] - this.pos[ax + 1];
      let dz = this.pos[bx + 2] - this.pos[ax + 2];
      const len = Math.hypot(dx, dy, dz) || 1e-6;

      const compliance = this.complianceFor(con.type);
      // XPBD correction factor. The +compliance term in the denominator is
      // what makes a soft (high-compliance) constraint give, and what keeps
      // the solver stable independent of iteration count.
      const diff = (len - con.restLength) / (len * (wSum + compliance));

      dx *= diff; dy *= diff; dz *= diff;
      this.pos[ax]     += dx * wA;
      this.pos[ax + 1] += dy * wA;
      this.pos[ax + 2] += dz * wA;
      this.pos[bx]     -= dx * wB;
      this.pos[bx + 1] -= dy * wB;
      this.pos[bx + 2] -= dz * wB;
    }
  }

  // ── Output for the renderer ───────────────────────────────────────────────
  /** Triangle indices for the mesh. Static — generate once, reuse. */
  buildIndices(): Uint16Array {
    const { cols, rows } = this;
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = r * cols + c, tr = tl + 1;
        const bl = tl + cols, br = bl + 1;
        idx.push(tl, bl, tr, bl, br, tr);
      }
    }
    return new Uint16Array(idx);
  }

  /** Static UVs (0..1 across the sheet). Generate once. */
  buildUVs(): Float32Array {
    const uv = new Float32Array(this.count * 2);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        uv[i * 2] = c / (this.cols - 1);
        uv[i * 2 + 1] = r / (this.rows - 1);
      }
    }
    return uv;
  }

  /** Smooth per-vertex normals, recomputed each frame from current positions.
   *  Writes into a caller-owned buffer to avoid per-frame allocation. */
  computeNormals(indices: Uint16Array, out: Float32Array): void {
    out.fill(0);
    const p = this.pos;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
      const ax = i0 * 3, bx = i1 * 3, cx = i2 * 3;
      const ux = p[bx] - p[ax], uy = p[bx + 1] - p[ax + 1], uz = p[bx + 2] - p[ax + 2];
      const vx = p[cx] - p[ax], vy = p[cx + 1] - p[ax + 1], vz = p[cx + 2] - p[ax + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      out[ax] += nx; out[ax + 1] += ny; out[ax + 2] += nz;
      out[bx] += nx; out[bx + 1] += ny; out[bx + 2] += nz;
      out[cx] += nx; out[cx + 1] += ny; out[cx + 2] += nz;
    }
    for (let i = 0; i < this.count * 3; i += 3) {
      const len = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1e-6;
      out[i] /= len; out[i + 1] /= len; out[i + 2] /= len;
    }
  }

  /** Per-particle directional strain, written 2-per-particle into `out`
   *  (length count·2): [uStrain, vStrain] where u is the crosswise (weft /
   *  UV-x) axis and v the lengthwise (warp / UV-y) axis. 0 = at rest spacing,
   *  >0 = stretched, <0 = compressed. Measured from the live distance to each
   *  axis neighbour vs `spacing`; averaged over both sides so it's smooth. The
   *  renderer reads this as a vertex attribute to make taut regions of the
   *  cloth go sheer / flatten their relief / specularise — the shader never
   *  has to guess where the fabric is under tension. Cheap: a handful of ops
   *  per particle, O(N), and only called when the stretch effect is on. */
  computeStrain(out: Float32Array): void {
    const { cols, rows, spacing } = this.cfg;
    const inv = 1 / spacing;
    const dist = (a: number, b: number): number => {
      const ax = a * 3, bx = b * 3;
      const dx = this.pos[ax] - this.pos[bx];
      const dy = this.pos[ax + 1] - this.pos[bx + 1];
      const dz = this.pos[ax + 2] - this.pos[bx + 2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        // crosswise (u): left + right neighbours
        let uSum = 0, uN = 0;
        if (c > 0) { uSum += dist(i, i - 1) * inv; uN++; }
        if (c < cols - 1) { uSum += dist(i, i + 1) * inv; uN++; }
        // lengthwise (v): up + down neighbours
        let vSum = 0, vN = 0;
        if (r > 0) { vSum += dist(i, i - cols) * inv; vN++; }
        if (r < rows - 1) { vSum += dist(i, i + cols) * inv; vN++; }
        out[i * 2] = uN > 0 ? uSum / uN - 1 : 0;
        out[i * 2 + 1] = vN > 0 ? vSum / vN - 1 : 0;
      }
    }
  }
}
