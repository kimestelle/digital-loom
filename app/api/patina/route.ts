import { extractPatina } from "@/lib/fal/client";
import type { CachedMap } from "@/lib/fal/cache";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

interface MapPayload extends CachedMap {
  url: string;
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = formData.get("image");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing 'image' file field" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: "image must be between 1 byte and 4 MB" },
      { status: 413 },
    );
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType =
    file.type.toLowerCase() || IMAGE_TYPE_BY_EXTENSION[extension] || "";
  if (!ACCEPTED_IMAGE_TYPES.has(contentType)) {
    return Response.json(
      { error: "image must be PNG, JPEG, or WebP" },
      { status: 415 },
    );
  }

  const rawPrompt = formData.get("prompt");
  const prompt =
    typeof rawPrompt === "string" && rawPrompt.trim().length > 0
      ? rawPrompt.trim()
      : "fabric";
  if (prompt.length > 500) {
    return Response.json(
      { error: "prompt must be 500 characters or fewer" },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // A user-supplied fal key (workshop panel) rides in a header and takes
    // precedence over the server's env credential for this request.
    const userKey = request.headers.get("x-fal-key") ?? undefined;
    const { hash, manifest, cacheHit } = await extractPatina(
      bytes,
      file.name,
      contentType,
      prompt,
      userKey,
    );
    const maps: MapPayload[] = manifest.maps.map((m) => ({
      ...m,
      url: `/api/cache/${hash}/${m.file}`,
    }));
    return Response.json({
      hash,
      endpoint: manifest.endpoint,
      createdAt: manifest.createdAt,
      cacheHit,
      maps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
