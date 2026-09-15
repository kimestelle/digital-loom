import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ClothSolver, finitePositionDistance, type ClothConfig } from "./ClothSolver";
import { FABRICS, resolveFabric } from "./fabrics";
import {
  CLOTH_INTERACTION_RADIUS, CLOTH_PLUCK_RADIUS, CLOTH_POINTER_PROFILES,
  MAX_CONTACT_TRAVEL_PER_TICK, MAX_MOUSE_FORCE, MAX_POINTER_TRAVEL_PER_TICK,
} from "./pointerInteraction";

const fabric = resolveFabric(FABRICS.myeongju);

interface ProjectionState {
  constraints: {
    a: number;
    b: number;
    type: number;
    restLength: number;
    lambda: number;
  }[];
  invMass: Float32Array;
  complianceFor: (type: number) => number;
  projectConstraints: () => void;
}

/** Preserve the previous projection as a regression oracle. The default length
 * path must stay exact; forces, collisions, and plasticity use the real solver. */
function installPreviousProjection(solver: ClothSolver): void {
  const state = solver as unknown as ProjectionState;
  let dtSq = 1;
  const step = solver.step.bind(solver);
  solver.step = (dt = 1) => {
    dtSq = dt * dt;
    step(dt);
  };
  state.projectConstraints = () => {
    const cs = state.constraints;
    for (let n = 0; n < cs.length; n++) {
      const con = cs[n];
      const a = con.a, b = con.b;
      const wA = state.invMass[a], wB = state.invMass[b];
      const wSum = wA + wB;
      if (wSum === 0) continue;

      const ax = a * 3, bx = b * 3;
      let dx = solver.pos[bx] - solver.pos[ax];
      let dy = solver.pos[bx + 1] - solver.pos[ax + 1];
      let dz = solver.pos[bx + 2] - solver.pos[ax + 2];
      const len = Math.hypot(dx, dy, dz) || 1e-6;

      const alphaTilde = state.complianceFor(con.type) / dtSq;
      const C = len - con.restLength;
      const deltaLambda =
        (-C - alphaTilde * con.lambda) / (wSum + alphaTilde);
      con.lambda += deltaLambda;
      const diff = -deltaLambda / len;
      dx *= diff; dy *= diff; dz *= diff;
      solver.pos[ax]     += dx * wA;
      solver.pos[ax + 1] += dy * wA;
      solver.pos[ax + 2] += dz * wA;
      solver.pos[bx]     -= dx * wB;
      solver.pos[bx + 1] -= dy * wB;
      solver.pos[bx + 2] -= dz * wB;
    }
  };
}

function makeSolver(cols: number, rows: number, previous = false, fast = false): ClothSolver {
  const config: ClothConfig = {
    cols, rows, spacing: 9, originX: 0, originY: 0,
    gravity: 0.4, iterations: 6, fastConstraintDistances: fast,
  };
  const solver = new ClothSolver(config, fabric);
  solver.pinTopEdge();
  if (previous) installPreviousProjection(solver);
  return solver;
}

describe("ClothSolver constraint distance", () => {
  it("keeps the default path exact through changing physical state", () => {
    const current = makeSolver(12, 10);
    const previous = makeSolver(12, 10, true);

    for (let tick = 0; tick < 96; tick++) {
      for (const solver of [current, previous]) {
        if (tick === 16) solver.setFabric({
          ...fabric, warpStiffness: 0.73, weftStiffness: 0.29,
          shearStiffness: 0.43, bendStiffness: 0.17,
          particleMass: fabric.particleMass * 1.7,
        });
        if (tick === 28) solver.setPinned(4, false);
        if (tick === 36) solver.bakeCrease("row", 4, 0.35);
        if (tick === 48) solver.setIterations(3);
        if (tick === 60) solver.setFabric(fabric);
        if (tick === 72) {
          solver.reset();
          solver.pinTopEdge();
          solver.setIterations(9);
        }
        solver.applyWind(tick, 0.06);
        solver.applyContactField(48, 54, 42, 0.8, -0.35, 0.2, 0.12);
        solver.step([1, 0.5, 0.75, 1.25][tick % 4]);
      }
      assert.deepEqual(current.pos, previous.pos);
      assert.deepEqual(current.prev, previous.prev);
      assert.deepEqual((current as unknown as ProjectionState).constraints,
        (previous as unknown as ProjectionState).constraints,
      );
    }
  });

  it("keeps the room distance path within tolerance under folds and maximum pointer forces", () => {
    const previous = makeSolver(12, 10, true);
    const fast = makeSolver(12, 10, false, true);
    let maxPositionError = 0;
    let maxConstraintError = 0;
    const pinned = previous.pos.slice(0, previous.cols * 3);
    for (let tick = 0; tick < 144; tick++) {
      for (const solver of [previous, fast]) {
        if (tick === 24) {
          // A doubled lower half produces actual non-neighbour contacts.
          for (let r = 5; r < solver.rows; r++) {
            for (let c = 0; c < solver.cols; c++) {
              const i = (r * solver.cols + c) * 3;
              solver.pos[i + 1] = (9 - r) * 9;
              solver.pos[i + 2] = 2;
            }
          }
          solver.prev.set(solver.pos);
          solver.bakeCrease("row", 4, 0.35);
        }
        if (tick === 48) solver.setFabric({
          ...fabric, warpStiffness: 0.61, weftStiffness: 0.37,
          shearStiffness: 0.29, bendStiffness: 0.13,
          particleMass: fabric.particleMass * 1.5,
        });
        if (tick === 96) {
          solver.reset();
          solver.pinTopEdge();
          solver.setFabric(fabric);
          solver.setIterations(9);
        }
        solver.applyWind(tick, 0.12);
        if (tick < 72) {
          const mouse = CLOTH_POINTER_PROFILES.mouse;
          solver.applyCursor(48, 54, CLOTH_INTERACTION_RADIUS,
            mouse.pressureStrength * MAX_MOUSE_FORCE);
          solver.applyDrag(48, 54,
            (tick % 2 ? -1 : 1) * MAX_POINTER_TRAVEL_PER_TICK,
            MAX_POINTER_TRAVEL_PER_TICK * 0.25, CLOTH_INTERACTION_RADIUS,
            mouse.dragStrength * MAX_MOUSE_FORCE);
        } else {
          const touch = CLOTH_POINTER_PROFILES.touch;
          solver.applyContactField(48, 54, CLOTH_INTERACTION_RADIUS,
            (tick % 2 ? -1 : 1) * MAX_CONTACT_TRAVEL_PER_TICK,
            MAX_CONTACT_TRAVEL_PER_TICK * 0.35,
            touch.pressureStrength, touch.dragStrength);
          if (tick % 24 === 0) solver.applyPluck(48, 54, CLOTH_PLUCK_RADIUS,
            touch.pluckStrength);
        }
        solver.step([1, 0.5, 0.75, 1.25][tick % 4]);
        assert.deepEqual(solver.pos.slice(0, solver.cols * 3), pinned);
      }
      for (const field of ["pos", "prev"] as const) {
        for (let i = 0; i < fast[field].length; i++) {
          assert(Number.isFinite(fast[field][i]));
          maxPositionError = Math.max(maxPositionError,
            Math.abs(previous[field][i] - fast[field][i]));
        }
      }
      const a = (previous as unknown as ProjectionState).constraints;
      const b = (fast as unknown as ProjectionState).constraints;
      for (let i = 0; i < a.length; i++) {
        for (const field of ["lambda", "restLength"] as const) {
          maxConstraintError = Math.max(maxConstraintError,
            Math.abs(a[i][field] - b[i][field]));
        }
      }
    }
    // 0.001 world units is 1/9000 of one mesh cell. The stricter hidden-state
    // bound also catches drift before it becomes visible in Float32 positions.
    assert(maxPositionError <= 0.001, `position error: ${maxPositionError}`);
    assert(maxConstraintError <= 0.001, `constraint error: ${maxConstraintError}`);
  });

  it("preserves the finite Float32 range, zero, and hypot's nonfinite behavior", () => {
    const max = 3.4028234663852886e38;
    const min = 1.401298464324817e-45;
    for (const [x, y, z] of [
      [0, 0, 0], [2 * max, -2 * max, max], [min, -min, min],
      [Infinity, NaN, 0], [-Infinity, 1, 0], [NaN, 1, 0],
    ]) {
      const expected = Math.hypot(x, y, z);
      const actual = finitePositionDistance(x, y, z);
      if (!Number.isFinite(expected) || expected === 0) {
        assert(Object.is(actual, expected));
      } else {
        assert(Number.isFinite(actual));
        assert(Math.abs(actual / expected - 1) <= Number.EPSILON * 4);
      }
    }
  });
});
