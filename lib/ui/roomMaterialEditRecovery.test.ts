import { describe, expect, it } from "vitest";
import redSilk from "../../fabrics/presets/71871d958aa681541baf9159cbf98bc4.json";
import type { MaterialPreset } from "../presets/types";
import { createMaterialDraft, materialDraftReducer } from "./materialDraftHistory";
import {
  readMaterialEditRecovery,
  serializeMaterialEditRecovery,
  type MaterialEditSource,
} from "./materialEditRecovery";
import { readRoomMaterialEditRecovery } from "./roomMaterialEditRecovery";
import { roomMaterialPreset } from "./roomMaterialPreset";

const seed = redSilk as MaterialPreset;
const oldSource: MaterialEditSource = {
  materialId: seed.slug,
  pkgHash: seed.pkgHash!,
  fabricId: seed.fabricId,
  metalness: seed.metalness,
  knobs: seed.knobs,
};
const roomSource = { ...oldSource, knobs: roomMaterialPreset(seed).knobs };
const edited = materialDraftReducer(createMaterialDraft(seed.knobs), {
  type: "commit",
  knobs: { ...seed.knobs, sheen: 0.65, alphaBoost: 0.12 },
});
const secondEdit = materialDraftReducer(edited, {
  type: "commit",
  knobs: { ...edited.current, normalAmount: 0.9 },
});
const withRedo = materialDraftReducer(secondEdit, { type: "undo" });
const oldJson = serializeMaterialEditRecovery(oldSource, withRedo)!;

describe("room silk edit recovery", () => {
  it("keeps all unsaved values and history across the exact baseline correction", () => {
    expect(readMaterialEditRecovery(oldJson, roomSource)).toBeNull();
    const restored = readRoomMaterialEditRecovery(oldJson, roomSource, seed)!;

    expect(restored.baseline).toEqual(roomSource.knobs);
    expect(restored.current).toEqual(withRedo.current);
    expect(restored.undoStack).toEqual(withRedo.undoStack);
    expect(restored.redoStack).toEqual(withRedo.redoStack);
    expect(restored.current.alphaFromDensity).toBe(0.048);
    expect(restored.current.alphaBoost).toBe(0.12);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.baseline)).toBe(true);
    expect(readMaterialEditRecovery(oldJson, oldSource)).toEqual(withRedo);
  });

  it("persists the recovered session against the corrected source on the next write", () => {
    const restored = readRoomMaterialEditRecovery(oldJson, roomSource, seed)!;
    const nextJson = serializeMaterialEditRecovery(roomSource, restored);
    expect(nextJson).not.toBeNull();
    expect(readMaterialEditRecovery(nextJson, roomSource)).toEqual(restored);
    expect(readRoomMaterialEditRecovery(nextJson, roomSource)).toEqual(restored);
    expect(materialDraftReducer(restored, { type: "redo" }).current).toEqual(secondEdit.current);
  });

  it.each<Partial<MaterialPreset>>([
    { builtIn: false },
    { builtIn: undefined },
    { slug: "private-copy" },
    { pkgHash: "other-package" },
    { knobs: { ...seed.knobs, openness: 0.2 } },
  ])("requires the untouched built-in source, not another preset: %j", (changes) => {
    expect(readRoomMaterialEditRecovery(oldJson, roomSource, { ...seed, ...changes })).toBeNull();
  });

  it.each<Partial<MaterialEditSource>>([
    { materialId: "private-copy" },
    { pkgHash: "new-package" },
    { metalness: 0.1 },
    { fabricId: "denim" },
    { knobs: { ...roomSource.knobs, sheen: 0.2 } },
  ])("still rejects source replacements or later baseline changes: %j", (changes) => {
    expect(readRoomMaterialEditRecovery(oldJson, { ...roomSource, ...changes }, seed)).toBeNull();
  });

  it("does not bypass malformed-record validation or require migration for ordinary recovery", () => {
    expect(readRoomMaterialEditRecovery("not json", roomSource, seed)).toBeNull();
    expect(readRoomMaterialEditRecovery(oldJson, roomSource)).toBeNull();
    expect(readRoomMaterialEditRecovery(oldJson, oldSource)).toEqual(withRedo);
  });
});
