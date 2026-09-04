/**
 * Pointer-to-cloth tuning lives outside the scene so input feel is explicit,
 * testable, and independent from render resolution. Strengths are solver
 * accelerations, not event multipliers. Mouse travel is consumed once per
 * fixed tick; direct-contact travel is filtered across a few ticks so sparse
 * touch events still produce one continuous material gesture.
 */
export type ClothPointerKind = "mouse" | "pen" | "touch";

export interface ClothPointerProfile {
  /** Sustained radial pressure applied once per fixed simulation tick. */
  pressureStrength: number;
  /** Directional acceleration applied to the pointer's consumed travel. */
  dragStrength: number;
  /** One-shot forward impulse on contact. Zero means no contact pluck. */
  pluckStrength: number;
}

export const CLOTH_INTERACTION_RADIUS = 140;
export const CLOTH_PLUCK_RADIUS = 168;

/** Mouse force is an authored scene preference rather than a material trait.
 *  Three times the safe base profile makes hover read immediately; five times
 *  is the user-facing ceiling and still keeps pressure below the old unstable
 *  1.2 force. */
export const DEFAULT_MOUSE_FORCE = 3;
export const MAX_MOUSE_FORCE = 5;

export function resolveMouseForce(force = DEFAULT_MOUSE_FORCE): number {
  if (!Number.isFinite(force)) return DEFAULT_MOUSE_FORCE;
  return Math.min(MAX_MOUSE_FORCE, Math.max(0, force));
}

/**
 * Prevent a sparse pointer-event burst or near-parallel ray projection from
 * injecting an unbounded displacement into one simulation tick. This is about
 * 15% of the 423-unit sheet width: still a forceful swipe, but recoverable.
 */
export const MAX_POINTER_TRAVEL_PER_TICK = 64;

/** Direct contact is intentionally tighter than mouse hover travel. A finger
 * can produce very sparse browser samples; capping before filtering prevents
 * one late event from kicking the entire patch across the sheet. */
export const MAX_CONTACT_TRAVEL_PER_TICK = 24;
export const CONTACT_VELOCITY_BLEND = 0.45;
export const CONTACT_VELOCITY_DECAY = 0.78;

export const CLOTH_POINTER_PROFILES: Readonly<
  Record<ClothPointerKind, Readonly<ClothPointerProfile>>
> = {
  // Safe base profile. The live scene multiplies both pressure and drag by the
  // user-facing mouse-force control (3x by default, 0–5x available).
  mouse: {
    pressureStrength: 0.22,
    dragStrength: 0.045,
    // A completed click releases a local forward gust. The scene scales this
    // with the same mouse-force preference as hover movement.
    pluckStrength: 0.22,
  },
  // A stylus has contact intent, but stays a little more precise than touch.
  pen: {
    pressureStrength: 0.45,
    dragStrength: 0.075,
    pluckStrength: 0.14,
  },
  // Touch only exists while the finger is down, so it gets the strongest
  // sustained press, travel coupling, and an immediate contact response.
  touch: {
    pressureStrength: 0.65,
    dragStrength: 0.1,
    pluckStrength: 0.18,
  },
};

export function normalizeClothPointerKind(
  pointerType: string,
): ClothPointerKind {
  return pointerType === "touch" || pointerType === "pen"
    ? pointerType
    : "mouse";
}

export function clampPointerTravel(
  dx: number,
  dy: number,
  maxTravel = MAX_POINTER_TRAVEL_PER_TICK,
): { dx: number; dy: number } {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { dx: 0, dy: 0 };
  const magnitude = Math.hypot(dx, dy);
  if (magnitude === 0 || magnitude <= maxTravel) return { dx, dy };
  const scale = maxTravel / magnitude;
  return { dx: dx * scale, dy: dy * scale };
}

/** Advance the velocity carried by a direct contact. New travel is blended
 * rather than copied, and missing samples decay instead of dropping to zero.
 * At the default decay the bridge has roughly a three-tick / 50ms half-life.
 * The helper is pure so input feel can be verified without a renderer. */
export function updateContactVelocity(
  vx: number,
  vy: number,
  sampleDx: number,
  sampleDy: number,
  hasSample: boolean,
): { vx: number; vy: number } {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    vx = 0;
    vy = 0;
  }
  if (!hasSample) {
    const nextX = vx * CONTACT_VELOCITY_DECAY;
    const nextY = vy * CONTACT_VELOCITY_DECAY;
    return {
      vx: Math.abs(nextX) < 1e-4 ? 0 : nextX,
      vy: Math.abs(nextY) < 1e-4 ? 0 : nextY,
    };
  }
  const sample = clampPointerTravel(
    sampleDx,
    sampleDy,
    MAX_CONTACT_TRAVEL_PER_TICK,
  );
  return {
    vx: vx + (sample.dx - vx) * CONTACT_VELOCITY_BLEND,
    vy: vy + (sample.dy - vy) * CONTACT_VELOCITY_BLEND,
  };
}
