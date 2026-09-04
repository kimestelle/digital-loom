import { describe, expect, it } from "vitest";
import {
  clampPointerTravel,
  CONTACT_VELOCITY_DECAY,
  CLOTH_POINTER_PROFILES,
  DEFAULT_MOUSE_FORCE,
  MAX_CONTACT_TRAVEL_PER_TICK,
  MAX_MOUSE_FORCE,
  MAX_POINTER_TRAVEL_PER_TICK,
  normalizeClothPointerKind,
  resolveMouseForce,
  updateContactVelocity,
} from "./pointerInteraction";

describe("cloth pointer interaction", () => {
  it("makes continuous mouse hover materially stronger without returning to the unstable legacy force", () => {
    const effectivePressure =
      CLOTH_POINTER_PROFILES.mouse.pressureStrength *
      resolveMouseForce(DEFAULT_MOUSE_FORCE);
    expect(effectivePressure).toBeGreaterThan(
      CLOTH_POINTER_PROFILES.touch.pressureStrength,
    );
    expect(
      CLOTH_POINTER_PROFILES.mouse.pressureStrength * MAX_MOUSE_FORCE,
    ).toBeLessThan(1.2);
  });

  it("gives mouse clicks a tuneable local gust", () => {
    expect(CLOTH_POINTER_PROFILES.mouse.pluckStrength).toBeGreaterThan(0);
    expect(
      CLOTH_POINTER_PROFILES.mouse.pluckStrength * MAX_MOUSE_FORCE,
    ).toBeLessThanOrEqual(1.2);
  });

  it("clamps the tuneable mouse-force multiplier to its stable range", () => {
    expect(resolveMouseForce()).toBe(DEFAULT_MOUSE_FORCE);
    expect(resolveMouseForce(-4)).toBe(0);
    expect(resolveMouseForce(99)).toBe(MAX_MOUSE_FORCE);
    expect(resolveMouseForce(Number.NaN)).toBe(DEFAULT_MOUSE_FORCE);
  });

  it("gives direct touch stronger sustained pressure and drag", () => {
    expect(CLOTH_POINTER_PROFILES.touch.pressureStrength).toBeGreaterThan(
      CLOTH_POINTER_PROFILES.mouse.pressureStrength,
    );
    expect(CLOTH_POINTER_PROFILES.touch.dragStrength).toBeGreaterThan(
      CLOTH_POINTER_PROFILES.mouse.dragStrength,
    );
    expect(CLOTH_POINTER_PROFILES.touch.pluckStrength).toBeLessThan(0.2);
  });

  it("caps one tick of pointer travel without changing its direction", () => {
    const clamped = clampPointerTravel(300, 400);
    expect(Math.hypot(clamped.dx, clamped.dy)).toBeCloseTo(
      MAX_POINTER_TRAVEL_PER_TICK,
    );
    expect(clamped.dx / clamped.dy).toBeCloseTo(300 / 400);
    expect(clampPointerTravel(3, 4)).toEqual({ dx: 3, dy: 4 });
    expect(clampPointerTravel(Number.NaN, 4)).toEqual({ dx: 0, dy: 0 });
  });

  it("normalizes unknown pointer types to the mouse profile", () => {
    expect(normalizeClothPointerKind("touch")).toBe("touch");
    expect(normalizeClothPointerKind("pen")).toBe("pen");
    expect(normalizeClothPointerKind("")).toBe("mouse");
  });

  it("filters sparse direct-contact travel and decays it instead of dropping it", () => {
    const first = updateContactVelocity(0, 0, 30, 40, true);
    expect(Math.hypot(first.vx, first.vy)).toBeCloseTo(
      MAX_CONTACT_TRAVEL_PER_TICK * 0.45,
    );
    const held = updateContactVelocity(
      first.vx,
      first.vy,
      0,
      0,
      false,
    );
    expect(held.vx).toBeCloseTo(first.vx * CONTACT_VELOCITY_DECAY);
    expect(held.vy).toBeCloseTo(first.vy * CONTACT_VELOCITY_DECAY);
    expect(Math.hypot(held.vx, held.vy)).toBeGreaterThan(0);
  });

  it("recovers the direct-contact filter from invalid samples", () => {
    expect(updateContactVelocity(Number.NaN, 4, Number.NaN, 2, true)).toEqual({
      vx: 0,
      vy: 0,
    });
  });
});
