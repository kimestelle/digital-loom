import { extractPatina } from "@/lib/fal/client";
import type { CachedMap } from "@/lib/fal/cache";

export const runtime = "nodejs";

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

  const rawPrompt = formData.get("prompt");
  const prompt =
    typeof rawPrompt === "string" && rawPrompt.trim().length > 0
      ? rawPrompt.trim()
      : "fabric";

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // A user-supplied fal key (workshop panel) rides in a header and takes
    // precedence over the server's env credential for this request.
    const userKey = request.headers.get("x-fal-key") ?? undefined;
    const { hash, manifest, cacheHit } = await extractPatina(
      bytes,
      file.name,
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
