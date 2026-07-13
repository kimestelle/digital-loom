import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const SAMPLES_DIR = path.resolve(process.cwd(), "samples");

interface SampleManifest {
  label: string;
  prompt?: string;
  sourceFile?: string;
  hash: string;
  maps: { name: string; file: string }[];
}

/** List the built-in sample materials (each a folder under samples/ with a
 *  manifest + baked patina maps). Map URLs point back at the nested file
 *  server so the client can dress the cloth exactly like a cache entry. */
export async function GET(): Promise<Response> {
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(SAMPLES_DIR);
  } catch {
    return Response.json({ samples: [] });
  }
  const samples = [];
  for (const label of dirs) {
    if (label.startsWith(".")) continue;
    try {
      const raw = await fs.readFile(
        path.join(SAMPLES_DIR, label, "manifest.json"),
        "utf8",
      );
      const m = JSON.parse(raw) as SampleManifest;
      samples.push({
        label: m.label ?? label,
        prompt: m.prompt ?? null,
        hash: m.hash,
        maps: m.maps.map((mp) => ({
          name: mp.name,
          file: mp.file,
          url: `/api/samples/${label}/${mp.file}`,
        })),
      });
    } catch {
      // not a sample folder — skip
    }
  }
  samples.sort((a, b) => a.label.localeCompare(b.label));
  return Response.json({ samples });
}
