import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_KNOBS, DEFAULT_KNOBS } from "./knobs";
import {
  createMaterialDraft,
  materialDraftReducer,
  type MaterialDraftHistory,
} from "./materialDraftHistory";
import {
  MATERIAL_EDIT_RECOVERY_HISTORY_LIMIT,
  MATERIAL_EDIT_RECOVERY_MAX_LENGTH,
  MATERIAL_EDIT_RECOVERY_PREFIX,
  materialEditRecoveryKey,
  readMaterialEditRecovery,
  serializeMaterialEditRecovery,
  type MaterialEditSource,
} from "./materialEditRecovery";

const source: MaterialEditSource = {
  materialId: "red-silk",
  pkgHash: "package-123",
  fabricId: "myeongju",
  metalness: 0,
  knobs: DEFAULT_FABRIC_KNOBS,
};

function edited(): MaterialDraftHistory {
  return materialDraftReducer(createMaterialDraft(source.knobs), {
    type: "commit",
    knobs: { ...source.knobs, sheen: 0.31, alphaBoostSource: 3 },
  });
}

function record(): Record<string, unknown> {
  return JSON.parse(serializeMaterialEditRecovery(source, edited())!) as Record<string, unknown>;
}

describe("material edit recovery", () => {
  it("round-trips authored values and undo/redo without rewriting the source", () => {
    const first = edited();
    const next = materialDraftReducer(first, {
      type: "commit",
      knobs: { ...first.current, tileScale: 2.123456789 },
    });
    const undone = materialDraftReducer(next, { type: "undo" });
    const restored = readMaterialEditRecovery(serializeMaterialEditRecovery(source, undone), source)!;
    expect(restored).toEqual(undone);
    expect(materialDraftReducer(restored, { type: "redo" }).current.tileScale).toBe(2.123456789);
    expect(materialDraftReducer(restored, { type: "undo" }).current).toEqual(source.knobs);
    expect(source.knobs).toEqual(DEFAULT_FABRIC_KNOBS);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.current)).toBe(true);
    expect(Object.isFrozen(restored.undoStack)).toBe(true);
  });

  it("reopens edited appearance instead of temporary original comparison", () => {
    const comparing = materialDraftReducer(edited(), { type: "compare", selection: "baseline" });
    const restored = readMaterialEditRecovery(serializeMaterialEditRecovery(source, comparing), source)!;
    expect(restored.comparison).toBe("current");
    expect(restored.current.sheen).toBe(0.31);
  });

  it("retains at most the latest 50 states at each end of history", () => {
    const snapshots = Array.from({ length: 80 }, (_, i) => ({ ...source.knobs, sheen: i }));
    const oversized = { ...edited(), undoStack: snapshots, redoStack: snapshots };
    const restored = readMaterialEditRecovery(serializeMaterialEditRecovery(source, oversized), source)!;
    expect(restored.undoStack).toHaveLength(MATERIAL_EDIT_RECOVERY_HISTORY_LIMIT);
    expect(restored.redoStack).toHaveLength(MATERIAL_EDIT_RECOVERY_HISTORY_LIMIT);
    expect(restored.undoStack[0].sheen).toBe(30);
    expect(materialDraftReducer(restored, { type: "undo" }).current.sheen).toBe(79);
    expect(materialDraftReducer(restored, { type: "redo" }).current.sheen).toBe(79);
  });

  it("bounds stacks when reading an externally oversized record too", () => {
    const raw = record();
    const history = raw.history as Record<string, unknown>;
    history.undoStack = Array.from({ length: 60 }, () => source.knobs);
    expect(readMaterialEditRecovery(JSON.stringify(raw), source)?.undoStack).toHaveLength(50);
  });

  it("never serializes unrelated fields from source or snapshots", () => {
    const extraKnobs = { ...DEFAULT_KNOBS, apiKey: "private-key", maps: { albedo: "blob:private" } };
    const extraSource = { ...source, maps: { albedo: "secret-image-data" } };
    const json = serializeMaterialEditRecovery(extraSource, {
      ...createMaterialDraft(source.knobs),
      current: extraKnobs,
      undoStack: [extraKnobs],
    })!;
    expect(json).not.toMatch(/apiKey|private|maps|quality|mouseForce/);
    expect(Object.keys(readMaterialEditRecovery(json, source)!.current)).toEqual(Object.keys(DEFAULT_FABRIC_KNOBS));
  });

  it("ignores unknown stored fields without exposing them to live state", () => {
    const raw = record();
    raw.credentials = "secret";
    const history = raw.history as Record<string, unknown>;
    (history.current as Record<string, unknown>).wireframe = true;
    history.transientMap = "blob:gone";
    const restored = readMaterialEditRecovery(JSON.stringify(raw), source)!;
    expect(restored).not.toHaveProperty("transientMap");
    expect(restored.current).not.toHaveProperty("wireframe");
  });

  it.each([
    { materialId: "another-material" },
    { pkgHash: "replaced-package" },
    { fabricId: "denim" as const },
    { metalness: 0.00000001 },
    { knobs: { ...source.knobs, sheen: source.knobs.sheen + 0.00000001 } },
  ])("rejects stale recovery when source changes: %j", (change) => {
    expect(readMaterialEditRecovery(serializeMaterialEditRecovery(source, edited()), {
      ...source,
      ...change,
    })).toBeNull();
  });

  it("rejects a history baseline that differs from its source", () => {
    const history = { ...edited(), baseline: { ...source.knobs, sheen: 0.1 } };
    expect(serializeMaterialEditRecovery(source, history)).toBeNull();
    const raw = record();
    (raw.history as Record<string, unknown>).baseline = history.baseline;
    expect(readMaterialEditRecovery(JSON.stringify(raw), source)).toBeNull();
  });

  it.each([null, "", "invalid", "null", "[]", '{"version":2}'])("ignores malformed/unsupported storage: %j", (json) => {
    expect(readMaterialEditRecovery(json, source)).toBeNull();
  });

  it.each([null, "0.5", Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid knob numbers: %j", (value) => {
    const raw = record();
    const history = raw.history as Record<string, unknown>;
    (history.current as Record<string, unknown>).sheen = value;
    expect(readMaterialEditRecovery(JSON.stringify(raw), source)).toBeNull();
  });

  it("rejects missing knobs, invalid map selectors, and malformed history", () => {
    const missing = record();
    const missingHistory = missing.history as Record<string, unknown>;
    delete (missingHistory.current as Record<string, unknown>).edgeFray;
    expect(readMaterialEditRecovery(JSON.stringify(missing), source)).toBeNull();
    const invalid = record();
    const invalidHistory = invalid.history as Record<string, unknown>;
    (invalidHistory.current as Record<string, unknown>).alphaBoostSource = 4;
    expect(readMaterialEditRecovery(JSON.stringify(invalid), source)).toBeNull();
    invalidHistory.current = source.knobs;
    invalidHistory.undoStack = [null];
    expect(readMaterialEditRecovery(JSON.stringify(invalid), source)).toBeNull();
    invalidHistory.undoStack = {};
    expect(readMaterialEditRecovery(JSON.stringify(invalid), source)).toBeNull();
  });

  it("rejects invalid source identity rather than accepting inherited keys", () => {
    const raw = record();
    const storedSource = raw.source as Record<string, unknown>;
    storedSource.fabricId = "toString";
    expect(readMaterialEditRecovery(JSON.stringify(raw), source)).toBeNull();
    storedSource.fabricId = "myeongju";
    storedSource.materialId = "";
    expect(readMaterialEditRecovery(JSON.stringify(raw), source)).toBeNull();
  });

  it("rejects non-finite values on write before JSON could turn them into null", () => {
    expect(serializeMaterialEditRecovery(source, {
      ...edited(),
      current: { ...source.knobs, sheen: Number.NaN },
    })).toBeNull();
  });

  it("refuses oversized JSON before parsing", () => {
    expect(readMaterialEditRecovery(" ".repeat(MATERIAL_EDIT_RECOVERY_MAX_LENGTH + 1), source)).toBeNull();
  });

  it("namespaces records without collisions between material and package ids", () => {
    expect(materialEditRecoveryKey("red-silk", "package-123")).toMatch(new RegExp(`^${MATERIAL_EDIT_RECOVERY_PREFIX.replaceAll(".", "\\.")}`));
    expect(materialEditRecoveryKey("a:b", "c")).not.toBe(materialEditRecoveryKey("a", "b:c"));
  });
});
