import type { MapName } from "@/lib/core/materialPackage";

export interface PatinaMapRef {
  url: string;
  contentType?: string;
}

interface PatinaImage {
  url?: unknown;
  content_type?: unknown;
  map_type?: unknown;
}

const MAP_TYPE_TO_NAME: Record<string, MapName> = {
  basecolor: "albedo",
  albedo: "albedo",
  diffuse: "albedo",
  normal: "normal",
  roughness: "roughness",
  metalness: "metalness",
  metallic: "metalness",
  height: "height",
  displacement: "height",
  ao: "ao",
  ambient_occlusion: "ao",
};

/** Maps the fal response to the names used by Loom. The material extractor is
 * expected to return these four maps; metalness/AO remain optional because a
 * dielectric material may legitimately omit them. */
export const REQUIRED_PATINA_MAPS = [
  "albedo",
  "normal",
  "roughness",
  "height",
] as const satisfies readonly MapName[];

export function parsePatinaMapRefs(
  response: unknown,
): Partial<Record<MapName, PatinaMapRef>> {
  const found: Partial<Record<MapName, PatinaMapRef>> = {};
  const root =
    response && typeof response === "object" && "data" in response
      ? (response as { data: unknown }).data
      : response;
  if (!root || typeof root !== "object") return found;
  const images = (root as { images?: unknown }).images;
  if (!Array.isArray(images)) return found;
  for (const image of images as PatinaImage[]) {
    if (typeof image.url !== "string" || typeof image.map_type !== "string") {
      continue;
    }
    const name = MAP_TYPE_TO_NAME[image.map_type.toLowerCase()];
    if (!name || found[name]) continue;
    found[name] = {
      url: image.url,
      contentType:
        typeof image.content_type === "string"
          ? image.content_type.toLowerCase()
          : undefined,
    };
  }
  return found;
}

export function missingRequiredPatinaMaps(
  maps: Partial<Record<MapName, unknown>>,
): MapName[] {
  return REQUIRED_PATINA_MAPS.filter((name) => !maps[name]);
}
