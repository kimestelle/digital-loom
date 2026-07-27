"use client";

// ─── materialExport.ts ────────────────────────────────────────────────────────
// Turn the currently-loaded material into a portable bundle every 3D toolchain
// can read: PBR-suffixed maps, a packed ORM, a self-contained .glb specimen,
// a machine-readable material.json (maps + PBR scalars + loom-native physics +
// provenance), and a README with a copy-paste three.js snippet and per-engine
// import steps. All client-side — the maps are already served, the scalars
// already live in React state. three + jszip are imported lazily so they never
// weigh down the main bundle.

import type * as THREE from "three"; // types only — runtime is dynamic-imported
import type { MaterialPackage } from "@/lib/core/materialPackage";
import type { FabricKnobs } from "@/lib/ui/knobs";
import type { FabricProfile } from "@/lib/cloth/fabrics";
import { getCachedMap, putCachedMap } from "@/lib/export/mapCache";

export interface ExportInput {
  /** Display name; also the folder + file-stem (slugified). */
  name: string;
  pkg: MaterialPackage;
  knobs: FabricKnobs;
  /** Insert-panel metalness amount (0..1). */
  metalness: number;
  /** Curved openness (what the shader/transmission actually sees). */
  openness: number;
  /** Base fabric profile — carries the loom-native physics + weave identity. */
  fabric: FabricProfile;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "material"
  );
}

// Cloth map name → the PBR filename suffix 3D tools expect (Blender's Node
// Wrangler, Unity, Unreal all key auto-import off these).
const SUFFIX: Record<string, string> = {
  albedo: "BaseColor",
  normal: "Normal",
  roughness: "Roughness",
  metalness: "Metallic",
  height: "Height",
  ao: "AO",
};

/** Bytes for a map, browser-cache first. Same reliability path as the
 *  collection export: the server extraction cache is a plain directory,
 *  ephemeral on serverless hosts (see lib/fal/cache.ts), so a map the user is
 *  looking at right now can still 404 there. Read the IndexedDB copy warmed on
 *  selection before touching the network. Returns null (rather than throwing)
 *  when a map is genuinely unavailable, so one missing map doesn't sink the
 *  whole bundle — the README/json are generated from the maps that made it in. */
async function fetchMapBytes(url: string): Promise<ArrayBuffer | null> {
  const cached = await getCachedMap(url);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) return null;
  const bytes = await r.arrayBuffer();
  void putCachedMap(url, bytes);
  return bytes;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`img load ${url}`));
    img.src = url;
  });
}

/** Pack ORM (Occlusion / Roughness / Metallic) into one RGB texture — the
 *  glTF + Unreal convention: R = AO, G = roughness, B = metalness. Missing
 *  inputs get their neutral: AO → white, metal → black, rough → mid-grey. */
async function packORM(
  roughUrl: string | undefined,
  metalUrl: string | undefined,
  aoUrl: string | undefined,
): Promise<Blob | null> {
  const rough = roughUrl ? await loadImage(roughUrl) : null;
  const metal = metalUrl ? await loadImage(metalUrl) : null;
  const ao = aoUrl ? await loadImage(aoUrl) : null;
  const size = rough?.naturalWidth || metal?.naturalWidth || ao?.naturalWidth || 1024;

  const read = (img: HTMLImageElement | null): Uint8ClampedArray | null => {
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  };
  const rd = read(rough);
  const md = read(metal);
  const ad = read(ao);

  const out = document.createElement("canvas");
  out.width = out.height = size;
  const octx = out.getContext("2d");
  if (!octx) return null;
  const outData = octx.createImageData(size, size);
  const n = size * size;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    outData.data[j] = ad ? ad[j] : 255; // occlusion (white = unoccluded)
    outData.data[j + 1] = rd ? rd[j] : 128; // roughness
    outData.data[j + 2] = md ? md[j] : 0; // metalness (black = dielectric)
    outData.data[j + 3] = 255;
  }
  octx.putImageData(outData, 0, 0);
  return new Promise((resolve) => out.toBlob((b) => resolve(b), "image/png"));
}

/** A self-contained .glb: a unit plane wearing the material, standard PBR
 *  plus KHR_materials_sheen and _transmission so the fabric's sheen and
 *  see-through-ness survive into any glTF viewer. */
async function buildGlb(
  albedoUrl: string | undefined,
  normalUrl: string | undefined,
  ormBlob: Blob | null,
  scalars: { metalness: number; sheen: number; transmission: number; baseColor: number },
): Promise<ArrayBuffer> {
  const THREE = await import("three");
  const { GLTFExporter } = await import(
    "three/examples/jsm/exporters/GLTFExporter.js"
  );

  const texFromImage = (img: HTMLImageElement, srgb: boolean): THREE.Texture => {
    const t = new THREE.Texture(img);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(scalars.baseColor, scalars.baseColor, scalars.baseColor),
    metalness: scalars.metalness,
    roughness: 1,
    sheen: scalars.sheen,
    sheenColor: new THREE.Color(0xf3dcb1),
    sheenRoughness: 0.8,
    transmission: scalars.transmission,
    thickness: 0.35,
    ior: 1.4,
    side: THREE.DoubleSide,
  });
  if (albedoUrl) mat.map = texFromImage(await loadImage(albedoUrl), true);
  if (normalUrl) mat.normalMap = texFromImage(await loadImage(normalUrl), false);
  if (ormBlob) {
    const ormUrl = URL.createObjectURL(ormBlob);
    // glTF references ONE ORM texture for both occlusion (R) and
    // metallic-roughness (G,B); assigning the same texture to all three slots
    // is exactly what GLTFExporter merges into that single reference.
    const orm = texFromImage(await loadImage(ormUrl), false);
    mat.aoMap = orm;
    mat.roughnessMap = orm;
    mat.metalnessMap = orm;
    URL.revokeObjectURL(ormUrl);
  }

  const geom = new THREE.PlaneGeometry(1, 1);
  // aoMap reads uv2; plane only has uv, so copy it.
  geom.setAttribute("uv2", geom.getAttribute("uv"));
  const mesh = new THREE.Mesh(geom, mat);
  const scene = new THREE.Scene();
  scene.add(mesh);

  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => resolve(result as ArrayBuffer),
      (err) => reject(err),
      { binary: true },
    );
  });
}

function buildMaterialJson(input: ExportInput, files: Record<string, string>): string {
  const { pkg, knobs, metalness, openness, fabric } = input;
  const doc = {
    schema: "loom.material/1",
    name: input.name,
    createdAt: pkg.meta.createdAt,
    provenance: {
      // Honest receipt — this material was AI-extracted, not authored.
      extractor: "fal-ai/patina/material/extract",
      prompt: pkg.meta.captureNotes ?? null,
      sourceHash: pkg.id,
      note: "PBR maps AI-extracted from a single photo via Patina.",
    },
    files,
    pbr: {
      metalness,
      // roughness/ao/metalness are map-driven (multiplier 1); sheen +
      // transmission are the fabric-specific extras.
      sheen: knobs.sheen,
      transmission: Number((openness * 0.4).toFixed(3)),
      transmissionSource: "openness (curved) × 0.4",
      albedoAmount: knobs.albedoAmount,
      tileScale: knobs.tileScale,
    },
    // Loom-native cloth dynamics — no engine has a standard for these, so
    // ship the raw values + semantics rather than a lossy mapping.
    physics: {
      weaveType: fabric.core.weaveType,
      fiberType: fabric.core.fiberType,
      warpStiffness: knobs.warpStiffness,
      weftStiffness: knobs.weftStiffness,
      shearStiffness: knobs.shearStiffness,
      bendStiffness: knobs.bendStiffness,
      weight: knobs.weight,
      openness: knobs.openness,
      note: "0..1 stiffness → XPBD compliance; bend separates the fabrics.",
    },
    identity: {
      fabricId: fabric.id,
      nameKo: fabric.nameKo,
      nameRoman: fabric.nameRoman,
      nameEn: fabric.nameEn,
    },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function buildReadme(input: ExportInput, files: Record<string, string>): string {
  const { name, knobs, metalness, openness, fabric } = input;
  const stem = slugify(name);
  const transmission = (openness * 0.4).toFixed(2);
  const has = (k: string) => Boolean(files[k]);
  const snippet = `import * as THREE from "three";

const tl = new THREE.TextureLoader();
const srgb = (t) => ((t.colorSpace = THREE.SRGBColorSpace), t);

const material = new THREE.MeshPhysicalMaterial({
  map:          srgb(tl.load("${files.baseColor ?? ""}")),${
    has("normal") ? `\n  normalMap:    tl.load("${files.normal}"),` : ""
  }${has("orm") ? `\n  roughnessMap: tl.load("${files.orm}"), // G = roughness` : ""}${
    has("orm") ? `\n  metalnessMap: tl.load("${files.orm}"), // B = metalness` : ""
  }${has("orm") ? `\n  aoMap:        tl.load("${files.orm}"), // R = occlusion` : ""}
  metalness:     ${metalness},
  roughness:     1,
  sheen:         ${knobs.sheen},
  sheenColor:    new THREE.Color(0xf3dcb1),
  sheenRoughness: 0.8,
  transmission:  ${transmission}, // fabric openness → see-through
  thickness:     0.35,
  ior:           1.4,
  side:          THREE.DoubleSide,
});
// aoMap needs a second UV set: geometry.setAttribute("uv2", geometry.getAttribute("uv"));`;

  return `# ${name}

AI-extracted fabric material (${fabric.nameKo} · ${fabric.nameEn}), captured from a single
photo via Patina and dialed in with **loom**. Tileable PBR maps + a ready-to-drop
\`.glb\`, plus the cloth's motion character for physics-aware pipelines.

## Files

| file | use |
|---|---|
${files.baseColor ? `| \`${files.baseColor}\` | base color / albedo (sRGB) |\n` : ""}${files.normal ? `| \`${files.normal}\` | normal (OpenGL, Y+) |\n` : ""}${files.roughness ? `| \`${files.roughness}\` | roughness (linear) |\n` : ""}${files.metallic ? `| \`${files.metallic}\` | metalness (linear) |\n` : ""}${files.height ? `| \`${files.height}\` | height / displacement |\n` : ""}${files.orm ? `| \`${files.orm}\` | packed **O**cclusion·**R**oughness·**M**etallic (glTF/Unreal) |\n` : ""}| \`${stem}.glb\` | self-contained specimen (PBR + sheen + transmission) |
| \`material.json\` | maps + PBR scalars + cloth physics + provenance |

## Import

- **Blender** — enable *Node Wrangler*, add a Principled BSDF, \`Ctrl+Shift+T\`, select all the map PNGs. Suffixes auto-wire.
- **Unreal / glTF** — use \`${files.orm ?? "the ORM"}\` as the packed metallic-roughness (+occlusion) texture.
- **Unity (HDRP/URP)** — BaseColor + Normal + \`${files.orm ?? "ORM"}\` (Mask/MetallicSmoothness); note Unity wants **DirectX (Y−)** normals — flip the green channel if it looks inverted.
- **three.js / R3F** — the \`.glb\` drops straight in, or use the snippet below.

## three.js

\`\`\`js
${snippet}
\`\`\`

## Cloth physics (loom-native)

Not a PBR standard — these describe how the fabric *moves* (0..1 stiffness →
XPBD compliance). See \`material.json → physics\`.

| axis | value |
|---|---|
| weave | ${fabric.core.weaveType} |
| warp / weft | ${knobs.warpStiffness} / ${knobs.weftStiffness} |
| shear | ${knobs.shearStiffness} |
| bend | ${knobs.bendStiffness} |
| weight | ${knobs.weight} |

*Extracted via Patina · packaged by loom.*
`;
}

/** Build + download the bundle. Returns the filename it saved. */
export async function exportMaterial(input: ExportInput): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const stem = slugify(input.name);
  const zip = new JSZip();
  const folder = zip.folder(stem)!;
  const files: Record<string, string> = {};

  const m = input.pkg.maps;
  // Renamed raw maps.
  const rawJobs: Promise<void>[] = [];
  for (const [cloth, suffix] of Object.entries(SUFFIX)) {
    const entry = m[cloth as keyof typeof m];
    if (!entry) continue;
    const fname = `${stem}_${suffix}.png`;
    const key = cloth === "albedo" ? "baseColor" : cloth === "metalness" ? "metallic" : cloth;
    rawJobs.push(
      fetchMapBytes(entry.url).then((buf) => {
        if (!buf) {
          console.warn(`[export] map unavailable, skipped: ${entry.url}`);
          return;
        }
        folder.file(fname, buf);
        // Record only maps that made it in, so material.json + README never
        // reference a file that isn't in the zip.
        files[key] = fname;
      }),
    );
  }
  await Promise.all(rawJobs);

  // Packed ORM.
  try {
    const orm = await packORM(m.roughness?.url, m.metalness?.url, m.ao?.url);
    if (orm) {
      const fname = `${stem}_ORM.png`;
      files.orm = fname;
      folder.file(fname, orm);
    }
  } catch {
    // non-fatal — skip ORM
  }

  // GLB specimen (best-effort — the maps + json still ship if it throws).
  try {
    const orm = files.orm ? await packORM(m.roughness?.url, m.metalness?.url, m.ao?.url) : null;
    const glb = await buildGlb(m.albedo?.url, m.normal?.url, orm, {
      metalness: input.metalness,
      sheen: input.knobs.sheen,
      transmission: input.openness * 0.4,
      baseColor: m.albedo ? 1 : 0.75,
    });
    folder.file(`${stem}.glb`, glb);
    files.glb = `${stem}.glb`;
  } catch {
    // non-fatal
  }

  folder.file("material.json", buildMaterialJson(input, files));
  folder.file("README.md", buildReadme(input, files));

  const blob = await zip.generateAsync({ type: "blob" });
  const filename = `${stem}.zip`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}
