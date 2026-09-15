# Room performance

The small-screen preview enlarges texture repeats by 1.5× at the room's 820px
breakpoint. It divides rendered UV repeats by 1.5; authored values, undo, saves,
and exports do not change. Both cloth and mesh previews use the same factor.
The pattern controls explain the distinction.

## Costs and retained changes

- The default 48×48 solver has 2,304 particles and 13,346 constraints. Six
  iterations mean about 80,000 distance projections per tick. Room instances
  use square-root distances for finite Float32 positions; `/sky` retains
  `Math.hypot`. Zero-distance and nonfinite fallbacks remain intact. No stiffness,
  timestep, force, mesh-density or collision-frequency changes.
- Covered cloth uses opaque depth rendering after its reveal. Sheer materials
  and unfinished fades retain the existing two-sided transparent path. The live
  default scene dropped from roughly 9k to 5k submitted triangles and one fewer
  draw. This is not a claim that every pixel was previously shaded twice.
- POM's sun-shadow march is skipped when direct light is zero. View parallax and
  ambient weave remain. The room shader omits its always-zero fog calculation.
- Inactive cabinet faces, closed environment controls, and offscreen/clipped
  live pixels pause without losing state. The frame meter owns its own updates
  instead of rerendering the whole page twice a second.
- The daylight controller skips unchanged CSS values. Changing projections still
  use their existing precision and cadence. Bloom, textures and light transitions
  are unchanged; the sunlight system already uses adjacent baked frames.

Fragment resolution, POM quality, touch response and bloom were not reduced.

## Measurements

Local September 2026 runs against `1054e3d`, 48×48, six iterations, full
self-collision, three paired samples. These are **desktop solver timings**, not
iPhone FPS. Other machine activity affects absolute timings.

| Engine | Baseline median / tick | Room median / tick |
| --- | ---: | ---: |
| Node / V8 | 37.25 ms | 28.16 ms |
| WebKit 26.5 / JavaScriptCore | 12.97 ms | 11.22 ms |

All three WebKit pairs improved, by 5.5–32.5%; the ratio of medians is a more
conservative 13.5% reduction. The 120-tick WebKit replay retained identical
particle positions and previous positions; the maximum internal constraint
difference was 7.77e-15. Stress tests also cover folds, maximum mouse force,
pinning, reset, material changes and timestep changes with a 0.001-world-unit
bound. The default solver path remains exactly equal to the baseline replay.

```sh
node scripts/benchmark-cloth-solver.mjs 1054e3d
node scripts/benchmark-cloth-solver-browser.mjs webkit 1054e3d
PLAYWRIGHT_BASE_URL=http://localhost:3003 npx playwright test e2e/room-performance.spec.ts --project=mobile-webkit
```

The WebKit UI test uses an iPhone viewport, real material maps, 2× fragment
resolution and native taps. Its smaller simulation isolates rendering contracts;
it is not a full-load performance benchmark. `data-renderer-backend` on
`.cloth-scene` records whether the actual renderer chose WebGPU or WebGL2.

The hi-resolution contract runs only in the WebKit project. An additional
headless Chromium run did not complete within four minutes on this host; it is
not a passing result. Existing Chromium desktop/touch journeys retain their
own rendering budgets. The native WebGPU preview was checked separately, but
that does not substitute for a passing automated high-resolution Chromium run.

## Next measurement

Use a production build on the affected iPhone. Fix the material, morning light,
quality and collision settings; warm the maps, then compare idle and sustained
touch. Record FPS, simulation time, available GPU time, browser/backend and how
they change after several minutes. A resized desktop browser does not reproduce
phone GPU limits or thermal throttling.

The next CPU target is self-collision's spatial hash: up to 27 neighboring-cell
lookups per particle per collision step. A typed-array broad phase can reduce
Map overhead, but must preserve contact traversal and fold separation. A worker
could free the UI thread; moving the same work does not itself reduce its cost.
Profile bloom rasterization before changing it—static filtered plates are not
proof of a repeated full-screen blur.
