// ─── fabricSerial.ts ─────────────────────────────────────────────────────────
// Commit format for a FabricProfile. This is the file the tuning tool writes
// into — cores are read-only from the tool's perspective and overrides are the
// deltas it proposes. Deliberately NEVER stores resolved values (translucency,
// bendStiffness, etc. that derive() produces); only the authored inputs.
//
// Separate on purpose from MaterialPackage serialization (lib/core/
// materialPackage.ts). pkg.params still owns map-pipeline scalars. Whether to
// embed a fabric block into MaterialPackage is a later question.

import type { DerivedFabric } from "./derive";
import type { FabricCore, FiberType, WeaveType } from "./fabricCore";
import type { FabricId, FabricProfile } from "./fabrics";

/** Current wire format. Bump on breaking changes; add a per-version parse arm
 *  rather than trying to make one parser handle every historical shape. */
export const FABRIC_SERIAL_VERSION = 1;

const TOP_KEYS = ["version", "id", "names", "urls", "core", "overrides"] as const;
const NAME_KEYS = ["ko", "roman", "en"] as const;
const URL_KEYS = ["albedo", "texture"] as const;
const CORE_KEYS = [
  "gsm",
  "coverFactor",
  "thicknessMm",
  "fiberModulus",
  "fiberType",
  "weaveType",
  "twist",
] as const;
const FABRIC_IDS = [
  "myeongju",
  "mosi",
  "sambe",
  "mumyeong",
  "jersey",
  "denim",
] as const;
const FIBER_TYPES: readonly FiberType[] = ["filament", "staple"];
const WEAVE_TYPES: readonly WeaveType[] = ["plain", "twill", "satin", "knit"];

/** Every field derive() produces — the entire legal surface for overrides.
 *  Anything else means the writer leaked a resolved value or made up a knob. */
const OVERRIDE_KEYS: readonly (keyof DerivedFabric)[] = [
  // FabricKnobs
  "sheen",
  "openness",
  "translucency",
  "densityAmount",
  "alphaFromDensity",
  "alphaBoost",
  "alphaBoostSource",
  "albedoAmount",
  "pomScale",
  "normalAmount",
  "pomShadow",
  "stretch",
  "edgeInset",
  "edgeFray",
  "edgeSharpness",
  "edgeDetail",
  "tileScale",
  "txHeight",
  "txAlbedo",
  "txRoughness",
  "transmissionContrast",
  "weight",
  "warpStiffness",
  "weftStiffness",
  "shearStiffness",
  "bendStiffness",
  // SolverDerived (openness deduped — already listed above)
  "creaseFriction",
  "creaseThreshold",
  "creaseCommitRate",
  "creaseRelease",
  "particleMass",
  "damping",
  "windResponse",
];

/** JSON shape written to disk. Nested `names` / `urls` group the identity
 *  fields together — the flat FabricProfile shape is a UI-ergonomic detail
 *  that shouldn't leak into the on-disk format. */
export interface SerializedFabric {
  version: typeof FABRIC_SERIAL_VERSION;
  id: FabricId;
  names: { ko: string; roman: string; en: string };
  urls: { albedo: string; texture: string };
  core: FabricCore;
  overrides: Partial<DerivedFabric>;
}

export function serializeFabric(profile: FabricProfile): string {
  const s: SerializedFabric = {
    version: FABRIC_SERIAL_VERSION,
    id: profile.id,
    names: {
      ko: profile.nameKo,
      roman: profile.nameRoman,
      en: profile.nameEn,
    },
    urls: {
      albedo: profile.albedoURL,
      texture: profile.textureURL,
    },
    core: { ...profile.core },
    overrides: { ...profile.overrides },
  };
  return JSON.stringify(s, null, 2) + "\n";
}

export function parseFabric(json: string): FabricProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`parseFabric: invalid JSON — ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error("parseFabric: top-level must be an object");

  rejectUnknownKeys(raw, TOP_KEYS, "");

  if (raw.version !== FABRIC_SERIAL_VERSION) {
    throw new Error(
      `parseFabric: unsupported version ${String(raw.version)}, expected ${FABRIC_SERIAL_VERSION}`,
    );
  }

  const id = expectEnum(raw.id, FABRIC_IDS, "id");
  const names = parseNames(raw.names);
  const urls = parseUrls(raw.urls);
  const core = parseCore(raw.core);
  const overrides = raw.overrides === undefined ? {} : parseOverrides(raw.overrides);

  return {
    id,
    nameKo: names.ko,
    nameRoman: names.roman,
    nameEn: names.en,
    albedoURL: urls.albedo,
    textureURL: urls.texture,
    core,
    overrides,
  };
}

// ── parsers ────────────────────────────────────────────────────────────────

function parseNames(v: unknown): { ko: string; roman: string; en: string } {
  if (!isRecord(v)) throw new Error("parseFabric: names must be an object");
  rejectUnknownKeys(v, NAME_KEYS, "names.");
  return {
    ko: expectString(v.ko, "names.ko"),
    roman: expectString(v.roman, "names.roman"),
    en: expectString(v.en, "names.en"),
  };
}

function parseUrls(v: unknown): { albedo: string; texture: string } {
  if (!isRecord(v)) throw new Error("parseFabric: urls must be an object");
  rejectUnknownKeys(v, URL_KEYS, "urls.");
  return {
    albedo: expectString(v.albedo, "urls.albedo"),
    texture: expectString(v.texture, "urls.texture"),
  };
}

function parseCore(v: unknown): FabricCore {
  if (!isRecord(v)) throw new Error("parseFabric: core must be an object");
  rejectUnknownKeys(v, CORE_KEYS, "core.");
  return {
    gsm: expectNumber(v.gsm, "core.gsm"),
    coverFactor: expectNumber(v.coverFactor, "core.coverFactor"),
    thicknessMm: expectNumber(v.thicknessMm, "core.thicknessMm"),
    fiberModulus: expectNumber(v.fiberModulus, "core.fiberModulus"),
    fiberType: expectEnum(v.fiberType, FIBER_TYPES, "core.fiberType"),
    weaveType: expectEnum(v.weaveType, WEAVE_TYPES, "core.weaveType"),
    twist: expectNumber(v.twist, "core.twist"),
  };
}

function parseOverrides(v: unknown): Partial<DerivedFabric> {
  if (!isRecord(v)) throw new Error("parseFabric: overrides must be an object");
  const out: Record<string, number> = {};
  for (const k of Object.keys(v)) {
    if (!(OVERRIDE_KEYS as readonly string[]).includes(k)) {
      throw new Error(
        `parseFabric: unknown override key "${k}" — resolved values are not persisted`,
      );
    }
    if (k === "alphaBoostSource") {
      const raw = v[k];
      if (raw !== 0 && raw !== 1 && raw !== 2 && raw !== 3) {
        throw new Error(
          `parseFabric: overrides.alphaBoostSource must be 0 | 1 | 2 | 3, got ${String(raw)}`,
        );
      }
      out[k] = raw;
    } else {
      out[k] = expectNumber(v[k], `overrides.${k}`);
    }
  }
  return out as Partial<DerivedFabric>;
}

// ── primitives ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new Error(`parseFabric: unknown key "${path}${k}"`);
    }
  }
}

function expectString(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new Error(`parseFabric: ${path} must be a string, got ${typeOf(v)}`);
  }
  return v;
}

function expectNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`parseFabric: ${path} must be a finite number, got ${typeOf(v)}`);
  }
  return v;
}

function expectEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new Error(
      `parseFabric: ${path} must be one of ${allowed.join(" | ")}, got ${typeOf(v)}`,
    );
  }
  return v as T;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
