import {
  DEFAULT_FABRIC_KNOBS,
  type FabricKnobs,
} from "./knobs";

export type MaterialDraftComparison = "baseline" | "current";
export type MaterialDraftSnapshot = Readonly<FabricKnobs>;

/**
 * A recoverable editing session for one material. Scene preferences are
 * intentionally absent: every snapshot is rebuilt from FabricKnobs keys only.
 *
 * `undoStack` and `redoStack` store committed states, with the next state at
 * the end of each array. A UI should dispatch one `commit` per completed
 * gesture (for example, on slider pointer-up), not for every preview frame.
 */
export interface MaterialDraftHistory {
  readonly baseline: MaterialDraftSnapshot;
  readonly current: MaterialDraftSnapshot;
  readonly undoStack: readonly MaterialDraftSnapshot[];
  readonly redoStack: readonly MaterialDraftSnapshot[];
  readonly comparison: MaterialDraftComparison;
}

export type MaterialDraftAction =
  | { readonly type: "commit"; readonly knobs: FabricKnobs }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "discard" }
  | { readonly type: "keep"; readonly knobs?: FabricKnobs }
  | {
      readonly type: "compare";
      readonly selection: MaterialDraftComparison;
    };

const FABRIC_KNOB_KEYS = Object.keys(DEFAULT_FABRIC_KNOBS) as (
  keyof FabricKnobs
)[];

/** Clone the flat material surface without serializing or widening values. */
function snapshot(knobs: FabricKnobs): MaterialDraftSnapshot {
  return Object.freeze(
    Object.fromEntries(FABRIC_KNOB_KEYS.map((key) => [key, knobs[key]])),
  ) as unknown as MaterialDraftSnapshot;
}

function sameKnobs(
  left: MaterialDraftSnapshot,
  right: MaterialDraftSnapshot,
): boolean {
  return FABRIC_KNOB_KEYS.every((key) => Object.is(left[key], right[key]));
}

function historyState(
  baseline: MaterialDraftSnapshot,
  current: MaterialDraftSnapshot,
  undoStack: readonly MaterialDraftSnapshot[],
  redoStack: readonly MaterialDraftSnapshot[],
  comparison: MaterialDraftComparison,
): MaterialDraftHistory {
  return Object.freeze({
    baseline,
    current,
    undoStack: Object.freeze(undoStack),
    redoStack: Object.freeze(redoStack),
    comparison,
  });
}

export function createMaterialDraft(
  knobs: FabricKnobs,
): MaterialDraftHistory {
  return historyState(snapshot(knobs), snapshot(knobs), [], [], "current");
}

/** Reducer suitable for React.useReducer. Each `commit` is one undo step. */
export function materialDraftReducer(
  state: MaterialDraftHistory,
  action: MaterialDraftAction,
): MaterialDraftHistory {
  switch (action.type) {
    case "commit": {
      const next = snapshot(action.knobs);
      if (sameKnobs(state.current, next)) {
        return state.comparison === "current"
          ? state
          : historyState(
              state.baseline,
              state.current,
              state.undoStack,
              state.redoStack,
              "current",
            );
      }

      return historyState(
        state.baseline,
        next,
        [...state.undoStack, state.current],
        [],
        "current",
      );
    }

    case "undo": {
      const previous = state.undoStack.at(-1);
      if (!previous) {
        return state.comparison === "current"
          ? state
          : historyState(
              state.baseline,
              state.current,
              state.undoStack,
              state.redoStack,
              "current",
            );
      }

      return historyState(
        state.baseline,
        previous,
        state.undoStack.slice(0, -1),
        [...state.redoStack, state.current],
        "current",
      );
    }

    case "redo": {
      const next = state.redoStack.at(-1);
      if (!next) {
        return state.comparison === "current"
          ? state
          : historyState(
              state.baseline,
              state.current,
              state.undoStack,
              state.redoStack,
              "current",
            );
      }

      return historyState(
        state.baseline,
        next,
        [...state.undoStack, state.current],
        state.redoStack.slice(0, -1),
        "current",
      );
    }

    case "discard": {
      const baseline = snapshot(state.baseline);
      return historyState(baseline, snapshot(baseline), [], [], "current");
    }

    case "keep": {
      const kept = snapshot(action.knobs ?? state.current);
      return historyState(kept, snapshot(kept), [], [], "current");
    }

    case "compare":
      return action.selection === state.comparison
        ? state
        : historyState(
            state.baseline,
            state.current,
            state.undoStack,
            state.redoStack,
            action.selection,
          );
  }
}

export function isMaterialDraftDirty(state: MaterialDraftHistory): boolean {
  return !sameKnobs(state.baseline, state.current);
}

export function selectedMaterialDraft(
  state: MaterialDraftHistory,
): MaterialDraftSnapshot {
  return state.comparison === "baseline" ? state.baseline : state.current;
}

export function canUndoMaterialDraft(state: MaterialDraftHistory): boolean {
  return state.undoStack.length > 0;
}

export function canRedoMaterialDraft(state: MaterialDraftHistory): boolean {
  return state.redoStack.length > 0;
}
