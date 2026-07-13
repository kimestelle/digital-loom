import { readCachedFile } from "@/lib/fal/cache";

export const runtime = "nodejs";

const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  exr: "image/x-exr",
  json: "application/json",
};

const HASH_RE = /^[a-f0-9]{8,64}$/;
const FILE_RE = /^[A-Za-z0-9_.-]+$/;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ hash: string; file: string }> },
): Promise<Response> {
  const { hash, file } = await ctx.params;
  if (!HASH_RE.test(hash) || !FILE_RE.test(file)) {
    return new Response("bad path", { status: 400 });
  }
  const bytes = await readCachedFile(hash, file);
  if (!bytes) return new Response("not found", { status: 404 });

  const ext = file.substring(file.lastIndexOf(".") + 1).toLowerCase();
  const type = CONTENT_TYPE[ext] ?? "application/octet-stream";
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
