"use client";

// ─── collectionExport.ts ──────────────────────────────────────────────────────
// The user's whole swatch collection as one portable zip, and the reverse.
//
// Layout convention (stable — importers key off it):
//   loom-collection.zip
//   ├── manifest.json            all parameter metadata + display order
//   ├── <slug>/albedo.png        one folder per material, slug = its name
//   ├── <slug>/height.png        (map filenames preserved from the cache)
//   └── …
//
// manifest.json carries, per material: name, cache hash (identity), prompt /
// source-photo provenance, the tuned parameters (fabricId · metalness ·
// knobs) when the material has a preset, and the map paths inside the zip.
// Clones own params but share another material's maps, so they appear in the
// manifest with `mapsOf` pointing at the source folder instead of files.
//
// Import restores maps into the extraction cache under their ORIGINAL hashes
// (content identity survives the round-trip, so presets and clones re-attach
// by construction), re-posts every preset, and hands back the display order.

import type { FabricKnobs } from "@/lib/ui/knobs";
import type { MaterialPreset } from "@/lib/presets/types";

export interface CollectionMaterial {
  id: string;
  pkgHash: string;
  label: string;
  clone: boolean;
  entry?: {
    hash: string;
    prompt?: string | null;
    sourceFilename?: string | null;
    maps: { name: string; file: string; url: string }[];
  };
  preset?: MaterialPreset;
}

interface ManifestMaterial {
  slug: string;
  name: string;
  id: string;
  pkgHash: string;
  prompt?: string;
  sourceFilename?: string;
  /** Map name → path inside the zip (own maps). */
  maps?: Record<string, string>;
  /** Clone: folder slug of the material whose maps it wears. */
  mapsOf?: string;
  /** Tuned parameters, when the material has been saved. */
  params?: {
    fabricId: string;
    metalness: number;
    knobs: FabricKnobs;
  };
}

interface CollectionManifest {
  app: "digital-loom";
  kind: "collection";
  version: 1;
  exportedAt: string;
  /** Display order, as manifest slugs. */
  order: string[];
  materials: ManifestMaterial[];
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "material"
  );
}

/** Unique folder-safe slugs: "red silk", "red silk" → red-silk, red-silk-2. */
function slugAllocator() {
  const used = new Map<string, number>();
  return (name: string) => {
    const base = slugify(name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

export async function exportCollection(
  items: CollectionMaterial[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const nextSlug = slugAllocator();
  const slugByHash = new Map<string, string>();
  const materials: ManifestMaterial[] = [];

  // Map-owning materials first so clones can point at their folders.
  const owners = items.filter((i) => !i.clone && i.entry);
  const rest = items.filter((i) => i.clone || !i.entry);

  let done = 0;
  const total = owners.reduce((n, i) => n + (i.entry?.maps.length ?? 0), 0);

  for (const item of owners) {
    const slug = nextSlug(item.label);
    slugByHash.set(item.pkgHash, slug);
    const maps: Record<string, string> = {};
    for (const m of item.entry!.maps) {
      const r = await fetch(m.url);
      if (!r.ok) continue;
      const path = `${slug}/${m.file}`;
      zip.file(path, await r.arrayBuffer());
      maps[m.name] = path;
      onProgress?.(++done, total);
    }
    materials.push({
      slug,
      name: item.label,
      id: item.id,
      pkgHash: item.pkgHash,
      prompt: item.entry!.prompt ?? undefined,
      sourceFilename: item.entry!.sourceFilename ?? undefined,
      maps,
      params: item.preset
        ? {
            fabricId: item.preset.fabricId,
            metalness: item.preset.metalness,
            knobs: item.preset.knobs,
          }
        : undefined,
    });
  }

  for (const item of rest) {
    // Clones + params-only items: parameters travel, maps are referenced.
    materials.push({
      slug: nextSlug(item.label),
      name: item.label,
      id: item.id,
      pkgHash: item.pkgHash,
      mapsOf: slugByHash.get(item.pkgHash),
      params: item.preset
        ? {
            fabricId: item.preset.fabricId,
            metalness: item.preset.metalness,
            knobs: item.preset.knobs,
          }
        : undefined,
    });
  }

  const manifest: CollectionManifest = {
    app: "digital-loom",
    kind: "collection",
    version: 1,
    exportedAt: new Date().toISOString(),
    order: materials.map((m) => m.slug),
    materials,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `loom-collection-${stamp}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export interface ImportResult {
  /** Materials restored (maps and/or params). */
  restored: number;
  /** Item ids in the manifest's display order (for libraryOrder). */
  order: string[];
}

export async function importCollection(file: File): Promise<ImportResult> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("not a loom collection (no manifest.json)");
  const manifest = JSON.parse(
    await manifestFile.async("string"),
  ) as CollectionManifest;
  if (manifest.kind !== "collection") {
    throw new Error("not a loom collection zip");
  }

  let restored = 0;
  for (const mat of manifest.materials) {
    // 1. Maps → the extraction cache, under the original hash.
    if (mat.maps && Object.keys(mat.maps).length > 0) {
      const form = new FormData();
      form.set("hash", mat.pkgHash);
      if (mat.prompt) form.set("prompt", mat.prompt);
      if (mat.sourceFilename) form.set("sourceFilename", mat.sourceFilename);
      for (const [name, path] of Object.entries(mat.maps)) {
        const entry = zip.file(path);
        if (!entry) continue;
        const blob = await entry.async("blob");
        form.append(name, new File([blob], path.split("/").pop()!));
      }
      const r = await fetch("/api/cache/import", { method: "POST", body: form });
      if (!r.ok) continue;
    }
    // 2. Parameters → a preset under the original id.
    if (mat.params) {
      await fetch("/api/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: mat.id,
          name: mat.name,
          fabricId: mat.params.fabricId,
          pkgHash: mat.pkgHash,
          metalness: mat.params.metalness,
          knobs: mat.params.knobs,
        }),
      });
    }
    restored++;
  }
  return { restored, order: manifest.materials.map((m) => m.id) };
}
