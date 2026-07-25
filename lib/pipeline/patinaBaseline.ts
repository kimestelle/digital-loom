import {
  emptyPackage,
  type MapEntry,
  type MapName,
  type MaterialPackage,
} from "@/lib/core/materialPackage";

interface PatinaMapPayload {
  name: string;
  file: string;
  url: string;
}

interface PatinaResponse {
  hash: string;
  endpoint: string;
  createdAt: string;
  cacheHit: boolean;
  maps: PatinaMapPayload[];
}

const VALID: MapName[] = [
  "albedo",
  "normal",
  "roughness",
  "metalness",
  "height",
  "ao",
];

function isValidName(n: string): n is MapName {
  return (VALID as readonly string[]).includes(n);
}

export interface BaselineOptions {
  fabricName: string;
  prompt?: string;
  captureNotes?: string;
  captured?: {
    frontLitUrl?: string;
    backLitUrl?: string;
  };
}

export interface BaselineResult {
  pkg: MaterialPackage;
  hash: string;
  cacheHit: boolean;
  endpoint: string;
}

export async function runPatinaBaseline(
  frontLit: File | Blob,
  opts: BaselineOptions,
): Promise<BaselineResult> {
  const form = new FormData();
  const file =
    frontLit instanceof File
      ? frontLit
      : new File([frontLit], "front-lit.png", { type: "image/png" });
  form.append("image", file);
  form.append("prompt", opts.prompt?.trim() || "fabric");

  // The user's own fal key (if saved in the workshop panel) travels per
  // request; the server falls back to its env credential when absent.
  const userKey =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("loom.falKey")?.trim()
      : null;
  const res = await fetch("/api/patina", {
    method: "POST",
    body: form,
    headers: userKey ? { "x-fal-key": userKey } : undefined,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      `Patina extract failed (${res.status}): ${errBody.error ?? res.statusText}`,
    );
  }
  const data = (await res.json()) as PatinaResponse;

  const pkg = emptyPackage(opts.fabricName);
  if (opts.captureNotes) pkg.meta.captureNotes = opts.captureNotes;

  for (const m of data.maps) {
    if (!isValidName(m.name)) continue;
    const entry: MapEntry = {
      name: m.name,
      url: m.url,
      provenance: "patina",
      sourceHash: data.hash,
    };
    pkg.maps[m.name] = entry;
  }

  if (opts.captured?.frontLitUrl) {
    pkg.meta.captureNotes = [
      pkg.meta.captureNotes,
      `frontLit=${opts.captured.frontLitUrl}`,
    ]
      .filter(Boolean)
      .join(" | ");
  }
  if (opts.captured?.backLitUrl) {
    pkg.meta.captureNotes = [
      pkg.meta.captureNotes,
      `backLit=${opts.captured.backLitUrl}`,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return { pkg, hash: data.hash, cacheHit: data.cacheHit, endpoint: data.endpoint };
}
