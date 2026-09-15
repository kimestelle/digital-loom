// Bounded CPU comparison against a git revision, without the test runner.
// Usage: node scripts/benchmark-cloth-solver.mjs [baseline-revision]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const solverPath = "lib/cloth/ClothSolver.ts";
const baselineRevision = process.argv[2] ?? "HEAD";
const previousSource = execFileSync(
  "git", ["show", `${baselineRevision}:${solverPath}`],
  { cwd: root, encoding: "utf8" },
);
const currentSource = readFileSync(path.join(root, solverPath), "utf8");

// The solver's source imports only local pure simulation modules. Give each
// version its own module cache so both real classes keep normal method calls.
function loadSimulation(source) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const moduleRecord = { exports: {} };
    cache.set(file, moduleRecord);
    const text = file === path.join(root, solverPath)
      ? source : readFileSync(file, "utf8");
    const compiled = ts.transpileModule(text, { compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const requireLocal = (name) => {
      if (!name.startsWith(".")) throw new Error(`Unexpected import: ${name}`);
      return load(path.resolve(path.dirname(file), `${name}.ts`));
    };
    new Function("require", "module", "exports", compiled)(
      requireLocal, moduleRecord, moduleRecord.exports,
    );
    return moduleRecord.exports;
  }
  return {
    ...load(path.join(root, solverPath)),
    ...load(path.join(root, "lib/cloth/fabrics.ts")),
  };
}

const versions = [previousSource, currentSource, currentSource].map(loadSimulation);
const names = ["previous", "default", "room-fast"];
function makeSolver(version, collision, size = 48) {
  const simulation = versions[version];
  const solver = new simulation.ClothSolver({
    cols: size, rows: size, spacing: 9, originX: 0, originY: 0,
    gravity: 0.4, iterations: 6,
    fastConstraintDistances: version === 2,
  }, simulation.resolveFabric(simulation.FABRICS.myeongju));
  solver.pinTopEdge();
  solver.selfCollisionEvery = collision;
  return solver;
}

const replay = [0, 1, 2].map((version) => makeSolver(version, 1, 12));
const comparison = [1, 2].map(() => ({
  differingValues: 0, maxDelta: 0, differingHiddenValues: 0, maxHiddenDelta: 0,
}));
for (let tick = 0; tick < 120; tick++) {
  for (const solver of replay) {
    solver.applyWind(tick, 0.06);
    solver.applyContactField(48, 54, 42, 0.8, -0.35, 0.2, 0.12);
    solver.step([1, 0.5, 0.75, 1.25][tick % 4]);
  }
  for (let version = 1; version <= 2; version++) {
    for (let i = 0; i < replay[0].pos.length; i++) {
      const a = replay[0].pos[i], b = replay[version].pos[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error("Non-finite replay state");
      }
      if (a !== b) comparison[version - 1].differingValues++;
      comparison[version - 1].maxDelta = Math.max(
        comparison[version - 1].maxDelta, Math.abs(a - b),
      );
    }
    for (let i = 0; i < replay[0].constraints.length; i++) {
      for (const field of ["lambda", "restLength"]) {
        const a = replay[0].constraints[i][field];
        const b = replay[version].constraints[i][field];
        if (a !== b) comparison[version - 1].differingHiddenValues++;
        comparison[version - 1].maxHiddenDelta = Math.max(
          comparison[version - 1].maxHiddenDelta, Math.abs(a - b),
        );
      }
    }
  }
}
console.log(JSON.stringify({ baselineRevision, replayTicks: 120, comparison }));
if (comparison[0].differingValues !== 0 || comparison[0].differingHiddenValues !== 0) {
  throw new Error("Default distance path changed trajectory");
}

const median = (values) => [...values].sort((a, b) => a - b)[1];
for (const collision of [1]) {
  const timings = [[], [], []];
  for (let round = 0; round < 3; round++) {
    for (let index = 0; index < 2; index++) {
      const version = [0, 2][(index + round) % 2];
      const solver = makeSolver(version, collision);
      for (let tick = 0; tick < 16; tick++) {
        solver.applyWind(tick, 0.06);
        solver.step(1);
      }
      const start = performance.now();
      for (let tick = 16; tick < 48; tick++) {
        solver.applyWind(tick, 0.06);
        solver.step(1);
      }
      timings[version].push((performance.now() - start) / 32);
    }
  }
  console.log(JSON.stringify({
    mesh: "48x48", iterations: 6, selfCollisionEvery: collision,
    samples: 3, ticksPerSample: 32,
    results: [0, 2].map((index) => ({
      name: names[index], medianMs: median(timings[index]),
    })),
  }));
}
