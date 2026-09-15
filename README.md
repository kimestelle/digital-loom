# digital loom

Digital loom turns a fabric photograph into a tunable material. It extracts
tileable PBR maps, applies them to an interactive cloth simulation or 3D model,
and exports a portable material bundle with rendering and cloth-physics data.

## Development

Install dependencies and start the Next.js development server:

```bash
npm install
npm run dev
```

The room interface opens at [http://localhost:3000](http://localhost:3000).
The preserved original sky interface opens at [http://localhost:3000/sky](http://localhost:3000/sky).
Existing `/room` links redirect to `/`, retaining query parameters.
The isolated [component workbench](http://localhost:3000/room/components) lets you
inspect the real UI, edit per-specimen token drafts, reset states, and export CSS.
It does not load the cloth renderer, call extraction, or write to your materials.
They have separate root layouts, styles, and renderer entry points; crossing
between them loads a new document. Their material library and APIs remain shared.
The embeddable viewer demo
is available at [http://localhost:3000/viewer](http://localhost:3000/viewer).

Fresh Patina extractions require a local `.env` file:

```bash
FAL_KEY=your_fal_api_key
# Optional override:
# PATINA_ENDPOINT_ID=fal-ai/patina/material/extract
```

Submitting a new image calls the configured FAL endpoint. Selecting or dropping
an image only stages it; the paid request starts when **submit** is pressed.
Users can also paste their own fal key in the swatch archive's add-material
disclosure (stored in localStorage, sent per request) — it overrides the server
key.

## Room workflow (`/`)

The studio opens on the committed red-silk reference specimen. The white-glass
swatch archive selects, duplicates, imports, and reorders sources; the square
edge tab reveals the same mounted cabinet's pale material dossier for map
editing, parameter tuning, and export. The Digital Loom mark unfolds the left
environment rail: time of day, lighting, projection, cycle speed, and the cloth/mesh switch. Each
cabinet face scrolls as one surface, including its header. On narrow screens the two cabinet faces slide side by
side through the lower third while the live specimen keeps the upper two thirds.

The room itself is measured SVG/CSS perspective architecture: static plaster
and floor textures, baked plane gradients, and a bounded projected-light layer.
The cloth, rigid dowel, two suspension cords, object preview, and one flat
window-frame mesh are rendered in Three.js. The room rig is a reduced two-axis swing model rather
than a second string/rope solver; the reusable sky viewer retains the full
clothesline. Click the specimen to toggle its bounded 2× loupe; the lens follows
the mouse with the cursor hidden and pointer forces suspended. Click again or
press Escape to return to hover interaction. Two fingers inspect on touch screens.

The day/night cycle shares one resolved light state between fabric and room.
Each visit starts at 09:00; other saved room controls are preserved.
The room crossfades static atmosphere plates; the existing lens-flare shader
adds its ghosts and glare only while the window source is visible. Opening
environment controls pauses the cycle for inspection; closing resumes it.
The floor uses the original warm light field and blurred fabric-tinted shadow
cue, without its former leaf pattern. It is not a real-time shadow map.

## Deploying on Vercel

Push the repo to GitHub, create a Vercel project from it, and add one
environment variable: `FAL_KEY` (`FAL_API_KEY` is still accepted as a fallback).
Keep it in the host's server environment, never in Git or a `NEXT_PUBLIC_` variable. The build needs
no other configuration.

What ships with the deploy: the sample materials (`samples/`), pregen silk
bundle (`public/pregen/`), and versioned fabric profiles (`fabrics/`). Normal
authoring is local-first: fresh map bytes, material controls, clones, deletes,
and library order commit to IndexedDB on the user's device. The filesystem
cache and preset routes are compatibility mirrors only; on Vercel they live in
`/tmp` and may disappear on a cold start without losing the browser library.

The collection zip (swatch archive → collection → download zip) remains the
explicit portable backup for another browser or device. For durable shared
server storage, point `LOOM_CACHE_DIR` / `LOOM_PRESETS_DIR` at a mounted disk
and add an account/ownership boundary rather than treating the routes as a
multi-user database.

The Patina route deliberately caps source images at 4 MB, below the common
serverless request-body limit. Collection/material ZIP imports stay local in
the browser and do not depend on that upload allowance.

## Commands

```bash
npm run dev       # local development
npm run lint      # Next.js, React, and TypeScript lint rules
npm run typecheck # TypeScript without emitting files
npm test          # Vitest suite
npm run build     # production build
npm run test:e2e  # desktop + touch Playwright journeys
npm start         # serve the production build
```

## Architecture

- `app/(room)/page.tsx` owns the room's material library, autosave, and tuning UI at `/`.
- `app/(original)/` and `lib/original/ui/` preserve the original interface and renderer
  from `ae7cf659752dc83088cd1d7c5130e1ace6396885` at `/sky`.
- `app/api/` exposes Patina extraction, cache, sample, and preset routes.
- `lib/cloth/` contains the fabric model and typed-array XPBD cloth solver.
- `lib/ui/clothScene.tsx` connects the solver to Three.js and the custom shaders.
- `lib/ui/roomLight.ts` resolves one source path into the renderer light, window
  glow, angled beam, five-panel floor projection, and material-conditioned
  transmission cue.
- `lib/ui/roomFrame.tsx` and `materialCabinet.tsx` compose the textured 2D
  perspective room around the persistent 3D specimen.
- `lib/pipeline/` turns extracted maps into a material package and starting knobs.
- `lib/library/` owns transactional, local-first material persistence.
- `lib/core/loomMaterial.ts` defines the strict, versioned authored-material contract.
- `lib/export/` creates and reopens material/collection ZIPs; ORM and GLB are
  reported as optional derived artifacts when the browser cannot build them.

The [room design system](docs/design-system.md) documents the shared UI tokens,
control variants, stylesheet order, and accessibility rules. Room tokens and
primitives live in `app/styles/room-tokens.css` and `room-controls.css`; retained
dark authoring overlays use a separate compatibility theme.

The material flow is:

```text
photo -> FAL Patina -> content-addressed maps -> local material repository
      -> LoomMaterial + runtime projection -> cloth/object renderer
      -> validated material or collection bundle -> reopen / downstream use
```

## Project data

- `samples/` contains committed, baked materials shown in the Samples panel.
- `fabrics/` contains versioned physical profiles and committed specimen presets.
- `public/pregen/` contains the bundled startup material.
- `cache/` contains local extraction results and is ignored except for
  `cache/.gitkeep`.

Material presets persist material properties only. Device and scene preferences
such as mesh resolution, fragment quality, room light, and collision cadence
remain outside the material contract.

## Next.js version

This project uses Next.js 16. Its APIs and conventions differ from earlier
versions. Before changing framework code, read the relevant installed guide in
`node_modules/next/dist/docs/` as required by `AGENTS.md`.
