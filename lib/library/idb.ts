"use client";

// ─── library/idb.ts ───────────────────────────────────────────────────────────
// The single owner of the browser-local IndexedDB used for loom persistence.
// One database, one version, one upgrade path — so the raw map-byte cache
// (lib/export/mapCache.ts) and the durable library registry (lib/library/vault.ts)
// can never disagree about the schema.
//
// Stores:
//   maps      — raw map bytes (ArrayBuffer), keyed by their /api/cache/<hash>/<file> URL.
//   materials — imported material metadata (VaultMaterial), keyed by pkg hash.
//   presets   — imported material params (MaterialPreset), keyed by slug.
//
// Why this exists at all: on serverless hosts the server-side extraction cache
// lives in /tmp, which is per-instance and wiped on cold start (see
// lib/fal/cache.ts). Importing a collection there writes maps to whatever
// instance served each request, so a later read sees only a scattered subset —
// often one. The browser is the one place that reliably holds a user's imported
// library, so that's where it lives.
//
// Best-effort throughout: IndexedDB can be unavailable (private browsing, quota,
// disabled). Callers degrade to "act as if nothing is stored" rather than throw.

export const DB_NAME = "loom-map-cache";
// v1 shipped with only the `maps` store; v2 adds `materials` + `presets`.
export const DB_VERSION = 2;

export const STORE_MAPS = "maps";
export const STORE_MATERIALS = "materials";
export const STORE_PRESETS = "presets";

export function openLoomDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Idempotent: create only the stores that don't exist yet, so upgrading
      // from v1 (maps only) adds the two new stores without touching cached bytes.
      if (!db.objectStoreNames.contains(STORE_MAPS)) {
        db.createObjectStore(STORE_MAPS);
      }
      if (!db.objectStoreNames.contains(STORE_MATERIALS)) {
        db.createObjectStore(STORE_MATERIALS);
      }
      if (!db.objectStoreNames.contains(STORE_PRESETS)) {
        db.createObjectStore(STORE_PRESETS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** True for URLs whose bytes are already in memory this session (blob:) or
 *  inline (data:) — pointless and wasteful to (re)cache in IndexedDB, and
 *  their keys are ephemeral, so caching under them would just leak orphaned
 *  copies on every page load. */
export function isTransientUrl(url: string): boolean {
  return url.startsWith("blob:") || url.startsWith("data:");
}
