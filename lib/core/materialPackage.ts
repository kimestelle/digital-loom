export type MapName =
  | "albedo"
  | "normal"
  | "roughness"
  | "metalness"
  | "height"
  | "ao"
  | "transmission"
  | "anisoDirection"
  | "anisoCoherence";

export type Provenance =
  | "captured"
  | "patina"
  | "derived"
  | "predicted"
  | "upscaled";

export interface MapEntry {
  name: MapName;
  url: string;
  provenance: Provenance;
  sourceHash?: string;
}

export interface MaterialPackage {
  id: string;
  maps: Partial<Record<MapName, MapEntry>>;
  params: Record<string, number>;
  meta: {
    fabricName: string;
    captureNotes?: string;
    createdAt: string;
  };
}

export const MAP_ORDER: MapName[] = [
  "albedo",
  "normal",
  "roughness",
  "metalness",
  "height",
  "ao",
  "transmission",
  "anisoDirection",
  "anisoCoherence",
];

export function emptyPackage(fabricName: string): MaterialPackage {
  return {
    id: crypto.randomUUID(),
    maps: {},
    params: {},
    meta: { fabricName, createdAt: new Date().toISOString() },
  };
}

/** Build a package from a manifest-style map list (pregen bundle, sample, or
 *  cache entry). `base` prefixes bare file names; hydrated entries can supply
 *  their full URL and authored provenance directly. Unknown map names are
 *  skipped. */
export function pkgFromMaps(
  name: string,
  base: string,
  maps: {
    name: string;
    file: string;
    /** Hydrated cache/vault entries already have their session-local URL. */
    url?: string;
    provenance?: Provenance;
    sourceHash?: string;
  }[],
  meta: {
    prompt?: string | null;
    sourceFilename?: string | null;
    hash?: string;
    /** Preserve the package timestamp when rebuilding a runtime projection. */
    createdAt?: string;
  } = {},
): MaterialPackage {
  const pkg: MaterialPackage = {
    id: meta.hash ?? crypto.randomUUID(),
    maps: {},
    params: {},
    meta: {
      fabricName: name,
      captureNotes: meta.prompt
        ? `prompt: ${meta.prompt}${meta.sourceFilename ? ` · ${meta.sourceFilename}` : ""}`
        : undefined,
      createdAt: meta.createdAt ?? new Date().toISOString(),
    },
  };
  for (const m of maps) {
    if (!(MAP_ORDER as string[]).includes(m.name)) continue;
    const provenance = m.provenance ?? "patina";
    pkg.maps[m.name as MapName] = {
      name: m.name as MapName,
      url:
        m.url ??
        (base.endsWith("/") ? `${base}${m.file}` : `${base}/${m.file}`),
      provenance,
      // Older Patina manifests did not repeat the extraction hash per map.
      // Their package hash is the map source identity; authored/derived maps
      // retain an explicitly stored sourceHash (including `undefined`).
      sourceHash:
        m.sourceHash ??
        (m.provenance === undefined && provenance === "patina"
          ? meta.hash
          : undefined),
    };
  }
  return pkg;
}

/**
 * @deprecated Runtime snapshot only. It omits the authored fabric state and map
 * file metadata; use loomMaterial.ts + the single-material bundle reader/writer
 * for interchange.
 */
export function serialize(pkg: MaterialPackage): string {
  return JSON.stringify(pkg, null, 2);
}

/** @deprecated Runtime snapshot reader; not a Loom interchange parser. */
export function deserialize(json: string): MaterialPackage {
  const parsed = JSON.parse(json) as MaterialPackage;
  if (!parsed.id || !parsed.maps || !parsed.meta) {
    throw new Error("invalid MaterialPackage");
  }
  return parsed;
}
