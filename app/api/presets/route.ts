import {
  deletePreset,
  listPresets,
  savePreset,
} from "@/lib/presets/store";
import type { MaterialPreset } from "@/lib/presets/types";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const presets = await listPresets();
  return Response.json({ presets });
}

export async function POST(request: Request): Promise<Response> {
  let body: Partial<MaterialPreset>;
  try {
    body = (await request.json()) as Partial<MaterialPreset>;
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return Response.json({ error: "preset needs a name" }, { status: 400 });
  }
  if (typeof body.knobs !== "object" || body.knobs === null) {
    return Response.json({ error: "preset needs knobs" }, { status: 400 });
  }
  try {
    const saved = await savePreset({
      name: body.name.trim(),
      slug: typeof body.slug === "string" ? body.slug : undefined,
      fabricId: (body.fabricId ?? "myeongju") as MaterialPreset["fabricId"],
      pkgHash: typeof body.pkgHash === "string" ? body.pkgHash : null,
      metalness: typeof body.metalness === "number" ? body.metalness : 0,
      knobs: body.knobs,
    });
    return Response.json({ preset: saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) {
    return Response.json({ error: "missing ?slug=" }, { status: 400 });
  }
  const ok = await deletePreset(slug);
  return ok
    ? Response.json({ deleted: slug })
    : Response.json({ error: "not found" }, { status: 404 });
}
