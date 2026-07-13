// ─── presets/types.ts ─────────────────────────────────────────────────────────
// Shared shape for user-authored material presets. A preset captures the
// *material* — which base fabric, which extracted map package, and the full
// FabricKnobs surface — but deliberately NOT the scene knobs (quality, mesh
// res, sky, pins): those are device/viewing preferences, and restoring a
// preset shouldn't downgrade a fast machine or restyle the stage.
//
// Client and server both import this file; keep it type-only + pure data
// (no fs, no React).

import type { FabricKnobs } from "@/lib/ui/knobs";
import type { FabricId } from "@/lib/cloth/fabrics";

export const PRESET_VERSION = 1;

export interface MaterialPreset {
  version: typeof PRESET_VERSION;
  /** Display name, e.g. "red silk". */
  name: string;
  /** Filesystem-safe identity derived from name; also the file basename. */
  slug: string;
  createdAt: string;
  /** Base physics profile the knobs modify. */
  fabricId: FabricId;
  /** Cache hash of the Patina extraction whose maps dress this preset,
   *  or null for presets that use the base fabric's bundled textures. */
  pkgHash: string | null;
  /** Insert-panel metalness amount (lives outside knobs on the page). */
  metalness: number;
  /** Full material knob surface at save time. */
  knobs: FabricKnobs;
}

/** Name → slug. Lowercase, spaces to dashes, strip anything exotic. */
export function presetSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
