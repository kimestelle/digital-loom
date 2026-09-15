# Daylight sunlight bakes

`public/2d-textures/room-sunlight-day.json` indexes five computed direct-light
fields: 06:00, 09:00, 12:00, 15:00, and 18:00. Each PNG's adjacent JSON records
its bounds, aperture, direction, optical parameters, encoding, and checks.
The approved 09:00 PNG and metadata are unchanged. No dark night frames are
needed: the existing day/night resolver brings direct light to zero.

## Reproduce

The runner imports the application's actual `resolveRoomLight` path, uses the
approved morning exposure for every new frame, and verifies/reuses existing
files. Node 22.18+ and Python with NumPy are required; Blender's bundled Python
is detected without starting Blender:

```sh
node scripts/bake-room-sunlight-day.mjs
```

Use `--python /path/to/python` to select another NumPy installation. The original
morning bake traced 4,096 × 2,112 aperture samples at 13 wavelengths. The four
new frames use 1,536 × 792 × 13: 63,258,624 additional rays, less total tracing
than the original morning field alone. They took 233.51 seconds on the authoring
machine. All five PNGs total 1,865,529 bytes (1.78 MiB); each is 1,024 × 512.

The underlying Python CLI accepts `--direction X Y Z`, `--path-position`,
`--name`, `--exposure`, and `--output-dir`. It refuses existing image/metadata
pairs unless `--overwrite` is explicitly supplied. Use a separate output
directory for experiments. Optional `--preview /tmp/sunlight-preview.png`
composites the same optical field over a neutral gray ground.

## What is computed

The aperture is 3.2 m wide, with its sill at 1.0 m and top at 2.65 m. X follows
the window, Y points into the room, and Z points up. A finite solar disk supplies
incoming rays. Each ray intersects the front surface, refracts by Snell's law,
intersects the back surface, refracts again, and reaches the Z=0 floor. Both
interfaces apply unpolarized Fresnel transmission. The frame blocks rays at
its front and back planes.

The two surfaces share a gentle pane bow. Small, smooth, nonperiodic variations
in thickness produce slight changes in ray density. Dispersion comes from
different ray paths at different wavelengths through the glass. No color bands
are drawn onto the image. Conservative bilinear deposition and a 0.70 pixel
reconstruction filter make a display texture from those paths. The solar disk
itself produces the geometric penumbra.

The clear crown glass proxy uses the [SCHOTT N-BK7 Sellmeier model](https://www.schott.com/shop/advanced-optics/en/Optical-Glass/N-BK7/c/glass-N-BK7).
Spectral integration uses the piecewise CIE 1931 fits from [Wyman, Sloan, and
Shirley (2013)](https://jcgt.org/published/0002/02/01/), followed by XYZ-to-linear-sRGB
conversion and a neutral clear-pane white balance.

## Runtime contract

The approved morning image covers X = 0.868026…6.157269 m and
Y = 0.808004…2.798212 m. The top-left image corner is `(minX, minY)`;
columns increase X and rows increase Y. The runtime projects that rectangle
through the measured room's floor and right-wall mappings. The other frames
have their own derived bounds; they must not reuse morning's pixel coordinates.

The PNG contains straight-alpha RGBA. RGB stores the sRGB-encoded chromaticity
of the normalized linear energy; neutral illumination is white. Alpha stores
the bounded energy contribution. The exterior is transparent, including all
boundary pixels. CSS opacity can reduce the contribution over the room floor.
This display encoding is not a photometric radiance format.

`lib/ui/roomSunlightProjection.ts` maps the image through the existing floor
homography using the measured window and viewport. The room drawing is a
calibrated 3.4 m wall / 4 m depth proxy, not a recovered shared camera with the
live cloth. Resizing repositions the same image; it does not trace new rays.

The right-wall receiver continues the same ray to the wall plane instead of
letting its floor projection pass through that wall. Its vertical coordinate
uses the same homogeneous camera denominator as the floor, so both transforms
coincide exactly at zero wall height. Shared CSS corner coordinates clip the
two receivers, including the 80%-height mobile room. They use the same image
URL and the same bloom treatment, with independent load-readiness flags. This
adds one composited receiver, not another WebGL scene or ray-tracing loop.
The caustic pattern is reprojected from the floor bake; it is not recomputed for
the wall's shorter optical travel distance.

At most two neighboring source images are mounted per receiver; an exact
keyframe uses one. Each field is registered to the current light direction
before its opacity is blended, so the projected pane grid moves continuously
instead of dissolving between displaced shadows. Linear complementary weights
are composited with `mix-blend-mode: plus-lighter` inside an isolated receiver.
This is a [premultiplied display crossfade](https://drafts.csswg.org/compositing/#plus-lighter),
not linear-radiance interpolation. No JavaScript pixel buffers, runtime ray
tracing, second canvas, or additional animation loop are used.

Only the selected keyframe/pair is requested; previously visited files may
remain in the browser cache. A decoded neighbor holds at normalized full
strength while the other loads or fails. If neither selected field is decoded,
the previous light treatment remains the fallback. React changes the image
pair only at interval boundaries. Transforms and blend weights use the existing
24 Hz room publication cadence; hidden-tab/data-saving/reduced-motion pauses
remain with the existing controller. The live cloth renderer is unchanged.

Floor and wall source crops are derived from the visible receiver before
projection, with up to 96 source pixels of bloom padding. Invisible padding is
reduced near the projective horizon. Projected wrapper corners stay within
[-2 × viewport, 3 × viewport], avoiding enormous offscreen wall quads on narrow
afternoon views. The full-resolution source/filter stays fixed; its crop offset
is translated beneath that wrapper. These layers still have a compositing cost.

Strength scales the contribution. Edge softness adds a bounded 0–2 px display
blur to the neutral image, independent of solar motion; it is not a new optical simulation.

The default sunlit display treatment takes the supplied sunlight photograph's
tonal relationship, not its exact scene: near-white direct illumination against
warmer shade. The same PNG receives a static 2.85× alpha exposure lift; its
overall opacity is capped at 0.92 to retain some floor grain. A separate cached
warm multiply gradient affects only the room substrate. Both disappear with
zero direct sunlight, zero patch strength, or no available image. The white
window and live cloth renderer are not tinted by the substrate layer.

Bloom is separate from edge softness. The fixed image filter extracts bright
light after exposure and spreads a pale cream contribution at two radii (6 and
32 source-image pixels), then places the direct light on top. Its padded filter
region permits spill beyond the optical footprint. Bloom strength is tunable in
the component study; it does not change ray geometry or the optical asset. The
display treatment doubles the edge-softness range to 0–4 px. This is local,
projected-image halation, not full-screen camera bloom or additional simulated
glass transport. Filter parameters stay fixed during solar motion; no renderer
or animation loop is added. Static filtering still has a compositing cost.

Edge softness and bloom now default to 100%; existing saved room softness is
preserved. The window opening also receives a local two-radius bloom (3 and
18 CSS pixels), spilling across its flush sill and surrounding plaster. Its
intensity follows the same bloom control, bake availability, daylight,
and light-patch strength. No sharp source is merged into that bloom layer.

`roomWindowGeometry.ts` supplies the exact twelve window quads to both the
production Three frame and the canvas-free study's SVG adapter. The existing
room resize observer publishes the SVG paths and the exact aperture clip;
these are not rebuilt on solar ticks. The real room retains its late,
depth-tested Three frame so the bars do not show through cloth alpha. Only
the study draws the sharp SVG frame. The bloom stays beneath the cloth canvas.

Compare and tune the actual room components at
`/room/components/preview?component=sunlight`. This fixture has no cloth canvas
or persisted settings. `/` uses the same keyframes alongside the live cloth;
the original interface is preserved at `/sky`.

## Limits and checks

This is a reproducible custom transport bake, not Blender path tracing or a
full global-illumination solution. It includes no room bounce, sky illumination,
fabric, object occlusion, absorption tint, or repeated internal reflections.
The glass relief and crown-glass material are authored proxies, not surveyed
window measurements. Source directions follow the existing room's authored
daylight path, not a geographic solar ephemeris. The five fields share a single
display exposure; normalizing each frame independently would cause brightness
pumping between keyframes.

The script checks finite floor intersections, positive glass thickness,
bounded interface transmission, conserved deposited energy, an illuminated
output, and transparent boundaries. The metadata records transmission and
refraction measurements plus the PNG SHA-256 hash.
