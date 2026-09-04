import { describe, expect, it } from "vitest";
import { ClothSolver, type ClothConfig } from "./ClothSolver";
import { FABRICS, resolveFabric } from "./fabrics";

const CONFIG: ClothConfig = {
  cols: 8,
  rows: 8,
  spacing: 10,
  originX: 0,
  originY: 0,
  gravity: 0.35,
  iterations: 6,
};

function makeSolver(): ClothSolver {
  const solver = new ClothSolver(CONFIG, resolveFabric(FABRICS.myeongju));
  solver.selfCollisionEvery = 2;
  return solver;
}

function replay(solver: ClothSolver): Float32Array {
  solver.pinTopEdge();
  for (let tick = 0; tick < 36; tick++) {
    solver.applyWind(tick, 0.06);
    solver.step(1);
  }
  return new Float32Array(solver.pos);
}

describe("ClothSolver reset", () => {
  it("restores a deterministic replay boundary after forces and plasticity", () => {
    const used = makeSolver();
    used.pinTopEdge();
    used.bakeCrease("row", 3, 0.45);
    for (let tick = 0; tick < 18; tick++) {
      used.applyWind(tick + 80, 0.2);
      used.step(1);
    }
    // A queued force must not survive the reset either.
    used.addAcceleration(used.cols * 4 + 4, 20, -10, 30);
    used.reset();

    expect(replay(used)).toEqual(replay(makeSolver()));
  });
});
