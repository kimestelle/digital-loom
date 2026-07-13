import { deleteCacheEntry, readManifest } from "@/lib/fal/cache";

export const runtime = "nodejs";

const HASH_RE = /^[a-f0-9]{8,64}$/;

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const { hash } = await ctx.params;
  if (!HASH_RE.test(hash)) {
    return new Response("bad hash", { status: 400 });
  }
  // Only delete directories that are actually cache entries (have a
  // manifest) — refuses stray paths that merely look hash-shaped.
  const manifest = await readManifest(hash);
  if (!manifest) return new Response("not found", { status: 404 });

  const ok = await deleteCacheEntry(hash);
  return ok
    ? Response.json({ deleted: hash })
    : new Response("delete failed", { status: 500 });
}
