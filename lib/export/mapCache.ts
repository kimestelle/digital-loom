"use client";

// ─── mapCache.ts ──────────────────────────────────────────────────────────────
// Browser-local cache for material map bytes, keyed by their
// /api/cache/<hash>/<file> URL. Backed by the shared loom IndexedDB (see
// lib/library/idb.ts). Not a replacement for the server-side extraction cache —
// but the server cache is a plain directory on disk (ephemeral on serverless
// hosts — see lib/fal/cache.ts), so a map that briefly 404s there shouldn't also
// sink a zip export of a material the user is actively looking at right now.
// warmMapCache primes this cache the moment a material's maps are known
// (selection); collectionExport reads from it first and only falls back to the
// network. Collection IMPORT also populates it, so imported materials keep
// working even when the server cache has recycled (see lib/library/vault.ts).
//
// Best-effort throughout: every function degrades to "act as if nothing was
// cached" rather than throwing.

import { openLoomDb, STORE_MAPS, isTransientUrl } from "@/lib/library/idb";

export async function getCachedMap(url: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openLoomDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MAPS, "readonly");
      const req = tx.objectStore(STORE_MAPS).get(url);
      req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCachedMap(url: string, bytes: ArrayBuffer): Promise<void> {
  // blob:/data: keys are ephemeral — caching under them just leaks a fresh
  // orphaned copy of the same bytes on every page load. The canonical
  // /api/cache URL is the durable key.
  if (isTransientUrl(url)) return;
  try {
    const db = await openLoomDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MAPS, "readwrite");
      tx.objectStore(STORE_MAPS).put(bytes, url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Quota/availability failures are fine to swallow — this is a cache.
  }
}

/** Fire-and-forget: warm the cache for a material's maps right when it's
 *  selected/loaded, so a later zip export can read bytes already sitting in
 *  the browser instead of depending on the server cache still having them. */
export function warmMapCache(urls: string[]): void {
  for (const url of urls) {
    // A blob: URL is already backed by bytes in memory (and, for vaulted
    // materials, by the canonical copy already in IndexedDB) — nothing to warm.
    if (isTransientUrl(url)) continue;
    void (async () => {
      if (await getCachedMap(url)) return;
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        await putCachedMap(url, await r.arrayBuffer());
      } catch {
        // Best-effort warm — a real export attempt will retry the fetch.
      }
    })();
  }
}
