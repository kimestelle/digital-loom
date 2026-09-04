import { describe, expect, it } from "vitest";
import {
  ClothSolver,
  FixedStepAccumulator,
  type ClothConfig,
} from "./ClothSolver";
import { FABRICS, resolveFabric, type ResolvedFabric } from "./fabrics";
import {
  CLOTH_INTERACTION_RADIUS,
  CLOTH_PLUCK_RADIUS,
  CLOTH_POINTER_PROFILES,
  MAX_CONTACT_TRAVEL_PER_TICK,
  MAX_MOUSE_FORCE,
  MAX_POINTER_TRAVEL_PER_TICK,
} from "./pointerInteraction";

const BASE_FABRIC = resolveFabric(FABRICS.myeongju);

function config(overrides: Partial<ClothConfig> = {}): ClothConfig {
  return {
    cols: 8,
    rows: 8,
    spacing: 10,
    originX: 0,
    originY: 0,
    gravity: 0.35,
    iterations: 6,
    ...overrides,
  };
}

function fabric(overrides: Partial<ResolvedFabric> = {}): ResolvedFabric {
  return { ...BASE_FABRIC, ...overrides };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function seededReplay(seed: number): Float32Array {
  const solver = new ClothSolver(config(), fabric());
  solver.pinTopEdge();
  solver.selfCollisionEvery = 2;
  const random = lcg(seed);

  for (let tick = 0; tick < 90; tick++) {
    solver.applyWind(tick, 0.035);
    for (let n = 0; n < 3; n++) {
      const i = 8 + Math.floor(random() * (solver.count - 8));
      solver.addAcceleration(
        i,
        (random() - 0.5) * 0.08,
        (random() - 0.5) * 0.04,
        (random() - 0.5) * 0.12,
      );
    }
    solver.step(1);
  }
  return new Float32Array(solver.pos);
}

describe("FixedStepAccumulator", () => {
  it("advances the same number of simulation ticks at 30, 60, and 120 fps", () => {
    const run = (frames: number, frameSeconds: number) => {
      const clock = new FixedStepAccumulator();
      let ticks = 0;
      for (let i = 0; i < frames; i++) {
        clock.advance(frameSeconds, () => ticks++);
      }
      return ticks;
    };

    expect(run(30, 1 / 30)).toBe(60);
    expect(run(60, 1 / 60)).toBe(60);
    expect(run(120, 1 / 120)).toBe(60);
  });

  it("produces the same cloth state across render frame rates", () => {
    const run = (frames: number, frameSeconds: number) => {
      const clock = new FixedStepAccumulator();
      const solver = new ClothSolver(config({ cols: 6, rows: 6 }), fabric());
      solver.pinTopEdge();
      solver.selfCollisionEvery = 2;
      let tick = 0;
      for (let frame = 0; frame < frames; frame++) {
        clock.advance(frameSeconds, () => {
          tick++;
          solver.applyWind(tick, 0.035);
          solver.step(1);
        });
      }
      return new Float32Array(solver.pos);
    };

    const at30 = run(30, 1 / 30);
    expect(run(60, 1 / 60)).toEqual(at30);
    expect(run(120, 1 / 120)).toEqual(at30);
  });

  it("bounds catch-up work and drops hidden-tab debt", () => {
    const clock = new FixedStepAccumulator({ maxSubSteps: 4 });
    let ticks = 0;
    expect(clock.advance(5, () => ticks++)).toBe(4);
    expect(ticks).toBe(4);
    expect(clock.advance(1 / 120, () => ticks++)).toBe(0);
    expect(ticks).toBe(4);
    clock.reset();
    expect(clock.advance(1 / 60, () => ticks++)).toBe(1);
  });
});

describe("ClothSolver XPBD invariants", () => {
  it("never moves pinned particles under gravity, wind, or direct force", () => {
    const solver = new ClothSolver(config(), fabric());
    solver.pinTopEdge();
    const pinnedBefore = new Float32Array(solver.pos.slice(0, solver.cols * 3));

    for (let tick = 0; tick < 30; tick++) {
      solver.applyWind(tick, 0.08);
      for (let i = 0; i < solver.cols; i++) {
        solver.addAcceleration(i, 10, 10, 10);
      }
      solver.step(1);
    }

    expect(solver.pos.slice(0, solver.cols * 3)).toEqual(pinnedBefore);
    expect(solver.prev.slice(0, solver.cols * 3)).toEqual(pinnedBefore);
  });

  it("keeps a compliant distance constraint invariant across iteration counts", () => {
    const solve = (iterations: number, dt: number) => {
      const solver = new ClothSolver(
        config({ cols: 2, rows: 1, gravity: 0, iterations }),
        fabric({ damping: 0, weftStiffness: 0 }),
      );
      solver.selfCollisionEvery = 0;
      solver.setPinned(0, true);
      solver.pos[3] = 15;
      solver.prev[3] = 15;
      solver.step(dt);
      return solver.pos[3];
    };

    expect(solve(1, 1)).toBeCloseTo(solve(8, 1), 5);
    // XPBD scales compliance by dt². For the same starting violation, a
    // shorter step has a larger alpha-tilde and therefore corrects less.
    expect(solve(1, 0.5)).toBeGreaterThan(solve(1, 1));
  });

  it("keeps the public stiffness dial monotonic", () => {
    const solve = (stiffness: number) => {
      const solver = new ClothSolver(
        config({ cols: 2, rows: 1, gravity: 0, iterations: 6 }),
        fabric({ damping: 0, weftStiffness: stiffness }),
      );
      solver.selfCollisionEvery = 0;
      solver.setPinned(0, true);
      solver.pos[3] = 15;
      solver.prev[3] = 15;
      solver.step(1);
      return Math.abs(solver.pos[3] - 10);
    };

    expect(solve(0)).toBeGreaterThan(solve(0.5));
    expect(solve(0.5)).toBeGreaterThan(solve(1));
    expect(solve(1)).toBeCloseTo(0, 6);
  });

  it("keeps all state finite during a seeded wind-and-force replay", () => {
    const state = seededReplay(0x5eed1234);
    for (const value of state) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(1_000_000);
    }
  });

  it("replays the same seeded force sequence exactly", () => {
    expect(seededReplay(0xc0ffee)).toEqual(seededReplay(0xc0ffee));
  });

  it("stays finite under sustained strong touch pressure, swipes, and plucks", () => {
    const solver = new ClothSolver(config(), fabric());
    solver.pinTopEdge();
    solver.selfCollisionEvery = 1;
    const touch = CLOTH_POINTER_PROFILES.touch;

    for (let tick = 0; tick < 180; tick++) {
      solver.applyContactField(
        35,
        35,
        CLOTH_INTERACTION_RADIUS,
        tick % 2 === 0
          ? MAX_CONTACT_TRAVEL_PER_TICK
          : -MAX_CONTACT_TRAVEL_PER_TICK,
        MAX_CONTACT_TRAVEL_PER_TICK * 0.35,
        touch.pressureStrength,
        touch.dragStrength,
      );
      if (tick % 30 === 0) {
        solver.applyPluck(
          35,
          35,
          CLOTH_PLUCK_RADIUS,
          touch.pluckStrength,
        );
      }
      solver.step(1);
    }

    for (const value of solver.pos) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(1_000_000);
    }
  });

  it("stays finite at the maximum tuneable mouse force", () => {
    const solver = new ClothSolver(config(), fabric());
    solver.pinTopEdge();
    solver.selfCollisionEvery = 1;
    const mouse = CLOTH_POINTER_PROFILES.mouse;
    const pinnedBefore = new Float32Array(solver.pos.slice(0, solver.cols * 3));

    for (let tick = 0; tick < 180; tick++) {
      solver.applyDrag(
        35,
        35,
        tick % 2 === 0
          ? MAX_POINTER_TRAVEL_PER_TICK
          : -MAX_POINTER_TRAVEL_PER_TICK,
        MAX_POINTER_TRAVEL_PER_TICK * 0.25,
        CLOTH_INTERACTION_RADIUS,
        mouse.dragStrength * MAX_MOUSE_FORCE,
      );
      solver.applyCursor(
        35,
        35,
        CLOTH_INTERACTION_RADIUS,
        mouse.pressureStrength * MAX_MOUSE_FORCE,
      );
      solver.step(1);
    }

    expect(solver.pos.slice(0, solver.cols * 3)).toEqual(pinnedBefore);
    for (const value of solver.pos) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(1_000_000);
    }
  });

  it("moves a direct-contact patch while keeping pinned particles fixed", () => {
    const solver = new ClothSolver(
      config({ cols: 4, rows: 4, gravity: 0, iterations: 2 }),
      fabric(),
    );
    solver.pinTopEdge();
    solver.selfCollisionEvery = 0;
    const pinnedBefore = new Float32Array(solver.pos.slice(0, solver.cols * 3));
    const moving = 10;
    const zBefore = solver.pos[moving * 3 + 2];

    solver.applyContactField(
      solver.pos[moving * 3],
      solver.pos[moving * 3 + 1],
      CLOTH_INTERACTION_RADIUS,
      8,
      0,
      CLOTH_POINTER_PROFILES.touch.pressureStrength,
      CLOTH_POINTER_PROFILES.touch.dragStrength,
    );
    solver.step(1);

    expect(solver.pos.slice(0, solver.cols * 3)).toEqual(pinnedBefore);
    expect(solver.pos[moving * 3 + 2]).toBeLessThan(zBefore);
  });

  it("rejects invalid timesteps before they can poison the state", () => {
    const solver = new ClothSolver(config(), fabric());
    expect(() => solver.step(0)).toThrow(/dt must be positive and finite/);
    expect(() => solver.step(Number.NaN)).toThrow(
      /dt must be positive and finite/,
    );
  });
});

describe("ClothSolver self-collision", () => {
  it("separates a non-neighbour particle pair to the requested thickness", () => {
    const solver = new ClothSolver(
      config({ cols: 4, rows: 4, gravity: 0 }),
      fabric({ damping: 0 }),
    );
    const a = 0;
    const b = 15; // grid distance (3,3): deliberately not constraint-neighbours
    solver.pos.set([0, 0, 0], a * 3);
    solver.pos.set([1, 0, 0], b * 3);

    solver.selfCollide(5);

    const dx = solver.pos[b * 3] - solver.pos[a * 3];
    const dy = solver.pos[b * 3 + 1] - solver.pos[a * 3 + 1];
    const dz = solver.pos[b * 3 + 2] - solver.pos[a * 3 + 2];
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(5, 5);
  });

  it("keeps earlier corrections when one particle has multiple contacts", () => {
    const solver = new ClothSolver(
      config({ cols: 4, rows: 4, gravity: 0 }),
      fabric({ damping: 0 }),
    );
    const moving = 0;
    const fixedX = 11;
    const fixedY = 15;
    solver.pos.set([0, 0, 0], moving * 3);
    solver.pos.set([1, 0, 0], fixedX * 3);
    solver.pos.set([0, 1, 0], fixedY * 3);
    solver.setPinned(fixedX, true);
    solver.setPinned(fixedY, true);

    solver.selfCollide(5);

    const distance = (a: number, b: number) => {
      const ai = a * 3;
      const bi = b * 3;
      return Math.hypot(
        solver.pos[bi] - solver.pos[ai],
        solver.pos[bi + 1] - solver.pos[ai + 1],
        solver.pos[bi + 2] - solver.pos[ai + 2],
      );
    };
    expect(distance(moving, fixedX)).toBeGreaterThanOrEqual(5 - 1e-5);
    expect(distance(moving, fixedY)).toBeGreaterThanOrEqual(5 - 1e-5);
  });

  it("uses distinct safe-number keys for adjacent in-range 3D cells", () => {
    const solver = new ClothSolver(config(), fabric());
    const keyFor = (
      solver as unknown as {
        collisionCellKey: (x: number, y: number, z: number) => number | string;
      }
    ).collisionCellKey.bind(solver);
    const keys = [-3, -2, -1, 0, 1, 2, 3].map((z) => keyFor(0, 0, z));

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(typeof key).toBe("number");
      expect(Number.isSafeInteger(key)).toBe(true);
    }
    expect(typeof keyFor(70_000, 0, 0)).toBe("string");
  });
});
