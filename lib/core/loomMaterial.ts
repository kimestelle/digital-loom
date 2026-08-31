import {
  DEFAULT_FABRIC_KNOBS,
  type FabricKnobs,
} from "../ui/knobs";
import { FABRICS, type FabricId } from "../cloth/fabrics";
import type {
  FabricCore,
  FiberType,
  WeaveType,
} from "../cloth/fabricCore";
import {
  MAP_ORDER,
  type MapName,
  type Provenance,
} from "./materialPackage";

/**
 * Stable, portable material contract. Runtime MaterialPackage objects are light
 * renderer inputs; this document is the authored interchange format written to
 * material.json and read back from a single-material bundle.
 */
export const LOOM_MATERIAL_SCHEMA = "loom.material/2" as const;
export const LEGACY_LOOM_MATERIAL_SCHEMA = "loom.material/1" as const;

export type LoomMapMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/x-exr";

export type LoomMapExtension = "png" | "jpg" | "jpeg" | "webp" | "exr";
export type LoomMapColorSpace = "srgb" | "linear";
export type LoomNormalConvention = "opengl-y+";

export interface LoomMapFile {
  name: MapName;
  file: string;
  mimeType: LoomMapMimeType;
  extension: LoomMapExtension;
  colorSpace: LoomMapColorSpace;
  normalConvention?: LoomNormalConvention;
  provenance: Provenance;
  sourceHash?: string;
}

export interface LoomOrmArtifact {
  file: string;
  mimeType: "image/png";
  extension: "png";
  colorSpace: "linear";
  channels: {
    r: "occlusion";
    g: "roughness";
    b: "metalness";
  };
}

export interface LoomGlbArtifact {
  file: string;
  mimeType: "model/gltf-binary";
  extension: "glb";
}

export interface LoomMaterialV2 {
  schema: typeof LOOM_MATERIAL_SCHEMA;
  /** Identity of this authored material document. */
  id: string;
  name: string;
  createdAt: string;
  source: {
    /** Stable extraction/source identity, independent of display name. */
    identity: string;
    /** Runtime package id retained for traceability. */
    packageId: string;
    extractor: string | null;
    captureNotes: string | null;
  };
  fabric: {
    id: FabricId;
    names: {
      ko: string;
      roman: string;
      en: string;
    };
    /** Physical authored core, so the bundle does not depend on local presets. */
    core: FabricCore;
  };
  authored: {
    /** Complete material control surface; scene/device preferences never enter. */
    knobs: FabricKnobs;
    /** Legacy material scalar that lives outside FabricKnobs in the studio. */
    metalness: number;
  };
  maps: Partial<Record<MapName, LoomMapFile>>;
  artifacts: {
    orm?: LoomOrmArtifact;
    glb?: LoomGlbArtifact;
  };
}

const FABRIC_IDS: readonly FabricId[] = [
  "myeongju",
  "mosi",
  "sambe",
  "mumyeong",
  "jersey",
  "denim",
];

const PROVENANCE_VALUES: readonly Provenance[] = [
  "captured",
  "patina",
  "derived",
  "predicted",
  "upscaled",
];
const FIBER_TYPES: readonly FiberType[] = ["filament", "staple"];
const WEAVE_TYPES: readonly WeaveType[] = ["plain", "twill", "satin", "knit"];

const MAP_MIME_BY_EXTENSION: Record<LoomMapExtension, LoomMapMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  exr: "image/x-exr",
};

const FABRIC_KNOB_KEYS = Object.keys(
  DEFAULT_FABRIC_KNOBS,
) as (keyof FabricKnobs)[];

export function mimeTypeForMapExtension(
  extension: LoomMapExtension,
): LoomMapMimeType {
  return MAP_MIME_BY_EXTENSION[extension];
}

export function isLoomMapExtension(value: string): value is LoomMapExtension {
  return value in MAP_MIME_BY_EXTENSION;
}

export function parseLoomMaterial(input: string | unknown): LoomMaterialV2 {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new Error(
        `loom material: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return migrateLoomMaterial(raw);
}

/**
 * Version-dispatch entry point. Every historical format gets its own migration;
 * never loosen the current validator to accommodate an older shape.
 */
export function migrateLoomMaterial(input: unknown): LoomMaterialV2 {
  const raw = expectRecord(input, "document");
  if (raw.schema === LOOM_MATERIAL_SCHEMA) return validateV2(raw);
  if (raw.schema === LEGACY_LOOM_MATERIAL_SCHEMA) {
    return validateV2(
      migrateV1(raw) as unknown as Record<string, unknown>,
    );
  }
  throw new Error(
    `loom material: unsupported schema ${JSON.stringify(raw.schema)}`,
  );
}

export function serializeLoomMaterial(document: LoomMaterialV2): string {
  const validated = validateV2(document as unknown as Record<string, unknown>);
  return JSON.stringify(validated, null, 2) + "\n";
}

function validateV2(raw: Record<string, unknown>): LoomMaterialV2 {
  rejectUnknownKeys(
    raw,
    [
      "schema",
      "id",
      "name",
      "createdAt",
      "source",
      "fabric",
      "authored",
      "maps",
      "artifacts",
    ],
    "document",
  );
  if (raw.schema !== LOOM_MATERIAL_SCHEMA) {
    throw new Error(`loom material: expected schema ${LOOM_MATERIAL_SCHEMA}`);
  }

  const id = expectNonEmptyString(raw.id, "id");
  const name = expectNonEmptyString(raw.name, "name");
  const createdAt = expectDateString(raw.createdAt, "createdAt");

  const sourceRaw = expectRecord(raw.source, "source");
  rejectUnknownKeys(
    sourceRaw,
    ["identity", "packageId", "extractor", "captureNotes"],
    "source",
  );
  const source = {
    identity: expectNonEmptyString(sourceRaw.identity, "source.identity"),
    packageId: expectNonEmptyString(sourceRaw.packageId, "source.packageId"),
    extractor: expectNullableString(sourceRaw.extractor, "source.extractor"),
    captureNotes: expectNullableString(
      sourceRaw.captureNotes,
      "source.captureNotes",
    ),
  };

  const fabricRaw = expectRecord(raw.fabric, "fabric");
  rejectUnknownKeys(fabricRaw, ["id", "names", "core"], "fabric");
  const fabricId = expectEnum(fabricRaw.id, FABRIC_IDS, "fabric.id");
  const namesRaw = expectRecord(fabricRaw.names, "fabric.names");
  rejectUnknownKeys(namesRaw, ["ko", "roman", "en"], "fabric.names");
  const fabric = {
    id: fabricId,
    names: {
      ko: expectString(namesRaw.ko, "fabric.names.ko"),
      roman: expectNonEmptyString(namesRaw.roman, "fabric.names.roman"),
      en: expectNonEmptyString(namesRaw.en, "fabric.names.en"),
    },
    core: parseFabricCore(fabricRaw.core),
  };

  const authoredRaw = expectRecord(raw.authored, "authored");
  rejectUnknownKeys(authoredRaw, ["knobs", "metalness"], "authored");
  const authored = {
    knobs: parseFabricKnobs(authoredRaw.knobs),
    metalness: expectRange(authoredRaw.metalness, 0, 1, "authored.metalness"),
  };

  const mapsRaw = expectRecord(raw.maps, "maps");
  rejectUnknownKeys(mapsRaw, MAP_ORDER, "maps");
  const maps: Partial<Record<MapName, LoomMapFile>> = {};
  for (const name of MAP_ORDER) {
    if (mapsRaw[name] === undefined) continue;
    maps[name] = parseMapFile(name, mapsRaw[name]);
  }

  const artifactsRaw = expectRecord(raw.artifacts, "artifacts");
  rejectUnknownKeys(artifactsRaw, ["orm", "glb"], "artifacts");
  const artifacts: LoomMaterialV2["artifacts"] = {};
  if (artifactsRaw.orm !== undefined) artifacts.orm = parseOrm(artifactsRaw.orm);
  if (artifactsRaw.glb !== undefined) artifacts.glb = parseGlb(artifactsRaw.glb);

  return {
    schema: LOOM_MATERIAL_SCHEMA,
    id,
    name,
    createdAt,
    source,
    fabric,
    authored,
    maps,
    artifacts,
  };
}

function parseFabricKnobs(input: unknown): FabricKnobs {
  const raw = expectRecord(input, "authored.knobs");
  rejectUnknownKeys(raw, FABRIC_KNOB_KEYS, "authored.knobs");
  for (const key of FABRIC_KNOB_KEYS) {
    if (!(key in raw)) {
      throw new Error(`loom material: missing authored.knobs.${String(key)}`);
    }
  }
  const out: Record<string, number> = {};
  for (const key of FABRIC_KNOB_KEYS) {
    const value = expectFiniteNumber(raw[key], `authored.knobs.${String(key)}`);
    if (
      key === "alphaBoostSource" &&
      value !== 0 &&
      value !== 1 &&
      value !== 2 &&
      value !== 3
    ) {
      throw new Error(
        `loom material: authored.knobs.alphaBoostSource must be 0 | 1 | 2 | 3`,
      );
    }
    out[key] = value;
  }
  return out as unknown as FabricKnobs;
}

function parseFabricCore(input: unknown): FabricCore {
  const raw = expectRecord(input, "fabric.core");
  rejectUnknownKeys(
    raw,
    [
      "gsm",
      "coverFactor",
      "thicknessMm",
      "fiberModulus",
      "fiberType",
      "weaveType",
      "twist",
    ],
    "fabric.core",
  );
  return {
    gsm: expectPositive(raw.gsm, "fabric.core.gsm"),
    coverFactor: expectRange(
      raw.coverFactor,
      0,
      1,
      "fabric.core.coverFactor",
    ),
    thicknessMm: expectPositive(
      raw.thicknessMm,
      "fabric.core.thicknessMm",
    ),
    fiberModulus: expectRange(
      raw.fiberModulus,
      0,
      1,
      "fabric.core.fiberModulus",
    ),
    fiberType: expectEnum(raw.fiberType, FIBER_TYPES, "fabric.core.fiberType"),
    weaveType: expectEnum(raw.weaveType, WEAVE_TYPES, "fabric.core.weaveType"),
    twist: expectRange(raw.twist, 0, 1, "fabric.core.twist"),
  };
}

function parseMapFile(name: MapName, input: unknown): LoomMapFile {
  const raw = expectRecord(input, `maps.${name}`);
  rejectUnknownKeys(
    raw,
    [
      "name",
      "file",
      "mimeType",
      "extension",
      "colorSpace",
      "normalConvention",
      "provenance",
      "sourceHash",
    ],
    `maps.${name}`,
  );
  if (raw.name !== name) {
    throw new Error(`loom material: maps.${name}.name must equal ${name}`);
  }
  const file = expectSafeFile(raw.file, `maps.${name}.file`);
  const extension = expectEnum(
    raw.extension,
    Object.keys(MAP_MIME_BY_EXTENSION) as LoomMapExtension[],
    `maps.${name}.extension`,
  );
  const mimeType = expectEnum(
    raw.mimeType,
    Object.values(MAP_MIME_BY_EXTENSION),
    `maps.${name}.mimeType`,
  );
  if (MAP_MIME_BY_EXTENSION[extension] !== mimeType) {
    throw new Error(
      `loom material: maps.${name} extension ${extension} does not match ${mimeType}`,
    );
  }
  if (!file.toLowerCase().endsWith(`.${extension}`)) {
    throw new Error(
      `loom material: maps.${name}.file must end in .${extension}`,
    );
  }
  const expectedColor: LoomMapColorSpace = name === "albedo" ? "srgb" : "linear";
  if (raw.colorSpace !== expectedColor) {
    throw new Error(
      `loom material: maps.${name}.colorSpace must be ${expectedColor}`,
    );
  }
  if (name === "normal") {
    if (raw.normalConvention !== "opengl-y+") {
      throw new Error(
        "loom material: maps.normal.normalConvention must be opengl-y+",
      );
    }
  } else if (raw.normalConvention !== undefined) {
    throw new Error(
      `loom material: maps.${name}.normalConvention is only valid for normal maps`,
    );
  }
  const provenance = expectEnum(
    raw.provenance,
    PROVENANCE_VALUES,
    `maps.${name}.provenance`,
  );
  const sourceHash =
    raw.sourceHash === undefined
      ? undefined
      : expectNonEmptyString(raw.sourceHash, `maps.${name}.sourceHash`);
  return {
    name,
    file,
    mimeType,
    extension,
    colorSpace: expectedColor,
    normalConvention: name === "normal" ? "opengl-y+" : undefined,
    provenance,
    sourceHash,
  };
}

function parseOrm(input: unknown): LoomOrmArtifact {
  const raw = expectRecord(input, "artifacts.orm");
  rejectUnknownKeys(
    raw,
    ["file", "mimeType", "extension", "colorSpace", "channels"],
    "artifacts.orm",
  );
  const file = expectSafeFile(raw.file, "artifacts.orm.file");
  if (!file.toLowerCase().endsWith(".png")) {
    throw new Error("loom material: artifacts.orm.file must end in .png");
  }
  if (
    raw.mimeType !== "image/png" ||
    raw.extension !== "png" ||
    raw.colorSpace !== "linear"
  ) {
    throw new Error("loom material: invalid ORM format descriptor");
  }
  const channels = expectRecord(raw.channels, "artifacts.orm.channels");
  rejectUnknownKeys(channels, ["r", "g", "b"], "artifacts.orm.channels");
  if (
    channels.r !== "occlusion" ||
    channels.g !== "roughness" ||
    channels.b !== "metalness"
  ) {
    throw new Error("loom material: ORM channels must be R=occlusion G=roughness B=metalness");
  }
  return {
    file,
    mimeType: "image/png",
    extension: "png",
    colorSpace: "linear",
    channels: { r: "occlusion", g: "roughness", b: "metalness" },
  };
}

function parseGlb(input: unknown): LoomGlbArtifact {
  const raw = expectRecord(input, "artifacts.glb");
  rejectUnknownKeys(raw, ["file", "mimeType", "extension"], "artifacts.glb");
  const file = expectSafeFile(raw.file, "artifacts.glb.file");
  if (!file.toLowerCase().endsWith(".glb")) {
    throw new Error("loom material: artifacts.glb.file must end in .glb");
  }
  if (raw.mimeType !== "model/gltf-binary" || raw.extension !== "glb") {
    throw new Error("loom material: invalid GLB format descriptor");
  }
  return { file, mimeType: "model/gltf-binary", extension: "glb" };
}

function migrateV1(raw: Record<string, unknown>): LoomMaterialV2 {
  rejectUnknownKeys(
    raw,
    [
      "schema",
      "name",
      "createdAt",
      "provenance",
      "files",
      "pbr",
      "physics",
      "identity",
    ],
    "legacy document",
  );
  const name = expectNonEmptyString(raw.name, "name");
  const createdAt = expectDateString(raw.createdAt, "createdAt");
  const provenance = expectRecord(raw.provenance, "provenance");
  const files = expectRecord(raw.files, "files");
  const pbr = expectRecord(raw.pbr, "pbr");
  const physics = expectRecord(raw.physics, "physics");
  const identity = expectRecord(raw.identity, "identity");

  const sourceHash = expectNonEmptyString(
    provenance.sourceHash,
    "provenance.sourceHash",
  );
  const fabricId = expectEnum(identity.fabricId, FABRIC_IDS, "identity.fabricId");
  const knobs: FabricKnobs = {
    ...DEFAULT_FABRIC_KNOBS,
    sheen: expectFiniteNumber(pbr.sheen, "pbr.sheen"),
    albedoAmount: expectFiniteNumber(pbr.albedoAmount, "pbr.albedoAmount"),
    tileScale: expectFiniteNumber(pbr.tileScale, "pbr.tileScale"),
    openness: expectFiniteNumber(physics.openness, "physics.openness"),
    warpStiffness: expectFiniteNumber(
      physics.warpStiffness,
      "physics.warpStiffness",
    ),
    weftStiffness: expectFiniteNumber(
      physics.weftStiffness,
      "physics.weftStiffness",
    ),
    shearStiffness: expectFiniteNumber(
      physics.shearStiffness,
      "physics.shearStiffness",
    ),
    bendStiffness: expectFiniteNumber(
      physics.bendStiffness,
      "physics.bendStiffness",
    ),
    weight: expectFiniteNumber(physics.weight, "physics.weight"),
  };

  const legacyMapKeys: Partial<Record<string, MapName>> = {
    baseColor: "albedo",
    normal: "normal",
    roughness: "roughness",
    metallic: "metalness",
    height: "height",
    ao: "ao",
    transmission: "transmission",
    anisoDirection: "anisoDirection",
    anisoCoherence: "anisoCoherence",
  };
  const maps: LoomMaterialV2["maps"] = {};
  for (const [legacyKey, mapName] of Object.entries(legacyMapKeys)) {
    const value = files[legacyKey];
    if (value === undefined || !mapName) continue;
    const file = expectSafeFile(value, `files.${legacyKey}`);
    const extension = extensionOf(file, `files.${legacyKey}`);
    maps[mapName] = {
      name: mapName,
      file,
      mimeType: MAP_MIME_BY_EXTENSION[extension],
      extension,
      colorSpace: mapName === "albedo" ? "srgb" : "linear",
      normalConvention: mapName === "normal" ? "opengl-y+" : undefined,
      provenance: "patina",
      sourceHash,
    };
  }

  const artifacts: LoomMaterialV2["artifacts"] = {};
  if (files.orm !== undefined) {
    const file = expectSafeFile(files.orm, "files.orm");
    artifacts.orm = {
      file,
      mimeType: "image/png",
      extension: "png",
      colorSpace: "linear",
      channels: { r: "occlusion", g: "roughness", b: "metalness" },
    };
  }
  if (files.glb !== undefined) {
    const file = expectSafeFile(files.glb, "files.glb");
    artifacts.glb = {
      file,
      mimeType: "model/gltf-binary",
      extension: "glb",
    };
  }

  return {
    schema: LOOM_MATERIAL_SCHEMA,
    id: sourceHash,
    name,
    createdAt,
    source: {
      identity: sourceHash,
      packageId: sourceHash,
      extractor: expectNullableString(
        provenance.extractor,
        "provenance.extractor",
      ),
      captureNotes: expectNullableString(
        provenance.prompt,
        "provenance.prompt",
      ),
    },
    fabric: {
      id: fabricId,
      names: {
        ko: expectString(identity.nameKo, "identity.nameKo"),
        roman: expectNonEmptyString(identity.nameRoman, "identity.nameRoman"),
        en: expectNonEmptyString(identity.nameEn, "identity.nameEn"),
      },
      core: {
        ...FABRICS[fabricId].core,
        fiberType: expectEnum(
          physics.fiberType,
          FIBER_TYPES,
          "physics.fiberType",
        ),
        weaveType: expectEnum(
          physics.weaveType,
          WEAVE_TYPES,
          "physics.weaveType",
        ),
      },
    },
    authored: {
      knobs,
      metalness: expectRange(pbr.metalness, 0, 1, "pbr.metalness"),
    },
    maps,
    artifacts,
  };
}

function extensionOf(value: string, path: string): LoomMapExtension {
  const dot = value.lastIndexOf(".");
  const extension = dot >= 0 ? value.slice(dot + 1).toLowerCase() : "";
  if (!isLoomMapExtension(extension)) {
    throw new Error(`loom material: ${path} has unsupported extension`);
  }
  return extension;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`loom material: ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly (string | number | symbol)[],
  path: string,
): void {
  const permitted = new Set(allowed.map(String));
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new Error(`loom material: unknown ${path}.${key}`);
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`loom material: ${path} must be a string`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const out = expectString(value, path);
  if (!out.trim()) throw new Error(`loom material: ${path} must not be empty`);
  return out;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`loom material: ${path} must be a finite number`);
  }
  return value;
}

function expectRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
): number {
  const out = expectFiniteNumber(value, path);
  if (out < min || out > max) {
    throw new Error(`loom material: ${path} must be between ${min} and ${max}`);
  }
  return out;
}

function expectPositive(value: unknown, path: string): number {
  const out = expectFiniteNumber(value, path);
  if (out <= 0) throw new Error(`loom material: ${path} must be greater than 0`);
  return out;
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `loom material: ${path} must be one of ${allowed.join(" | ")}`,
    );
  }
  return value as T;
}

function expectDateString(value: unknown, path: string): string {
  const out = expectNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(out))) {
    throw new Error(`loom material: ${path} must be a valid date`);
  }
  return out;
}

function expectSafeFile(value: unknown, path: string): string {
  const out = expectNonEmptyString(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out)) {
    throw new Error(`loom material: ${path} must be a safe relative filename`);
  }
  return out;
}
