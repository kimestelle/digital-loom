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
import { getCachedMap, putCachedMap } from "@/lib/export/mapCache";

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
      // The server-side extraction cache is a plain directory on disk —
      // ephemeral on serverless hosts (see lib/fal/cache.ts) — so a map the
      // user is actively looking at right now can still 404 there. Read
      // from the browser's own IndexedDB cache first (warmed on selection
      // by warmMapCache); only hit the network if it's genuinely not local.
      let bytes = await getCachedMap(m.url);
      if (!bytes) {
        const r = await fetch(m.url);
        if (!r.ok) {
          console.warn(`[export] map unavailable, skipped: ${m.url}`);
          continue;
        }
        bytes = await r.arrayBuffer();
        void putCachedMap(m.url, bytes);
      }
      const path = `${slug}/${m.file}`;
      zip.file(path, bytes);
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
  /** Materials restored fully (all their maps and params landed). */
  restored: number;
  /** Materials that partially failed — some maps or params didn't restore. */
  failed: number;
  /** Item ids in the manifest's display order (for libraryOrder). */
  order: string[];
}

/** Newest collection layout this build knows how to read. Bump alongside the
 *  CollectionManifest.version literal when the format changes. */
const SUPPORTED_VERSION = 1;

export async function importCollection(file: File): Promise<ImportResult> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("not a loom collection (no manifest.json)");
  const manifest = JSON.parse(
    await manifestFile.async("string"),
  ) as CollectionManifest;
  // Reject anything that isn't a loom collection before touching the cache — a
  // foreign zip that happens to carry a manifest.json shouldn't half-import.
  if (manifest.app !== "digital-loom" || manifest.kind !== "collection") {
    throw new Error("not a loom collection zip");
  }
  // A newer export could restructure maps/params in ways this importer would
  // silently mishandle; refuse rather than corrupt the cache.
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `unsupported collection version ${manifest.version} — this build reads version ${SUPPORTED_VERSION}`,
    );
  }

  // The durable restore target is the browser vault (IndexedDB), not the
  // server cache: on serverless hosts the server cache is per-instance and
  // wiped on cold start, so materials written there scatter across instances
  // and a later read sees only a subset (often one). The vault lives on the
  // user's device and survives reloads and instance churn. The server writes
  // below are kept purely best-effort — they help local dev (./cache) and a
  // still-warm serverless instance, but their failure does NOT fail an import.
  const { putVaultMaterial, putVaultPreset } = await import("@/lib/library/vault");
  const { PRESET_VERSION } = await import("@/lib/presets/types");
  const importedAt = manifest.exportedAt ?? new Date().toISOString();

  let restored = 0;
  let failed = 0;
  for (const mat of manifest.materials) {
    let ok = true;
    // 1. Maps → the browser vault (durable) + the server cache (best-effort).
    if (mat.maps && Object.keys(mat.maps).length > 0) {
      const bytesByFile = new Map<string, ArrayBuffer>();
      const vaultMaps: { name: string; file: string }[] = [];
      const form = new FormData();
      form.set("hash", mat.pkgHash);
      if (mat.prompt) form.set("prompt", mat.prompt);
      if (mat.sourceFilename) form.set("sourceFilename", mat.sourceFilename);
      for (const [name, path] of Object.entries(mat.maps)) {
        const entry = zip.file(path);
        if (!entry) continue;
        const bytes = await entry.async("arraybuffer");
        const file = path.split("/").pop()!;
        bytesByFile.set(file, bytes);
        vaultMaps.push({ name, file });
        form.append(name, new File([bytes], file));
      }
      if (vaultMaps.length === 0) {
        // The manifest listed maps but none were in the zip — a broken bundle.
        console.warn(`[import] no map files found in zip for "${mat.name}" (${mat.pkgHash})`);
        ok = false;
      } else {
        const vaulted = await putVaultMaterial(
          {
            hash: mat.pkgHash,
            prompt: mat.prompt ?? null,
            sourceFilename: mat.sourceFilename ?? null,
            createdAt: importedAt,
            maps: vaultMaps,
          },
          bytesByFile,
        );
        if (!vaulted) {
          console.warn(`[import] vault write failed for "${mat.name}" (${mat.pkgHash})`);
          ok = false;
        }
        try {
          await fetch("/api/cache/import", { method: "POST", body: form });
        } catch {
          // best-effort — the vault is the durable copy
        }
      }
    }
    // 2. Parameters → the vault preset (durable) + the server preset (best-effort).
    if (mat.params) {
      await putVaultPreset({
        version: PRESET_VERSION,
        name: mat.name,
        slug: mat.id,
        createdAt: importedAt,
        fabricId: mat.params.fabricId as MaterialPreset["fabricId"],
        pkgHash: mat.pkgHash,
        metalness: mat.params.metalness,
        knobs: mat.params.knobs,
      });
      try {
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
      } catch {
        // best-effort — the vault preset is the durable copy
      }
    }
    if (ok) restored++;
    else failed++;
  }
  return { restored, failed, order: manifest.materials.map((m) => m.id) };
}
