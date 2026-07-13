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
- `lib/cloth/` contains the fabric model and the typed-array XPBD cloth solver.
- `lib/ui/clothScene.tsx` connects the solver to Three.js and the custom shaders.
- `lib/pipeline/` turns extracted maps into a material package and starting knobs.
- `lib/export/` creates ZIP bundles containing PBR maps, ORM, GLB, and metadata.

The material flow is:

```text
photo -> FAL Patina -> cached PBR maps -> MaterialPackage
      -> fabric profile + tuning knobs -> cloth/object renderer -> export bundle
```

## Project data

- `samples/` contains committed, baked materials shown in the Samples panel.
- `fabrics/` contains physical fabric profiles and saved material presets.
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
