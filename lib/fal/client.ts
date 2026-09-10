import "server-only";
import { createFalClient, type FalClient } from "@fal-ai/client";
import {
  hashBytes,
  readManifest,
  writeBinary,
  writeManifest,
  writeText,
  type Manifest,
  type CachedMap,
} from "./cache";
import {
  missingRequiredPatinaMaps,
  parsePatinaMapRefs,
  type PatinaMapRef,
} from "./response";
import { inspectMapAsset } from "../core/mapAsset";

export interface FalCredentialEnvironment {
  FAL_KEY?: string;
  FAL_API_KEY?: string;
}

/**
 * Resolve credentials at the request boundary without mutating the fal SDK's
 * process-wide singleton. A user-provided key is intentionally first; FAL_KEY
 * is the canonical server setting and FAL_API_KEY remains a migration fallback.
 */
export function resolveFalCredentials(
  userKey?: string,
  environment: FalCredentialEnvironment = {
    FAL_KEY: process.env.FAL_KEY,
    FAL_API_KEY: process.env.FAL_API_KEY,
  },
): string {
  const credentials =
    userKey?.trim() ||
    environment.FAL_KEY?.trim() ||
    environment.FAL_API_KEY?.trim();
  if (!credentials) {
    throw new Error(
      "No fal key: set FAL_KEY in the server environment, or paste your own key in the material import panel.",
    );
  }
  return credentials;
}

function clientFor(userKey?: string): FalClient {
  // A caller-supplied key (the user's own fal account) beats the server's
  // env credential. Each extraction receives an isolated SDK client: mutating
  // the package-level singleton allowed overlapping requests from two people
  // to race and potentially continue under the wrong account.
  return createFalClient({ credentials: resolveFalCredentials(userKey) });
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
  contentType: string,
  prompt: string,
  userKey?: string,
): Promise<ExtractResult> {
  const hash = hashBytes(imageBytes, `${PATINA_ENDPOINT}|${prompt}`);
  const existing = await readManifest(hash);
  if (existing) {
    const existingNames = Object.fromEntries(
      existing.maps.map((map) => [map.name, true]),
    );
    if (missingRequiredPatinaMaps(existingNames).length === 0) {
      return { hash, manifest: existing, cacheHit: true };
    }
  }

  const fal = clientFor(userKey);

  const file = new File([imageBytes as unknown as BlobPart], filename || "input.png", {
    type: contentType,
  });
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

  const urls = parsePatinaMapRefs(submission);
  const missing = missingRequiredPatinaMaps(urls);
  if (missing.length > 0) {
    throw new Error(`Patina response omitted required maps: ${missing.join(", ")}`);
  }
  const cachedMaps: CachedMap[] = [];
  for (const [name, ref] of Object.entries(urls) as [CachedMap["name"], PatinaMapRef][]) {
    const dl = await downloadToBuffer(ref.url);
    if (dl.bytes.byteLength === 0) {
      throw new Error(`Patina returned an empty ${name} map`);
    }
    const ext = extForUrl(ref.url, ref.contentType ?? dl.contentType);
    const file = `${name}.${ext}`;
    await writeBinary(hash, file, dl.bytes);
    const mapBytes = dl.bytes.buffer.slice(
      dl.bytes.byteOffset,
      dl.bytes.byteOffset + dl.bytes.byteLength,
    ) as ArrayBuffer;
    cachedMaps.push({ name, file, asset: await inspectMapAsset(mapBytes) });
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
