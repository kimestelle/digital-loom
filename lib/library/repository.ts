"use client";

// The durable authoring boundary. UI code talks to this module rather than
// deciding independently which server route or browser store owns a change.
// IndexedDB commits are authoritative; filesystem routes are compatibility
// mirrors for local development and still-warm serverless instances.

import { getCachedMap } from "@/lib/export/mapCache";
import {
  cacheUrl,
  deleteVaultAuthoringItem,
  getVaultLibraryOrder,
  putVaultLibraryOrder,
  putVaultCollection,
  putVaultMaterial,
  putVaultPreset,
  hydrateVaultEntry,
  type HydratedEntry,
  type VaultMaterial,
  type VaultMap,
} from "@/lib/library/vault";
import {
  PRESET_VERSION,
  type MaterialPreset,
} from "@/lib/presets/types";
import { mapPackageSha256 } from "@/lib/core/mapAsset";

export interface AuthoringMap extends VaultMap {
  url: string;
}

export interface AuthoringMaterial {
  hash: string;
  createdAt: string;
  prompt: string | null;
  sourceFilename: string | null;
  maps: AuthoringMap[];
  hidden?: boolean;
}

const FILE_RE = /^[A-Za-z0-9_.-]+$/;
const HASH_RE = /^[a-f0-9]{8,64}$/;

function validateMaterialRecord(material: VaultMaterial): void {
  if (!HASH_RE.test(material.hash)) {
    throw new Error("Material has an invalid content hash");
  }
  if (material.maps.length === 0) throw new Error("Material has no maps to save");
  const seenNames = new Set<string>();
  const seenFiles = new Set<string>();
  for (const map of material.maps) {
    if (
      !map.name ||
      !FILE_RE.test(map.file) ||
      seenNames.has(map.name) ||
      seenFiles.has(map.file)
    ) {
      throw new Error(`Material has an invalid map entry: ${map.file}`);
    }
    seenNames.add(map.name);
    seenFiles.add(map.file);
  }
}

/** Atomic insertion point for importers that already decoded the archive map
 *  bytes. This deliberately rejects non-hex identities because they cannot be
 *  addressed by the cache routes; call `normalizeAuthoringHash` first. */
export async function saveAuthoringMaterialBytes(
  material: VaultMaterial,
  bytesByFile: Map<string, ArrayBuffer>,
): Promise<void> {
  validateMaterialRecord(material);
  for (const map of material.maps) {
    const bytes = bytesByFile.get(map.file);
    if (!bytes || bytes.byteLength === 0) {
      throw new Error(`Missing bytes for ${map.file}`);
    }
  }
  await putVaultMaterial(material, bytesByFile);
}

/** Derive package identity from the complete named byte set. `sourceIdentity`
 *  is retained in the signature for callers and provenance, but never trusted
 *  as the address: a hex-looking source id is not proof of these map bytes. */
export async function normalizeAuthoringHash(
  _sourceIdentity: string,
  bytesByFile: Map<string, ArrayBuffer>,
): Promise<string> {
  return mapPackageSha256(bytesByFile);
}

async function bytesForMap(
  hash: string,
  map: AuthoringMap,
): Promise<ArrayBuffer> {
  const canonical = cacheUrl(hash, map.file);
  const cached =
    (await getCachedMap(canonical)) ??
    (canonical === map.url ? null : await getCachedMap(map.url));
  if (cached) return cached;
  let response: Response;
  try {
    response = await fetch(map.url);
  } catch (error) {
    throw new Error(
      `Could not save ${map.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Could not save ${map.name}: map returned ${response.status}`);
  }
  return response.arrayBuffer();
}

/** Fetch every declared map before opening the transaction, then atomically put
 *  all bytes plus metadata. A failed fetch leaves the previous vault row intact. */
export async function saveAuthoringMaterial(
  material: AuthoringMaterial,
): Promise<void> {
  const record: VaultMaterial = {
    hash: material.hash,
    createdAt: material.createdAt,
    prompt: material.prompt,
    sourceFilename: material.sourceFilename,
    maps: material.maps.map(({ name, file, provenance, sourceHash, asset }) => ({
      name,
      file,
      provenance,
      sourceHash,
      asset,
    })),
    hidden: material.hidden ?? false,
  };
  validateMaterialRecord(record);
  const pairs = await Promise.all(
    material.maps.map(async (map) => [map.file, await bytesForMap(material.hash, map)] as const),
  );
  await saveAuthoringMaterialBytes(record, new Map(pairs));
}

export type PresetDraft = Pick<
  MaterialPreset,
  "slug" | "name" | "fabricId" | "pkgHash" | "metalness" | "knobs"
>;

const presetQueues = new Map<string, Promise<unknown>>();

function enqueuePreset<T>(slug: string, job: () => Promise<T>): Promise<T> {
  const previous = presetQueues.get(slug) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(job);
  // Keep a rejection-safe tail in the queue. Using `current.finally(...)` as
  // the stored promise both made the identity check impossible and created an
  // unobserved rejected promise when a write failed.
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  presetQueues.set(slug, tail);
  void tail.then(() => {
    if (presetQueues.get(slug) === tail) presetQueues.delete(slug);
  });
  return current;
}

async function mirrorPresetToServer(preset: MaterialPreset): Promise<void> {
  try {
    await fetch("/api/presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preset),
    });
  } catch {
    // IndexedDB already committed. The server mirror is expendable.
  }
}

/** Atomic single-material restore: maps, package metadata, authored controls,
 *  and library order become visible together. Reusing the collection
 *  transaction keeps retry semantics identical for one-item and whole-library
 *  imports. */
export async function importAuthoringMaterialBytes(
  material: VaultMaterial,
  bytesByFile: Map<string, ArrayBuffer>,
  draft: PresetDraft,
  order: string[],
): Promise<MaterialPreset> {
  validateMaterialRecord(material);
  for (const map of material.maps) {
    const bytes = bytesByFile.get(map.file);
    if (!bytes || bytes.byteLength === 0) {
      throw new Error(`Missing bytes for ${map.file}`);
    }
  }
  const preset: MaterialPreset = {
    ...draft,
    version: PRESET_VERSION,
    createdAt: new Date().toISOString(),
  };
  await putVaultCollection(
    [{ material, bytesByFile }],
    [preset],
    [...order],
  );
  return preset;
}

/** Local commit first, ordered per material; the returned object is exactly what
 *  was committed and can be folded into React state immediately. */
export function saveAuthoringPreset(
  draft: PresetDraft,
  options: { mirrorToServer?: boolean } = {},
): Promise<MaterialPreset> {
  return enqueuePreset(draft.slug, async () => {
    const preset: MaterialPreset = {
      ...draft,
      version: PRESET_VERSION,
      createdAt: new Date().toISOString(),
    };
    await putVaultPreset(preset);
    if (options.mirrorToServer !== false) void mirrorPresetToServer(preset);
    return preset;
  });
}

/** Targeted read-back for a just-committed authoring operation. */
export function loadAuthoringEntry(
  hash: string,
): Promise<HydratedEntry | null> {
  return hydrateVaultEntry(hash);
}

/** One-time migration path for seed/runtime presets discovered on the server. */
export async function adoptServerPreset(preset: MaterialPreset): Promise<void> {
  await putVaultPreset(preset);
}

let orderQueue: Promise<void> = Promise.resolve();

export function saveAuthoringOrder(order: string[]): Promise<void> {
  const snapshot = [...order];
  orderQueue = orderQueue.catch(() => undefined).then(() => putVaultLibraryOrder(snapshot));
  return orderQueue;
}

export function loadAuthoringOrder(): Promise<string[] | null> {
  return getVaultLibraryOrder();
}

export interface DeleteAuthoringInput {
  id: string;
  pkgHash: string;
  clone: boolean;
}

export interface DeleteAuthoringResult {
  /** True when no remaining local preset references the package. */
  mapsReleased: boolean;
  /** True when this action removed a locally owned package. */
  packageReleased: boolean;
}

/** Delete parameters without breaking clones that still wear the same map
 *  package. A deleted canonical material becomes a hidden map owner until its
 *  last clone is removed. */
export function deleteAuthoringItem(
  input: DeleteAuthoringInput,
): Promise<DeleteAuthoringResult> {
  return enqueuePreset(input.id, async () => {
    const { mapsReleased, packageReleased } =
      await deleteVaultAuthoringItem(input);

    // Compatibility mirrors happen only after the durable mutation succeeds.
    void (async () => {
      try {
        await fetch(`/api/presets?slug=${encodeURIComponent(input.id)}`, {
          method: "DELETE",
        });
      } catch {
        // best-effort
      }
    })();
    if ((!input.clone && mapsReleased) || packageReleased) {
      void (async () => {
        try {
          await fetch(`/api/cache/${input.pkgHash}`, { method: "DELETE" });
        } catch {
          // best-effort
        }
      })();
    }
    return { mapsReleased, packageReleased };
  });
}
