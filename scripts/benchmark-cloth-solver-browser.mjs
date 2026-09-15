// Pure solver timings in the selected browser engine; no app or WebGL scene.
// Usage: node scripts/benchmark-cloth-solver-browser.mjs [webkit|chromium] [baseline-revision]
// Add --prepare-only to validate the bundles without launching a browser.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright";
import ts from "typescript";

const args = process.argv.slice(2).filter((arg) => arg !== "--prepare-only");
const browserName = args[0] ?? "webkit";
const baselineRevision = args[1] ?? "HEAD";
const browserType = { webkit, chromium }[browserName];
if (!browserType) throw new Error("Browser must be webkit or chromium");
const root = path.resolve(import.meta.dirname, "..");
const solverPath = "lib/cloth/ClothSolver.ts";
const fabricPath = "lib/cloth/fabrics.ts";
const baselineCommit = execFileSync("git", ["rev-parse", baselineRevision], {
  cwd: root, encoding: "utf8",
}).trim();
const previousSource = execFileSync("git", ["show", `${baselineCommit}:${solverPath}`], {
  cwd: root, encoding: "utf8",
});
const currentSource = readFileSync(path.join(root, solverPath), "utf8");

// Resolve/transpile only local simulation dependencies before launching the
// browser. All versions use current fabric data; only solver source varies.
function bundleSimulation(solverSource) {
  const modules = {};
  function visit(file) {
    if (modules[file]) return;
    const source = file === solverPath
      ? solverSource : readFileSync(path.join(root, file), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const dependencies = {};
    modules[file] = { code, dependencies };
    for (const match of code.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
      const name = match[2];
      if (!name.startsWith(".")) throw new Error(`Nonlocal import: ${name}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), `${name}.ts`));
      if (dependency.startsWith("../")) throw new Error("Import outside project");
      dependencies[name] = dependency;
      visit(dependency);
    }
  }
  visit(solverPath);
  visit(fabricPath);
  return modules;
}

const bundles = [previousSource, currentSource, currentSource].map(bundleSimulation);
if (process.argv.includes("--prepare-only")) {
  console.log(JSON.stringify({
    prepared: true, browserName, baselineCommit,
    moduleCounts: bundles.map((bundle) => Object.keys(bundle).length),
    browserLaunched: false,
  }));
  process.exit(0);
}

const browser = await browserType.launch({ headless: true });
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  void browser.close();
}, 60_000);
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const metadata = await page.evaluate(({ bundles, solverPath, fabricPath }) => {
    function loadSimulation(modules) {
      const cache = new Map();
      function load(file) {
        if (cache.has(file)) return cache.get(file).exports;
        const entry = modules[file];
        if (!entry) throw new Error(`Missing bundled module: ${file}`);
        const moduleRecord = { exports: {} };
        cache.set(file, moduleRecord);
        const requireLocal = (name) => load(entry.dependencies[name]);
        new Function("require", "module", "exports", entry.code)(
          requireLocal, moduleRecord, moduleRecord.exports,
        );
        return moduleRecord.exports;
      }
      return { ...load(solverPath), ...load(fabricPath) };
    }
    const versions = bundles.map(loadSimulation);
    const names = ["previous", "default", "room-fast"];
    function makeSolver(version, size = 48) {
      const simulation = versions[version];
      const solver = new simulation.ClothSolver({
        cols: size, rows: size, spacing: 9, originX: 0, originY: 0,
        gravity: 0.4, iterations: 6, fastConstraintDistances: version === 2,
      }, simulation.resolveFabric(simulation.FABRICS.myeongju));
      solver.pinTopEdge();
      solver.selfCollisionEvery = 1;
      return solver;
    }
    globalThis.__clothSolverBenchmark = { versions, names, makeSolver };
    return { userAgent: navigator.userAgent, url: location.href };
  }, { bundles, solverPath, fabricPath });
  console.log(JSON.stringify({
    browserName, browserVersion: browser.version(), baselineCommit, ...metadata,
    scope: "Desktop browser engine, isolated pure CPU solver; not iPhone FPS",
  }));

  const replay = await page.evaluate(() => {
    const { versions, names, makeSolver } = globalThis.__clothSolverBenchmark;
    const solvers = [0, 1, 2].map((version) => makeSolver(version, 12));
    const comparisons = [1, 2].map((version) => ({
      name: names[version], differingStateValues: 0, maxStateError: 0,
      differingHiddenValues: 0, maxHiddenError: 0,
    }));
    for (let tick = 0; tick < 120; tick++) {
      for (let version = 0; version < 3; version++) {
        const solver = solvers[version];
        if (tick === 24) {
          for (let r = 6; r < 12; r++) {
            for (let c = 0; c < 12; c++) {
              const i = (r * 12 + c) * 3;
              solver.pos[i + 1] = (11 - r) * 9;
              solver.pos[i + 2] = 2;
            }
          }
          solver.prev.set(solver.pos);
          solver.bakeCrease("row", 5, 0.35);
        }
        if (tick === 36) solver.setPinned(4, false);
        if (tick === 48) {
          const simulation = versions[version];
          const fabric = simulation.resolveFabric(simulation.FABRICS.myeongju);
          solver.setFabric({ ...fabric, warpStiffness: 0.61,
            weftStiffness: 0.37, bendStiffness: 0.13,
            particleMass: fabric.particleMass * 1.5 });
        }
        if (tick === 96) {
          solver.reset();
          solver.pinTopEdge();
          solver.setIterations(9);
        }
        solver.applyWind(tick, 0.06);
        solver.applyContactField(48, 54, 42, 0.8, -0.35, 0.2, 0.12);
        solver.step([1, 0.5, 0.75, 1.25][tick % 4]);
      }
      for (let version = 1; version <= 2; version++) {
        const result = comparisons[version - 1];
        for (const field of ["pos", "prev"]) {
          for (let i = 0; i < solvers[0][field].length; i++) {
            const a = solvers[0][field][i], b = solvers[version][field][i];
            if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Nonfinite replay state");
            if (a !== b) result.differingStateValues++;
            result.maxStateError = Math.max(result.maxStateError, Math.abs(a - b));
          }
        }
        for (let i = 0; i < solvers[0].constraints.length; i++) {
          for (const field of ["lambda", "restLength"]) {
            const a = solvers[0].constraints[i][field];
            const b = solvers[version].constraints[i][field];
            if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Nonfinite constraint state");
            if (a !== b) result.differingHiddenValues++;
            result.maxHiddenError = Math.max(result.maxHiddenError, Math.abs(a - b));
          }
        }
      }
    }
    if (comparisons[0].differingStateValues || comparisons[0].differingHiddenValues) {
      throw new Error(`Default trajectory changed: ${JSON.stringify(comparisons[0])}`);
    }
    if (comparisons[1].maxStateError > 0.001 || comparisons[1].maxHiddenError > 0.001) {
      throw new Error(`Room trajectory exceeded tolerance: ${JSON.stringify(comparisons[1])}`);
    }
    return { replayTicks: 120, stateToleranceWorldUnits: 0.001,
      hiddenStateTolerance: 0.001, comparisons };
  });
  console.log(JSON.stringify(replay));

  const pairedSamples = [];
  for (let round = 0; round < 3; round++) {
    const timings = {};
    // Each variant gets identical fresh state and warmup; alternate pair order.
    for (const version of round % 2 ? [2, 0] : [0, 2]) {
      timings[version] = await page.evaluate((version) => {
        const solver = globalThis.__clothSolverBenchmark.makeSolver(version);
        for (let tick = 0; tick < 32; tick++) {
          solver.applyWind(tick, 0.06);
          solver.step(1);
        }
        const start = performance.now();
        for (let tick = 32; tick < 64; tick++) {
          solver.applyWind(tick, 0.06);
          solver.step(1);
        }
        return (performance.now() - start) / 32;
      }, version);
    }
    const sample = {
      round: round + 1, previousMs: timings[0], roomFastMs: timings[2],
      reductionPercent: (1 - timings[2] / timings[0]) * 100,
    };
    pairedSamples.push(sample);
    console.log(JSON.stringify({ pairedSample: sample }));
  }
  const median = (values) => [...values].sort((a, b) => a - b)[1];
  const previousMs = median(pairedSamples.map((sample) => sample.previousMs));
  const roomFastMs = median(pairedSamples.map((sample) => sample.roomFastMs));
  console.log(JSON.stringify({
    browserName, mesh: "48x48", iterations: 6, selfCollisionEvery: 1,
    rounds: 3, warmupTicks: 32, measuredTicksPerSample: 32,
    previousMedianMs: previousMs, roomFastMedianMs: roomFastMs,
    reductionPercent: (1 - roomFastMs / previousMs) * 100,
    medianPairedReductionPercent: median(pairedSamples.map((sample) => sample.reductionPercent)),
  }));
} catch (error) {
  if (timedOut) throw new Error("Browser benchmark exceeded its 60-second bound", { cause: error });
  throw error;
} finally {
  clearTimeout(deadline);
  await browser.close();
}
