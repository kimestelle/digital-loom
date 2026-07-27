"use client";

// ─── library/vault.ts ─────────────────────────────────────────────────────────
// The browser-local, durable home for a user's imported materials. Where the
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
// Best-effort: any IndexedDB failure degrades to "no vault", never throws.

import {
  openLoomDb,
  STORE_MAPS,
  STORE_MATERIALS,
  STORE_PRESETS,
} from "@/lib/library/idb";
import { getCachedMap, putCachedMap } from "@/lib/export/mapCache";
import type { MaterialPreset } from "@/lib/presets/types";

export interface VaultMap {
  name: string;
  file: string;
}

export interface VaultMaterial {
  hash: string;
  prompt: string | null;
  sourceFilename: string | null;
  createdAt: string;
  maps: VaultMap[];
}

/** CacheEntry-shaped record the library consumes. Structurally identical to the
 *  page's CacheEntry, but its map URLs are blob: URLs backed by IndexedDB. */
export interface HydratedEntry {
  hash: string;
  createdAt: string;
  prompt: string | null;
  sourceFilename: string | null;
  maps: { name: string; file: string; url: string }[];
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

function getAll<T>(store: string): Promise<T[]> {
  return (async () => {
    try {
      const db = await openLoomDb();
      return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve((req.result as T[]) ?? []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  })();
}

function put(store: string, key: string, value: unknown): Promise<void> {
  return (async () => {
    try {
      const db = await openLoomDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // best-effort
    }
  })();
}

function del(store: string, key: string): Promise<void> {
  return (async () => {
    try {
      const db = await openLoomDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // best-effort
    }
  })();
}

/** Persist one imported material: its map bytes (under canonical URLs) and its
 *  metadata. Returns false only if the material record itself couldn't be
 *  written — the caller uses that to decide the import partially failed. */
export async function putVaultMaterial(
  material: VaultMaterial,
  bytesByFile: Map<string, ArrayBuffer>,
): Promise<boolean> {
  for (const m of material.maps) {
    const bytes = bytesByFile.get(m.file);
    if (bytes) await putCachedMap(cacheUrl(material.hash, m.file), bytes);
  }
  try {
    await put(STORE_MATERIALS, material.hash, material);
    return true;
  } catch {
    return false;
  }
}

export async function putVaultPreset(preset: MaterialPreset): Promise<void> {
  await put(STORE_PRESETS, preset.slug, preset);
}

export async function deleteVaultMaterial(hash: string): Promise<void> {
  const materials = await getAll<VaultMaterial>(STORE_MATERIALS);
  const found = materials.find((m) => m.hash === hash);
  if (found) {
    for (const m of found.maps) {
      const canonical = cacheUrl(hash, m.file);
      await del(STORE_MAPS, canonical);
      const url = blobUrls.get(canonical);
      if (url) {
        URL.revokeObjectURL(url);
        blobUrls.delete(canonical);
      }
    }
  }
  await del(STORE_MATERIALS, hash);
}

export async function deleteVaultPreset(slug: string): Promise<void> {
  await del(STORE_PRESETS, slug);
}

/** All vaulted materials as CacheEntry-shaped records with blob: map URLs.
 *  A material whose bytes are missing (partial import, evicted) is dropped —
 *  a library row that can't paint its own maps is worse than no row. */
export async function hydrateVaultEntries(): Promise<HydratedEntry[]> {
  const materials = await getAll<VaultMaterial>(STORE_MATERIALS);
  const out: HydratedEntry[] = [];
  for (const mat of materials) {
    const maps: HydratedEntry["maps"] = [];
    for (const m of mat.maps) {
      const canonical = cacheUrl(mat.hash, m.file);
      const bytes = await getCachedMap(canonical);
      if (!bytes) continue; // bytes gone — skip this map
      maps.push({ name: m.name, file: m.file, url: blobUrlFor(canonical, m.file, bytes) });
    }
    if (maps.length === 0) continue; // nothing paintable — skip the material
    out.push({
      hash: mat.hash,
      createdAt: mat.createdAt,
      prompt: mat.prompt,
      sourceFilename: mat.sourceFilename,
      maps,
    });
  }
  return out;
}

export async function getVaultPresets(): Promise<MaterialPreset[]> {
  return getAll<MaterialPreset>(STORE_PRESETS);
}
