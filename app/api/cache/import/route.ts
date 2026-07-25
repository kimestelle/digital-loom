import {
  ensureCacheDir,
  readManifest,
  writeBinary,
  writeManifest,
} from "@/lib/fal/cache";

export const runtime = "nodejs";

const HASH_RE = /^[a-f0-9]{8,64}$/;
// Map images only; the extension whitelist keeps imports from planting
// arbitrary file types inside the cache.
const FILE_RE = /^[a-z0-9_-]+\.(png|jpg|jpeg|webp)$/;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Restore one material's maps into the extraction cache — the write half of
 *  a collection-zip import. Idempotent: a hash that already has a manifest is
 *  acknowledged without rewriting (the maps were content-addressed by the
 *  original extraction, so same hash = same pixels). */
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
  if (await readManifest(hash)) {
    return Response.json({ ok: true, existed: true });
  }

  const prompt = form.get("prompt");
  const sourceFilename = form.get("sourceFilename");
  const maps: { name: string; file: string }[] = [];
  await ensureCacheDir(hash);
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const file = value.name;
    if (!FILE_RE.test(file) || value.size > MAX_FILE_BYTES) {
      return Response.json({ error: `bad map file ${file}` }, { status: 400 });
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    await writeBinary(hash, file, bytes);
    maps.push({ name: key, file });
  }
  if (maps.length === 0) {
    return Response.json({ error: "no maps" }, { status: 400 });
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
    maps,
    rawResponsePath: "",
  });
  return Response.json({ ok: true, existed: false });
}
