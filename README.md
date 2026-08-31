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

Open [http://localhost:3000](http://localhost:3000). The embeddable viewer demo
is available at [http://localhost:3000/viewer](http://localhost:3000/viewer).

Fresh Patina extractions require a local `.env` file:

```bash
FAL_API_KEY=your_fal_api_key
# Optional override:
# PATINA_ENDPOINT_ID=fal-ai/patina/material/extract
```

Submitting a new image calls the configured FAL endpoint. Selecting or dropping
an image only stages it; the paid request starts when **submit** is pressed.
Users can also paste their own fal key in the workshop panel (stored in
localStorage, sent per request) — it overrides the server key.

## Deploying on Vercel

Push the repo to GitHub, create a Vercel project from it, and add one
environment variable: `FAL_API_KEY`. That's the whole setup — the build needs
no other configuration.

What ships with the deploy: the sample materials (`samples/`), pregen silk
bundle (`public/pregen/`), and versioned fabric profiles (`fabrics/`). Normal
authoring is local-first: fresh map bytes, material controls, clones, deletes,
and library order commit to IndexedDB on the user's device. The filesystem
cache and preset routes are compatibility mirrors only; on Vercel they live in
`/tmp` and may disappear on a cold start without losing the browser library.

The collection zip (my swatches → collection → download zip) remains the
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
npm start         # serve the production build
```

## Architecture

- `app/page.tsx` owns the studio state, material library, autosave, and tuning UI.
- `app/api/` exposes Patina extraction, cache, sample, and preset routes.
- `lib/cloth/` contains the fabric model and typed-array XPBD cloth solver.
- `lib/ui/clothScene.tsx` connects the solver to Three.js and the custom shaders.
- `lib/pipeline/` turns extracted maps into a material package and starting knobs.
- `lib/library/` owns transactional, local-first material persistence.
- `lib/core/loomMaterial.ts` defines the strict, versioned authored-material contract.
- `lib/export/` creates and reopens material/collection ZIPs; ORM and GLB are
  reported as optional derived artifacts when the browser cannot build them.

The material flow is:

```text
photo -> FAL Patina -> content-addressed maps -> local material repository
      -> LoomMaterial + runtime projection -> cloth/object renderer
      -> validated material or collection bundle -> reopen / downstream use
```

## Project data

- `samples/` contains committed, baked materials shown in the Samples panel.
- `fabrics/` contains versioned physical fabric profiles.
- `public/pregen/` contains the bundled startup material.
- `cache/` contains local extraction results and is ignored except for
  `cache/.gitkeep`.

Material presets persist material properties only. Device and scene preferences
such as mesh resolution, fragment quality, sky, and collision cadence remain
local browser preferences.

## Next.js version

This project uses Next.js 16. Its APIs and conventions differ from earlier
versions. Before changing framework code, read the relevant installed guide in
`node_modules/next/dist/docs/` as required by `AGENTS.md`.
# digital-loom
