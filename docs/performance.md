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
- Narrow screens (≤820px), coarse hoverless devices (including landscape
  phones), and reduced-motion users get static selection pixels. They redraw
  on selection, resize, or visibility changes; the shared animation loop stops.
  Desktop animation resumes when the media conditions change. `/sky` keeps its
  separate original pixel implementation.
- The daylight controller skips unchanged CSS values. Changing projections still
  use their existing precision and cadence. Bloom, textures and light transitions
  are unchanged; the sunlight system already uses adjacent baked frames.

Fragment resolution, POM quality, touch response and bloom were not reduced.

## Cached room background

- The approved 100% bloom / 100% softness treatment now uses five display-ready
  PNG derivatives, including the original exposure and near/wide scatter. Both
  receivers reuse the selected image pair with `filter: none`. Custom bloom,
  softness, or neutral-tone settings retain the optical maps and live filter
  as a tuning fallback. A failed derivative also falls back to the original.
- The window's exact SVG bloom is rasterized once per measured geometry. The
  bitmap covers only the visible room plus a 54px scatter margin, capped at
  2 DPR / 2 million pixels. Its parent still follows daylight opacity. Resize
  rebuilds it; stale jobs and URLs are disposed. Loading/failure uses the SVG.
- On narrow or coarse/hoverless devices, the real wall/floor SVG (gradients,
  texture blends, masks and seams) becomes one viewport-sized canvas capped at
  1.5 DPR / 1.5 million pixels. It rebuilds on resize or an authored palette
  change, not autonomous daylight ticks. The original SVG stays measurable and
  returns immediately during resize or on cache failure.
- Time-of-day washes, the registered sunlight pair and the cloth shadow remain
  separate and live. Projection cropping still handles the perspective horizon;
  it is not safe to replace that with an unbounded transformed rectangle.

These changes remove active filter graphs/static surface blending; they do not
eliminate background compositing. No new WebGL context or cloth-quality change.
WebKit checks compare the rasterized substrate/window against their actual
source renderers, and browser tests exercise time changes, tuning, resize,
missing assets and stale loads. They are not measurements of iPhone FPS.

```sh
node scripts/bake-room-sunlight-display.mjs --verify-only
node scripts/verify-room-sunlight-display.mjs --browser webkit --base-url http://localhost:3003
node scripts/verify-room-surface-cache.mjs
PLAYWRIGHT_BASE_URL=http://localhost:3003 npx playwright test e2e/sunlight.spec.ts e2e/room-background.spec.ts --project=mobile-webkit
```

The source-space bake oracle uses its recorded Chromium renderer. WebKit's
isolated 0.35× filter sampling differs enough to fail that one-byte mean gate;
do not treat that synthetic comparison as pixel identity across engines. The
actual WebKit room comparison (real crops, transforms and blends) passed at
390×844 / 2 DPR and 1280×832 / 1 DPR, at morning and mid-interval. Mean RGB byte
errors were below 0.03/255; sparse desktop edge pixels differed by up to 32/255.

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

The GPU meter uses actual render-pass timestamp queries when supported, but
excludes the DOM/SVG room and browser compositing. The simulation meter covers
the solver and nearby geometry/texture work, not the entire main thread. CPU
and GPU timings overlap; adding them does not give total frame time. To isolate
the bottleneck on-device, briefly bypass simulation while keeping rendering
active, then separately bypass POM at the same fragment resolution. Compare
FPS and both timings; these are diagnostic experiments, not quality defaults.

The next CPU target is self-collision's spatial hash: up to 27 neighboring-cell
lookups per particle per collision step. A typed-array broad phase can reduce
Map overhead, but must preserve contact traversal and fold separation. A worker
could free the UI thread; moving the same work does not itself reduce its cost.
Profile bloom rasterization before changing it—static filtered plates are not
proof of a repeated full-screen blur.
