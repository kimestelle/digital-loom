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

import type { MaterialPreset } from "../presets/types";
import { FABRICS } from "../cloth/fabrics";
import type { MapName, Provenance } from "../core/materialPackage";
import {
  LOOM_MATERIAL_SCHEMA,
  type LoomMaterialV3,
} from "../core/loomMaterial";
import {
  inspectMapAsset,
  verifyMapAsset,
  type MapAssetMetadata,
} from "../core/mapAsset";
import { getCachedMap, putCachedMap } from "./mapCache";
import { detectMapFormat } from "./materialExport";
import {
  assertArchiveInputSize,
  assertSafeArchiveContents,
} from "./archiveSafety";
import {
  collectionOrderIds,
  CURRENT_COLLECTION_VERSION,
  validateCollectionManifest,
  type CollectionManifest,
  type ManifestMaterial,
} from "./collectionManifest";
export {
  collectionOrderIds,
  validateCollectionManifest,
  type CollectionManifest,
  type ManifestMaterial,
} from "./collectionManifest";

export interface CollectionMaterial {
  id: string;
  pkgHash: string;
  label: string;
  clone: boolean;
  entry?: {
    hash: string;
    prompt?: string | null;
    sourceFilename?: string | null;
    maps: {
      name: MapName;
      file: string;
      url: string;
      provenance?: Provenance;
      sourceHash?: string;
      asset?: MapAssetMetadata;
    }[];
  };
  preset?: MaterialPreset;
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

function canonicalMaterialFor(
  item: CollectionMaterial,
  maps: LoomMaterialV3["maps"],
): LoomMaterialV3 | undefined {
  const preset = item.preset;
  if (!preset) return undefined;
  const fabric = FABRICS[preset.fabricId];
  return {
    schema: LOOM_MATERIAL_SCHEMA,
    id: item.id,
    name: item.label,
    createdAt: preset.createdAt,
    source: {
      identity: item.pkgHash,
      packageId: item.pkgHash,
      // The collection registry historically retained the prompt/hash but not
      // the extractor name. Do not reconstruct provenance we no longer know.
      extractor: null,
      captureNotes: item.entry?.prompt ?? null,
    },
    fabric: {
      id: fabric.id,
      names: {
        ko: fabric.nameKo,
        roman: fabric.nameRoman,
        en: fabric.nameEn,
      },
      core: { ...fabric.core },
    },
    authored: {
      knobs: { ...preset.knobs },
      metalness: preset.metalness,
    },
    maps: { ...maps },
    artifacts: {},
  };
}

export async function exportCollection(
  items: CollectionMaterial[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const nextSlug = slugAllocator();
  // Allocate identities in the visible library order before grouping by map
  // ownership. Packaging owners first must not reorder the archive on restore.
  const slugById = new Map(items.map((item) => [item.id, nextSlug(item.label)]));
  const slugByHash = new Map<string, string>();
  const descriptorsByHash = new Map<string, LoomMaterialV3["maps"]>();
  const materialById = new Map<string, ManifestMaterial>();

  // Choose exactly one map owner per package. Prefer its canonical material,
  // but let a clone carry the bytes when the original is a built-in sample and
  // therefore is not itself part of the user's library.
  const byHash = new Map<string, CollectionMaterial[]>();
  for (const item of items) {
    const group = byHash.get(item.pkgHash) ?? [];
    group.push(item);
    byHash.set(item.pkgHash, group);
  }
  const owners: CollectionMaterial[] = [];
  for (const group of byHash.values()) {
    const owner = group.find((item) => !item.clone && item.entry) ?? group.find((item) => item.entry);
    if (!owner) {
      throw new Error(
        `Cannot back up ${group[0]?.label ?? "material"}: its maps are unavailable`,
      );
    }
    owners.push(owner);
  }
  const ownerIds = new Set(owners.map((item) => item.id));
  const rest = items.filter((item) => !ownerIds.has(item.id));

  let done = 0;
  const total = owners.reduce((n, i) => n + (i.entry?.maps.length ?? 0), 0);

  for (const item of owners) {
    const slug = slugById.get(item.id)!;
    slugByHash.set(item.pkgHash, slug);
    const maps: Record<string, string> = {};
    const mapAssets: NonNullable<ManifestMaterial["mapAssets"]> = {};
    const descriptors: LoomMaterialV3["maps"] = {};
    for (const m of item.entry!.maps) {
      // The server-side extraction cache is a plain directory on disk —
      // ephemeral on serverless hosts (see lib/fal/cache.ts) — so a map the
      // user is actively looking at right now can still 404 there. Read
      // from the browser's own IndexedDB cache first (warmed on selection
      // by warmMapCache); only hit the network if it's genuinely not local.
      let bytes = await getCachedMap(m.url);
      if (!bytes) {
        const r = await fetch(m.url);
        if (!r.ok) throw new Error(`Cannot back up ${item.label}: ${m.name} returned ${r.status}`);
        bytes = await r.arrayBuffer();
        void putCachedMap(m.url, bytes);
      }
      const format = detectMapFormat(bytes, { url: m.url, extension: m.file });
      if (!format) {
        throw new Error(
          `Cannot back up ${item.label}: ${m.name} has an unsupported image format`,
        );
      }
      if (!m.file.toLowerCase().endsWith(`.${format.extension}`)) {
        throw new Error(
          `Cannot back up ${item.label}: ${m.file} does not match its image bytes`,
        );
      }
      const path = `${slug}/${m.file}`;
      const asset = m.asset
        ? await verifyMapAsset(bytes, m.asset, `${item.label} ${m.name}`)
        : await inspectMapAsset(bytes);
      zip.file(path, bytes);
      maps[m.name] = path;
      mapAssets[m.name] = asset;
      const name = m.name as MapName;
      descriptors[name] = {
        name,
        file: m.file,
        mimeType: format.mimeType,
        extension: format.extension,
        colorSpace: name === "albedo" ? "srgb" : "linear",
        normalConvention: name === "normal" ? "opengl-y+" : undefined,
        provenance: m.provenance ?? "patina",
        sourceHash: m.sourceHash ?? item.pkgHash,
        asset,
      };
      onProgress?.(++done, total);
    }
    if (Object.keys(maps).length !== item.entry!.maps.length) {
      throw new Error(`Cannot back up ${item.label}: its map set is incomplete`);
    }
    descriptorsByHash.set(item.pkgHash, descriptors);
    const material = canonicalMaterialFor(item, descriptors);
    materialById.set(item.id, {
      slug,
      name: item.label,
      id: item.id,
      pkgHash: item.pkgHash,
      prompt: item.entry!.prompt ?? undefined,
      sourceFilename: item.entry!.sourceFilename ?? undefined,
      maps,
      mapAssets,
      material,
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
    const mapsOf = slugByHash.get(item.pkgHash);
    if (!mapsOf) {
      throw new Error(`Cannot back up ${item.label}: its map owner is unavailable`);
    }
    const material = canonicalMaterialFor(
      item,
      descriptorsByHash.get(item.pkgHash) ?? {},
    );
    materialById.set(item.id, {
      slug: slugById.get(item.id)!,
      name: item.label,
      id: item.id,
      pkgHash: item.pkgHash,
      mapsOf,
      material,
      params: item.preset
        ? {
            fabricId: item.preset.fabricId,
            metalness: item.preset.metalness,
            knobs: item.preset.knobs,
          }
        : undefined,
    });
  }

  const materials = items.map((item) => materialById.get(item.id)!);

  const manifest: CollectionManifest = {
    app: "digital-loom",
    kind: "collection",
    version: CURRENT_COLLECTION_VERSION,
    exportedAt: new Date().toISOString(),
    order: items.map((item) => slugById.get(item.id)!),
    materials,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `loom-collection-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Embedded WebKit may dereference the object URL after the click task.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export interface ImportResult {
  /** Materials restored fully (all their maps and params landed). */
  restored: number;
  /** Materials that partially failed — some maps or params didn't restore. */
  failed: number;
  /** Item ids in the manifest's display order (for libraryOrder). */
  order: string[];
}

export async function importCollection(file: File): Promise<ImportResult> {
  const { default: JSZip } = await import("jszip");
  assertArchiveInputSize(file.size);
  const zip = await JSZip.loadAsync(file);
  assertSafeArchiveContents(zip.files);
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("not a loom collection (no manifest.json)");
  const manifest = validateCollectionManifest(
    JSON.parse(await manifestFile.async("string")),
  );

  // The durable restore target is the browser vault (IndexedDB), not the
  // server cache: on serverless hosts the server cache is per-instance and
  // wiped on cold start, so materials written there scatter across instances
  // and a later read sees only a subset (often one). The vault lives on the
  // user's device and survives reloads and instance churn. The server writes
  // below are kept purely best-effort — they help local dev (./cache) and a
  // still-warm serverless instance, but their failure does NOT fail an import.
  const { putVaultCollection } = await import("@/lib/library/vault");
  const { PRESET_VERSION } = await import("@/lib/presets/types");
  const importedAt = manifest.exportedAt ?? new Date().toISOString();
  const order = collectionOrderIds(manifest);
  const packages: Parameters<typeof putVaultCollection>[0] = [];
  const presets: MaterialPreset[] = [];
  const cacheMirrors: FormData[] = [];
  for (const mat of manifest.materials) {
    if (mat.maps) {
      const bytesByFile = new Map<string, ArrayBuffer>();
      const maps: Parameters<typeof putVaultCollection>[0][number]["material"]["maps"] = [];
      const form = new FormData();
      form.set("hash", mat.pkgHash);
      if (mat.prompt) form.set("prompt", mat.prompt);
      if (mat.sourceFilename) form.set("sourceFilename", mat.sourceFilename);
      for (const [name, path] of Object.entries(mat.maps)) {
        const entry = zip.file(path);
        if (!entry) {
          throw new Error(`Collection is incomplete: missing ${path}`);
        }
        const bytes = await entry.async("arraybuffer");
        if (bytes.byteLength === 0) {
          throw new Error(`Collection is incomplete: ${path} is empty`);
        }
        const fileName = path.split("/").pop()!;
        bytesByFile.set(fileName, bytes);
        const mapName = name as MapName;
        const descriptor = mat.material?.maps[mapName];
        const expectedAsset = mat.mapAssets?.[mapName] ?? descriptor?.asset;
        const asset = expectedAsset
          ? await verifyMapAsset(bytes, expectedAsset, path)
          : await inspectMapAsset(bytes);
        const detected = detectMapFormat(bytes, { extension: fileName });
        if (!detected || !fileName.toLowerCase().endsWith(`.${detected.extension}`)) {
          throw new Error(`Collection map ${path} does not match its image bytes`);
        }
        if (
          descriptor &&
          (descriptor.mimeType !== detected.mimeType ||
            descriptor.extension !== detected.extension)
        ) {
          throw new Error(`Collection map ${path} disagrees with its format descriptor`);
        }
        maps.push({
          name: mapName,
          file: fileName,
          provenance: descriptor?.provenance ?? "patina",
          sourceHash: descriptor?.sourceHash ?? mat.pkgHash,
          asset,
        });
        form.append(name, new File([bytes], fileName));
      }
      packages.push({
        material: {
          hash: mat.pkgHash,
          prompt: mat.prompt ?? null,
          sourceFilename: mat.sourceFilename ?? null,
          createdAt: importedAt,
          maps,
          hidden: mat.id !== mat.pkgHash,
        },
        bytesByFile,
      });
      cacheMirrors.push(form);
    }
    const authored = mat.material
      ? {
          fabricId: mat.material.fabric.id,
          metalness: mat.material.authored.metalness,
          knobs: mat.material.authored.knobs,
        }
      : mat.params;
    if (authored) {
      presets.push({
        version: PRESET_VERSION,
        name: mat.name,
        slug: mat.id,
        createdAt: importedAt,
        fabricId: authored.fabricId as MaterialPreset["fabricId"],
        pkgHash: mat.pkgHash,
        metalness: authored.metalness,
        knobs: authored.knobs,
      });
    }
  }
  await putVaultCollection(packages, presets, order);

  // Server filesystem mirrors never participate in the success result. The
  // browser transaction above is already complete and authoritative.
  for (const form of cacheMirrors) {
    void fetch("/api/cache/import", { method: "POST", body: form }).catch(
      () => undefined,
    );
  }
  for (const preset of presets) {
    void fetch("/api/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preset),
    }).catch(() => undefined);
  }
  return { restored: manifest.materials.length, failed: 0, order };
}
