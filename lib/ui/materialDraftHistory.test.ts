import { describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_KNOBS,
  DEFAULT_KNOBS,
  type FabricKnobs,
  type Knobs,
} from "./knobs";
import {
  canRedoMaterialDraft,
  canUndoMaterialDraft,
  createMaterialDraft,
  isMaterialDraftDirty,
  materialDraftReducer,
  selectedMaterialDraft,
} from "./materialDraftHistory";

function withKnobs(changes: Partial<FabricKnobs>): FabricKnobs {
  return { ...DEFAULT_FABRIC_KNOBS, ...changes };
}

describe("material draft history", () => {
  it("snapshots only fabric fields and preserves unusual numeric values exactly", () => {
    const merged: Knobs = {
      ...DEFAULT_KNOBS,
      sheen: -0,
      iridescence: Number.NaN,
      pomScale: Number.POSITIVE_INFINITY,
      alphaBoostSource: 3,
    };

    const state = createMaterialDraft(merged);

    expect(state.current).not.toHaveProperty("mouseForce");
    expect(state.current).not.toHaveProperty("quality");
    expect(Object.keys(state.current)).toEqual(
      Object.keys(DEFAULT_FABRIC_KNOBS),
    );
    expect(Object.is(state.current.sheen, -0)).toBe(true);
    expect(Object.is(state.current.iridescence, Number.NaN)).toBe(true);
    expect(state.current.pomScale).toBe(Number.POSITIVE_INFINITY);
    expect(state.current.alphaBoostSource).toBe(3);

    merged.sheen = 0.75;
    expect(Object.is(state.baseline.sheen, -0)).toBe(true);
    expect(Object.is(state.current.sheen, -0)).toBe(true);
  });

  it("records every changed commit as one undo step and ignores no-op commits", () => {
    const initial = createMaterialDraft(DEFAULT_FABRIC_KNOBS);
    const changed = withKnobs({ sheen: 0.2, edgeFray: 0.8 });
    const committed = materialDraftReducer(initial, {
      type: "commit",
      knobs: changed,
    });

    expect(committed.current.sheen).toBe(0.2);
    expect(committed.current.edgeFray).toBe(0.8);
    expect(committed.undoStack).toHaveLength(1);
    expect(committed.redoStack).toHaveLength(0);
    expect(isMaterialDraftDirty(committed)).toBe(true);

    const noOp = materialDraftReducer(committed, {
      type: "commit",
      knobs: { ...changed },
    });
    expect(noOp).toBe(committed);
    expect(noOp.undoStack).toHaveLength(1);
  });

  it("undoes and redoes complete snapshots in order", () => {
    const initial = createMaterialDraft(DEFAULT_FABRIC_KNOBS);
    const first = materialDraftReducer(initial, {
      type: "commit",
      knobs: withKnobs({ sheen: 0.25, alphaBoostSource: 1 }),
    });
    const second = materialDraftReducer(first, {
      type: "commit",
      knobs: withKnobs({ sheen: 0.75, alphaBoostSource: 2 }),
    });

    const undoSecond = materialDraftReducer(second, { type: "undo" });
    expect(undoSecond.current.sheen).toBe(0.25);
    expect(undoSecond.current.alphaBoostSource).toBe(1);
    expect(canUndoMaterialDraft(undoSecond)).toBe(true);
    expect(canRedoMaterialDraft(undoSecond)).toBe(true);

    const undoFirst = materialDraftReducer(undoSecond, { type: "undo" });
    expect(undoFirst.current).toEqual(DEFAULT_FABRIC_KNOBS);
    expect(canUndoMaterialDraft(undoFirst)).toBe(false);

    const redoFirst = materialDraftReducer(undoFirst, { type: "redo" });
    const redoSecond = materialDraftReducer(redoFirst, { type: "redo" });
    expect(redoSecond.current.sheen).toBe(0.75);
    expect(redoSecond.current.alphaBoostSource).toBe(2);
    expect(canRedoMaterialDraft(redoSecond)).toBe(false);
  });

  it("clears redo history when a new edit branches from an undone state", () => {
    const first = materialDraftReducer(createMaterialDraft(DEFAULT_FABRIC_KNOBS), {
      type: "commit",
      knobs: withKnobs({ sheen: 0.1 }),
    });
    const second = materialDraftReducer(first, {
      type: "commit",
      knobs: withKnobs({ sheen: 0.2 }),
    });
    const undone = materialDraftReducer(second, { type: "undo" });
    const branch = materialDraftReducer(undone, {
      type: "commit",
      knobs: withKnobs({ sheen: 0.9 }),
    });

    expect(branch.current.sheen).toBe(0.9);
    expect(canRedoMaterialDraft(branch)).toBe(false);
    expect(branch.undoStack).toHaveLength(2);
  });

  it("discards the working edit back to its baseline", () => {
    const edited = materialDraftReducer(createMaterialDraft(DEFAULT_FABRIC_KNOBS), {
      type: "commit",
      knobs: withKnobs({ bendStiffness: 0.9 }),
    });
    const comparing = materialDraftReducer(edited, {
      type: "compare",
      selection: "baseline",
    });
    const discarded = materialDraftReducer(comparing, { type: "discard" });

    expect(discarded.current).toEqual(DEFAULT_FABRIC_KNOBS);
    expect(discarded.comparison).toBe("current");
    expect(discarded.undoStack).toHaveLength(0);
    expect(discarded.redoStack).toHaveLength(0);
    expect(isMaterialDraftDirty(discarded)).toBe(false);
  });

  it("marks the current or a persisted snapshot as the new kept baseline", () => {
    const edited = materialDraftReducer(createMaterialDraft(DEFAULT_FABRIC_KNOBS), {
      type: "commit",
      knobs: withKnobs({ openness: 0.8 }),
    });
    const kept = materialDraftReducer(edited, { type: "keep" });

    expect(kept.baseline.openness).toBe(0.8);
    expect(kept.current.openness).toBe(0.8);
    expect(isMaterialDraftDirty(kept)).toBe(false);
    expect(canUndoMaterialDraft(kept)).toBe(false);

    const persisted = withKnobs({ openness: 0.79, alphaBoostSource: 2 });
    const normalized = materialDraftReducer(edited, {
      type: "keep",
      knobs: persisted,
    });
    expect(normalized.baseline).toEqual(persisted);
    expect(normalized.current).toEqual(persisted);
    expect(normalized.undoStack).toHaveLength(0);
  });

  it("selects baseline or current for comparison without changing history", () => {
    const edited = materialDraftReducer(createMaterialDraft(DEFAULT_FABRIC_KNOBS), {
      type: "commit",
      knobs: withKnobs({ tileScale: 4 }),
    });
    const comparing = materialDraftReducer(edited, {
      type: "compare",
      selection: "baseline",
    });

    expect(selectedMaterialDraft(comparing).tileScale).toBe(
      DEFAULT_FABRIC_KNOBS.tileScale,
    );
    expect(comparing.current.tileScale).toBe(4);
    expect(comparing.undoStack).toBe(edited.undoStack);
    expect(isMaterialDraftDirty(comparing)).toBe(true);

    const current = materialDraftReducer(comparing, {
      type: "compare",
      selection: "current",
    });
    expect(selectedMaterialDraft(current).tileScale).toBe(4);
  });

  it("uses exact equality for dirty detection", () => {
    const negativeZero = createMaterialDraft(withKnobs({ sheen: -0 }));
    const positiveZero = materialDraftReducer(negativeZero, {
      type: "commit",
      knobs: withKnobs({ sheen: 0 }),
    });
    expect(isMaterialDraftDirty(positiveZero)).toBe(true);

    const nanBaseline = createMaterialDraft(
      withKnobs({ iridescence: Number.NaN }),
    );
    const sameNan = materialDraftReducer(nanBaseline, {
      type: "commit",
      knobs: withKnobs({ iridescence: Number.NaN }),
    });
    expect(sameNan).toBe(nanBaseline);
    expect(isMaterialDraftDirty(sameNan)).toBe(false);
  });
});
