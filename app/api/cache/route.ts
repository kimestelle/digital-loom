import { listCacheEntries } from "@/lib/fal/cache";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const entries = await listCacheEntries();
  const payload = entries.map((m) => ({
    hash: m.hash,
    endpoint: m.endpoint,
    createdAt: m.createdAt,
    prompt: m.prompt ?? null,
    sourceFilename: m.sourceFilename ?? null,
    maps: m.maps.map((mp) => ({
      name: mp.name,
      file: mp.file,
      url: `/api/cache/${m.hash}/${mp.file}`,
    })),
  }));
  return Response.json({ entries: payload });
}
