// ─── presets/store.ts ─────────────────────────────────────────────────────────
// Server-side persistence for user material presets. One JSON file per preset
// under fabrics/presets/ — same neighborhood as the committed fabric profiles,
// so a preset the user likes can graduate to version control by just leaving
// the file there.

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PRESET_VERSION,
  presetSlug,
  type MaterialPreset,
} from "./types";

export const PRESETS_ROOT = path.resolve(process.cwd(), "fabrics", "presets");

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function presetPath(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  return path.join(PRESETS_ROOT, `${slug}.json`);
}

export async function listPresets(): Promise<MaterialPreset[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(PRESETS_ROOT);
  } catch {
    return []; // directory absent → no presets yet
  }
  const out: MaterialPreset[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(PRESETS_ROOT, n), "utf8");
      const p = JSON.parse(raw) as MaterialPreset;
      if (p?.version === PRESET_VERSION && p.name && p.slug && p.knobs) {
        out.push(p);
      }
    } catch {
      // Skip unreadable/corrupt files rather than failing the whole list.
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

/** Save (or overwrite). Identity precedence:
 *   1. an explicit `slug` — clones pass their own id so a copy of a material
 *      is its own file, independent of the source it shares maps with;
 *   2. else the material's `pkgHash` — canonical params for a material live in
 *      a hash-named file that autosave rewrites as the user turns knobs;
 *   3. else a name-derived slug (materials with no maps). */
export async function savePreset(
  preset: Omit<MaterialPreset, "version" | "slug" | "createdAt"> & {
    slug?: string;
  },
): Promise<MaterialPreset> {
  const slug =
    preset.slug && SLUG_RE.test(preset.slug)
      ? preset.slug
      : preset.pkgHash && SLUG_RE.test(preset.pkgHash)
        ? preset.pkgHash
        : presetSlug(preset.name);
  const file = presetPath(slug);
  if (!slug || !file) throw new Error(`unusable preset name: ${preset.name}`);
  const full: MaterialPreset = {
    ...preset,
    version: PRESET_VERSION,
    slug,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(PRESETS_ROOT, { recursive: true });
  await fs.writeFile(file, JSON.stringify(full, null, 2) + "\n", "utf8");
  return full;
}

export async function deletePreset(slug: string): Promise<boolean> {
  const file = presetPath(slug);
  if (!file) return false;
  try {
    await fs.rm(file);
    return true;
  } catch {
    return false;
  }
}
