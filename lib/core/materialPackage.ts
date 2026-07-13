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
 *  cache entry). `base` prefixes each file name. Cache/sample entries carry
 *  full per-map URLs instead — callers overwrite `url` after building.
 *  Unknown map names are skipped. */
export function pkgFromMaps(
  name: string,
  base: string,
  maps: { name: string; file: string }[],
  meta: { prompt?: string | null; sourceFilename?: string | null; hash?: string } = {},
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
      createdAt: new Date().toISOString(),
    },
  };
  for (const m of maps) {
    if (!(MAP_ORDER as string[]).includes(m.name)) continue;
    pkg.maps[m.name as MapName] = {
      name: m.name as MapName,
      url: base.endsWith("/") ? `${base}${m.file}` : `${base}/${m.file}`,
      provenance: "patina",
    };
  }
  return pkg;
}

export function serialize(pkg: MaterialPackage): string {
  return JSON.stringify(pkg, null, 2);
}

export function deserialize(json: string): MaterialPackage {
  const parsed = JSON.parse(json) as MaterialPackage;
  if (!parsed.id || !parsed.maps || !parsed.meta) {
    throw new Error("invalid MaterialPackage");
  }
  return parsed;
}
