import { describe, expect, it } from "vitest";
import redSilk from "../../fabrics/presets/71871d958aa681541baf9159cbf98bc4.json";
import type { MaterialPreset } from "../presets/types";
import type { FabricKnobs } from "./knobs";
import { paramSig } from "./knobs";
import { createMaterialDraft, isMaterialDraftDirty } from "./materialDraftHistory";
import { roomMaterialPreset, roomOpennessCoverageFields } from "./roomMaterialPreset";

const seed = redSilk as MaterialPreset;

describe("room silk coverage", () => {
  it("corrects only the committed silk's alpha loss, retaining fiber glow and fray", () => {
    const source = Object.freeze({ ...seed, knobs: Object.freeze({ ...seed.knobs }) });
    const result = roomMaterialPreset(source);

    expect(result).toEqual({ ...source, knobs: { ...source.knobs, alphaFromDensity: 0 } });
    expect(result.knobs.translucency).toBe(0.48);
    expect(result.knobs.densityAmount).toBe(0.76);
    expect(result.knobs.edgeFray).toBe(source.knobs.edgeFray);
    expect(source.knobs.alphaFromDensity).toBe(0.048);
    expect(roomMaterialPreset(result)).toBe(result);
  });

  it.each<Partial<MaterialPreset>>([
    { builtIn: false },
    { builtIn: undefined },
    { slug: "user-silk-copy" },
    { pkgHash: "other-package" },
    { pkgHash: null },
  ])("leaves user, imported and unrelated presets untouched: %j", (changes) => {
    const source = { ...seed, ...changes };
    expect(roomMaterialPreset(source)).toBe(source);
  });

  it.each<Partial<FabricKnobs>>([
    { openness: 0.8 },
    { translucency: 0.7 },
    { densityAmount: 0.5 },
    { alphaFromDensity: 0.08 },
    { alphaBoost: 0.4 },
    { alphaBoostSource: 2 },
    { txHeight: 0 },
    { txAlbedo: 0 },
    { txRoughness: 0.5 },
    { transmissionContrast: 0.8 },
  ])("does not reinterpret a different authored optical signature: %j", (changes) => {
    const source = { ...seed, knobs: { ...seed.knobs, ...changes } };
    expect(roomMaterialPreset(source)).toBe(source);
  });

  it("establishes a clean draft and matching save signature from the corrected baseline", () => {
    const roomPreset = roomMaterialPreset(seed);
    const draft = createMaterialDraft(roomPreset.knobs);
    const signature = (knobs: FabricKnobs) =>
      paramSig(roomPreset.fabricId, roomPreset.metalness, knobs);

    expect(isMaterialDraftDirty(draft)).toBe(false);
    expect(signature(draft.current)).toBe(signature(roomPreset.knobs));
    expect(signature(draft.current)).not.toBe(signature(seed.knobs));
    expect(draft.baseline.alphaFromDensity).toBe(0);
    expect(draft.current.translucency).toBe(0.48);
  });

  it("copies and serializes corrected actual values without depending on a render override", () => {
    // cloneItem uses the selected library preset's knobs, while export/save
    // use the live draft. Both must inherit the same corrected baseline.
    const libraryPreset = roomMaterialPreset(seed);
    const copy: MaterialPreset = {
      ...libraryPreset,
      builtIn: undefined,
      slug: "private-copy",
      knobs: { ...libraryPreset.knobs },
    };
    const reopened = JSON.parse(JSON.stringify(copy)) as MaterialPreset;

    expect(roomMaterialPreset(reopened)).toBe(reopened);
    expect(reopened.knobs.alphaFromDensity).toBe(0);
    expect(reopened.knobs.translucency).toBe(0.48);
    copy.knobs.alphaBoost = 0.5;
    expect(libraryPreset.knobs.alphaBoost).toBe(0);
    expect(seed.knobs.alphaFromDensity).toBe(0.048);
  });

  it("keeps fiber backlighting independent through an openness round trip", () => {
    const source = roomMaterialPreset(seed).knobs;
    const sheer = { ...source, openness: 1, ...roomOpennessCoverageFields(1) };
    const closed = { ...sheer, openness: 0, ...roomOpennessCoverageFields(0) };

    expect(sheer.alphaFromDensity).toBe(0.1);
    expect(sheer.densityAmount).toBe(0.76);
    expect(sheer.translucency).toBe(0.48);
    expect(closed.alphaFromDensity).toBe(0);
    expect(closed.translucency).toBe(0.48);
    expect(closed).toEqual(source);
    expect(roomOpennessCoverageFields(0)).not.toHaveProperty("translucency");
    expect(roomOpennessCoverageFields(0)).not.toHaveProperty("densityAmount");
  });

  it("preserves the cubic coverage curve and its bounds", () => {
    expect(roomOpennessCoverageFields(0.5)).toEqual({
      alphaFromDensity: 0.0125,
    });
    expect(roomOpennessCoverageFields(-1)).toEqual(roomOpennessCoverageFields(0));
    expect(roomOpennessCoverageFields(2)).toEqual(roomOpennessCoverageFields(1));
  });
});
