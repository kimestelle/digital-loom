import { MAP_ORDER } from "../core/materialPackage";
import {
  parseLoomMaterial,
  type LoomMaterialV3,
} from "../core/loomMaterial";
import type { FabricKnobs } from "../ui/knobs";
import {
  validateMapAssetMetadata,
  type MapAssetMetadata,
} from "../core/mapAsset";

export interface ManifestMaterial {
  slug: string;
  name: string;
  id: string;
  pkgHash: string;
  prompt?: string;
  sourceFilename?: string;
  maps?: Record<string, string>;
  /** Byte metadata for every owned map. Optional only for legacy v1 archives. */
  mapAssets?: Partial<Record<(typeof MAP_ORDER)[number], MapAssetMetadata>>;
  mapsOf?: string;
  /** Canonical authored state. New exports write this; `params` remains only
   *  as a compatibility mirror for collection readers predating material/2. */
  material?: LoomMaterialV3;
  /** @deprecated Read only for older collection archives. */
  params?: {
    fabricId: string;
    metalness: number;
    knobs: FabricKnobs;
  };
}

export interface CollectionManifest {
  app: "digital-loom";
  kind: "collection";
  version: 1 | 2;
  exportedAt: string;
  order: string[];
  materials: ManifestMaterial[];
}

export const CURRENT_COLLECTION_VERSION = 2 as const;
const SUPPORTED_VERSIONS = [1, CURRENT_COLLECTION_VERSION] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Validate the whole manifest before an importer reads or writes archive data. */
export function validateCollectionManifest(value: unknown): CollectionManifest {
  if (!isRecord(value) || value.app !== "digital-loom" || value.kind !== "collection") {
    throw new Error("not a loom collection zip");
  }
  if (!SUPPORTED_VERSIONS.includes(value.version as 1 | 2)) {
    throw new Error(
      `unsupported collection version ${String(value.version)} — this build reads versions ${SUPPORTED_VERSIONS.join(" and ")}`,
    );
  }
  if (!Array.isArray(value.materials) || !Array.isArray(value.order)) {
    throw new Error("invalid loom collection manifest");
  }
  const materials: ManifestMaterial[] = value.materials.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`invalid material at index ${index}`);
    for (const field of ["slug", "name", "id", "pkgHash"] as const) {
      if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
        throw new Error(`material ${index} has invalid ${field}`);
      }
    }
    if (candidate.maps !== undefined) {
      if (!isRecord(candidate.maps)) throw new Error(`material ${index} has invalid maps`);
      const paths = new Set<string>();
      for (const [name, path] of Object.entries(candidate.maps)) {
        if (
          !MAP_ORDER.includes(name as (typeof MAP_ORDER)[number]) ||
          typeof path !== "string" ||
          !/^[a-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(path) ||
          paths.has(path)
        ) {
          throw new Error(`material ${index} has an invalid map path`);
        }
        paths.add(path);
      }
    }
    let mapAssets: ManifestMaterial["mapAssets"];
    if (candidate.mapAssets !== undefined) {
      if (!isRecord(candidate.mapAssets)) {
        throw new Error(`material ${index} has invalid mapAssets`);
      }
      mapAssets = {};
      for (const [name, metadata] of Object.entries(candidate.mapAssets)) {
        if (!MAP_ORDER.includes(name as (typeof MAP_ORDER)[number])) {
          throw new Error(`material ${index} has an invalid map asset name`);
        }
        mapAssets[name as (typeof MAP_ORDER)[number]] =
          validateMapAssetMetadata(
            metadata,
            `material ${index} mapAssets.${name}`,
          );
      }
      const mapNames = Object.keys(candidate.maps ?? {}).sort();
      const assetNames = Object.keys(mapAssets).sort();
      if (mapNames.join("\n") !== assetNames.join("\n")) {
        throw new Error(`material ${index} map assets must describe every owned map`);
      }
    }
    if (candidate.mapsOf !== undefined && typeof candidate.mapsOf !== "string") {
      throw new Error(`material ${index} has invalid mapsOf`);
    }
    let material: LoomMaterialV3 | undefined;
    if (candidate.material !== undefined) {
      material = parseLoomMaterial(candidate.material);
      if (
        material.id !== candidate.id ||
        material.name !== candidate.name ||
        material.source.identity !== candidate.pkgHash
      ) {
        throw new Error(`material ${index} canonical identity does not match its collection entry`);
      }
    }
    if (candidate.params !== undefined) {
      if (
        !isRecord(candidate.params) ||
        typeof candidate.params.fabricId !== "string" ||
        typeof candidate.params.metalness !== "number" ||
        !isRecord(candidate.params.knobs)
      ) {
        throw new Error(`material ${index} has invalid params`);
      }
      if (
        material &&
        (candidate.params.fabricId !== material.fabric.id ||
          candidate.params.metalness !== material.authored.metalness ||
          JSON.stringify(candidate.params.knobs) !==
            JSON.stringify(material.authored.knobs))
      ) {
        throw new Error(`material ${index} compatibility params disagree with canonical material`);
      }
    }
    return {
      ...(candidate as unknown as ManifestMaterial),
      material,
      mapAssets,
    };
  });

  const slugs = materials.map((material) => material.slug);
  const ids = materials.map((material) => material.id);
  if (new Set(slugs).size !== slugs.length || new Set(ids).size !== ids.length) {
    throw new Error("collection material identities must be unique");
  }
  const order = value.order;
  if (
    !order.every((slug): slug is string => typeof slug === "string") ||
    order.length !== slugs.length ||
    new Set(order).size !== order.length ||
    order.some((slug) => !slugs.includes(slug))
  ) {
    throw new Error("collection order must name every material exactly once");
  }
  const bySlug = new Map(materials.map((material) => [material.slug, material]));
  const mapOwnerByHash = new Map<string, ManifestMaterial>();
  for (const material of materials) {
    if (!/^[a-f0-9]{8,64}$/.test(material.pkgHash)) {
      throw new Error(`material ${material.slug} has an invalid package hash`);
    }
    if (material.maps && Object.keys(material.maps).length > 0) {
      if (mapOwnerByHash.has(material.pkgHash)) {
        throw new Error(`package ${material.pkgHash} has multiple map owners`);
      }
      mapOwnerByHash.set(material.pkgHash, material);
    }
    if (!material.mapsOf && !material.maps) {
      throw new Error(`material ${material.slug} has no map package`);
    }
  }
  for (const material of materials) {
    if (material.mapsOf) {
      const owner = bySlug.get(material.mapsOf);
      if (
        !owner ||
        owner.pkgHash !== material.pkgHash ||
        !owner.maps ||
        Object.keys(owner.maps).length === 0
      ) {
        throw new Error(`map owner ${material.mapsOf} is missing or incompatible`);
      }
    } else if (!mapOwnerByHash.has(material.pkgHash)) {
      throw new Error(`material ${material.slug} has no complete map owner`);
    }
    if (material.material) {
      const owner = mapOwnerByHash.get(material.pkgHash);
      const archivedFiles = new Map(
        Object.entries(owner?.maps ?? {}).map(([name, path]) => [
          name,
          path.split("/").pop()!,
        ]),
      );
      for (const name of MAP_ORDER) {
        const descriptor = material.material.maps[name];
        const archived = archivedFiles.get(name);
        if (Boolean(descriptor) !== Boolean(archived)) {
          throw new Error(
            `material ${material.slug} map contract disagrees with its package`,
          );
        }
        if (descriptor && descriptor.file !== archived) {
          throw new Error(
            `material ${material.slug} map filename disagrees with its package`,
          );
        }
        const asset = owner?.mapAssets?.[name];
        if (
          descriptor?.asset &&
          asset &&
          JSON.stringify(descriptor.asset) !== JSON.stringify(asset)
        ) {
          throw new Error(
            `material ${material.slug} map asset metadata disagrees with its package`,
          );
        }
      }
    }
  }
  return {
    app: "digital-loom",
    kind: "collection",
    version: value.version as 1 | 2,
    exportedAt:
      typeof value.exportedAt === "string"
        ? value.exportedAt
        : new Date().toISOString(),
    order,
    materials,
  };
}

export function collectionOrderIds(manifest: CollectionManifest): string[] {
  const idBySlug = new Map(
    manifest.materials.map((material) => [material.slug, material.id]),
  );
  return manifest.order.map((slug) => idBySlug.get(slug)!);
}
