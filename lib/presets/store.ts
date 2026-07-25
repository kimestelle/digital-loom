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

// Two roots: the repo's committed presets are the read-only SEED (the sample
// materials' tuned params ship there), and PRESETS_ROOT is where new writes
// land. Locally both are the same directory — behavior unchanged. On Vercel
// (read-only repo tree) writes go to /tmp: functional within an instance,
// ephemeral across cold starts; the collection zip is the durable backup.
export const SEED_ROOT = path.resolve(process.cwd(), "fabrics", "presets");
export const PRESETS_ROOT = process.env.LOOM_PRESETS_DIR
  ? path.resolve(process.env.LOOM_PRESETS_DIR)
  : process.env.VERCEL
    ? "/tmp/loom-presets"
    : SEED_ROOT;

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function presetPath(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  return path.join(PRESETS_ROOT, `${slug}.json`);
}

async function readPresetDir(dir: string): Promise<MaterialPreset[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // directory absent → no presets there
  }
  const out: MaterialPreset[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, n), "utf8");
      const p = JSON.parse(raw) as MaterialPreset;
      if (p?.version === PRESET_VERSION && p.name && p.slug && p.knobs) {
        out.push(p);
      }
    } catch {
      // Skip unreadable/corrupt files rather than failing the whole list.
    }
  }
  return out;
}

export async function listPresets(): Promise<MaterialPreset[]> {
  const seed = await readPresetDir(SEED_ROOT);
  const bySlug = new Map(seed.map((p) => [p.slug, p]));
  if (PRESETS_ROOT !== SEED_ROOT) {
    // Writable overlay wins: a user's tweak of a seeded material shadows it.
    for (const p of await readPresetDir(PRESETS_ROOT)) bySlug.set(p.slug, p);
  }
  const out = [...bySlug.values()];
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
