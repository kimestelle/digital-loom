import "server-only";
import { fal } from "@fal-ai/client";
import type { MapName } from "@/lib/core/materialPackage";
import {
  hashBytes,
  readManifest,
  writeBinary,
  writeManifest,
  writeText,
  type Manifest,
  type CachedMap,
} from "./cache";

let configuredKey: string | null = null;
function configure(userKey?: string): void {
  // A caller-supplied key (the user's own fal account) beats the server's
  // env credential. fal.config is module-global, so re-configure whenever
  // the effective key changes.
  const credentials =
    userKey?.trim() || process.env.FAL_API_KEY || process.env.FAL_KEY;
  if (!credentials) {
    throw new Error(
      "No fal key: set FAL_API_KEY in the server env, or paste your own key in the workshop panel.",
    );
  }
  if (configuredKey === credentials) return;
  fal.config({ credentials });
  configuredKey = credentials;
}

export const PATINA_ENDPOINT =
  process.env.PATINA_ENDPOINT_ID ?? "fal-ai/patina/material/extract";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/x-exr": "exr",
  "image/exr": "exr",
};

interface UrlLike {
  url?: string;
  content_type?: string;
}

interface PatinaImage extends UrlLike {
  map_type?: string;
  file_name?: string;
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

function extractMapUrls(response: unknown): Partial<Record<MapName, UrlLike>> {
  const found: Partial<Record<MapName, UrlLike>> = {};
  const root =
    response && typeof response === "object" && "data" in (response as object)
      ? (response as { data: unknown }).data
      : response;
  if (!root || typeof root !== "object") return found;
  const images = (root as { images?: unknown }).images;
  if (!Array.isArray(images)) return found;
  for (const img of images as PatinaImage[]) {
    if (!img?.url || !img.map_type) continue;
    const key = img.map_type.toLowerCase();
    const name = MAP_TYPE_TO_NAME[key];
    if (!name) continue;
    if (!found[name]) found[name] = img;
  }
  return found;
}

function extForUrl(url: string, contentType?: string): string {
  if (contentType && EXT_BY_CONTENT_TYPE[contentType]) {
    return EXT_BY_CONTENT_TYPE[contentType];
  }
  const clean = url.split("?")[0];
  const tail = clean.substring(clean.lastIndexOf(".") + 1).toLowerCase();
  if (tail.length >= 2 && tail.length <= 4) return tail;
  return "png";
}

async function downloadToBuffer(url: string): Promise<{
  bytes: Uint8Array;
  contentType?: string;
}> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: ${url} → ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get("content-type") ?? undefined };
}

export interface ExtractResult {
  hash: string;
  manifest: Manifest;
  cacheHit: boolean;
}

export async function extractPatina(
  imageBytes: Uint8Array,
  filename: string,
  prompt: string,
  userKey?: string,
): Promise<ExtractResult> {
  const hash = hashBytes(imageBytes, `${PATINA_ENDPOINT}|${prompt}`);
  const existing = await readManifest(hash);
  if (existing) return { hash, manifest: existing, cacheHit: true };

  configure(userKey);

  const blob = new Blob([imageBytes as unknown as BlobPart]);
  const file = new File([blob], filename || "input.png");
  const uploadedUrl = await fal.storage.upload(file);

  const submission = await fal.subscribe(PATINA_ENDPOINT, {
    input: {
      prompt,
      image_url: uploadedUrl,
      tiling_mode: "both",
    },
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS") {
        for (const log of update.logs ?? []) {
          if (log?.message) console.log(`[patina] ${log.message}`);
        }
      }
    },
  });

  await writeText(hash, "response.json", JSON.stringify(submission, null, 2));

  const urls = extractMapUrls(submission);
  const cachedMaps: CachedMap[] = [];
  for (const [name, ref] of Object.entries(urls) as [MapName, UrlLike][]) {
    if (!ref.url) continue;
    const dl = await downloadToBuffer(ref.url);
    const ext = extForUrl(ref.url, ref.content_type ?? dl.contentType);
    const file = `${name}.${ext}`;
    await writeBinary(hash, file, dl.bytes);
    cachedMaps.push({ name, file });
  }

  const manifest: Manifest = {
    endpoint: PATINA_ENDPOINT,
    hash,
    createdAt: new Date().toISOString(),
    prompt,
    sourceFilename: filename || undefined,
    maps: cachedMaps,
    rawResponsePath: "response.json",
  };
  await writeManifest(manifest);
  return { hash, manifest, cacheHit: false };
}
