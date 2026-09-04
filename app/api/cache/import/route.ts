import {
  ensureCacheDir,
  readManifest,
  writeBinary,
  writeManifest,
  readCachedFile,
} from "@/lib/fal/cache";
import { inspectMapAsset, sha256Hex } from "@/lib/core/mapAsset";
import { MAP_ORDER } from "@/lib/core/materialPackage";

export const runtime = "nodejs";

const HASH_RE = /^[a-f0-9]{8,64}$/;
// Map images only; the extension whitelist keeps imports from planting
// arbitrary file types inside the cache.
const FILE_RE = /^[a-z0-9_-]+\.(png|jpg|jpeg|webp|exr)$/;
const MAP_NAMES = new Set<string>(MAP_ORDER);
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Restore one material's maps into the extraction cache — the write half of
 *  a collection-zip import. Reusing an address is idempotent only when every
 *  named file has the same digest; an arbitrary hex id is not trusted. */
export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart form" }, { status: 400 });
  }
  const hash = String(form.get("hash") ?? "");
  if (!HASH_RE.test(hash)) {
    return Response.json({ error: "bad hash" }, { status: 400 });
  }
  const prompt = form.get("prompt");
  const sourceFilename = form.get("sourceFilename");
  const prepared: {
    name: string;
    file: string;
    bytes: Uint8Array;
    asset: Awaited<ReturnType<typeof inspectMapAsset>>;
  }[] = [];
  let totalBytes = 0;
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const file = value.name;
    if (
      !MAP_NAMES.has(key) ||
      !FILE_RE.test(file) ||
      value.size === 0 ||
      value.size > MAX_FILE_BYTES
    ) {
      return Response.json({ error: `bad map file ${file}` }, { status: 400 });
    }
    totalBytes += value.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return Response.json({ error: "map package is too large" }, { status: 413 });
    }
    const buffer = await value.arrayBuffer();
    try {
      prepared.push({
        name: key,
        file,
        bytes: new Uint8Array(buffer),
        asset: await inspectMapAsset(buffer),
      });
    } catch (error) {
      return Response.json(
        {
          error: `bad map file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 400 },
      );
    }
  }
  if (prepared.length === 0) {
    return Response.json({ error: "no maps" }, { status: 400 });
  }
  if (
    new Set(prepared.map((map) => map.name)).size !== prepared.length ||
    new Set(prepared.map((map) => map.file)).size !== prepared.length
  ) {
    return Response.json({ error: "duplicate map names or files" }, { status: 400 });
  }

  const existing = await readManifest(hash);
  if (existing) {
    const existingKeys = existing.maps
      .map((map) => `${map.name}:${map.file}`)
      .sort();
    const incomingKeys = prepared
      .map((map) => `${map.name}:${map.file}`)
      .sort();
    if (existingKeys.join("\n") !== incomingKeys.join("\n")) {
      return Response.json(
        { error: "hash already belongs to a different map package" },
        { status: 409 },
      );
    }
    for (const map of prepared) {
      const stored = await readCachedFile(hash, map.file);
      if (!stored) {
        return Response.json(
          { error: `hash has an incomplete stored map: ${map.file}` },
          { status: 409 },
        );
      }
      const storedBuffer = stored.buffer.slice(
        stored.byteOffset,
        stored.byteOffset + stored.byteLength,
      ) as ArrayBuffer;
      if ((await sha256Hex(storedBuffer)) !== map.asset.sha256) {
        return Response.json(
          { error: `hash already belongs to different bytes for ${map.file}` },
          { status: 409 },
        );
      }
    }
    return Response.json({ ok: true, existed: true });
  }

  await ensureCacheDir(hash);
  for (const map of prepared) {
    await writeBinary(hash, map.file, map.bytes);
  }
  await writeManifest({
    endpoint: "collection-import",
    hash,
    createdAt: new Date().toISOString(),
    prompt: typeof prompt === "string" && prompt ? prompt : undefined,
    sourceFilename:
      typeof sourceFilename === "string" && sourceFilename
        ? sourceFilename
        : undefined,
    maps: prepared.map(({ name, file, asset }) => ({ name, file, asset })),
    rawResponsePath: "",
  });
  return Response.json({ ok: true, existed: false });
}
