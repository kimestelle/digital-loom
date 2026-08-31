"use client";

// ─── library/vault.ts ─────────────────────────────────────────────────────────
// The browser-local, durable home for authored and imported materials. Where the
// server-side cache is ephemeral on serverless hosts (per-instance /tmp, wiped
// on cold start — see lib/fal/cache.ts), the vault survives reloads and instance
// churn because it lives in IndexedDB on the user's own device.
//
// It stores two things per imported material:
//   • metadata (VaultMaterial) in the `materials` store, keyed by pkg hash;
//   • its params (MaterialPreset) in the `presets` store, keyed by slug.
// The map *bytes* live in the shared `maps` store (lib/export/mapCache.ts),
// keyed by the same /api/cache/<hash>/<file> URL the server would serve them at.
//
// On the way back out, hydrateVaultEntries reconstructs CacheEntry-shaped
// records whose map URLs are blob: URLs minted from those stored bytes — so the
// rest of the app (thumbnails, the viewer, export) loads them with zero server
// round-trips. Blob URLs are session-scoped and deduped per canonical URL, so a
// material costs one object URL per map for the life of the tab.
//
// IndexedDB errors intentionally reject: callers must keep the UI dirty and
// offer retry rather than reporting a write that never committed.

import {
  openLoomDb,
  STORE_MAPS,
  STORE_MATERIALS,
  STORE_PRESETS,
  STORE_SETTINGS,
} from "@/lib/library/idb";
import type { MaterialPreset } from "@/lib/presets/types";
import type {
  MapName,
  Provenance,
} from "@/lib/core/materialPackage";

export interface VaultMap {
  name: MapName;
  file: string;
  provenance?: Provenance;
  sourceHash?: string;
}

export interface VaultMaterial {
  hash: string;
  prompt: string | null;
  sourceFilename: string | null;
  createdAt: string;
  maps: VaultMap[];
  /** Keep the package available to clones without showing its deleted canonical
   *  row in the library. */
  hidden?: boolean;
}

/** CacheEntry-shaped record the library consumes. Structurally identical to the
 *  page's CacheEntry, but its map URLs are blob: URLs backed by IndexedDB. */
export interface HydratedEntry {
  hash: string;
  createdAt: string;
  prompt: string | null;
  sourceFilename: string | null;
  maps: (VaultMap & { url: string })[];
  hidden?: boolean;
}

/** The canonical URL a map is (or would be) served at — also its byte-cache
 *  key, so vault bytes and server bytes share one address space. */
export function cacheUrl(hash: string, file: string): string {
  return `/api/cache/${hash}/${file}`;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// One blob URL per canonical URL for the life of the tab. Re-hydrating (e.g. a
// second refresh) reuses the same URL instead of leaking a new one each time.
const blobUrls = new Map<string, string>();

function blobUrlFor(canonical: string, file: string, bytes: ArrayBuffer): string {
  const existing = blobUrls.get(canonical);
  if (existing) return existing;
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
  blobUrls.set(canonical, url);
  return url;
}

async function getAll<T>(store: string): Promise<T[]> {
  const db = await openLoomDb();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    let value: T[] = [];
    req.onsuccess = () => {
      value = (req.result as T[]) ?? [];
    };
    req.onerror = () => tx.abort();
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? req.error ?? new Error(`IndexedDB read failed: ${store}`));
    };
    tx.onabort = tx.onerror;
  });
}

async function getOne<T>(store: string, key: string): Promise<T | null> {
  const db = await openLoomDb();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    let value: T | null = null;
    req.onsuccess = () => {
      value = (req.result as T | undefined) ?? null;
    };
    req.onerror = () => tx.abort();
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? req.error ?? new Error(`IndexedDB read failed: ${store}`));
    };
    tx.onabort = tx.onerror;
  });
}

async function getAllKeys(store: string): Promise<IDBValidKey[]> {
  const db = await openLoomDb();
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    let value: IDBValidKey[] = [];
    req.onsuccess = () => {
      value = req.result ?? [];
    };
    req.onerror = () => tx.abort();
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? req.error ?? new Error(`IndexedDB read failed: ${store}`));
    };
    tx.onabort = tx.onerror;
  });
}

async function write(
  stores: string | string[],
  mutate: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await openLoomDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    try {
      mutate(tx);
    } catch (error) {
      tx.abort();
      db.close();
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB write failed"));
    };
    tx.onabort = tx.onerror;
  });
}

function put(store: string, key: string, value: unknown): Promise<void> {
  return write(store, (tx) => tx.objectStore(store).put(value, key));
}

/** Persist one material and all of its map bytes in a single transaction. A
 *  material row is never committed with only part of its declared map set. */
export async function putVaultMaterial(
  material: VaultMaterial,
  bytesByFile: Map<string, ArrayBuffer>,
): Promise<void> {
  for (const m of material.maps) {
    const bytes = bytesByFile.get(m.file);
    if (!bytes) throw new Error(`missing bytes for ${m.file}`);
  }
  if (material.maps.length === 0) throw new Error("material needs at least one map");
  await write([STORE_MAPS, STORE_MATERIALS, STORE_SETTINGS], (tx) => {
    const maps = tx.objectStore(STORE_MAPS);
    for (const m of material.maps) {
      maps.put(bytesByFile.get(m.file)!, cacheUrl(material.hash, m.file));
    }
    tx.objectStore(STORE_MATERIALS).put(material, material.hash);
    tx.objectStore(STORE_SETTINGS).delete(deletedMaterialKey(material.hash));
  });
}

export interface VaultCollectionPackage {
  material: VaultMaterial;
  bytesByFile: Map<string, ArrayBuffer>;
}

/** Import a complete collection into maps/materials/presets/order in one
 *  transaction. Every archive file is read and validated before this opens, so
 *  a malformed or quota-exhausted restore cannot leave a half-library behind. */
export async function putVaultCollection(
  packages: VaultCollectionPackage[],
  presets: MaterialPreset[],
  order: string[],
): Promise<void> {
  const hashes = new Set<string>();
  for (const pkg of packages) {
    if (hashes.has(pkg.material.hash)) {
      throw new Error(`duplicate map package ${pkg.material.hash}`);
    }
    hashes.add(pkg.material.hash);
    if (pkg.material.maps.length === 0) {
      throw new Error(`material ${pkg.material.hash} has no maps`);
    }
    for (const map of pkg.material.maps) {
      const bytes = pkg.bytesByFile.get(map.file);
      if (!bytes || bytes.byteLength === 0) {
        throw new Error(`missing bytes for ${map.file}`);
      }
    }
  }
  const existing = new Map(
    await Promise.all(
      packages.map(async ({ material }) => [
        material.hash,
        await getVaultMaterial(material.hash),
      ] as const),
    ),
  );
  await write(
    [STORE_MAPS, STORE_MATERIALS, STORE_PRESETS, STORE_SETTINGS],
    (tx) => {
      const maps = tx.objectStore(STORE_MAPS);
      const materials = tx.objectStore(STORE_MATERIALS);
      const presetStore = tx.objectStore(STORE_PRESETS);
      const settings = tx.objectStore(STORE_SETTINGS);
      for (const pkg of packages) {
        const prior = existing.get(pkg.material.hash);
        for (const map of prior?.maps ?? []) {
          maps.delete(cacheUrl(pkg.material.hash, map.file));
        }
        for (const map of pkg.material.maps) {
          maps.put(
            pkg.bytesByFile.get(map.file)!,
            cacheUrl(pkg.material.hash, map.file),
          );
        }
        materials.put(
          {
            ...pkg.material,
            // A clone-owned archive package must not hide a canonical material
            // that is already visible in this local library.
            hidden: prior && !prior.hidden ? false : pkg.material.hidden,
          },
          pkg.material.hash,
        );
        settings.delete(deletedMaterialKey(pkg.material.hash));
      }
      for (const preset of presets) {
        presetStore.put(preset, preset.slug);
        settings.delete(deletedPresetKey(preset.slug));
      }
      settings.put([...order], LIBRARY_ORDER_KEY);
    },
  );
}

export async function putVaultPreset(preset: MaterialPreset): Promise<void> {
  await write([STORE_PRESETS, STORE_SETTINGS], (tx) => {
    tx.objectStore(STORE_PRESETS).put(preset, preset.slug);
    tx.objectStore(STORE_SETTINGS).delete(deletedPresetKey(preset.slug));
  });
}

export async function deleteVaultMaterial(hash: string): Promise<void> {
  const found = await getOne<VaultMaterial>(STORE_MATERIALS, hash);
  await write([STORE_MAPS, STORE_MATERIALS, STORE_SETTINGS], (tx) => {
    if (found) {
      const maps = tx.objectStore(STORE_MAPS);
      for (const m of found.maps) maps.delete(cacheUrl(hash, m.file));
    }
    tx.objectStore(STORE_MATERIALS).delete(hash);
    tx.objectStore(STORE_SETTINGS).put(true, deletedMaterialKey(hash));
  });
  for (const m of found?.maps ?? []) {
    const canonical = cacheUrl(hash, m.file);
    const url = blobUrls.get(canonical);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(canonical);
    }
  }
}

export async function deleteVaultPreset(slug: string): Promise<void> {
  await write([STORE_PRESETS, STORE_SETTINGS], (tx) => {
    tx.objectStore(STORE_PRESETS).delete(slug);
    tx.objectStore(STORE_SETTINGS).put(true, deletedPresetKey(slug));
  });
}

export interface DeleteVaultAuthoringInput {
  id: string;
  pkgHash: string;
  clone: boolean;
}

/** Remove an authored row, update clone ownership, and release its map package
 *  in one transaction. A canonical delete hides the package while clones still
 *  reference it; deleting the final clone releases a previously hidden owner. */
export async function deleteVaultAuthoringItem(
  input: DeleteVaultAuthoringInput,
): Promise<{ mapsReleased: boolean; packageReleased: boolean }> {
  const db = await openLoomDb();
  let mapsReleased = false;
  let packageReleased = false;
  let removedMaps: VaultMap[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [STORE_PRESETS, STORE_MATERIALS, STORE_MAPS, STORE_SETTINGS],
      "readwrite",
    );
    const presets = tx.objectStore(STORE_PRESETS);
    const materials = tx.objectStore(STORE_MATERIALS);
    const maps = tx.objectStore(STORE_MAPS);
    const settings = tx.objectStore(STORE_SETTINGS);
    presets.delete(input.id);
    settings.put(true, deletedPresetKey(input.id));
    if (!input.clone) settings.put(true, deletedMaterialKey(input.pkgHash));
    const presetsReq = presets.getAll();
    const materialReq = materials.get(input.pkgHash);
    let remaining: MaterialPreset[] | null = null;
    let material: VaultMaterial | null | undefined;

    const reconcile = () => {
      if (remaining === null || material === undefined) return;
      mapsReleased = !remaining.some(
        (preset) => preset.pkgHash === input.pkgHash,
      );
      const shouldRelease =
        Boolean(material) &&
        mapsReleased &&
        (!input.clone || Boolean(material?.hidden));
      if (shouldRelease) {
        packageReleased = true;
        removedMaps = material!.maps;
        for (const map of removedMaps) {
          maps.delete(cacheUrl(input.pkgHash, map.file));
        }
        materials.delete(input.pkgHash);
        settings.put(true, deletedMaterialKey(input.pkgHash));
      } else if (!input.clone && material) {
        materials.put({ ...material, hidden: true }, input.pkgHash);
      }
    };

    presetsReq.onsuccess = () => {
      remaining = (presetsReq.result as MaterialPreset[]) ?? [];
      reconcile();
    };
    materialReq.onsuccess = () => {
      material = (materialReq.result as VaultMaterial | undefined) ?? null;
      reconcile();
    };
    presetsReq.onerror = materialReq.onerror = () => tx.abort();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB delete failed"));
    };
    tx.onabort = tx.onerror;
  });
  for (const map of removedMaps) {
    const canonical = cacheUrl(input.pkgHash, map.file);
    const url = blobUrls.get(canonical);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(canonical);
    }
  }
  return { mapsReleased, packageReleased };
}

export function getVaultMaterial(hash: string): Promise<VaultMaterial | null> {
  return getOne<VaultMaterial>(STORE_MATERIALS, hash);
}

export async function setVaultMaterialHidden(
  hash: string,
  hidden: boolean,
): Promise<void> {
  const material = await getVaultMaterial(hash);
  if (!material) return;
  await put(STORE_MATERIALS, hash, { ...material, hidden });
}

const LIBRARY_ORDER_KEY = "libraryOrder";
const DELETED_MATERIAL_PREFIX = "deletedMaterial:";
const DELETED_PRESET_PREFIX = "deletedPreset:";

function deletedMaterialKey(hash: string): string {
  return `${DELETED_MATERIAL_PREFIX}${hash}`;
}

function deletedPresetKey(slug: string): string {
  return `${DELETED_PRESET_PREFIX}${slug}`;
}

export async function putVaultLibraryOrder(order: string[]): Promise<void> {
  await put(STORE_SETTINGS, LIBRARY_ORDER_KEY, [...order]);
}

export async function getVaultLibraryOrder(): Promise<string[] | null> {
  const value = await getOne<unknown>(STORE_SETTINGS, LIBRARY_ORDER_KEY);
  return Array.isArray(value) && value.every((id) => typeof id === "string")
    ? value
    : null;
}

export async function getVaultDeletedMaterialHashes(): Promise<Set<string>> {
  const keys = await getAllKeys(STORE_SETTINGS);
  return new Set(
    keys.flatMap((key) => {
      if (typeof key !== "string" || !key.startsWith(DELETED_MATERIAL_PREFIX)) {
        return [];
      }
      return [key.slice(DELETED_MATERIAL_PREFIX.length)];
    }),
  );
}

export async function getVaultDeletedPresetSlugs(): Promise<Set<string>> {
  const keys = await getAllKeys(STORE_SETTINGS);
  return new Set(
    keys.flatMap((key) => {
      if (typeof key !== "string" || !key.startsWith(DELETED_PRESET_PREFIX)) {
        return [];
      }
      return [key.slice(DELETED_PRESET_PREFIX.length)];
    }),
  );
}

/** All vaulted materials as CacheEntry-shaped records with blob: map URLs.
 *  A material whose bytes are missing (partial import, evicted) is dropped —
 *  a library row that can't paint its own maps is worse than no row. */
export async function hydrateVaultEntries(): Promise<HydratedEntry[]> {
  const materials = await getAll<VaultMaterial>(STORE_MATERIALS);
  const out: HydratedEntry[] = [];
  for (const mat of materials) {
    const bytesByFile = new Map<string, ArrayBuffer>();
    for (const m of mat.maps) {
      const canonical = cacheUrl(mat.hash, m.file);
      const bytes = await getOne<ArrayBuffer>(STORE_MAPS, canonical);
      if (!bytes || bytes.byteLength === 0) {
        bytesByFile.clear();
        break;
      }
      bytesByFile.set(m.file, bytes);
    }
    if (bytesByFile.size !== mat.maps.length) continue;
    const maps: HydratedEntry["maps"] = mat.maps.map((m) => {
      const canonical = cacheUrl(mat.hash, m.file);
      return {
        name: m.name,
        file: m.file,
        provenance: m.provenance,
        sourceHash: m.sourceHash,
        url: blobUrlFor(canonical, m.file, bytesByFile.get(m.file)!),
      };
    });
    out.push({
      hash: mat.hash,
      createdAt: mat.createdAt,
      prompt: mat.prompt,
      sourceFilename: mat.sourceFilename,
      maps,
      hidden: mat.hidden,
    });
  }
  return out;
}

export async function getVaultPresets(): Promise<MaterialPreset[]> {
  return getAll<MaterialPreset>(STORE_PRESETS);
}
