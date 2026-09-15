import type { FabricId } from "../cloth/fabrics";
import { DEFAULT_FABRIC_KNOBS, type FabricKnobs } from "./knobs";
import type {
  MaterialDraftHistory,
  MaterialDraftSnapshot,
} from "./materialDraftHistory";

export const MATERIAL_EDIT_RECOVERY_VERSION = 1;
export const MATERIAL_EDIT_RECOVERY_PREFIX = "loom.material-edits.v1:";
export const MATERIAL_EDIT_RECOVERY_HISTORY_LIMIT = 50;
// Bound parsing work and storage use before touching any untrusted JSON.
export const MATERIAL_EDIT_RECOVERY_MAX_LENGTH = 128 * 1024;

/** Identity of the saved source, never the unsaved values currently on screen. */
export interface MaterialEditSource {
  readonly materialId: string;
  readonly pkgHash: string;
  readonly fabricId: FabricId;
  readonly metalness: number;
  readonly knobs: Readonly<FabricKnobs>;
}

const FABRIC_KNOB_KEYS = Object.keys(DEFAULT_FABRIC_KNOBS) as (keyof FabricKnobs)[];
const FABRIC_IDS: Record<FabricId, true> = {
  myeongju: true,
  mosi: true,
  sambe: true,
  mumyeong: true,
  jersey: true,
  denim: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Retain only real knobs. Match the material-file parser's finite-number
 * contract, without rounding or clamping authored values during recovery. */
function readKnobs(value: unknown): MaterialDraftSnapshot | null {
  if (!isRecord(value)) return null;
  const entries: [keyof FabricKnobs, number][] = [];
  for (const key of FABRIC_KNOB_KEYS) {
    if (!Object.hasOwn(value, key)) return null;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    if (key === "alphaBoostSource" && ![0, 1, 2, 3].includes(number)) return null;
    entries.push([key, number]);
  }
  return Object.freeze(Object.fromEntries(entries)) as unknown as MaterialDraftSnapshot;
}

function readSource(value: unknown): MaterialEditSource | null {
  if (!isRecord(value)) return null;
  if (!isIdentifier(value.materialId) || !isIdentifier(value.pkgHash)) return null;
  if (typeof value.fabricId !== "string" || !Object.hasOwn(FABRIC_IDS, value.fabricId)) {
    return null;
  }
  if (typeof value.metalness !== "number" || !Number.isFinite(value.metalness)) {
    return null;
  }
  const knobs = readKnobs(value.knobs);
  if (!knobs) return null;
  return {
    materialId: value.materialId,
    pkgHash: value.pkgHash,
    fabricId: value.fabricId as FabricId,
    metalness: value.metalness,
    knobs,
  };
}

function sameKnobs(left: MaterialDraftSnapshot, right: MaterialDraftSnapshot): boolean {
  return FABRIC_KNOB_KEYS.every((key) => Object.is(left[key], right[key]));
}

function sameSource(left: MaterialEditSource, right: MaterialEditSource): boolean {
  return left.materialId === right.materialId &&
    left.pkgHash === right.pkgHash &&
    left.fabricId === right.fabricId &&
    Object.is(left.metalness, right.metalness) &&
    sameKnobs(left.knobs, right.knobs);
}

function readStack(value: unknown): readonly MaterialDraftSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const snapshots: MaterialDraftSnapshot[] = [];
  // The reducer's next undo/redo state is at the end, not the beginning.
  for (const entry of value.slice(-MATERIAL_EDIT_RECOVERY_HISTORY_LIMIT)) {
    const knobs = readKnobs(entry);
    if (!knobs) return null;
    snapshots.push(knobs);
  }
  return Object.freeze(snapshots);
}

function readHistory(value: unknown): MaterialDraftHistory | null {
  if (!isRecord(value)) return null;
  const baseline = readKnobs(value.baseline);
  const current = readKnobs(value.current);
  const undoStack = readStack(value.undoStack);
  const redoStack = readStack(value.redoStack);
  if (!baseline || !current || !undoStack || !redoStack) return null;
  return Object.freeze({
    baseline,
    current,
    undoStack,
    redoStack,
    // Comparing is temporary view state. Reopen the actual unsaved material.
    comparison: "current",
  });
}

/** Per-source storage key. JSON framing avoids ambiguous id/hash separators. */
export function materialEditRecoveryKey(materialId: string, pkgHash: string): string {
  return `${MATERIAL_EDIT_RECOVERY_PREFIX}${JSON.stringify([materialId, pkgHash])}`;
}

/** Only material parameters + bounded history leave this function: never map
 * bytes, object URLs, credentials, scene preferences, or incidental state.
 * Returns null for an invalid/mismatched source; storage errors belong to the UI. */
export function serializeMaterialEditRecovery(
  source: MaterialEditSource,
  history: MaterialDraftHistory,
): string | null {
  const cleanSource = readSource(source);
  const cleanHistory = readHistory(history);
  if (!cleanSource || !cleanHistory || !sameKnobs(cleanSource.knobs, cleanHistory.baseline)) {
    return null;
  }
  const json = JSON.stringify({
    version: MATERIAL_EDIT_RECOVERY_VERSION,
    source: cleanSource,
    history: cleanHistory,
  });
  return json.length <= MATERIAL_EDIT_RECOVERY_MAX_LENGTH ? json : null;
}

/** Restore only after the saved source finishes loading. A renamed/replaced
 * package or changed saved parameters must never receive an older edit. */
export function readMaterialEditRecovery(
  json: string | null,
  expectedSource: MaterialEditSource,
): MaterialDraftHistory | null {
  if (!json || json.length > MATERIAL_EDIT_RECOVERY_MAX_LENGTH) return null;
  try {
    const raw: unknown = JSON.parse(json);
    if (!isRecord(raw) || raw.version !== MATERIAL_EDIT_RECOVERY_VERSION) return null;
    const expected = readSource(expectedSource);
    const source = readSource(raw.source);
    const history = readHistory(raw.history);
    if (!expected || !source || !history || !sameSource(source, expected)) return null;
    if (!sameKnobs(source.knobs, history.baseline)) return null;
    return history;
  } catch {
    return null;
  }
}
