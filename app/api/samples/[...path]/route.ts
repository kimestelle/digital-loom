import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const SAMPLES_DIR = path.resolve(process.cwd(), "samples");
const SEG_RE = /^[A-Za-z0-9_.-]+$/;

const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};

/** Serve a file nested inside samples/ (e.g. samples/teal-tweed/albedo.png).
 *  Each path segment is validated and the resolved path is confined to
 *  SAMPLES_DIR so no `..` can escape. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segs } = await ctx.params;
  if (!segs?.length || segs.some((s) => !SEG_RE.test(s))) {
    return new Response("bad path", { status: 400 });
  }
  const abs = path.join(SAMPLES_DIR, ...segs);
  const rel = path.relative(SAMPLES_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const bytes = await fs.readFile(abs);
    const ext = abs.substring(abs.lastIndexOf(".") + 1).toLowerCase();
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
