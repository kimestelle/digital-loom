"use client";

import type * as THREE from "three";
import {
  MAP_ORDER,
  type MapEntry,
  type MapName,
  type MaterialPackage,
} from "../core/materialPackage";
import {
  LOOM_MATERIAL_SCHEMA,
  isLoomMapExtension,
  mimeTypeForMapExtension,
  parseLoomMaterial,
  serializeLoomMaterial,
  type LoomMapExtension,
  type LoomMapFile,
  type LoomMapMimeType,
  type LoomMaterialV2,
} from "../core/loomMaterial";
import type { FabricKnobs } from "../ui/knobs";
import type { FabricProfile } from "../cloth/fabrics";

export interface ExportInput {
  name: string;
  pkg: MaterialPackage;
  knobs: FabricKnobs;
  metalness: number;
  /** Curved openness used by the current renderer. Retained for GLB output. */
  openness: number;
  fabric: FabricProfile;
  /** Optional stable identity for a clone/variant; package id is the fallback. */
  materialId?: string;
  /** Optional source override for non-Patina integrations. */
  source?: { identity?: string; extractor?: string | null };
}

export type MaterialExportStage = "map" | "orm" | "glb" | "download";
export interface MaterialExportIssue {
  stage: MaterialExportStage;
  code:
    | "map-unavailable"
    | "map-format-unsupported"
    | "orm-failed"
    | "glb-failed"
    | "download-failed";
  message: string;
  map?: MapName;
}

export interface MaterialExportResult {
  filename: string;
  /** ZIP bytes are exposed so callers can persist/share without rebuilding. */
  bytes: Uint8Array;
  blob: Blob;
  document: LoomMaterialV2;
  includedFiles: string[];
  issues: MaterialExportIssue[];
  complete: boolean;
}

export interface ResolvedMapInput {
  bytes: ArrayBuffer;
  /** Optional hints; magic-byte detection remains authoritative. */
  mimeType?: string;
  extension?: string;
}
export type MaterialMapResolver = (
  name: MapName,
  entry: MapEntry,
) => Promise<ResolvedMapInput | null>;
export interface MaterialBundleOptions {
  /** Called exactly once for every map present in the package. */
  resolveMap?: MaterialMapResolver;
  /** Raw-map-only mode for environments without Canvas/Three. Default: true. */
  includeDerivedArtifacts?: boolean;
}

export interface ReopenedMaterialBundle {
  document: LoomMaterialV2;
  pkg: MaterialPackage;
  knobs: FabricKnobs;
  metalness: number;
  mapBytes: Partial<Record<MapName, ArrayBuffer>>;
  revoke: () => void;
}

interface ResolvedMap {
  bytes: ArrayBuffer;
  descriptor: LoomMapFile;
}

type MapResolutionOutcome =
  | { issue: MaterialExportIssue }
  | { name: MapName; asset: ResolvedMap }
  | null;

const SUFFIX: Record<MapName, string> = {
  albedo: "BaseColor",
  normal: "Normal",
  roughness: "Roughness",
  metalness: "Metallic",
  height: "Height",
  ao: "AO",
  transmission: "Transmission",
  anisoDirection: "AnisoDirection",
  anisoCoherence: "AnisoCoherence",
};

const MIME_BY_EXTENSION: Record<LoomMapExtension, LoomMapMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  exr: "image/x-exr",
};
const DEFAULT_EXTENSION_BY_MIME: Record<
  LoomMapMimeType,
  LoomMapExtension
> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/x-exr": "exr",
};

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

function normalizeMime(value?: string): LoomMapMimeType | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  if (mime === "image/exr") return "image/x-exr";
  if (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/webp" ||
    mime === "image/x-exr"
  ) {
    return mime;
  }
  return null;
}

function extensionFromPath(value?: string): LoomMapExtension | null {
  if (!value) return null;
  const direct = value.toLowerCase();
  if (isLoomMapExtension(direct)) return direct;
  const clean = value.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  const ext = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
  return isLoomMapExtension(ext) ? ext : null;
}

function sniffMime(bytes: ArrayBuffer): LoomMapMimeType | null {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16));
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    b.length >= 4 &&
    b[0] === 0x76 &&
    b[1] === 0x2f &&
    b[2] === 0x31 &&
    b[3] === 0x01
  ) {
    return "image/x-exr";
  }
  return null;
}

export function detectMapFormat(
  bytes: ArrayBuffer,
  hints: { mimeType?: string; extension?: string; url?: string } = {},
): { mimeType: LoomMapMimeType; extension: LoomMapExtension } | null {
  const pathExtension =
    extensionFromPath(hints.extension) ?? extensionFromPath(hints.url);
  const hintedMime = normalizeMime(hints.mimeType);
  const mime =
    sniffMime(bytes) ??
    hintedMime ??
    (pathExtension ? mimeTypeForMapExtension(pathExtension) : null);
  if (!mime) return null;
  const extension =
    pathExtension && MIME_BY_EXTENSION[pathExtension] === mime
      ? pathExtension
      : DEFAULT_EXTENSION_BY_MIME[mime];
  return { mimeType: mime, extension };
}

async function defaultResolveMap(
  _name: MapName,
  entry: MapEntry,
): Promise<ResolvedMapInput | null> {
  const { getCachedMap, putCachedMap } = await import("./mapCache");
  const cached = await getCachedMap(entry.url);
  if (cached) {
    return {
      bytes: cached,
      extension: extensionFromPath(entry.url) ?? undefined,
    };
  }
  try {
    const response = await fetch(entry.url);
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    void putCachedMap(entry.url, bytes);
    return {
      bytes,
      mimeType: response.headers.get("content-type") ?? undefined,
      extension: extensionFromPath(entry.url) ?? undefined,
    };
  } catch {
    return null;
  }
}

function sourceIdentity(input: ExportInput): string {
  if (input.source?.identity?.trim()) return input.source.identity.trim();
  const sources = MAP_ORDER.flatMap((name) => {
    const hash = input.pkg.maps[name]?.sourceHash;
    return hash ? [`${name}:${hash}`] : [];
  });
  if (sources.length === 0) return input.pkg.id;
  const hashes = [
    ...new Set(sources.map((value) => value.slice(value.indexOf(":") + 1))),
  ];
  if (hashes.length === 1) return hashes[0];
  return `maps:${sources.join("|")}`;
}

function extractorFor(input: ExportInput): string | null {
  if (input.source && "extractor" in input.source) {
    return input.source.extractor ?? null;
  }
  return MAP_ORDER.some(
    (name) => input.pkg.maps[name]?.provenance === "patina",
  )
    ? "fal-ai/patina/material/extract"
    : null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image decode failed: ${url}`));
    image.src = url;
  });
}

async function imageFromMap(asset: ResolvedMap): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(
    new Blob([asset.bytes], { type: asset.descriptor.mimeType }),
  );
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function packORM(
  roughness?: ResolvedMap,
  metalness?: ResolvedMap,
  ao?: ResolvedMap,
): Promise<Blob | null> {
  const [rough, metal, occ] = await Promise.all([
    roughness ? imageFromMap(roughness) : null,
    metalness ? imageFromMap(metalness) : null,
    ao ? imageFromMap(ao) : null,
  ]);
  const basis = rough ?? metal ?? occ;
  if (!basis) return null;
  const width = basis.naturalWidth;
  const height = basis.naturalHeight;

  const read = (image: HTMLImageElement | null): Uint8ClampedArray | null => {
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  };
  const roughData = read(rough);
  const metalData = read(metal);
  const occData = read(occ);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const out = context.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    out.data[j] = occData ? occData[j] : 255;
    out.data[j + 1] = roughData ? roughData[j] : 128;
    out.data[j + 2] = metalData ? metalData[j] : 0;
    out.data[j + 3] = 255;
  }
  context.putImageData(out, 0, 0);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/png"),
  );
}

async function buildGlb(
  albedo: ResolvedMap | undefined,
  normal: ResolvedMap | undefined,
  ormBlob: Blob | null,
  scalars: {
    metalness: number;
    sheen: number;
    transmission: number;
    baseColor: number;
  },
): Promise<ArrayBuffer> {
  const THREE = await import("three");
  const { GLTFExporter } = await import(
    "three/examples/jsm/exporters/GLTFExporter.js"
  );
  const textureFromImage = (
    image: HTMLImageElement,
    srgb: boolean,
  ): THREE.Texture => {
    const texture = new THREE.Texture(image);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(
      scalars.baseColor,
      scalars.baseColor,
      scalars.baseColor,
    ),
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
  if (albedo) material.map = textureFromImage(await imageFromMap(albedo), true);
  if (normal) {
    material.normalMap = textureFromImage(await imageFromMap(normal), false);
  }
  if (ormBlob) {
    const url = URL.createObjectURL(ormBlob);
    try {
      const orm = textureFromImage(await loadImage(url), false);
      material.aoMap = orm;
      material.roughnessMap = orm;
      material.metalnessMap = orm;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute("uv2", geometry.getAttribute("uv"));
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => resolve(result as ArrayBuffer),
      (error) => reject(error),
      { binary: true },
    );
  });
}

function mapUse(name: MapName): string {
  const uses: Record<MapName, string> = {
    albedo: "base color / albedo (sRGB)",
    normal: "normal (OpenGL, Y+; linear)",
    roughness: "roughness (linear)",
    metalness: "metalness (linear)",
    height: "height / displacement (linear)",
    ao: "ambient occlusion (linear)",
    transmission: "transmission / porosity (linear)",
    anisoDirection: "anisotropy direction (linear)",
    anisoCoherence: "anisotropy coherence (linear)",
  };
  return uses[name];
}

function buildReadme(
  material: LoomMaterialV2,
  issues: MaterialExportIssue[],
): string {
  const { name, authored, fabric, maps, artifacts } = material;
  const lines: string[] = [
    `# ${name}`,
    "",
    "Fabric material authored in Digital Loom. The bundle contains the maps that",
    "were available at export time plus the complete material control state in",
    `\`material.json\` (${LOOM_MATERIAL_SCHEMA}).`,
    "",
    "## Files",
    "",
    "| file | use |",
    "|---|---|",
  ];
  for (const mapName of MAP_ORDER) {
    const map = maps[mapName];
    if (map) lines.push(`| \`${map.file}\` | ${mapUse(mapName)} |`);
  }
  if (artifacts.orm) {
    lines.push(
      `| \`${artifacts.orm.file}\` | packed occlusion (R), roughness (G), metalness (B) |`,
    );
  }
  if (artifacts.glb) {
    lines.push(`| \`${artifacts.glb.file}\` | self-contained glTF specimen |`);
  }
  lines.push(
    "| `material.json` | canonical authored state, map descriptors, and provenance |",
    "| `README.md` | this file |",
    "",
    "## Import",
    "",
  );
  if (maps.albedo || maps.normal || maps.roughness || maps.metalness) {
    lines.push(
      "- **Blender** — add a Principled BSDF and connect the suffixed PBR maps.",
    );
  }
  if (artifacts.orm) {
    lines.push(
      `- **Unreal / glTF** — use \`${artifacts.orm.file}\` as the packed ORM texture.`,
    );
  }
  if (artifacts.glb) {
    lines.push(
      `- **three.js / R3F / glTF viewers** — load \`${artifacts.glb.file}\` directly.`,
    );
  }
  if (maps.normal) {
    lines.push(
      `- **Unity** — \`${maps.normal.file}\` is OpenGL Y+; flip green for a DirectX Y− workflow.`,
    );
  }
  lines.push(
    "",
    "## Cloth physics (Loom-native)",
    "",
    "| axis | value |",
    "|---|---|",
    `| fabric | ${fabric.id} |`,
    `| warp / weft | ${authored.knobs.warpStiffness} / ${authored.knobs.weftStiffness} |`,
    `| shear | ${authored.knobs.shearStiffness} |`,
    `| bend | ${authored.knobs.bendStiffness} |`,
    `| weight | ${authored.knobs.weight} |`,
  );
  if (issues.length > 0) {
    lines.push("", "## Export notes", "");
    for (const issue of issues) lines.push(`- ${issue.message}`);
  }
  lines.push("", "The full authored FabricKnobs surface is in `material.json`.", "");
  return lines.join("\n");
}

export async function buildMaterialBundle(
  input: ExportInput,
  options: MaterialBundleOptions = {},
): Promise<MaterialExportResult> {
  const { default: JSZip } = await import("jszip");
  const stem = slugify(input.name);
  const filename = `${stem}.zip`;
  const zip = new JSZip();
  const folder = zip.folder(stem)!;
  const issues: MaterialExportIssue[] = [];
  const includedFiles: string[] = [];
  const resolved: Partial<Record<MapName, ResolvedMap>> = {};
  const maps: LoomMaterialV2["maps"] = {};
  const resolver = options.resolveMap ?? defaultResolveMap;

  const outcomes = await Promise.all(
    MAP_ORDER.map(async (name): Promise<MapResolutionOutcome> => {
      const entry = input.pkg.maps[name];
      if (!entry) return null;
      try {
        const asset = await resolver(name, entry);
        if (!asset) {
          return {
            issue: {
              stage: "map",
              code: "map-unavailable",
              map: name,
              message: `${name} map was unavailable and was not exported.`,
            } satisfies MaterialExportIssue,
          };
        }
        const format = detectMapFormat(asset.bytes, {
          mimeType: asset.mimeType,
          extension: asset.extension,
          url: entry.url,
        });
        if (!format) {
          return {
            issue: {
              stage: "map",
              code: "map-format-unsupported",
              map: name,
              message: `${name} map has an unsupported image format and was not exported.`,
            } satisfies MaterialExportIssue,
          };
        }
        const file = `${stem}_${SUFFIX[name]}.${format.extension}`;
        const descriptor: LoomMapFile = {
          name,
          file,
          mimeType: format.mimeType,
          extension: format.extension,
          colorSpace: name === "albedo" ? "srgb" : "linear",
          normalConvention: name === "normal" ? "opengl-y+" : undefined,
          provenance: entry.provenance,
          sourceHash: entry.sourceHash,
        };
        return { name, asset: { bytes: asset.bytes, descriptor } };
      } catch (error) {
        return {
          issue: {
            stage: "map",
            code: "map-unavailable",
            map: name,
            message: `${name} map failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
          } satisfies MaterialExportIssue,
        };
      }
    }),
  );

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ("issue" in outcome) {
      issues.push(outcome.issue);
      continue;
    }
    const { name, asset } = outcome;
    resolved[name] = asset;
    maps[name] = asset.descriptor;
    folder.file(asset.descriptor.file, asset.bytes);
    includedFiles.push(asset.descriptor.file);
  }

  const artifacts: LoomMaterialV2["artifacts"] = {};
  let ormBlob: Blob | null = null;
  if (options.includeDerivedArtifacts !== false) {
    if (resolved.roughness || resolved.metalness || resolved.ao) {
      try {
        ormBlob = await packORM(
          resolved.roughness,
          resolved.metalness,
          resolved.ao,
        );
        if (!ormBlob) throw new Error("canvas did not produce an image");
        const file = `${stem}_ORM.png`;
        folder.file(file, ormBlob);
        includedFiles.push(file);
        artifacts.orm = {
          file,
          mimeType: "image/png",
          extension: "png",
          colorSpace: "linear",
          channels: { r: "occlusion", g: "roughness", b: "metalness" },
        };
      } catch (error) {
        issues.push({
          stage: "orm",
          code: "orm-failed",
          message: `Packed ORM was not created: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    try {
      const glb = await buildGlb(resolved.albedo, resolved.normal, ormBlob, {
        metalness: input.metalness,
        sheen: input.knobs.sheen,
        transmission: input.openness * 0.4,
        baseColor: resolved.albedo ? 1 : 0.75,
      });
      const file = `${stem}.glb`;
      folder.file(file, glb);
      includedFiles.push(file);
      artifacts.glb = {
        file,
        mimeType: "model/gltf-binary",
        extension: "glb",
      };
    } catch (error) {
      issues.push({
        stage: "glb",
        code: "glb-failed",
        message: `GLB specimen was not created: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const material: LoomMaterialV2 = {
    schema: LOOM_MATERIAL_SCHEMA,
    id: input.materialId?.trim() || input.pkg.id,
    name: input.name,
    createdAt: input.pkg.meta.createdAt,
    source: {
      identity: sourceIdentity(input),
      packageId: input.pkg.id,
      extractor: extractorFor(input),
      captureNotes: input.pkg.meta.captureNotes ?? null,
    },
    fabric: {
      id: input.fabric.id,
      names: {
        ko: input.fabric.nameKo,
        roman: input.fabric.nameRoman,
        en: input.fabric.nameEn,
      },
      core: { ...input.fabric.core },
    },
    authored: { knobs: { ...input.knobs }, metalness: input.metalness },
    maps,
    artifacts,
  };
  folder.file("material.json", serializeLoomMaterial(material));
  folder.file("README.md", buildReadme(material, issues));
  includedFiles.push("material.json", "README.md");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/zip",
  });
  return {
    filename,
    bytes,
    blob,
    document: material,
    includedFiles,
    issues,
    complete: issues.length === 0,
  };
}

/** Build and download one material bundle. Partial results still download. */
export async function exportMaterial(
  input: ExportInput,
): Promise<MaterialExportResult> {
  const result = await buildMaterialBundle(input);
  try {
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Safari/WebKit and embedded browsers may resolve the object URL after the
    // click task returns. Revoking synchronously can silently cancel an
    // otherwise valid download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return result;
  } catch (error) {
    const issue: MaterialExportIssue = {
      stage: "download",
      code: "download-failed",
      message: `Bundle was built but the download did not start: ${error instanceof Error ? error.message : String(error)}`,
    };
    return {
      ...result,
      issues: [...result.issues, issue],
      complete: false,
    };
  }
}

function asZipInput(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer | Uint8Array> {
  return input instanceof Blob ? input.arrayBuffer() : Promise.resolve(input);
}

function objectUrlFor(
  bytes: ArrayBuffer,
  mimeType: LoomMapMimeType,
): { url: string; revoke: () => void } {
  if (typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  const raw = new Uint8Array(bytes);
  let binary = "";
  for (let start = 0; start < raw.length; start += 0x8000) {
    binary += String.fromCharCode(...raw.subarray(start, start + 0x8000));
  }
  return {
    url: `data:${mimeType};base64,${btoa(binary)}`,
    revoke: () => undefined,
  };
}

/** Read a v2 or legacy v1 single-material ZIP into runtime viewer inputs. */
export async function readMaterialBundle(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ReopenedMaterialBundle> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await asZipInput(input));
  const manifests = Object.values(zip.files).filter(
    (entry) => !entry.dir && /(^|\/)material\.json$/.test(entry.name),
  );
  if (manifests.length !== 1) {
    throw new Error(
      `loom material bundle: expected one material.json, found ${manifests.length}`,
    );
  }
  const manifestEntry = manifests[0];
  const material = parseLoomMaterial(await manifestEntry.async("string"));
  const base = manifestEntry.name.slice(0, -"material.json".length);
  const mapBytes: Partial<Record<MapName, ArrayBuffer>> = {};
  const maps: MaterialPackage["maps"] = {};
  const revokers: (() => void)[] = [];
  for (const name of MAP_ORDER) {
    const descriptor = material.maps[name];
    if (!descriptor) continue;
    const entry = zip.file(`${base}${descriptor.file}`);
    if (!entry) {
      for (const revoke of revokers) revoke();
      throw new Error(
        `loom material bundle: missing ${descriptor.file} referenced by material.json`,
      );
    }
    const bytes = await entry.async("arraybuffer");
    const detected = detectMapFormat(bytes, { extension: descriptor.extension });
    if (
      !detected ||
      detected.mimeType !== descriptor.mimeType ||
      detected.extension !== descriptor.extension
    ) {
      for (const revoke of revokers) revoke();
      throw new Error(
        `loom material bundle: ${descriptor.file} bytes do not match its format descriptor`,
      );
    }
    mapBytes[name] = bytes;
    const object = objectUrlFor(bytes, descriptor.mimeType);
    revokers.push(object.revoke);
    maps[name] = {
      name,
      url: object.url,
      provenance: descriptor.provenance,
      sourceHash: descriptor.sourceHash,
    };
  }
  for (const artifact of [material.artifacts.orm, material.artifacts.glb]) {
    if (artifact && !zip.file(`${base}${artifact.file}`)) {
      for (const revoke of revokers) revoke();
      throw new Error(
        `loom material bundle: missing ${artifact.file} referenced by material.json`,
      );
    }
  }
  const params: Record<string, number> = {
    metalness: material.authored.metalness,
  };
  for (const [key, value] of Object.entries(material.authored.knobs)) {
    params[key] = value;
  }
  const pkg: MaterialPackage = {
    id: material.id,
    maps,
    params,
    meta: {
      fabricName: material.name,
      captureNotes: material.source.captureNotes ?? undefined,
      createdAt: material.createdAt,
    },
  };
  return {
    document: material,
    pkg,
    knobs: { ...material.authored.knobs },
    metalness: material.authored.metalness,
    mapBytes,
    revoke: () => {
      for (const revoke of revokers.splice(0)) revoke();
    },
  };
}

export const importMaterialBundle = readMaterialBundle;
