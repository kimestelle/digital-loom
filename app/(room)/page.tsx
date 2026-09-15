"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import ClothScene, {
  type ClothProbe,
  type ClothSceneHandle,
  type ClothStats,
} from "@/lib/ui/clothScene";
import { STAMP_MASK_URI } from "@/lib/ui/stampMask";
import { fabricFromPkg } from "@/lib/ui/fabricViewer";
import {
  FABRICS,
  type FabricId,
} from "@/lib/cloth/fabrics";
import { runPatinaBaseline } from "@/lib/pipeline/patinaBaseline";
import { readMapStats } from "@/lib/pipeline/mapStats";
import {
  MAP_ORDER,
  pkgFromMaps,
  type MapEntry,
  type MapName,
  type MaterialPackage,
} from "@/lib/core/materialPackage";
import { resolveMetalnessAmount } from "@/lib/core/metalness";
import {
  type FabricKnobs,
  type Knobs,
  DEFAULT_FABRIC_KNOBS,
  DEFAULT_KNOBS,
  MESH_PRESETS,
  QUALITY_PRESETS,
  fabricKnobsOf,
  paramSig,
} from "@/lib/ui/knobs";
import type { MaterialPreset } from "@/lib/presets/types";
import {
  roomMaterialPreset,
  roomOpennessCoverageFields,
} from "@/lib/ui/roomMaterialPreset";
import { WeaveDiagram } from "@/lib/ui/weaveDiagram";
import {
  IntSlider,
  SectionLabel,
  Slider,
  shortHash,
} from "@/lib/ui/panelPrimitives";
import { InstrumentPad } from "@/lib/ui/instrumentPad";
import {
  CONSTRUCTION_OPTIONS,
  applyMaterialInstrument,
  createMaterialInstrumentBaseline,
  effectiveOpennessPercent,
  inferConstruction,
  readMaterialInstrument,
  tileScaleFromSlider,
  tileScaleToSlider,
  type Construction,
  type MaterialInstrumentState,
} from "@/lib/ui/materialInstrument";
import {
  canRedoMaterialDraft,
  canUndoMaterialDraft,
  createMaterialDraft,
  isMaterialDraftDirty,
  materialDraftReducer,
  type MaterialDraftAction,
  type MaterialDraftHistory,
} from "@/lib/ui/materialDraftHistory";
import {
  NavBar,
  type PipelineStatus,
  type StageMode,
} from "@/lib/ui/navBar";
import {
  MapsStrip,
  type ExportState,
} from "@/lib/ui/mapsStrip";
import type { MapVariationSource } from "@/lib/ui/mapEditorModal";
import { PixelPlay } from "@/lib/ui/pixelPlay";
import { PerformanceMeters, type PerformanceMetersHandle } from "@/lib/ui/performanceMeters";
import { InsertPanel } from "@/lib/ui/insertPanel";
import { RoomFrame } from "@/lib/ui/roomFrame";
import {
  MaterialCabinet,
  type MaterialCabinetFace,
} from "@/lib/ui/materialCabinet";
import { RoomLightModal } from "@/lib/ui/roomLightModal";
import { MaterialEditShelf } from "@/lib/ui/materialEditShelf";
import { MaterialLeaveDialog } from "@/lib/ui/materialLeaveDialog";
import {
  materialEditRecoveryKey,
  serializeMaterialEditRecovery,
} from "@/lib/ui/materialEditRecovery";
import { readRoomMaterialEditRecovery } from "@/lib/ui/roomMaterialEditRecovery";
import { useRoomLightController } from "@/lib/ui/useRoomLightController";
import { ROOM_NARROW_MEDIA, roomPreviewTileScale } from "@/lib/ui/roomPatternScale";
import { ROOM_MOBILE_PERFORMANCE_MEDIA, roomPerformance } from "@/lib/ui/roomPerformance";
import {
  DEFAULT_ROOM_LIGHT_SETTINGS,
  restoreRoomLightSettings,
  sanitizeRoomLightSettings,
  type MaterialLightProfile,
  type RgbColor,
  type RoomLightSettings,
} from "@/lib/ui/roomLight";
import { getCachedMap, warmMapCache } from "@/lib/export/mapCache";
import {
  LibraryGrid,
  SampleGrid,
  useSwatchDrag,
} from "@/lib/ui/materialSwatches";
import {
  useMaterialSwap,
  type MaterialSwapController,
} from "@/lib/ui/materialTransfer";
import type { SaveStatusKind } from "@/lib/ui/saveStatus";
import {
  adoptServerPreset,
  deleteAuthoringItem,
  importAuthoringMaterialBytes,
  loadAuthoringEntry,
  loadAuthoringOrder,
  normalizeAuthoringHash,
  saveAuthoringMaterial,
  saveAuthoringOrder,
  saveAuthoringPreset,
  type AuthoringMaterial,
} from "@/lib/library/repository";
import {
  SaveRevisionRegistry,
  type SaveRevision,
} from "@/lib/library/saveRevisions";

const OBJECT_MODEL_URL = "/model/whale.glb";

interface CacheEntry {
  hash: string;
  createdAt: string;
  prompt: string | null;
  sourceFilename: string | null;
  maps: {
    name: MapName;
    file: string;
    url: string;
    provenance?: MapEntry["provenance"];
    sourceHash?: string;
  }[];
  /** A retained map owner for clones whose canonical row was deleted. */
  hidden?: boolean;
}

function mapFileFromUrl(url: string, name: string): string {
  try {
    const path = new URL(url, "http://digital-loom.local").pathname;
    const file = decodeURIComponent(path.split("/").pop() ?? "");
    if (/^[A-Za-z0-9_.-]+$/.test(file)) return file;
  } catch {
    // Fall through to a deterministic filename for non-URL map sources.
  }
  return `${name}.png`;
}

function authoringMaterialFromEntry(entry: CacheEntry): AuthoringMaterial {
  return {
    hash: entry.hash,
    createdAt: entry.createdAt || new Date().toISOString(),
    prompt: entry.prompt,
    sourceFilename: entry.sourceFilename,
    hidden: entry.hidden,
    maps: entry.maps.map((map) => ({
      ...map,
      file: map.file || mapFileFromUrl(map.url, map.name),
    })),
  };
}

function cacheEntryFromPackage(
  hash: string,
  pkg: MaterialPackage,
  prompt: string,
  sourceFilename: string,
): CacheEntry {
  return {
    hash,
    createdAt: pkg.meta.createdAt,
    prompt,
    sourceFilename,
    maps: MAP_ORDER.flatMap((name) => {
      const map = pkg.maps[name];
      return map
        ? [
            {
              name,
              file: mapFileFromUrl(map.url, name),
              url: map.url,
              provenance: map.provenance,
              sourceHash: map.sourceHash,
            },
          ]
        : [];
    }),
  };
}

type TuningView = "fabric" | "scene";

function TuningViewPicker({
  view,
  onSelect,
  placement,
}: {
  view: TuningView;
  onSelect: (view: TuningView) => void;
  placement: "header" | "sheet";
}) {
  return (
    <div
      className={`tx-mode-picker tuning-view-picker tuning-view-picker-${placement}`}
      role="group"
      aria-label="tuning view"
    >
      <PixelPlay tone="ink" layer="over" />
      {(
        [
          { v: "fabric" as const, label: "fabric" },
          { v: "scene" as const, label: "scene" },
        ]
      ).map((option) => (
        <button
          key={option.v}
          type="button"
          className="tx-mode-tab"
          aria-pressed={view === option.v}
          data-active={view === option.v}
          onClick={() => onSelect(option.v)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const PREGEN_MANIFEST = "/pregen/silk-sample/manifest.json";
const PREGEN_BASE = "/pregen/silk-sample";
const ROOM_LIGHT_STORAGE_KEY = "loom.room.v1";
const LAST_EDITED_MATERIAL_KEY = "loom.room.last-edited-material.v1";
// Content hash of the pregen silk-sample bundle — the boot material and the
// maps behind the curated "red silk" preset.
const PREGEN_HASH = "71871d958aa681541baf9159cbf98bc4";

function axisWord(value: number, low: string, middle: string, high: string): string {
  if (value < 0.34) return low;
  if (value > 0.66) return high;
  return middle;
}

/** A selectable swatch — a built-in sample, a cached extraction, a curated
 *  material (red silk), or a user clone. `id` is the autosave key (a material's
 *  own hash, or a clone's private slug); `pkgHash` is which maps to load, so a
 *  clone can own its params while borrowing a source's maps. `entry` carries
 *  those maps (absent for params-only items); `preset` carries saved params
 *  (absent until the material has been tuned). Structurally a SwatchItem, so
 *  the grids in lib/ui/materialSwatches render it directly. */
interface LibraryItem {
  id: string;
  pkgHash: string;
  label: string;
  thumb?: string;
  title?: string;
  entry?: CacheEntry;
  preset?: MaterialPreset;
  /** A clone owns its params but shares another material's maps. */
  clone: boolean;
  /** Clones and cache runs can be removed; built-in samples stay. */
  deletable: boolean;
}

export default function Home() {
  const [pkg, setPkg] = useState<MaterialPackage | null>(null);
  const [status, setStatus] = useState<PipelineStatus>({ kind: "idle" });
  // No default prompt text — a pre-filled value led to accidental submits when
  // a photo was dropped. The field starts empty and the server falls back to
  // "fabric" if it's left blank at submit time.
  const [prompt, setPrompt] = useState("");
  // Metalness amount (raw text so the field can be genuinely empty rather than
  // showing a default 0). Parsed + clamped to 0..1 before it reaches the shader.
  const [metalnessInput, setMetalnessInput] = useState("");
  // A dropped/selected photo waits here until the user hits submit — dropping
  // no longer auto-runs the (billed) extraction.
  const [stagedFile, setStagedFile] = useState<{
    file: File;
    name: string;
  } | null>(null);
  const [mode, setMode] = useState<StageMode>("cloth");
  const roomRootRef = useRef<HTMLElement | null>(null);
  const [cabinetFace, setCabinetFace] =
    useState<MaterialCabinetFace>("archive");
  const [lightModalOpen, setLightModalOpen] = useState(false);
  const [roomLightSettings, setRoomLightSettings] =
    useState<RoomLightSettings>(() => ({ ...DEFAULT_ROOM_LIGHT_SETTINGS }));
  const [albedoTint, setAlbedoTint] = useState<RgbColor>({
    r: 0.58,
    g: 0.12,
    b: 0.13,
  });
  const [knobs, setKnobs] = useState<Knobs>(DEFAULT_KNOBS);
  const [materialDraft, setMaterialDraft] = useState<MaterialDraftHistory>(() =>
    createMaterialDraft(fabricKnobsOf(DEFAULT_KNOBS)),
  );
  const [construction, setConstruction] = useState<Construction>(() =>
    inferConstruction(fabricKnobsOf(DEFAULT_KNOBS)),
  );
  const [keepingDraft, setKeepingDraft] = useState(false);
  const [savedSwatchName, setSavedSwatchName] = useState<string | null>(null);
  const [viewingSavedSwatch, setViewingSavedSwatch] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const [leaveAction, setLeaveAction] = useState<string | null>(null);
  const leaveResolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const recoveryCheckedRef = useRef<string | null>(null);
  const resumedMaterialRef = useRef(false);
  const [pendingMaterialId, setPendingMaterialId] = useState<string | null>(null);
  const [tuningView, setTuningView] = useState<TuningView>("fabric");
  const tuningScrollRef = useRef<HTMLElement | null>(null);
  const selectTuningView = useCallback((view: TuningView) => {
    setTuningView(view);
    tuningScrollRef.current?.scrollTo({ top: 0 });
  }, []);
  const [fabricId, setFabricId] = useState<FabricId>("myeongju");
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([]);
  const [presets, setPresets] = useState<MaterialPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatusKind>("saved");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const saveJobIdRef = useRef(0);
  const savePendingRef = useRef(0);
  const failedSaveJobsRef = useRef(
    new Map<
      number,
      {
        job: () => Promise<void>;
        message: string;
        revision?: SaveRevision;
      }
    >(),
  );
  const saveRevisionsRef = useRef(new SaveRevisionRegistry());
  // Id of the material currently on the loom — the key its params autosave
  // under. A canonical material's id is its hash; a clone's id is its own slug.
  // null = nothing selected yet.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  // Last material signature loaded or saved. Keeping this in state makes the
  // autosave gate explicit and lets React sequence updates with material
  // selection instead of sharing mutable state across memoized callbacks.
  const [autosaveBaseline, setAutosaveBaseline] = useState<{
    id: string | null;
    sig: string;
  }>({ id: null, sig: "" });
  // The maps hash for the active material (a clone's differs from its id).
  const activePkgHashRef = useRef<string | null>(null);
  // Invalidates delayed estimators when the user chooses another material.
  // Map extraction may still finish and save safely, but an obsolete result
  // must never put its controls onto the current loom.
  const materialIntentRef = useRef(0);
  const pendingMaterialSelectionRef = useRef<{
    id: string;
    intent: number;
  } | null>(null);
  // Mesh-dissolve entry point for callbacks defined before the transfer hook
  // is instantiated (Patina completion, deletion). Until the hook mounts it
  // degrades to an instant commit — same behavior as before this feature.
  const materialSwapRef = useRef<MaterialSwapController["swap"]>(
    (commit) => commit(),
  );
  // User-defined order of the library section, by item id. Persists to
  // IndexedDB so drag-reordering sticks and nothing shuffles on its own.
  const [libraryOrder, setLibraryOrder] = useState<string[]>([]);
  const libraryOrderRef = useRef<string[]>([]);
  // Cross-grid drag state (samples → library clone drags share it).
  const drag = useSwatchDrag();
  // Built-in sample materials (baked patina bundles under samples/).
  const [samples, setSamples] = useState<CacheEntry[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const clothSceneRef = useRef<ClothSceneHandle | null>(null);
  const [stageSize, setStageSize] = useState({ w: 900, h: 700 });
  const [narrowPreview, setNarrowPreview] = useState(false);
  const [mobilePerformance, setMobilePerformance] = useState<boolean | null>(null);
  const previewPerformance = roomPerformance(knobs, mobilePerformance === true);
  const perfMetersRef = useRef<PerformanceMetersHandle | null>(null);
  const reportPerfStats = useCallback((stats: ClothStats) => {
    perfMetersRef.current?.update(stats);
  }, []);
  const applyAutoQuality = useCallback((quality: Knobs["quality"]) => {
    setKnobs((k) => ({ ...k, quality }));
  }, []);

  // Live mirrors of fast-changing state, so callbacks that only *read* these
  // at call time (clone, export) don't have to list them as deps — that keeps
  // the callbacks referentially stable and the memoized panels skipping
  // re-renders during slider drags.
  const knobsRef = useRef(knobs);
  const materialDraftRef = useRef(materialDraft);
  const constructionRef = useRef(construction);
  const fabricGestureActiveRef = useRef(false);
  const instrumentBaselineRef = useRef(
    createMaterialInstrumentBaseline(
      fabricKnobsOf(DEFAULT_KNOBS),
      inferConstruction(fabricKnobsOf(DEFAULT_KNOBS)),
    ),
  );
  const fabricIdRef = useRef(fabricId);
  const metalnessInputRef = useRef(metalnessInput);

  useEffect(() => {
    knobsRef.current = knobs;
    materialDraftRef.current = materialDraft;
    constructionRef.current = construction;
    fabricIdRef.current = fabricId;
    metalnessInputRef.current = metalnessInput;
    activeIdRef.current = activeId;
  }, [knobs, materialDraft, construction, fabricId, metalnessInput, activeId]);

  const updateSaveIndicator = useCallback(() => {
    const failures = failedSaveJobsRef.current;
    if (failures.size > 0) {
      const latest = [...failures.values()].at(-1);
      setSaveMessage(latest?.message ?? "Local save failed");
      setSaveStatus("error");
    } else if (savePendingRef.current > 0) {
      setSaveMessage(null);
      setSaveStatus("saving");
    } else {
      setSaveMessage(null);
      setSaveStatus(isMaterialDraftDirty(materialDraftRef.current) ? "dirty" : "saved");
    }
  }, []);

  /** Reserve a latest-wins revision before a debounce begins. Any failed
   * closure for the same resource is obsolete as soon as the user edits again. */
  const reserveDurableSave = useCallback(
    (key: string): SaveRevision => {
      const revision = saveRevisionsRef.current.reserve(key);
      for (const [id, failed] of failedSaveJobsRef.current) {
        if (failed.revision?.key === key) failedSaveJobsRef.current.delete(id);
      }
      updateSaveIndicator();
      return revision;
    },
    [updateSaveIndicator],
  );

  /** Run a complete, idempotent local mutation. Failed jobs normally stay
   *  queued until retry succeeds; callers with their own retry UI can keep the
   *  failure local instead. Server compatibility failures are swallowed inside
   *  the repository and never masquerade as local-save failures. */
  const runDurableSave = useCallback(
    async (
      job: () => Promise<void>,
      revision?: SaveRevision,
      options: { retainFailure?: boolean } = {},
    ): Promise<boolean> => {
      if (revision && !saveRevisionsRef.current.isCurrent(revision)) {
        return true;
      }
      const id = ++saveJobIdRef.current;
      savePendingRef.current++;
      setSaveMessage(null);
      setSaveStatus("saving");
      try {
        await job();
        failedSaveJobsRef.current.delete(id);
        return true;
      } catch (error) {
        const current =
          !revision || saveRevisionsRef.current.isCurrent(revision);
        if (current && options.retainFailure !== false) {
          failedSaveJobsRef.current.set(id, {
            job,
            message: error instanceof Error ? error.message : String(error),
            revision,
          });
        }
        return !current;
      } finally {
        savePendingRef.current--;
        updateSaveIndicator();
      }
    },
    [updateSaveIndicator],
  );

  const retryFailedSaves = useCallback(async () => {
    if (failedSaveJobsRef.current.size === 0) return;
    const jobs = [...failedSaveJobsRef.current.entries()];
    savePendingRef.current += jobs.length;
    setSaveMessage(null);
    setSaveStatus("saving");
    for (const [id, failed] of jobs) {
      if (
        failed.revision &&
        !saveRevisionsRef.current.isCurrent(failed.revision)
      ) {
        failedSaveJobsRef.current.delete(id);
        savePendingRef.current--;
        continue;
      }
      try {
        await failed.job();
        failedSaveJobsRef.current.delete(id);
      } catch (error) {
        if (
          !failed.revision ||
          saveRevisionsRef.current.isCurrent(failed.revision)
        ) {
          failedSaveJobsRef.current.set(id, {
            job: failed.job,
            message: error instanceof Error ? error.message : String(error),
            revision: failed.revision,
          });
        } else {
          failedSaveJobsRef.current.delete(id);
        }
      } finally {
        savePendingRef.current--;
      }
    }
    updateSaveIndicator();
  }, [updateSaveIndicator]);

  const markSaveDirty = useCallback(() => {
    setSaveStatus((current) => (current === "error" ? current : "dirty"));
  }, []);

  const setMaterialDraftNow = useCallback((next: MaterialDraftHistory) => {
    materialDraftRef.current = next;
    setMaterialDraft(next);
  }, []);

  const confirmDiscardWorkingDraft = useCallback((action: string): Promise<boolean> => {
    if (!isMaterialDraftDirty(materialDraftRef.current)) return Promise.resolve(true);
    if (leaveResolverRef.current) return Promise.resolve(false);
    setLeaveAction(action);
    return new Promise(resolve => { leaveResolverRef.current = resolve; });
  }, []);

  const resolveLeave = useCallback((proceed: boolean) => {
    const resolve = leaveResolverRef.current;
    leaveResolverRef.current = null;
    setLeaveAction(null);
    resolve?.(proceed);
  }, []);

  useEffect(() => () => { leaveResolverRef.current?.(false); }, []);

  const replaceLiveFabric = useCallback((nextFabric: FabricKnobs) => {
    const next: Knobs = { ...knobsRef.current, ...nextFabric };
    knobsRef.current = next;
    setKnobs(next);
  }, []);

  /** Establish a new protected source state when a material is selected,
   * imported, estimated, or explicitly kept. */
  const loadMaterialDraft = useCallback(
    (nextFabric: FabricKnobs) => {
      recoveryCheckedRef.current = null;
      setSavedSwatchName(null);
      const nextConstruction = inferConstruction(nextFabric);
      const nextDraft = materialDraftReducer(materialDraftRef.current, {
        type: "keep",
        knobs: nextFabric,
      });
      fabricGestureActiveRef.current = false;
      constructionRef.current = nextConstruction;
      setConstruction(nextConstruction);
      instrumentBaselineRef.current = createMaterialInstrumentBaseline(
        nextFabric,
        nextConstruction,
      );
      setMaterialDraftNow(nextDraft);
      replaceLiveFabric(nextFabric);
    },
    [replaceLiveFabric, setMaterialDraftNow],
  );

  /** A drag may preview dozens of values, but the history records it once. */
  const protectFabricPreview = useCallback(() => {
    // The pad remains visually local until release, but touching it still
    // makes any delayed estimate/import older than the user's interaction.
    ++materialIntentRef.current;
  }, []);

  const beginFabricGesture = useCallback(() => {
    if (fabricGestureActiveRef.current) return;
    // A fresh material gesture is a newer intent than any delayed estimate,
    // import, or extraction still in flight. Material controls are inert while
    // an accepted swatch transfer is pending, so that commit remains atomic.
    ++materialIntentRef.current;
    if (materialDraftRef.current.comparison === "baseline") {
      setMaterialDraftNow(
        materialDraftReducer(materialDraftRef.current, {
          type: "compare",
          selection: "current",
        }),
      );
    }
    fabricGestureActiveRef.current = true;
    instrumentBaselineRef.current = createMaterialInstrumentBaseline(
      fabricKnobsOf(knobsRef.current),
      constructionRef.current,
    );
  }, [setMaterialDraftNow]);

  const previewFabricPatch = useCallback(
    (patch: Partial<FabricKnobs>) => {
      const opennessFields =
        patch.openness === undefined
          ? null
          : roomOpennessCoverageFields(patch.openness);
      replaceLiveFabric({
        ...fabricKnobsOf(knobsRef.current),
        ...opennessFields,
        ...patch,
      });
    },
    [replaceLiveFabric],
  );

  const previewInstrument = useCallback(
    (patch: Partial<MaterialInstrumentState>) => {
      const result = applyMaterialInstrument(instrumentBaselineRef.current, patch);
      constructionRef.current = result.construction;
      setConstruction(result.construction);
      replaceLiveFabric(
        patch.opennessPercent === undefined
          ? result.knobs
          : {
              ...result.knobs,
              ...roomOpennessCoverageFields(result.knobs.openness),
            },
      );
    },
    [replaceLiveFabric],
  );

  const commitFabricGesture = useCallback(() => {
    setSavedSwatchName(null);
    const currentFabric = fabricKnobsOf(knobsRef.current);
    const nextConstruction = inferConstruction(currentFabric);
    const previous = materialDraftRef.current;
    const next = materialDraftReducer(previous, {
      type: "commit",
      knobs: currentFabric,
    });
    fabricGestureActiveRef.current = false;
    constructionRef.current = nextConstruction;
    setConstruction(nextConstruction);
    instrumentBaselineRef.current = createMaterialInstrumentBaseline(
      currentFabric,
      nextConstruction,
    );
    if (next === previous) return;
    setMaterialDraftNow(next);
    markSaveDirty();
  }, [markSaveDirty, setMaterialDraftNow]);

  const commitFabricPatch = useCallback(
    (patch: Partial<FabricKnobs>) => {
      beginFabricGesture();
      previewFabricPatch(patch);
      commitFabricGesture();
    },
    [beginFabricGesture, commitFabricGesture, previewFabricPatch],
  );

  const commitInstrumentPatch = useCallback(
    (patch: Partial<MaterialInstrumentState>) => {
      beginFabricGesture();
      previewInstrument(patch);
      commitFabricGesture();
    },
    [beginFabricGesture, commitFabricGesture, previewInstrument],
  );

  const navigateMaterialDraft = useCallback(
    (action: Extract<MaterialDraftAction, { type: "undo" | "redo" | "discard" }>) => {
      const previous = materialDraftRef.current;
      const next = materialDraftReducer(previous, action);
      if (next === previous) return;
      const nextConstruction = inferConstruction(next.current);
      constructionRef.current = nextConstruction;
      setConstruction(nextConstruction);
      instrumentBaselineRef.current = createMaterialInstrumentBaseline(
        next.current,
        nextConstruction,
      );
      setMaterialDraftNow(next);
      replaceLiveFabric(next.current);
      if (isMaterialDraftDirty(next)) markSaveDirty();
      else updateSaveIndicator();
    },
    [markSaveDirty, replaceLiveFabric, setMaterialDraftNow, updateSaveIndicator],
  );

  const clearMaterialRecovery = useCallback((id = activeIdRef.current, hash = activePkgHashRef.current) => {
    if (!id || !hash) return;
    try {
      localStorage.removeItem(materialEditRecoveryKey(id, hash));
      const last = JSON.parse(localStorage.getItem(LAST_EDITED_MATERIAL_KEY) ?? "null");
      if (last?.id === id) localStorage.removeItem(LAST_EDITED_MATERIAL_KEY);
    } catch {
      setRecoveryWarning("Recovery storage unavailable. Save your swatch before leaving.");
    }
  }, []);

  const setDraftComparison = useCallback(
    (selection: "baseline" | "current") => {
      const previous = materialDraftRef.current;
      const next = materialDraftReducer(previous, {
        type: "compare",
        selection,
      });
      if (next !== previous) setMaterialDraftNow(next);
    },
    [setMaterialDraftNow],
  );

  // State + compatibility mirror only. Callers choose the right durable job so
  // clone/delete/import can commit their preset and order as one user action.
  const applyLibraryOrder = useCallback((next: string[]) => {
    const snapshot = [...next];
    libraryOrderRef.current = snapshot;
    setLibraryOrder(snapshot);
    try {
      localStorage.setItem("loom.libraryOrder", JSON.stringify(snapshot));
    } catch {
      // IndexedDB remains the source of truth when localStorage is unavailable.
    }
  }, []);

  // Apply a material's saved params (fabric + knobs + metalness) and arm the
  // autosave baseline at that signature so restoring doesn't rewrite the file.
  const applyParams = useCallback(
    (preset: MaterialPreset) => {
      fabricIdRef.current = preset.fabricId;
      setFabricId(preset.fabricId);
      // Scene knobs (quality/mesh/sky/pins) are viewing prefs — never restored.
      loadMaterialDraft(preset.knobs);
      // Keep an authored zero distinct from the empty/default state: imports and
      // saved materials must not silently re-enable a metalness map.
      const nextMetalness = String(preset.metalness);
      metalnessInputRef.current = nextMetalness;
      setMetalnessInput(nextMetalness);
      setAutosaveBaseline({
        id: preset.slug,
        sig: paramSig(preset.fabricId, preset.metalness, preset.knobs),
      });
    },
    [loadMaterialDraft],
  );

  // ── load pregen silk-sample on first mount ─────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(PREGEN_MANIFEST);
        if (!r.ok) return;
        const manifest = (await r.json()) as {
          maps: { name: string; file: string }[];
          prompt?: string;
          sourceFilename?: string;
          hash?: string;
          createdAt?: string;
        };
        const initial = pkgFromMaps("silk-sample", PREGEN_BASE, manifest.maps, {
          prompt: manifest.prompt,
          sourceFilename: manifest.sourceFilename,
          hash: manifest.hash,
          createdAt: manifest.createdAt,
        });
        setPkg(initial);
        setStatus({
          kind: "done",
          cacheHit: true,
          hash: manifest.hash ?? "pregen",
        });
        // Mark the boot material as the autosave target; boot hydration applies
        // its saved params (red silk) once /api/presets has loaded.
        if (manifest.hash) {
          activePkgHashRef.current = manifest.hash;
          activeIdRef.current = manifest.hash;
          setActiveId(manifest.hash);
        }
      } catch {
        // pregen absent — start empty
      }
    })();
  }, []);

  // ── keyboard: 'p' cycles POM debug (off → offset → steps → off) ─────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;
      setKnobs((k) => ({
        ...k,
        pomDebug: ((k.pomDebug + 1) % 3) as 0 | 1 | 2,
      }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── keep a running cache history ────────────────────────────────────────
  // Browser-local durable library. The server cache is ephemeral on serverless
  // hosts (per-instance /tmp, wiped on cold start), so imported materials live
  // in IndexedDB and are folded in here. Held in refs so refreshCache /
  // refreshPresets can merge them without an extra render pass.
  const vaultEntriesRef = useRef<CacheEntry[]>([]);
  const vaultPresetsRef = useRef<MaterialPreset[]>([]);
  const deletedHashesRef = useRef(new Set<string>());
  const deletedPresetSlugsRef = useRef(new Set<string>());
  const refreshVault = useCallback(async () => {
    const {
      getVaultDeletedMaterialHashes,
      getVaultDeletedPresetSlugs,
      getVaultPresets,
      hydrateVaultEntries,
    } = await import(
      "@/lib/library/vault"
    );
    const [entries, vpresets, deletedHashes, deletedPresetSlugs] = await Promise.all([
      hydrateVaultEntries(),
      getVaultPresets(),
      getVaultDeletedMaterialHashes(),
      getVaultDeletedPresetSlugs(),
    ]);
    vaultEntriesRef.current = entries;
    vaultPresetsRef.current = vpresets;
    deletedHashesRef.current = deletedHashes;
    deletedPresetSlugsRef.current = deletedPresetSlugs;
  }, []);

  const refreshCache = useCallback(async () => {
    let server: CacheEntry[] = [];
    try {
      const r = await fetch("/api/cache", { cache: "no-store" });
      if (r.ok) server = ((await r.json()) as { entries: CacheEntry[] }).entries;
    } catch {
      // ignore — the vault may still supply entries
    }
    const localHashes = new Set(vaultEntriesRef.current.map((entry) => entry.hash));
    const migratable = server.filter(
      (entry) =>
        !deletedHashesRef.current.has(entry.hash) && !localHashes.has(entry.hash),
    );
    if (migratable.length > 0) {
      await Promise.allSettled(
        migratable.map((entry) =>
          saveAuthoringMaterial(authoringMaterialFromEntry(entry)),
        ),
      );
      await refreshVault();
    }
    // Vault entries win over a same-hash server entry: their blob: URLs are
    // always readable this session, while a server URL 404s once its serverless
    // instance recycles.
    const byHash = new Map<string, CacheEntry>();
    for (const e of server) {
      if (!deletedHashesRef.current.has(e.hash)) byHash.set(e.hash, e);
    }
    for (const e of vaultEntriesRef.current) byHash.set(e.hash, e);
    setCacheEntries([...byHash.values()]);
  }, [refreshVault]);

  // ── stage measure ──────────────────────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const narrow = window.matchMedia(ROOM_NARROW_MEDIA);
    const mobile = window.matchMedia(ROOM_MOBILE_PERFORMANCE_MEDIA);
    const measurePerformance = () => setMobilePerformance(mobile.matches);
    const measurePatternPreview = () => setNarrowPreview(narrow.matches);
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      // Keep it a wide 4:3-ish stage that snaps to the container size.
      const w = Math.max(320, Math.round(rect.width));
      const h = Math.max(240, Math.round(rect.height));
      setStageSize({ w, h });
    };
    measure();
    measurePatternPreview();
    measurePerformance();
    mobile.addEventListener("change", measurePerformance);
    narrow.addEventListener("change", measurePatternPreview);
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => {
      ro.disconnect();
      narrow.removeEventListener("change", measurePatternPreview);
      mobile.removeEventListener("change", measurePerformance);
    };
  }, []);

  // ── run a fresh extraction ─────────────────────────────────────────────
  const runBaseline = useCallback(
    async (front: File | Blob, name: string) => {
      const intent = ++materialIntentRef.current;
      pendingMaterialSelectionRef.current = null;
      setPendingMaterialId("extracting");
      setStatus({ kind: "loading", message: "extracting patina maps…" });
      try {
        const result = await runPatinaBaseline(front, {
          fabricName: name,
          prompt,
        });
        const durableEntry = cacheEntryFromPackage(
          result.hash,
          result.pkg,
          prompt.trim() || "fabric",
          front instanceof File ? front.name : "front-lit.png",
        );
        markSaveDirty();
        // Canonical params for a material use slug === hash.
        const saved = presets.find((preset) => preset.slug === result.hash);
        let durableError: unknown = null;
        const durable = await runDurableSave(async () => {
          try {
            await saveAuthoringMaterial(authoringMaterialFromEntry(durableEntry));
            await refreshVault();
            await refreshCache();
          } catch (error) {
            durableError = error;
            throw error;
          }
        });
        if (!durable) {
          throw durableError instanceof Error
            ? durableError
            : new Error("The material was generated but could not be saved locally");
        }
        // The extraction remains safely cached, but a later swatch choice owns
        // the loom and must not be replaced when this async job finally lands.
        if (materialIntentRef.current !== intent) return;
        activeIdRef.current = result.hash;
        activePkgHashRef.current = result.hash;
        if (!(result.cacheHit && saved)) {
          loadMaterialDraft({ ...DEFAULT_FABRIC_KNOBS });
          metalnessInputRef.current = "";
          setMetalnessInput("");
          setAutosaveBaseline({ id: result.hash, sig: "" });
        }
        setStatus({
          kind: "done",
          cacheHit: result.cacheHit,
          hash: result.hash,
        });
        // Wear the fresh maps behind a mesh pixel-dissolve: the cloth
        // dissolves out, the material-affecting state lands while it's fully
        // hidden, and the reveal gates on the new albedo actually loading.
        materialSwapRef.current(
          () => {
            if (materialIntentRef.current !== intent) return;
            setPkg(result.pkg);
            activePkgHashRef.current = result.hash;
            activeIdRef.current = result.hash;
            setActiveId(result.hash);
            if (result.cacheHit && saved) {
              // Re-extracting a material we've already tuned — restore its
              // params rather than overwriting them with defaults.
              applyParams(saved);
            }
            setPendingMaterialId(null);
          },
          {
            expectedAlbedoURL: result.pkg.maps.albedo?.url,
            ownerAfter: result.hash,
          },
        );
        if (!(result.cacheHit && saved)) {
          // Fresh maps (or a cache hit we've never tuned): auto-tune off the
          // maps and let autosave persist that as the material's first preset.
          try {
            const { estimateParams } = await import(
              "@/lib/pipeline/estimateParams"
            );
            const est = await estimateParams(result.pkg);
            if (
              materialIntentRef.current !== intent ||
              activeIdRef.current !== result.hash ||
              activePkgHashRef.current !== result.hash ||
              fabricGestureActiveRef.current ||
              isMaterialDraftDirty(materialDraftRef.current)
            ) {
              return;
            }
            loadMaterialDraft({
              ...DEFAULT_FABRIC_KNOBS,
              ...est.knobs,
            });
            const nextMetalness = est.metalness > 0 ? String(est.metalness) : "";
            metalnessInputRef.current = nextMetalness;
            setMetalnessInput(nextMetalness);
          } catch {
            // estimation is a nicety — never let it break the extraction
          }
        }
      } catch (err) {
        if (materialIntentRef.current === intent) setPendingMaterialId(null);
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message: msg });
      }
    },
    [
      applyParams,
      loadMaterialDraft,
      markSaveDirty,
      presets,
      prompt,
      refreshCache,
      refreshVault,
      runDurableSave,
    ],
  );

  // Stage a dropped/selected photo without running anything. The user reviews
  // the prompt + metalness, then presses submit.
  const stageFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const front = files[0];
    setStagedFile({ file: front, name: front.name.replace(/\.[^.]+$/, "") });
    setStatus((s) => (s.kind === "error" ? { kind: "idle" } : s));
  }, []);

  const submit = useCallback(async () => {
    if (!stagedFile || status.kind === "loading" || pendingMaterialId !== null) return;
    if (!(await confirmDiscardWorkingDraft("extract a new material"))) return;
    void runBaseline(stagedFile.file, stagedFile.name);
  }, [
    confirmDiscardWorkingDraft,
    pendingMaterialId,
    stagedFile,
    status.kind,
    runBaseline,
  ]);

  const loadCachedEntry = useCallback((entry: CacheEntry) => {
    const name = entry.sourceFilename?.replace(/\.[^.]+$/, "") ?? "cached";
    const p = pkgFromMaps(name, "", entry.maps, {
      prompt: entry.prompt,
      sourceFilename: entry.sourceFilename,
      hash: entry.hash,
      createdAt: entry.createdAt || undefined,
    });
    setPkg(p);
    setStatus({ kind: "done", cacheHit: true, hash: entry.hash });
    // Best-effort: prime the browser-local map cache the moment this
    // material's maps are known, so a later zip export of it can read
    // bytes locally instead of depending on the server cache still having
    // them (see lib/export/mapCache.ts).
    warmMapCache(entry.maps.map((m) => m.url));
  }, []);

  // ── material presets ───────────────────────────────────────────────────
  const refreshPresets = useCallback(async () => {
    let server: MaterialPreset[] = [];
    try {
      const r = await fetch("/api/presets", { cache: "no-store" });
      if (r.ok) server = ((await r.json()) as { presets: MaterialPreset[] }).presets;
    } catch {
      // ignore
    }
    const localBySlug = new Map(
      vaultPresetsRef.current.map((preset) => [preset.slug, preset]),
    );
    // Adopt server-only seeds once, then let the local copy own subsequent
    // authoring. A stale instance response must never overwrite a newer local
    // knob edit with the same slug.
    const visibleServer = server.filter(
      (preset) => !deletedPresetSlugsRef.current.has(preset.slug),
    );
    const builtIn = visibleServer.filter((preset) => preset.builtIn);
    // A built-in is an immutable comparison specimen. Always refresh the
    // browser copy from the committed seed; tuning is kept under a new
    // variation slug instead of making the baseline machine-dependent.
    for (const preset of builtIn) localBySlug.set(preset.slug, preset);
    const missing = visibleServer.filter(
      (preset) => !localBySlug.has(preset.slug),
    );
    await Promise.all(
      [...missing, ...builtIn].map((preset) => adoptServerPreset(preset)),
    );
    for (const preset of missing) localBySlug.set(preset.slug, preset);
    vaultPresetsRef.current = [...localBySlug.values()];
    const bySlug = new Map(
      visibleServer.map((preset) => [preset.slug, preset]),
    );
    for (const preset of localBySlug.values()) {
      if (!bySlug.get(preset.slug)?.builtIn) bySlug.set(preset.slug, preset);
    }
    // Room-specific baseline optics belong in actual authoring state so
    // drafts/copies/exports agree, without rewriting the original's seed.
    setPresets([...bySlug.values()].map(roomMaterialPreset));
    setPresetsLoaded(true);
  }, []);

  // One mount pass: load the durable vault first, then fold it into the cache +
  // preset lists. Both refreshes read vaultEntriesRef/vaultPresetsRef, so the
  // vault must be populated before they run.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled) return;
      await runDurableSave(async () => {
        await refreshVault();
        if (cancelled) return;
        await Promise.all([refreshCache(), refreshPresets()]);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [refreshVault, refreshCache, refreshPresets, runDurableSave]);

  // Built-in samples — fetched once; served from samples/ as baked bundles.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/samples", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as {
          samples: {
            label: string;
            prompt: string | null;
            hash: string;
            maps: { name: string; file: string; url: string }[];
          }[];
        };
        setSamples(
          data.samples.map((s) => ({
            hash: s.hash,
            createdAt: "",
            prompt: s.prompt,
            sourceFilename: s.label,
            maps: s.maps.flatMap((map) =>
              MAP_ORDER.includes(map.name as MapName)
                ? [
                    {
                      ...map,
                      name: map.name as MapName,
                      provenance: "patina" as const,
                      sourceHash: s.hash,
                    },
                  ]
                : [],
            ),
          })),
        );
      } catch {
        // no samples — fine
      }
    })();
  }, []);

  // ── library order: IndexedDB is authoritative. localStorage is read only as
  //    a one-time migration from older builds and kept as a compatibility
  //    mirror after local commits. ──────────────────────────────────────────
  const orderLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled) return;
      await runDurableSave(async () => {
        let savedOrder = await loadAuthoringOrder();
        if (!savedOrder) {
          try {
            const raw = localStorage.getItem("loom.libraryOrder");
            const legacy: unknown = raw ? JSON.parse(raw) : null;
            if (
              Array.isArray(legacy) &&
              legacy.every((id) => typeof id === "string")
            ) {
              savedOrder = legacy;
              await saveAuthoringOrder(legacy);
            }
          } catch {
            // Corrupt/absent legacy mirror — start unordered.
          }
        }
        if (cancelled) return;
        applyLibraryOrder(savedOrder ?? []);
        orderLoadedRef.current = true;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [applyLibraryOrder, runDurableSave]);

  // ── scene/device prefs persist locally and never travel with a material ──
  const perfLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let savedPrefs: Partial<Knobs> | null = null;
    try {
      const raw = localStorage.getItem("loom.perf");
      if (raw) savedPrefs = JSON.parse(raw) as Partial<Knobs>;
    } catch {
      // corrupt/absent — ignore, use defaults
    }
    queueMicrotask(() => {
      if (cancelled) return;
      if (savedPrefs) {
        setKnobs((current) => ({
          ...current,
          ...(typeof savedPrefs.iterations === "number"
            ? { iterations: savedPrefs.iterations }
            : {}),
          ...(savedPrefs.selfCollide
            ? { selfCollide: savedPrefs.selfCollide }
            : {}),
          ...(savedPrefs.anisotropy
            ? { anisotropy: savedPrefs.anisotropy }
            : {}),
          ...(typeof savedPrefs.autoQuality === "boolean"
            ? { autoQuality: savedPrefs.autoQuality }
            : {}),
          ...(savedPrefs.quality ? { quality: savedPrefs.quality } : {}),
          ...(savedPrefs.meshRes ? { meshRes: savedPrefs.meshRes } : {}),
          ...(typeof savedPrefs.mouseForce === "number"
            ? {
                mouseForce: Math.min(
                  5,
                  Math.max(0, savedPrefs.mouseForce),
                ),
              }
            : {}),
        }));
      }
      perfLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!perfLoadedRef.current) return;
    try {
      localStorage.setItem(
        "loom.perf",
        JSON.stringify({
          iterations: knobs.iterations,
          selfCollide: knobs.selfCollide,
          anisotropy: knobs.anisotropy,
          autoQuality: knobs.autoQuality,
          quality: knobs.quality,
          meshRes: knobs.meshRes,
          mouseForce: knobs.mouseForce,
        }),
      );
    } catch {
      // storage disabled — non-fatal
    }
  }, [
    knobs.iterations,
    knobs.selfCollide,
    knobs.anisotropy,
    knobs.autoQuality,
    knobs.quality,
    knobs.meshRes,
    knobs.mouseForce,
  ]);

  // Monotonic request id so a slow async lookup from an earlier click can't
  // land after a later one and swap in the wrong material.
  const presetReqRef = useRef(0);

  // Resolve maps for a params-only material (no cache/sample entry) — the
  // curated red-silk preset points at the pregen bundle, which /api/cache
  // never lists, so it's resolved by manifest hash here.
  const resolveMapsForHash = useCallback(
    async (hash: string) => {
      const req = ++presetReqRef.current;
      const current = () => req === presetReqRef.current;
      let entry = cacheEntries.find((e) => e.hash === hash);
      if (!entry) {
        try {
          const r = await fetch("/api/cache", { cache: "no-store" });
          if (r.ok) {
            const data = (await r.json()) as { entries: CacheEntry[] };
            entry = data.entries.find((e) => e.hash === hash);
          }
        } catch {
          // ignore — fall through
        }
      }
      if (!current()) return;
      if (entry) {
        loadCachedEntry(entry);
        return;
      }
      try {
        const r = await fetch(PREGEN_MANIFEST);
        if (r.ok) {
          const m = (await r.json()) as {
            maps: { name: string; file: string }[];
            prompt?: string;
            sourceFilename?: string;
            hash?: string;
            createdAt?: string;
          };
          if (current() && m.hash === hash) {
            const pk = pkgFromMaps("silk-sample", PREGEN_BASE, m.maps, {
              prompt: m.prompt,
              sourceFilename: m.sourceFilename,
              hash: m.hash,
              createdAt: m.createdAt,
            });
            setPkg(pk);
            setStatus({ kind: "done", cacheHit: true, hash: m.hash ?? "pregen" });
            return;
          }
        }
      } catch {
        // ignore
      }
      if (current()) {
        setPkg(null);
        setStatus({ kind: "idle" });
      }
    },
    [cacheEntries, loadCachedEntry],
  );

  // Seed params for a material that has no saved preset yet — auto-tune off its
  // maps so it doesn't start from flat defaults. The empty-signature baseline
  // (armed by selectMaterial) then lets autosave persist this as its first file.
  const seedParamsFromEntry = useCallback(
    async (
      entry: CacheEntry,
      expected: { itemId: string; pkgHash: string; intent: number },
    ) => {
      try {
        const p = pkgFromMaps(
          entry.sourceFilename ?? "material",
          "",
          entry.maps,
          {
            prompt: entry.prompt,
            sourceFilename: entry.sourceFilename,
            hash: entry.hash,
            createdAt: entry.createdAt || undefined,
          },
        );
        const { estimateParams } = await import("@/lib/pipeline/estimateParams");
        const est = await estimateParams(p);
        if (
          materialIntentRef.current !== expected.intent ||
          activeIdRef.current !== expected.itemId ||
          activePkgHashRef.current !== expected.pkgHash ||
          fabricGestureActiveRef.current ||
          isMaterialDraftDirty(materialDraftRef.current)
        ) {
          return;
        }
        loadMaterialDraft({
          ...DEFAULT_FABRIC_KNOBS,
          ...est.knobs,
        });
        const nextMetalness = est.metalness > 0 ? String(est.metalness) : "";
        metalnessInputRef.current = nextMetalness;
        setMetalnessInput(nextMetalness);
      } catch {
        // estimation is a nicety — leave defaults if it fails
      }
    },
    [loadMaterialDraft],
  );

  // Human label to store on a material's preset file, keyed by its id.
  const labelForId = useCallback(
    (id: string): string => {
      const preset = presets.find((candidate) => candidate.slug === id);
      if (preset) return preset.name;
      const s = samples.find((x) => x.hash === id);
      if (s?.sourceFilename) return s.sourceFilename;
      const e = cacheEntries.find((x) => x.hash === id);
      return e?.prompt ?? e?.sourceFilename ?? shortHash(id);
    },
    [presets, samples, cacheEntries],
  );

  // Write a material's params. `id` is the file key (hash or clone slug),
  // `pkgHash` the maps it dresses in. Optimistically folds the result into
  // local state so the library reflects it without waiting on a refetch.
  const postParams = useCallback(
    async (
      id: string,
      pkgHash: string,
      name: string,
      fabricId: FabricId,
      metalness: number,
      knobs: FabricKnobs,
    ): Promise<MaterialPreset> => {
      const preset = await saveAuthoringPreset(
        {
          slug: id,
          name,
          fabricId,
          pkgHash,
          metalness,
          knobs,
        },
        {
          // A hidden vault package belongs only to this browser. Mirroring its
          // preset without the map bytes creates an unusable server orphan.
          mirrorToServer: !vaultEntriesRef.current.some(
            (entry) => entry.hash === pkgHash && entry.hidden,
          ),
        },
      );
      vaultPresetsRef.current = [
        ...vaultPresetsRef.current.filter((candidate) => candidate.slug !== id),
        preset,
      ];
      setPresets((cur) => {
        const rest = cur.filter((candidate) => candidate.slug !== id);
        return [...rest, preset].sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : 1,
        );
      });
      return preset;
    },
    [],
  );

  // Select a material into the loom: load its maps, then either restore its
  // saved params or seed+persist fresh ones. Sets it as the autosave target.
  const selectMaterial = useCallback(
    (item: LibraryItem, intent: number) => {
      if (
        materialIntentRef.current !== intent ||
        pendingMaterialSelectionRef.current?.id !== item.id ||
        pendingMaterialSelectionRef.current.intent !== intent
      ) {
        return;
      }
      pendingMaterialSelectionRef.current = null;
      setPendingMaterialId(null);
      activeIdRef.current = item.id;
      activePkgHashRef.current = item.pkgHash;
      setActiveId(item.id);
      if (item.entry) {
        loadCachedEntry(item.entry);
        // Migrate legacy server-only cache entries the first time they are used.
        // Vault-hydrated entries already have blob URLs and need no rewrite.
        const serverOnly = item.entry.maps.some(
          (map) => !map.url.startsWith("blob:"),
        );
        const builtIn = samples.some((sample) => sample.hash === item.pkgHash);
        if (serverOnly && !builtIn) {
          void runDurableSave(async () => {
            await saveAuthoringMaterial(authoringMaterialFromEntry(item.entry!));
            await refreshVault();
            await refreshCache();
          });
        }
      }
      else void resolveMapsForHash(item.pkgHash);
      if (item.preset) {
        applyParams(item.preset);
      } else {
        // Never inherit the previous swatch's unrepresented controls while its
        // estimate is pending. The estimator may fill only part of this clean
        // source; a user gesture makes the delayed result ineligible to land.
        loadMaterialDraft({ ...DEFAULT_FABRIC_KNOBS });
        metalnessInputRef.current = "";
        setMetalnessInput("");
        // Arm the baseline empty so defaults/seeded params write once settled.
        setAutosaveBaseline({ id: item.id, sig: "" });
        if (item.entry) {
          void seedParamsFromEntry(item.entry, {
            itemId: item.id,
            pkgHash: item.pkgHash,
            intent,
          });
        }
      }
    },
    [
      loadCachedEntry,
      resolveMapsForHash,
      applyParams,
      loadMaterialDraft,
      seedParamsFromEntry,
      samples,
      runDurableSave,
      refreshVault,
      refreshCache,
    ],
  );

  // ── bootstrap save: persist an untouched material's initial estimate ─────
  // Once editing begins, the canonical source is protected. Recovery storage
  // is separate; only an explicit save creates a new archive swatch.
  // The debounce remains for a newly extracted material's first auto-estimate.
  useEffect(() => {
    if (!activeId) return;
    if (autosaveBaseline.id !== activeId) return; // not armed/hydrated yet
    if (
      fabricGestureActiveRef.current ||
      isMaterialDraftDirty(materialDraft)
    ) {
      return;
    }
    const hasMetalnessMap = Boolean(pkg?.maps.metalness);
    const metal = resolveMetalnessAmount(metalnessInput, hasMetalnessMap);
    const fk = fabricKnobsOf(knobs);
    const sig = paramSig(fabricId, metal, fk);
    if (sig === autosaveBaseline.sig) return; // nothing material changed
    const pkgHash = activePkgHashRef.current ?? activeId;
    const saveRevision = reserveDurableSave(`preset:${activeId}`);
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) markSaveDirty();
    });
    const t = setTimeout(() => {
      void runDurableSave(
        async () => {
          await postParams(
            activeId,
            pkgHash,
            labelForId(activeId),
            fabricId,
            metal,
            fk,
          );
          const currentMetal = resolveMetalnessAmount(
            metalnessInputRef.current,
            hasMetalnessMap,
          );
          const currentSig = paramSig(
            fabricIdRef.current,
            currentMetal,
            fabricKnobsOf(knobsRef.current),
          );
          // A retry may finish after the user selected another material or made
          // another edit. Only certify the exact state this write committed.
          if (activeIdRef.current === activeId && currentSig === sig) {
            setAutosaveBaseline({ id: activeId, sig });
          }
        },
        saveRevision,
      );
    }, 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    knobs,
    materialDraft,
    metalnessInput,
    fabricId,
    activeId,
    autosaveBaseline,
    labelForId,
    markSaveDirty,
    postParams,
    pkg,
    reserveDurableSave,
    runDurableSave,
  ]);

  // ── boot hydration: once the material and its presets are both loaded, apply
  //    the saved params for whatever's on the loom (pregen → red silk). Runs
  //    once; arms autosave without writing.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    if (!activeId || !presetsLoaded) return;
    const preset = presets.find((candidate) => candidate.slug === activeId);
    const metal = resolveMetalnessAmount(
      metalnessInput,
      Boolean(pkg?.maps.metalness),
    );
    const baseline = {
      id: activeId,
      sig: paramSig(fabricId, metal, fabricKnobsOf(knobs)),
    };
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || bootedRef.current) return;
      bootedRef.current = true;
      if (preset) applyParams(preset);
      else {
        loadMaterialDraft(fabricKnobsOf(knobs));
        setAutosaveBaseline(baseline);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    presets,
    presetsLoaded,
    applyParams,
    loadMaterialDraft,
    fabricId,
    metalnessInput,
    knobs,
    pkg,
  ]);

  // Recovery is not an archive save: keep only bounded parameter history, and
  // restore it only against the exact saved source that just finished loading.
  useEffect(() => {
    if (!bootedRef.current || !activeId || !pkg || pendingMaterialId !== null ||
      autosaveBaseline.id !== activeId) return;
    if (!autosaveBaseline.sig) {
      if (isMaterialDraftDirty(materialDraft)) {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) setRecoveryWarning("This new material is not recoverable yet. Save your swatch before leaving.");
        });
        return () => { cancelled = true; };
      }
      return;
    }
    const hash = activePkgHashRef.current ?? pkg.id;
    const key = materialEditRecoveryKey(activeId, hash);
    const source = {
      materialId: activeId, pkgHash: hash, fabricId,
      metalness: resolveMetalnessAmount(metalnessInput, Boolean(pkg.maps.metalness)),
      knobs: materialDraft.baseline,
    };
    let cancelled = false;
    try {
      if (recoveryCheckedRef.current !== key) {
        const recovered = readRoomMaterialEditRecovery(
          localStorage.getItem(key),
          source,
          vaultPresetsRef.current.find((preset) => preset.slug === activeId),
        );
        if (recovered && !isMaterialDraftDirty(materialDraft)) {
          const intent = materialIntentRef.current;
          queueMicrotask(() => {
            if (cancelled || activeIdRef.current !== activeId || activePkgHashRef.current !== hash ||
              materialIntentRef.current !== intent || materialDraftRef.current !== materialDraft ||
              fabricGestureActiveRef.current) return;
            recoveryCheckedRef.current = key;
            const nextConstruction = inferConstruction(recovered.current);
            constructionRef.current = nextConstruction;
            setConstruction(nextConstruction);
            instrumentBaselineRef.current = createMaterialInstrumentBaseline(recovered.current, nextConstruction);
            setMaterialDraftNow(recovered);
            replaceLiveFabric(recovered.current);
            markSaveDirty();
          });
          return () => { cancelled = true; };
        }
        recoveryCheckedRef.current = key;
      }
      if (isMaterialDraftDirty(materialDraft)) {
        const json = serializeMaterialEditRecovery(source, materialDraft);
        if (!json) throw new Error("Invalid recovery record");
        localStorage.setItem(key, json);
        localStorage.setItem(LAST_EDITED_MATERIAL_KEY, JSON.stringify({ id: activeId, pkgHash: hash }));
      } else {
        localStorage.removeItem(key);
        const last = JSON.parse(localStorage.getItem(LAST_EDITED_MATERIAL_KEY) ?? "null");
        if (last?.id === activeId) localStorage.removeItem(LAST_EDITED_MATERIAL_KEY);
      }
      queueMicrotask(() => { if (!cancelled) setRecoveryWarning(null); });
    } catch {
      queueMicrotask(() => { if (!cancelled) setRecoveryWarning("Recovery storage unavailable. Save your swatch before leaving."); });
    }
    return () => { cancelled = true; };
  }, [activeId, autosaveBaseline, fabricId, materialDraft, metalnessInput, pkg,
    pendingMaterialId, setMaterialDraftNow, replaceLiveFabric, markSaveDirty]);

  useEffect(() => {
    if (!recoveryWarning || !isMaterialDraftDirty(materialDraft)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [materialDraft, recoveryWarning]);

  // Remove a library material: its params file, plus the cache run behind it
  // when it's a user extraction. Clones drop their own file only; built-in
  // samples aren't deletable.
  const deleteLibraryItem = useCallback(
    async (item: LibraryItem) => {
      const nextOrder = libraryOrderRef.current.filter((id) => id !== item.id);
      const wasActive = activeIdRef.current === item.id;
      if (wasActive) ++materialIntentRef.current;
      // Deletion supersedes any failed knob/name write for this material.
      reserveDurableSave(`preset:${item.id}`);
      const orderRevision = reserveDurableSave("library-order");
      markSaveDirty();
      await runDurableSave(async () => {
        await deleteAuthoringItem({
          id: item.id,
          pkgHash: item.pkgHash,
          clone: item.clone,
        });
        if (saveRevisionsRef.current.isCurrent(orderRevision)) {
          await saveAuthoringOrder(nextOrder);
        }
        vaultPresetsRef.current = vaultPresetsRef.current.filter(
          (preset) => preset.slug !== item.id,
        );
        setPresets((cur) => cur.filter((preset) => preset.slug !== item.id));
        if (saveRevisionsRef.current.isCurrent(orderRevision)) {
          applyLibraryOrder(nextOrder);
        }
        await refreshVault();
        // Fold the durable result into the current list without immediately
        // re-reading a lagging server mirror that may still contain the delete.
        setCacheEntries((current) => [
          ...current.filter((entry) => entry.hash !== item.pkgHash),
          ...vaultEntriesRef.current.filter(
            (entry) => entry.hash === item.pkgHash,
          ),
        ]);
        if (wasActive && activeIdRef.current === item.id) {
          materialSwapRef.current(
            () => {
              activeIdRef.current = null;
              activePkgHashRef.current = null;
              setActiveId(null);
              setAutosaveBaseline({ id: null, sig: "" });
              setPkg(null);
            },
            { ownerAfter: null },
          );
        }
      });
    },
    [
      applyLibraryOrder,
      markSaveDirty,
      refreshVault,
      reserveDurableSave,
      runDurableSave,
    ],
  );

  // ── clone: drag a swatch body → a private, tweakable copy in the library.
  //    Shares the source's maps (pkgHash) but gets its own slug + params file,
  //    so tuning the copy never touches the original.
  const cloneItem = useCallback(
    async (item: LibraryItem) => {
      const slug =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `clone-${Date.now().toString(36)}`;
      // Copy the source's saved params if it has any; otherwise the live knobs
      // (typically you're cloning the material you're looking at). Live state
      // is read through refs at call time — keeps this callback stable.
      const src = item.preset;
      const fId = src?.fabricId ?? fabricIdRef.current;
      const metal = resolveMetalnessAmount(
        src?.metalness ?? metalnessInputRef.current,
        Boolean(item.entry?.maps.some((map) => map.name === "metalness")),
      );
      const knobsToClone = src?.knobs ?? fabricKnobsOf(knobsRef.current);
      const name = `${item.label} copy`;
      const nextOrder = libraryOrderRef.current.filter((id) => id !== slug);
      const at = nextOrder.indexOf(item.id);
      if (at === -1) nextOrder.push(slug);
      else nextOrder.splice(at + 1, 0, slug);
      const presetRevision = reserveDurableSave(`preset:${slug}`);
      const orderRevision = reserveDurableSave("library-order");
      markSaveDirty();
      await runDurableSave(
        async () => {
          // A clone never depends solely on a server cache URL. If the source's
          // maps are available here, make the package durable before its preset.
          if (item.entry) {
            await saveAuthoringMaterial(authoringMaterialFromEntry(item.entry));
            await refreshVault();
          }
          await postParams(slug, item.pkgHash, name, fId, metal, knobsToClone);
          if (saveRevisionsRef.current.isCurrent(orderRevision)) {
            await saveAuthoringOrder(nextOrder);
            applyLibraryOrder(nextOrder);
          }
        },
        presetRevision,
      );
    },
    [
      applyLibraryOrder,
      markSaveDirty,
      postParams,
      refreshVault,
      reserveDurableSave,
      runDurableSave,
    ],
  );

  // ── reorder: drag a grip → move an item before another in the library.
  const reorderLibrary = useCallback((dragId: string, beforeId: string) => {
    if (pendingMaterialId !== null) return;
    if (dragId === beforeId) return;
    const next = libraryOrderRef.current.filter((id) => id !== dragId);
    const at = next.indexOf(beforeId);
    if (at === -1) next.push(dragId);
    else next.splice(at, 0, dragId);
    applyLibraryOrder(next);
    markSaveDirty();
    const revision = reserveDurableSave("library-order");
    void runDurableSave(() => saveAuthoringOrder(next), revision);
  }, [
    applyLibraryOrder,
    markSaveDirty,
    pendingMaterialId,
    reserveDurableSave,
    runDurableSave,
  ]);

  const presentedKnobs = useMemo<Knobs>(
    () => {
      if (materialDraft.comparison !== "baseline") return knobs;
      // Appearance A/B is reversible: retain the live solver's mass and
      // constraints while swapping the source's shader/map/edge surface.
      // Motion differences are judged from a clean state with the probes.
      const currentFabric = fabricKnobsOf(knobs);
      return {
        ...knobs,
        ...materialDraft.baseline,
        weight: currentFabric.weight,
        warpStiffness: currentFabric.warpStiffness,
        weftStiffness: currentFabric.weftStiffness,
        shearStiffness: currentFabric.shearStiffness,
        bendStiffness: currentFabric.bendStiffness,
      };
    },
    [knobs, materialDraft],
  );

  const fabric = useMemo(
    () => fabricFromPkg(pkg, presentedKnobs, fabricId),
    [pkg, presentedKnobs, fabricId],
  );
  useEffect(() => {
    const url = pkg?.maps.albedo?.url ?? fabric.albedoURL;
    let current = true;
    void readMapStats(url, { isCurrent: () => current }).then((result) => {
      if (!current || result.status === "stale") return;
      setAlbedoTint(result.stats.meanRgb);
    });
    return () => {
      current = false;
    };
  }, [fabric.albedoURL, pkg?.maps.albedo?.url]);

  // The openness slider is intentionally exponential: linear drag on the
  // range input rises as t³, so dense fabrics get most of the slider's
  // travel (fine control at the opaque end) while a small push near the top
  // takes you the rest of the way to organza-sheer. Applied at the boundary
  // so `knobs.openness` remains the raw slider position; ClothScene and
  // ObjectViewer only ever see the curved value.
  const opennessCurved = Math.pow(presentedKnobs.openness, 3);
  const materialLightProfile = useMemo<MaterialLightProfile>(() => {
    const core = FABRICS[fabricId].core;
    return {
      openness: opennessCurved,
      cover: core.coverFactor,
      thickness: Math.min(1, core.thicknessMm / 2),
      // This is the same bounded multiplier the cloth shader receives. The tx*
      // controls select density-map sources; their weights are not a physical
      // measure of how much light passes through the material.
      transmission: Math.min(
        1,
        Math.max(0, presentedKnobs.translucency),
      ),
      transmissionContrast: presentedKnobs.transmissionContrast,
      albedoTint,
    };
  }, [albedoTint, fabricId, opennessCurved, presentedKnobs]);
  const roomLight = useRoomLightController({
    initialSettings: roomLightSettings,
    materialProfile: materialLightProfile,
    roomRootRef,
  });
  useEffect(() => {
    let cancelled = false;
    let restored = { ...DEFAULT_ROOM_LIGHT_SETTINGS };
    try {
      const raw = localStorage.getItem(ROOM_LIGHT_STORAGE_KEY);
      if (raw) restored = restoreRoomLightSettings(JSON.parse(raw));
    } catch {
      // Corrupt or unavailable local storage is non-fatal. Room settings are
      // a device preference and never become part of a material package.
    }
    queueMicrotask(() => {
      if (cancelled) return;
      setRoomLightSettings(restored);
      roomLight.setSettings(restored);
    });
    return () => {
      cancelled = true;
    };
  }, [roomLight]);

  const commitRoomLightSettings = useCallback(
    (settings: RoomLightSettings) => {
      const next = sanitizeRoomLightSettings(settings);
      setRoomLightSettings(next);
      roomLight.setSettings(next);
      try {
        localStorage.setItem(ROOM_LIGHT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be disabled; the room remains fully usable in memory.
      }
    },
    [roomLight],
  );
  const openLightModal = useCallback(() => {
    roomLight.pause("modal");
    setRoomLightSettings(roomLight.getSettings());
    setLightModalOpen(true);
  }, [roomLight]);
  const closeLightModal = useCallback(() => {
    setLightModalOpen(false);
    roomLight.resume("modal");
  }, [roomLight]);
  const resetRoomLight = useCallback(
    () => commitRoomLightSettings({ ...DEFAULT_ROOM_LIGHT_SETTINGS }),
    [commitRoomLightSettings],
  );

  const instrumentState = useMemo(
    () => readMaterialInstrument(fabricKnobsOf(knobs), construction),
    [knobs, construction],
  );
  const draftDirty = isMaterialDraftDirty(materialDraft);
  const canUndoDraft = canUndoMaterialDraft(materialDraft);
  const canRedoDraft = canRedoMaterialDraft(materialDraft);

  const runClothProbe = useCallback((probe: ClothProbe) => {
    clothSceneRef.current?.runProbe(probe);
  }, []);

  const metalness = resolveMetalnessAmount(
    metalnessInput,
    Boolean(pkg?.maps.metalness),
  );

  const mapEntries = useMemo<MapEntry[]>(() => {
    if (!pkg) return [];
    return MAP_ORDER.map((n) => pkg.maps[n]).filter((e): e is MapEntry => Boolean(e));
  }, [pkg]);
  const mapVariationSource = useMemo(
    () =>
      pkg
        ? {
            itemId: activeId ?? pkg.id,
            pkgHash: pkg.id,
          }
        : null,
    [activeId, pkg],
  );
  // Fast hash → maps-source lookups, so a clone (or curated preset) can find
  // the maps + thumbnail behind its pkgHash.
  const sampleByHash = useMemo(
    () => new Map(samples.map((s) => [s.hash, s])),
    [samples],
  );
  const cacheByHash = useMemo(
    () => new Map(cacheEntries.map((e) => [e.hash, e])),
    [cacheEntries],
  );
  const mapsForHash = useCallback(
    (pkgHash: string): { entry?: CacheEntry; thumb?: string } => {
      const s = sampleByHash.get(pkgHash);
      if (s) return { entry: s, thumb: s.maps.find((m) => m.name === "albedo")?.url };
      const c = cacheByHash.get(pkgHash);
      if (c) return { entry: c, thumb: c.maps.find((m) => m.name === "albedo")?.url };
      if (pkgHash === PREGEN_HASH) return { thumb: `${PREGEN_BASE}/albedo.png` };
      return {};
    },
    [sampleByHash, cacheByHash],
  );

  // ── SAMPLES section: the built-in bundles, always shown separately. Their
  //    tuned params live in a hash-named preset (applied on select), but the
  //    swatch itself belongs here, not in the user library. ────────────────
  const sampleItems = useMemo<LibraryItem[]>(() => {
    return samples.map((s) => {
      const canonical = presets.find((p) => p.slug === s.hash);
      return {
        id: s.hash,
        pkgHash: s.hash,
        label: canonical?.name ?? s.sourceFilename ?? shortHash(s.hash),
        thumb: s.maps.find((m) => m.name === "albedo")?.url,
        entry: s,
        preset: canonical,
        clone: false,
        deletable: false,
      };
    });
  }, [samples, presets]);

  // ── LIBRARY section: the user's own materials — cache runs, curated presets
  //    (red silk), and clones — in the user's drag order. Sample-canonical
  //    presets are excluded (they belong to the SAMPLES section above). ─────
  const libraryItems = useMemo<LibraryItem[]>(() => {
    const byId = new Map<string, LibraryItem>();
    // Cache runs that aren't themselves samples.
    for (const e of cacheEntries) {
      if (sampleByHash.has(e.hash) || e.hidden) continue;
      byId.set(e.hash, {
        id: e.hash,
        pkgHash: e.hash,
        label: e.prompt ?? e.sourceFilename ?? shortHash(e.hash),
        thumb: e.maps.find((m) => m.name === "albedo")?.url,
        entry: e,
        clone: false,
        deletable: true,
      });
    }
    // Presets: clones (slug ≠ pkgHash) and curated materials (red silk). Skip a
    // sample's own canonical params — those render as the sample swatch.
    for (const p of presets) {
      if (!p.pkgHash) continue;
      const isClone = p.slug !== p.pkgHash;
      if (!isClone && sampleByHash.has(p.pkgHash)) continue;
      const src = mapsForHash(p.pkgHash);
      const existing = byId.get(p.slug);
      // A preset whose pkgHash resolves to no maps anywhere (not a sample,
      // no cache entry, not pregen, and no thumb already staged by an
      // earlier cache-entry pass) is a dangling reference — its images
      // never made it to this deploy. Rendering it would be a permanently
      // broken, unselectable ghost swatch, so skip it instead. (Can happen
      // if a preset JSON gets committed to fabrics/presets/ without its
      // backing extraction ever landing in the shipped cache/samples.)
      if (!existing?.thumb && !src.thumb) continue;

      byId.set(p.slug, {
        id: p.slug,
        pkgHash: p.pkgHash,
        label: p.name,
        title: `${p.name} · ${FABRICS[p.fabricId]?.nameRoman ?? p.fabricId}`,
        thumb: existing?.thumb ?? src.thumb,
        entry: existing?.entry ?? src.entry,
        preset: p,
        clone: isClone,
        deletable: true,
      });
    }
    // Effective order = saved order first (for the ids it covers), then any
    // items not yet in it, kept in their natural order. New items therefore
    // land at the end and nothing reshuffles on its own; drag rewrites the
    // saved order. (The reconcile effect below folds new ids into libraryOrder.)
    const natural = [...byId.keys()];
    const inOrder = libraryOrder.filter((id) => byId.has(id));
    const seen = new Set(inOrder);
    const rest = natural.filter((id) => !seen.has(id));
    return [...inOrder, ...rest].map((id) => byId.get(id)!);
  }, [presets, cacheEntries, sampleByHash, mapsForHash, libraryOrder]);

  const activeMaterialItem = useMemo(
    () =>
      [...sampleItems, ...libraryItems].find((item) => item.id === activeId) ??
      null,
    [activeId, libraryItems, sampleItems],
  );
  const activeMaterialName =
    activeMaterialItem?.label ?? pkg?.meta.fabricName ?? "red silk";
  const activeMaterialSource =
    activeMaterialItem?.entry?.sourceFilename ??
    (pkg?.id === PREGEN_HASH ? "bundled red silk" : "material package");
  const activeMaterialDate =
    activeMaterialItem?.entry?.createdAt ||
    activeMaterialItem?.preset?.createdAt ||
    pkg?.meta.createdAt ||
    null;
  const activeMaterialDateLabel = activeMaterialDate
    ? activeMaterialDate.slice(0, 10)
    : "—";

  // Keep libraryOrder in sync with the actual item set: append new ids at the
  // end (natural order) and drop ones that vanished, so the saved order is
  // authoritative and a fresh clone stays put instead of jumping to the top.
  useEffect(() => {
    if (!orderLoadedRef.current) return;
    const ids = libraryItems.map((i) => i.id);
    const current = libraryOrderRef.current;
    const kept = current.filter((id) => ids.includes(id));
    const missing = ids.filter((id) => !kept.includes(id));
    if (missing.length === 0 && kept.length === current.length) return;
    const next = [...kept, ...missing];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      applyLibraryOrder(next);
      markSaveDirty();
      const revision = reserveDurableSave("library-order");
      void runDurableSave(() => saveAuthoringOrder(next), revision);
    });
    return () => {
      cancelled = true;
    };
  }, [
    applyLibraryOrder,
    libraryItems,
    markSaveDirty,
    reserveDurableSave,
    runDurableSave,
  ]);

  const [exportState, setExportState] = useState<ExportState>("idle");

  // ── map variations: never mutate a shared extraction in place. Read the
  // complete current map set, vary one member, content-address the result,
  // and commit it as a new authored swatch with the current controls. The
  // original package (and any clones wearing it) stays intact.
  const createMapVariation = useCallback(
    async (
      source: MapVariationSource,
      name: MapName,
      file: File,
      itemId: string,
    ): Promise<void> => {
      if (pendingMaterialId !== null) {
        throw new Error("Wait for the current material change to finish");
      }
      if (!pkg) {
        throw new Error("Select a material before creating a map variation");
      }
      const currentItemId = activeId ?? pkg.id;
      const currentPkgHash = activePkgHashRef.current ?? pkg.id;
      if (
        source.itemId !== currentItemId ||
        source.pkgHash !== currentPkgHash ||
        pkg.maps[name]?.url !== source.mapUrl
      ) {
        throw new Error(
          "The material changed while this map was open. Reopen the map and try again.",
        );
      }
      if (file.size === 0) throw new Error("The selected map is empty");
      if (file.size > 32 * 1024 * 1024) {
        throw new Error("Map files must be 32 MB or smaller");
      }
      const variationIntent = ++materialIntentRef.current;
      pendingMaterialSelectionRef.current = null;
      setPendingMaterialId(itemId);
      const sourcePackage = pkg;
      const sourceItem =
        sampleItems.find((item) => item.id === source.itemId) ??
        libraryItems.find((item) => item.id === source.itemId);
      const sourceHash = source.pkgHash;
      const sourceLabel =
        sourceItem?.label ?? sourcePackage.meta.fabricName ?? "material";
      // Snapshot the authored controls with the source pixels. If another
      // material becomes active during encoding, this variation still wears
      // the controls it was created from.
      const sourceFabricId = fabricIdRef.current;
      const sourceKnobs = fabricKnobsOf(knobsRef.current);
      const sourceMetalness = resolveMetalnessAmount(
        metalnessInputRef.current,
        Boolean(sourcePackage.maps.metalness),
      );
      let failure: unknown = null;
      markSaveDirty();
      const saved = await runDurableSave(async () => {
        try {
          const { detectMapFormat } = await import(
            "@/lib/export/materialExport"
          );
          const replacementBytes = await file.arrayBuffer();
          const replacementFormat = detectMapFormat(replacementBytes, {
            url: file.name,
            mimeType: file.type,
          });
          if (
            !replacementFormat ||
            ![
              "image/png",
              "image/jpeg",
              "image/webp",
            ].includes(replacementFormat.mimeType)
          ) {
            throw new Error("Use a PNG, JPEG, or WebP map");
          }

          const prepared: {
            name: MapName;
            file: string;
            bytes: ArrayBuffer;
            provenance: MapEntry["provenance"];
            sourceHash?: string;
          }[] = [];
          const bytesByFile = new Map<string, ArrayBuffer>();
          for (const mapName of MAP_ORDER) {
            const entry = sourcePackage.maps[mapName];
            if (!entry) continue;
            let bytes: ArrayBuffer;
            let format = replacementFormat;
            if (mapName === name) {
              bytes = replacementBytes;
            } else {
              bytes =
                (await getCachedMap(entry.url)) ??
                (await (async () => {
                  const response = await fetch(entry.url);
                  if (!response.ok) {
                    throw new Error(
                      `Could not reopen ${mapName}: map returned ${response.status}`,
                    );
                  }
                  return response.arrayBuffer();
                })());
              const detected = detectMapFormat(bytes, { url: entry.url });
              if (!detected) {
                throw new Error(
                  `Could not identify the current ${mapName} map format`,
                );
              }
              format = detected;
            }
            const mapFile = `${mapName}.${format.extension}`;
            bytesByFile.set(mapFile, bytes);
            prepared.push({
              name: mapName,
              file: mapFile,
              bytes,
              provenance:
                mapName === name ? "derived" : entry.provenance,
              sourceHash: entry.sourceHash,
            });
          }
          if (!prepared.some((map) => map.name === name)) {
            throw new Error(`${name} is not present in this material`);
          }

          const pkgHash = await normalizeAuthoringHash(
            `${sourceHash}:map-edit`,
            bytesByFile,
          );
          const currentOrder = libraryOrderRef.current.filter(
            (id) => id !== itemId,
          );
          const sourceIndex = currentOrder.indexOf(source.itemId);
          if (sourceIndex === -1) currentOrder.push(itemId);
          else currentOrder.splice(sourceIndex + 1, 0, itemId);
          const label = `${sourceLabel} · ${name} edit`;
          const preset = await importAuthoringMaterialBytes(
            {
              hash: pkgHash,
              createdAt: new Date().toISOString(),
              prompt: `map edit: ${sourceLabel} / ${name}`,
              sourceFilename: file.name,
              hidden: true,
              maps: prepared.map((map) => ({
                name: map.name,
                file: map.file,
                provenance: map.provenance,
                // Lineage points at the parent pixels. The output package's
                // own content identity already lives in `pkgHash`.
                sourceHash: map.sourceHash ?? sourceHash,
              })),
            },
            bytesByFile,
            {
              slug: itemId,
              pkgHash,
              name: label,
              fabricId: sourceFabricId,
              metalness: sourceMetalness,
              knobs: sourceKnobs,
            },
            currentOrder,
          );
          vaultPresetsRef.current = [
            ...vaultPresetsRef.current.filter(
              (candidate) => candidate.slug !== itemId,
            ),
            preset,
          ];
          setPresets((current) => [
            ...current.filter((candidate) => candidate.slug !== itemId),
            preset,
          ]);
          const entry = await loadAuthoringEntry(pkgHash);
          if (!entry) {
            throw new Error("The map variation could not be reopened locally");
          }
          vaultEntriesRef.current = [
            ...vaultEntriesRef.current.filter(
              (candidate) => candidate.hash !== pkgHash,
            ),
            entry,
          ];
          deletedHashesRef.current.delete(pkgHash);
          setCacheEntries((current) => [
            ...current.filter((candidate) => candidate.hash !== pkgHash),
            entry,
          ]);
          applyLibraryOrder(currentOrder);

          // Saving is still valid if the user moved on, but it must not yank a
          // newer material off the loom when the async encode finishes.
          const sourceStillActive =
            materialIntentRef.current === variationIntent &&
            (activeIdRef.current ?? sourcePackage.id) === source.itemId &&
            (activePkgHashRef.current ?? sourcePackage.id) === source.pkgHash;
          if (sourceStillActive) {
            materialSwapRef.current(
              () => {
                if (materialIntentRef.current !== variationIntent) return;
                ++materialIntentRef.current;
                loadCachedEntry(entry);
                activeIdRef.current = itemId;
                activePkgHashRef.current = pkgHash;
                setActiveId(itemId);
                applyParams(preset);
                setPendingMaterialId(null);
                setExportState("idle");
              },
              {
                expectedAlbedoURL: entry.maps.find(
                  (map) => map.name === "albedo",
                )?.url,
                ownerAfter: itemId,
              },
            );
          }
        } catch (error) {
          failure = error;
          throw error;
        }
      }, undefined, { retainFailure: false });
      if (!saved) {
        if (materialIntentRef.current === variationIntent) {
          setPendingMaterialId(null);
        }
        throw failure instanceof Error
          ? failure
          : new Error("The map variation was not saved");
      }
    },
    [
      activeId,
      applyLibraryOrder,
      applyParams,
      libraryItems,
      loadCachedEntry,
      markSaveDirty,
      pendingMaterialId,
      pkg,
      runDurableSave,
      sampleItems,
    ],
  );

  // ── material export (zip: PBR maps + ORM + glb + json + README) ─────────
  // Live knob/metalness values are read through refs at click time so the
  // callback stays stable and the memoized MapsStrip skips knob-drag renders.
  const handleExport = useCallback(async () => {
    if (!pkg || exportState === "working") return;
    setExportState("working");
    try {
      const { exportMaterial } = await import("@/lib/export/materialExport");
      const k = knobsRef.current;
      const fId = fabricIdRef.current;
      const authoredId = activeIdRef.current ?? pkg.id;
      const activeItem = [...sampleItems, ...libraryItems].find(
        (item) => item.id === authoredId,
      );
      const metal = resolveMetalnessAmount(
        metalnessInputRef.current,
        Boolean(pkg.maps.metalness),
      );
      const result = await exportMaterial({
        name:
          activeItem?.label ||
          pkg.meta.fabricName ||
          FABRICS[fId].nameRoman,
        materialId: authoredId,
        pkg,
        knobs: fabricKnobsOf(k),
        metalness: metal,
        openness: Math.pow(k.openness, 3),
        fabric: FABRICS[fId],
      });
      if (result.complete) {
        setExportState("idle");
      } else {
        setExportState("partial");
        setStatus({
          kind: "error",
          message: `Bundle downloaded with ${result.issues.length} omitted artifact${result.issues.length === 1 ? "" : "s"}. Open README.md for the exact list.`,
        });
      }
    } catch (e) {
      console.error("material export failed", e);
      setExportState("error");
    }
  }, [pkg, exportState, libraryItems, sampleItems]);

  // ── id → item adapters for the swatch grids (their callbacks report ids;
  //    the page resolves them back to rich LibraryItems). ───────────────────
  const commitById = useCallback(
    (id: string) => {
      const pending = pendingMaterialSelectionRef.current;
      if (
        !pending ||
        pending.id !== id ||
        materialIntentRef.current !== pending.intent
      ) {
        return;
      }
      const item =
        sampleItems.find((i) => i.id === id) ??
        libraryItems.find((i) => i.id === id);
      if (item) selectMaterial(item, pending.intent);
      else {
        pendingMaterialSelectionRef.current = null;
        setPendingMaterialId(null);
      }
    },
    [sampleItems, libraryItems, selectMaterial],
  );
  const cloneById = useCallback(
    (id: string) => {
      if (pendingMaterialId !== null) return;
      const item =
        sampleItems.find((i) => i.id === id) ??
        libraryItems.find((i) => i.id === id);
      if (item) void cloneItem(item);
    },
    [sampleItems, libraryItems, cloneItem, pendingMaterialId],
  );

  /** Commit the working material as a new lightweight branch. Map bytes stay
   * shared; only the authored parameters and library row are new. */
  const keepDraftAsVariation = useCallback(async () => {
    if (keepingDraft || !activeId || !pkg || !isMaterialDraftDirty(materialDraftRef.current)) {
      return false;
    }
    const source =
      sampleItems.find((item) => item.id === activeId) ??
      libraryItems.find((item) => item.id === activeId);
    const pkgHash = activePkgHashRef.current ?? pkg.id;
    const slug =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `variation-${Date.now().toString(36)}`;
    const currentFabric = fabricKnobsOf(knobsRef.current);
    const currentFabricId = fabricIdRef.current;
    const currentMetalness = resolveMetalnessAmount(
      metalnessInputRef.current,
      Boolean(pkg.maps.metalness),
    );
    const sourceId = activeId;
    const sourceSignature = paramSig(
      currentFabricId,
      currentMetalness,
      currentFabric,
    );
    const baseName = source?.label ?? labelForId(activeId);
    let suffix = 2;
    let name = `${baseName} ${suffix}`;
    while ([...sampleItems, ...libraryItems].some(item => item.label === name)) {
      name = `${baseName} ${++suffix}`;
    }
    const nextOrder = libraryOrderRef.current.filter((id) => id !== slug);
    const sourceIndex = nextOrder.indexOf(activeId);
    if (sourceIndex === -1) nextOrder.push(slug);
    else nextOrder.splice(sourceIndex + 1, 0, slug);
    const presetRevision = reserveDurableSave(`preset:${slug}`);
    const orderRevision = reserveDurableSave("library-order");

    setKeepingDraft(true);
    markSaveDirty();
    try {
      const durableSaved = await runDurableSave(
        async () => {
          if (source?.entry) {
            await saveAuthoringMaterial(authoringMaterialFromEntry(source.entry));
            await refreshVault();
          }
          await postParams(
            slug,
            pkgHash,
            name,
            currentFabricId,
            currentMetalness,
            currentFabric,
          );
          if (saveRevisionsRef.current.isCurrent(orderRevision)) {
            await saveAuthoringOrder(nextOrder);
            applyLibraryOrder(nextOrder);
          }
        },
        presetRevision,
      );

      // A retryable save job is persistence-only. It must never switch the
      // loom later, and a slow successful save must not erase edits made while
      // it was pending. The branch still appears in the library in either case.
      const liveMetalness = resolveMetalnessAmount(
        metalnessInputRef.current,
        Boolean(pkg.maps.metalness),
      );
      const liveSignature = paramSig(
        fabricIdRef.current,
        liveMetalness,
        fabricKnobsOf(knobsRef.current),
      );
      const adopted =
        durableSaved &&
        activeIdRef.current === sourceId &&
        activePkgHashRef.current === pkgHash &&
        liveSignature === sourceSignature;
      if (adopted) {
        clearMaterialRecovery(sourceId, pkgHash);
        ++materialIntentRef.current;
        activeIdRef.current = slug;
        activePkgHashRef.current = pkgHash;
        setActiveId(slug);
        setAutosaveBaseline({ id: slug, sig: sourceSignature });
        loadMaterialDraft(currentFabric);
        setSavedSwatchName(name);
        updateSaveIndicator();
      }
      return adopted;
    } finally {
      setKeepingDraft(false);
    }
  }, [
    activeId,
    applyLibraryOrder,
    keepingDraft,
    labelForId,
    libraryItems,
    loadMaterialDraft,
    markSaveDirty,
    pkg,
    postParams,
    refreshVault,
    reserveDurableSave,
    runDurableSave,
    sampleItems,
    updateSaveIndicator,
    clearMaterialRecovery,
  ]);

  const deleteById = useCallback(
    async (id: string) => {
      if (pendingMaterialId !== null) return;
      if (
        id === activeIdRef.current &&
        !(await confirmDiscardWorkingDraft("delete this material"))
      ) {
        return;
      }
      const item = libraryItems.find((i) => i.id === id);
      if (item) void deleteLibraryItem(item);
    },
    [
      confirmDiscardWorkingDraft,
      deleteLibraryItem,
      libraryItems,
      pendingMaterialId,
    ],
  );

  // Double-click rename. The display name lives on the material's preset, so
  // renaming re-posts the preset with the new name. An untuned cache run has
  // no preset yet — freeze one (same thing its first autosave would do),
  // using the live params when it's the worn material or the map-derived
  // estimate otherwise.
  const renameById = useCallback(
    async (id: string, name: string) => {
      if (pendingMaterialId !== null) return;
      const item =
        sampleItems.find((i) => i.id === id) ??
        libraryItems.find((i) => i.id === id);
      if (!item) return;
      const preset = item.preset;
      const persist = async (
        targetId: string,
        pkgHash: string,
        nextFabricId: FabricId,
        nextMetalness: number,
        nextKnobs: FabricKnobs,
      ) => {
        const revision = reserveDurableSave(`preset:${targetId}`);
        markSaveDirty();
        await runDurableSave(
          async () => {
            if (item.entry) {
              await saveAuthoringMaterial(authoringMaterialFromEntry(item.entry));
              await refreshVault();
            }
            await postParams(
              targetId,
              pkgHash,
              name,
              nextFabricId,
              nextMetalness,
              nextKnobs,
            );
          },
          revision,
        );
      };
      if (preset) {
        await persist(
          preset.slug,
          preset.pkgHash ?? item.pkgHash,
          preset.fabricId,
          preset.metalness,
          preset.knobs,
        );
        return;
      }
      if (activeId === id) {
        await persist(id, item.pkgHash, fabricId, metalness, fabricKnobsOf(knobs));
        return;
      }
      if (!item.entry) return;
      let estimatedMetalness = 0;
      let estimatedKnobs = { ...DEFAULT_FABRIC_KNOBS };
      try {
        const p = pkgFromMaps(
          item.entry.sourceFilename ?? "material",
          "",
          item.entry.maps,
          {
            prompt: item.entry.prompt,
            sourceFilename: item.entry.sourceFilename,
            hash: item.entry.hash,
            createdAt: item.entry.createdAt || undefined,
          },
        );
        const { estimateParams } = await import("@/lib/pipeline/estimateParams");
        const est = await estimateParams(p);
        estimatedMetalness = est.metalness;
        estimatedKnobs = {
          ...DEFAULT_FABRIC_KNOBS,
          ...est.knobs,
        };
      } catch {
        // Estimation is optional; persist a clean material baseline.
      }
      await persist(
        id,
        item.pkgHash,
        fabricId,
        estimatedMetalness,
        estimatedKnobs,
      );
    },
    [
      activeId,
      fabricId,
      libraryItems,
      markSaveDirty,
      metalness,
      knobs,
      pendingMaterialId,
      postParams,
      refreshVault,
      reserveDurableSave,
      runDurableSave,
      sampleItems,
    ],
  );

  // ── collection zip: download everything / restore everything ───────────
  const [collectionBusy, setCollectionBusy] = useState<
    "export" | "import" | "material-import" | null
  >(null);
  const collectionInputRef = useRef<HTMLInputElement | null>(null);
  const materialInputRef = useRef<HTMLInputElement | null>(null);
  const exportCollectionZip = useCallback(async () => {
    if (collectionBusy) return;
    setCollectionBusy("export");
    try {
      const { exportCollection } = await import(
        "@/lib/export/collectionExport"
      );
      await exportCollection(libraryItems);
    } finally {
      setCollectionBusy(null);
    }
  }, [collectionBusy, libraryItems]);
  const importCollectionZip = useCallback(
    async (file: File) => {
      if (collectionBusy) return;
      setCollectionBusy("import");
      markSaveDirty();
      let failure: unknown = null;
      const saved = await runDurableSave(async () => {
        try {
          const { importCollection } = await import(
            "@/lib/export/collectionExport"
          );
          const res = await importCollection(file);
          // Restored ids adopt the archive order; existing local items retain
          // their relative order. Commit that merged order before showing rows.
          const merged = [
            ...libraryOrderRef.current.filter(
              (id) => !res.order.includes(id),
            ),
            ...res.order,
          ];
          await saveAuthoringOrder(merged);
          await refreshVault();
          await Promise.all([refreshCache(), refreshPresets()]);
          applyLibraryOrder(merged);
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      if (!saved) {
        setStatus({
          kind: "error",
          message:
            failure instanceof Error
              ? failure.message
              : "Collection import did not complete",
        });
      }
      setCollectionBusy(null);
    },
    [
      applyLibraryOrder,
      collectionBusy,
      markSaveDirty,
      refreshVault,
      refreshCache,
      refreshPresets,
      runDurableSave,
    ],
  );

  // A single exported material is also an input. Validate or migrate its
  // LoomMaterial document, commit all declared maps and authored controls in
  // one local transaction, then wear the IndexedDB-hydrated copy.
  const importMaterialZip = useCallback(
    async (file: File) => {
      if (collectionBusy || pendingMaterialId !== null) return;
      if (!(await confirmDiscardWorkingDraft("open another material"))) return;
      const intent = ++materialIntentRef.current;
      pendingMaterialSelectionRef.current = null;
      setPendingMaterialId("importing");
      setCollectionBusy("material-import");
      markSaveDirty();
      // Keep the identity stable if this durable job has to be retried.
      const itemId = crypto.randomUUID();
      let failure: unknown = null;
      const saved = await runDurableSave(async () => {
        try {
          const { readMaterialBundle } = await import(
            "@/lib/export/materialExport"
          );
          const reopened = await readMaterialBundle(file);
          try {
            const bytesByFile = new Map<string, ArrayBuffer>();
            const vaultMaps: {
              name: MapName;
              file: string;
              provenance: MapEntry["provenance"];
              sourceHash?: string;
            }[] = [];
            for (const name of MAP_ORDER) {
              const descriptor = reopened.document.maps[name];
              const bytes = reopened.mapBytes[name];
              if (!descriptor || !bytes) continue;
              bytesByFile.set(descriptor.file, bytes);
              vaultMaps.push({
                name,
                file: descriptor.file,
                provenance: descriptor.provenance,
                sourceHash: descriptor.sourceHash,
              });
            }
            const pkgHash = await normalizeAuthoringHash(
              reopened.document.source.identity,
              bytesByFile,
            );
            const nextOrder = [
              ...libraryOrderRef.current.filter((id) => id !== itemId),
              itemId,
            ];
            const preset = await importAuthoringMaterialBytes(
              {
                hash: pkgHash,
                createdAt: reopened.document.createdAt,
                prompt: reopened.document.source.captureNotes,
                sourceFilename: reopened.document.name,
                maps: vaultMaps,
                // The imported authored item gets its own UUID. Keep the shared
                // source package as a hidden map owner so only that item appears.
                hidden: true,
              },
              bytesByFile,
              {
                slug: itemId,
                pkgHash,
                name: reopened.document.name,
                fabricId: reopened.document.fabric.id,
                metalness: reopened.metalness,
                knobs: reopened.knobs,
              },
              nextOrder,
            );
            vaultPresetsRef.current = [
              ...vaultPresetsRef.current.filter(
                (candidate) => candidate.slug !== itemId,
              ),
              preset,
            ];
            setPresets((current) => [
              ...current.filter((candidate) => candidate.slug !== itemId),
              preset,
            ]);
            await refreshVault();
            await refreshCache();
            applyLibraryOrder(nextOrder);
            const entry = vaultEntriesRef.current.find(
              (candidate) => candidate.hash === pkgHash,
            );
            if (!entry) {
              throw new Error("Imported maps could not be reopened locally");
            }
            if (materialIntentRef.current === intent) {
              materialSwapRef.current(
                () => {
                  if (materialIntentRef.current !== intent) return;
                  loadCachedEntry(entry);
                  activePkgHashRef.current = pkgHash;
                  activeIdRef.current = itemId;
                  setActiveId(itemId);
                  applyParams(preset);
                  setPendingMaterialId(null);
                },
                {
                  expectedAlbedoURL: entry.maps.find(
                    (map) => map.name === "albedo",
                  )?.url,
                  ownerAfter: itemId,
                },
              );
              setStatus({ kind: "done", cacheHit: true, hash: pkgHash });
            }
          } finally {
            // Every retry opens fresh object URLs; release that attempt's URLs
            // once the vault-hydrated copies have taken over.
            reopened.revoke();
          }
        } catch (error) {
          failure = error;
          throw error;
        }
      }, undefined, { retainFailure: false });
      if (!saved) {
        if (materialIntentRef.current === intent) setPendingMaterialId(null);
        setStatus({
          kind: "error",
          message:
            failure instanceof Error
              ? failure.message
              : "Material import did not complete",
        });
      }
      setCollectionBusy(null);
    },
    [
      applyLibraryOrder,
      applyParams,
      collectionBusy,
      confirmDiscardWorkingDraft,
      loadCachedEntry,
      markSaveDirty,
      pendingMaterialId,
      refreshCache,
      refreshVault,
      runDurableSave,
    ],
  );

  const materialSwap = useMaterialSwap({
    activeId,
    commit: commitById,
  });
  const selectTransferredMaterial = materialSwap.select;
  const selectMaterialWithDraftGuard = useCallback(
    async (id: string) => {
      if (id === activeId || pendingMaterialId !== null) return;
      if (!(await confirmDiscardWorkingDraft("switch swatches"))) return;
      const intent = ++materialIntentRef.current;
      pendingMaterialSelectionRef.current = { id, intent };
      setPendingMaterialId(id);
      selectTransferredMaterial(id);
    },
    [activeId, pendingMaterialId, confirmDiscardWorkingDraft, selectTransferredMaterial],
  );
  useEffect(() => {
    materialSwapRef.current = materialSwap.swap;
  }, [materialSwap.swap]);

  // Reopen the last edited source on refresh; its validated history is applied
  // by the recovery effect only after that source has hydrated.
  useEffect(() => {
    if (resumedMaterialRef.current || !bootedRef.current || !presetsLoaded || !activeId ||
      autosaveBaseline.id !== activeId || !autosaveBaseline.sig) return;
    if (materialIntentRef.current > 0) { resumedMaterialRef.current = true; return; }
    try {
      const last = JSON.parse(localStorage.getItem(LAST_EDITED_MATERIAL_KEY) ?? "null");
      if (!last || typeof last.id !== "string" || typeof last.pkgHash !== "string") {
        resumedMaterialRef.current = true;
        return;
      }
      if (last.id === activeId) { resumedMaterialRef.current = true; return; }
      const item = [...sampleItems, ...libraryItems].find(item => item.id === last.id && item.pkgHash === last.pkgHash);
      if (!item) return; // local material packages may still be hydrating
      // Never replace a gesture made while library hydration was pending.
      if (isMaterialDraftDirty(materialDraftRef.current) || fabricGestureActiveRef.current) return;
      let cancelled = false;
      const intent = materialIntentRef.current;
      queueMicrotask(() => {
        if (cancelled || activeIdRef.current !== activeId || materialIntentRef.current !== intent ||
          fabricGestureActiveRef.current || isMaterialDraftDirty(materialDraftRef.current) ||
          pendingMaterialSelectionRef.current) return;
        resumedMaterialRef.current = true;
        void selectMaterialWithDraftGuard(item.id);
      });
      return () => { cancelled = true; };
    } catch { resumedMaterialRef.current = true; }
  }, [activeId, autosaveBaseline, presetsLoaded, sampleItems, libraryItems, selectMaterialWithDraftGuard]);

  const focusMaterialName = () => {
    const target = cabinetFace === "material"
      ? ".cabinet-material-header h2" : ".material-cabinet__flip";
    document.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  };

  return (
    <div className="app">
      <MaterialLeaveDialog action={leaveAction} busy={keepingDraft}
        error={saveStatus === "error" ? saveMessage : null}
        onCancel={() => resolveLeave(false)}
        onDiscard={() => {
          clearMaterialRecovery();
          navigateMaterialDraft({ type: "discard" });
          resolveLeave(true);
        }}
        onSave={() => { void keepDraftAsVariation().then(saved => { if (saved) resolveLeave(true); }); }}
      />
      <NavBar
        onOpenLight={lightModalOpen ? closeLightModal : openLightModal}
        lightDialogOpen={lightModalOpen}
        status={status}
        saveStatus={draftDirty && saveStatus === "saved" ? "dirty" : saveStatus}
        saveMessage={saveMessage}
        onRetrySave={() => {
          void retryFailedSaves();
        }}
      />
      <RoomLightModal
        mode={mode}
        onMode={setMode}
        open={lightModalOpen}
        settings={roomLightSettings}
        resolved={roomLight.resolvedRef.current}
        onChange={commitRoomLightSettings}
        onReset={resetRoomLight}
        onClose={closeLightModal}
      />
      <RoomFrame
        ref={roomRootRef}
        stage={
      <div className="stage" ref={stageRef} data-pattern-magnification={narrowPreview ? "1.5" : "1"}>
        {/* One persistent scene. `mode` cross-fades the cloth and the object
            in place — no teardown, no remount. */}
        {mobilePerformance !== null && <ClothScene
          ref={clothSceneRef}
          fabric={fabric}
          width={stageSize.w}
          height={stageSize.h}
          mode={mode}
          pkg={pkg}
          objectModelUrl={OBJECT_MODEL_URL}
          objectTileScale={roomPreviewTileScale(presentedKnobs.tileScale, narrowPreview) * 5}
          wireframe={knobs.wireframe}
          pinMode={knobs.pinMode}
          openness={opennessCurved}
          translucency={presentedKnobs.translucency}
          densityAmount={presentedKnobs.densityAmount}
          alphaFromDensity={presentedKnobs.alphaFromDensity}
          alphaBoost={presentedKnobs.alphaBoost}
          alphaBoostSource={presentedKnobs.alphaBoostSource}
          roughnessMapURL={pkg?.maps.roughness?.url}
          porosityMapURL={pkg?.maps.transmission?.url}
          metalness={metalness}
          iridescence={presentedKnobs.iridescence}
          metalnessMapURL={pkg?.maps.metalness?.url}
          normalMapURL={pkg?.maps.normal?.url}
          normalAmount={presentedKnobs.normalAmount}
          pomShadow={presentedKnobs.pomShadow}
          stretch={presentedKnobs.stretch}
          stretchDebug={knobs.stretchDebug}
          albedoAmount={presentedKnobs.albedoAmount}
          pomScale={presentedKnobs.pomScale}
          pomMinSteps={previewPerformance.pomMinSteps}
          pomMaxSteps={previewPerformance.pomMaxSteps}
          pomDebug={knobs.pomDebug}
          edgeInset={presentedKnobs.edgeInset}
          edgeFray={presentedKnobs.edgeFray}
          edgeSharpness={presentedKnobs.edgeSharpness}
          edgeDetail={presentedKnobs.edgeDetail}
          tileScale={roomPreviewTileScale(presentedKnobs.tileScale, narrowPreview)}
          txHeight={presentedKnobs.txHeight}
          txAlbedo={presentedKnobs.txAlbedo}
          txRoughness={presentedKnobs.txRoughness}
          transmissionContrast={presentedKnobs.transmissionContrast}
          pixelScale={QUALITY_PRESETS[previewPerformance.quality].pixelScale}
          antialias={mobilePerformance ? false : undefined}
          meshCols={MESH_PRESETS[previewPerformance.meshRes].cols}
          meshRows={MESH_PRESETS[previewPerformance.meshRes].rows}
          breeze={knobs.breeze}
          skyMode={knobs.skyMode === "sky" ? 0 : 1}
          mouseForce={knobs.mouseForce}
          iterations={previewPerformance.iterations}
          selfCollide={previewPerformance.selfCollide}
          anisotropy={previewPerformance.anisotropy}
          environment="room"
          roomLightRef={roomLight.resolvedRef}
          materialRevealRef={materialSwap.opacityRef}
          materialTransitionKey={materialSwap.transitionKey}
          materialExpectedAlbedoURL={materialSwap.expectedAlbedoURL}
          onMaterialReady={materialSwap.materialReady}
          onStats={reportPerfStats}
        />}
        {mode === "cloth" && (knobs.pomDebug !== 0 || knobs.wireframe) ? (
          <div className="stage-badge">
            {[
              knobs.pomDebug !== 0
                ? `POM debug: ${knobs.pomDebug === 1 ? "offset" : "steps"} · press P`
                : null,
              knobs.wireframe
                ? "wire: verts + edges · color = velocity (slate→amber→white)"
                : null,
            ]
              .filter(Boolean)
              .join("  ·  ")}
          </div>
        ) : null}
        {status.kind === "loading" ? (
          <div className="stage-veil">{status.message}</div>
        ) : null}
      </div>
        }
        cabinet={
          <MaterialCabinet
            materialFaceRef={tuningScrollRef}
            face={cabinetFace}
            onFlip={face => { setViewingSavedSwatch(false); setCabinetFace(face); }}
            onFaceSettled={face => {
              if (face === "archive" && viewingSavedSwatch) {
                setViewingSavedSwatch(false);
                setSavedSwatchName(null);
              }
            }}
            actionShelf={pkg ? <MaterialEditShelf
              dirty={draftDirty}
              canUndo={canUndoDraft}
              canRedo={canRedoDraft}
              comparingOriginal={materialDraft.comparison === "baseline"}
              saving={keepingDraft}
              disabled={pendingMaterialId !== null}
              savedName={savedSwatchName}
              dismissing={viewingSavedSwatch}
              recoveryWarning={recoveryWarning}
              onCompare={original => setDraftComparison(original ? "baseline" : "current")}
              onUndo={() => navigateMaterialDraft({ type: "undo" })}
              onRedo={() => navigateMaterialDraft({ type: "redo" })}
              onReset={() => {
                focusMaterialName();
                clearMaterialRecovery();
                navigateMaterialDraft({ type: "discard" });
              }}
              onSave={() => { void keepDraftAsVariation().then(saved => { if (saved) focusMaterialName(); }); }}
              onViewArchive={() => {
                document.querySelector<HTMLElement>(".material-cabinet__flip")?.focus({ preventScroll: true });
                if (cabinetFace === "archive") setSavedSwatchName(null);
                else {
                  setViewingSavedSwatch(true);
                  setCabinetFace("archive");
                }
              }}
            /> : undefined}
            archiveFace={
              <aside
                className="cabinet-pane cabinet-pane--archive swatch-stamped"
                aria-label="swatch archive"
                style={
                  {
                    "--stamp-mask": `url("${STAMP_MASK_URI}")`,
                  } as CSSProperties
                }
              >
                <header className="cabinet-pane__header">
                  <p className="cabinet-pane__kicker">swatch archive</p>
                  <p className="cabinet-pane__lede">
                    Choose a swatch, save an edited copy, or bring in a new cloth.
                  </p>
                </header>
                <div className="cabinet-pane__scroll">
                  <SampleGrid
                    items={sampleItems}
                    activeId={activeId}
                    drag={drag}
                    onSelect={selectMaterialWithDraftGuard}
                    onClone={cloneById}
                  />
                  <LibraryGrid
                    items={libraryItems}
                    activeId={activeId}
                    drag={drag}
                    onSelect={selectMaterialWithDraftGuard}
                    onClone={cloneById}
                    onReorder={reorderLibrary}
                    onDelete={deleteById}
                    onRename={renameById}
                  />

                  <details className="cabinet-disclosure">
                    <summary>add material</summary>
                    <InsertPanel
                      stagedName={stagedFile?.name ?? null}
                      onFiles={stageFiles}
                      prompt={prompt}
                      onPrompt={setPrompt}
                      onSubmit={submit}
                      busy={status.kind === "loading"}
                      error={status.kind === "error" ? status.message : null}
                    />
                  </details>

                  <section className="panel-section" data-dye="persimmon">
                    <SectionLabel hint="save your whole collection (maps + tuned parameters) as one zip, or load a saved one back in">
                      collection
                    </SectionLabel>
                    <div className="collection-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={
                          collectionBusy !== null || libraryItems.length === 0
                        }
                        onClick={() => void exportCollectionZip()}
                      >
                        {collectionBusy === "export"
                          ? "zipping…"
                          : "download zip ↓"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost collection-load"
                        disabled={collectionBusy !== null}
                        onClick={() => collectionInputRef.current?.click()}
                      >
                        {collectionBusy === "import" ? "loading…" : "load zip"}
                      </button>
                      <input
                        ref={collectionInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        hidden
                        disabled={collectionBusy !== null}
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (f) void importCollectionZip(f);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost collection-load material-load"
                        disabled={collectionBusy !== null}
                        onClick={() => materialInputRef.current?.click()}
                      >
                        {collectionBusy === "material-import"
                          ? "opening material…"
                          : "load one material"}
                      </button>
                      <input
                        ref={materialInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        hidden
                        disabled={collectionBusy !== null}
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (f) void importMaterialZip(f);
                        }}
                      />
                    </div>
                  </section>
                </div>
              </aside>
            }
            materialFace={
              <aside
                className="cabinet-pane cabinet-pane--material"
                aria-label="material dossier"
              >
                <header className="cabinet-pane__header cabinet-material-header">
                  <div>
                    <p className="cabinet-pane__kicker">material dossier</p>
                    <h2 tabIndex={-1}>{activeMaterialName}</h2>
                  </div>
                </header>
                <dl className="cabinet-material-meta">
                  <div>
                    <dt>source</dt>
                    <dd>{activeMaterialSource}</dd>
                  </div>
                  <div>
                    <dt>maps</dt>
                    <dd>{mapEntries.length || "—"}</dd>
                  </div>
                  <div>
                    <dt>made</dt>
                    <dd>{activeMaterialDateLabel}</dd>
                  </div>
                </dl>
                <div className="cabinet-pane__scroll">
                  <MapsStrip
                    entries={mapEntries}
                    source={mapVariationSource}
                    onCreateVariation={createMapVariation}
                    exportState={exportState}
                    canExport={Boolean(pkg)}
                    onExport={handleExport}
                  />

                  <div className="cabinet-tuning-label">
                    <span>tuning</span>
                    <TuningViewPicker
                      view={tuningView}
                      onSelect={selectTuningView}
                      placement="sheet"
                    />
                  </div>

          <section
            className="panel-section"
            data-dye="indigo"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="forces that keep the cloth moving while you inspect it">
              motion
            </SectionLabel>
            <div className="knob-stack">
              <Slider
                label="mouse force"
                hint="multiplies hover movement; click the specimen to toggle the magnifier"
                value={knobs.mouseForce}
                min={0}
                max={5}
                step={0.1}
                onChange={(v) => setKnobs((k) => ({ ...k, mouseForce: v }))}
              />
              <Slider
                label="breeze"
                hint="wind strength; zero is dead calm"
                value={knobs.breeze}
                min={0}
                max={0.25}
                step={0.005}
                onChange={(v) => setKnobs((k) => ({ ...k, breeze: v }))}
              />
            </div>
            <div
              className="instrument-action-row probe-strip"
              role="group"
              aria-label="repeatable cloth tests"
            >
              <span className="instrument-row-label">tests</span>
              {(["still", "gust", "pull"] as const).map((probe) => (
                <button
                  key={probe}
                  type="button"
                  className="instrument-button"
                  disabled={mode !== "cloth"}
                  onClick={() => runClothProbe(probe)}
                >
                  {probe === "still" ? "drape" : probe}
                </button>
              ))}
              <button
                type="button"
                className="instrument-button instrument-reset"
                disabled={mode !== "cloth"}
                onClick={() => runClothProbe("reset")}
              >
                reset
              </button>
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="gardenia"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="how sharply the scene is drawn; higher is crisper but works the GPU harder">frag res</SectionLabel>
            {mobilePerformance && <p className="room-performance-note">Mobile preview uses low resolution and a 32 × 32 mesh. Saved materials and desktop preferences stay unchanged.</p>}
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay tone="ink" layer="over" />
              {(
                [
                  { v: "lo" as const, label: "lo" },
                  { v: "mid" as const, label: "mid" },
                  { v: "hi" as const, label: "hi" },
                ]
              ).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  role="tab"
                  disabled={mobilePerformance === true}
                  aria-selected={previewPerformance.quality === opt.v}
                  className="tx-mode-tab"
                  data-active={previewPerformance.quality === opt.v}
                  onClick={() => {
                    const preset = QUALITY_PRESETS[opt.v];
                    setKnobs((k) => ({
                      ...k,
                      quality: opt.v,
                      pomMinSteps: preset.pomMinSteps,
                      pomMaxSteps: preset.pomMaxSteps,
                    }));
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="persimmon"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="how many points simulate the cloth; higher drapes finer folds, costs speed">mesh res</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay tone="ink" layer="over" />
              {(
                [
                  { v: "lo" as const, label: "lo" },
                  { v: "mid" as const, label: "mid" },
                  { v: "hi" as const, label: "hi" },
                ]
              ).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  role="tab"
                  disabled={mobilePerformance === true}
                  aria-selected={previewPerformance.meshRes === opt.v}
                  className="tx-mode-tab"
                  data-active={previewPerformance.meshRes === opt.v}
                  onClick={() =>
                    setKnobs((k) => ({ ...k, meshRes: opt.v }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="persimmon"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="height-field sample limits used by the renderer">
              relief quality
            </SectionLabel>
            <div className="knob-stack">
              <IntSlider
                label="pom min"
                hint="guaranteed relief samples even when the offset is small on screen"
                value={previewPerformance.pomMinSteps}
                min={2}
                max={mobilePerformance ? 6 : 32}
                onChange={(v) => setKnobs((k) => ({ ...k, pomMinSteps: v }))}
              />
              <IntSlider
                label="pom max"
                hint="ceiling for grazing angles and close-up relief"
                value={previewPerformance.pomMaxSteps}
                min={8}
                max={mobilePerformance ? 16 : 64}
                onChange={(v) => setKnobs((k) => ({ ...k, pomMaxSteps: v }))}
              />
            </div>
          </section>

          <section
            className="panel-section instrument-surface"
            data-dye="mugwort"
            hidden={tuningView !== "fabric"}
            inert={pendingMaterialId !== null}
            aria-busy={pendingMaterialId !== null}
          >
            <SectionLabel hint="a compact performance surface; every gesture remains editable in fine tune">
              material instrument
            </SectionLabel>

            <div className="construction-control">
              <span className="instrument-control-label">construction</span>
              <div
                className="construction-options"
                role="group"
                aria-label="cloth construction"
              >
                <PixelPlay tone="ink" layer="over" />
                {CONSTRUCTION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={construction === option.value}
                    className="construction-option"
                    data-active={construction === option.value}
                    onClick={() =>
                      commitInstrumentPatch({ construction: option.value })
                    }
                  >
                    <WeaveDiagram
                      type={option.value}
                      threads={5}
                      yarn={0.55}
                    />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="instrument-pad-grid">
              <InstrumentPad
                label="behavior"
                x={instrumentState.hand}
                y={instrumentState.response}
                xLow="fluid"
                xHigh="crisp"
                yLow="floating"
                yHigh="grounded"
                valueText={`${axisWord(instrumentState.hand, "fluid", "balanced", "crisp")} · ${axisWord(instrumentState.response, "floating", "settled", "grounded")}`}
                onPreviewStart={protectFabricPreview}
                onGestureStart={beginFabricGesture}
                onChange={(hand, response) =>
                  previewInstrument({ hand, response })
                }
                onGestureEnd={commitFabricGesture}
              />
              <InstrumentPad
                label="surface"
                x={instrumentState.luster}
                y={instrumentState.relief}
                xLow="matte"
                xHigh="lustrous"
                yLow="subtle"
                yHigh="deep"
                valueText={`${axisWord(instrumentState.luster, "matte", "soft", "lustrous")} · ${axisWord(instrumentState.relief, "subtle", "raised", "deep")}`}
                onPreviewStart={protectFabricPreview}
                onGestureStart={beginFabricGesture}
                onChange={(luster, relief) =>
                  previewInstrument({ luster, relief })
                }
                onGestureEnd={commitFabricGesture}
              />
            </div>

            <div className="instrument-sliders">
              <Slider
                label="open area"
                hint="controls background visibility through the cloth, independently of fiber backlighting"
                value={instrumentState.opennessPercent}
                min={0}
                max={100}
                step={1}
                formatValue={(value) => `${Math.round(value)}%`}
                onChangeStart={beginFabricGesture}
                onChange={(opennessPercent) =>
                  previewInstrument({ opennessPercent })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="pattern scale"
                hint={narrowPreview
                  ? "saved texture repeats; this small-screen preview shows the pattern 1.5× larger"
                  : "texture repeats on a logarithmic scale, so fine and coarse changes get equal room"}
                value={tileScaleToSlider(instrumentState.tileScale)}
                min={0}
                max={1}
                step={0.01}
                formatValue={(value) =>
                  `${tileScaleFromSlider(value).toFixed(1)}×`
                }
                onChangeStart={beginFabricGesture}
                onChange={(value) =>
                  previewInstrument({ tileScale: tileScaleFromSlider(value) })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="edge finish"
                hint="clean cut to loose edge; coordinates fray, inset, softness, and thread detail"
                value={instrumentState.edgeFinish}
                formatValue={(value) =>
                  axisWord(value, "clean", "worn", "raw")
                }
                onChangeStart={beginFabricGesture}
                onChange={(edgeFinish) =>
                  previewInstrument({ edgeFinish })
                }
                onChangeEnd={commitFabricGesture}
              />
            </div>
          </section>

          <details
            className="fine-tune"
            hidden={tuningView !== "fabric"}
            inert={pendingMaterialId !== null}
            aria-busy={pendingMaterialId !== null}
          >
            <summary>
              <span>fine tune</span>
            </summary>
            <div className="fine-tune-sections">

          <section
            className="panel-section"
            data-dye="indigo"
            hidden={tuningView !== "fabric"}
          >
            <SectionLabel hint="what happens when the sun is behind the cloth and light passes through">transmission</SectionLabel>
            {/* Independent per-map weights: each map's pull on where the cloth
                goes sheer. Any can be zeroed out; they blend by relative
                weight. All three at 0 → opaque. */}
            <Slider
              label="from height"
                hint="how much the weave's hills and valleys decide where light shines through"
              value={knobs.txHeight}
              onChangeStart={beginFabricGesture}
              onChange={(txHeight) => previewFabricPatch({ txHeight })}
              onChangeEnd={commitFabricGesture}
            />
            <Slider
              label="from albedo"
                hint="bright spots in the color map let more light through"
              value={knobs.txAlbedo}
              onChangeStart={beginFabricGesture}
              onChange={(txAlbedo) => previewFabricPatch({ txAlbedo })}
              onChangeEnd={commitFabricGesture}
            />
            <Slider
              label="from roughness"
                hint="the roughness map decides where light sneaks through"
              value={knobs.txRoughness}
              onChangeStart={beginFabricGesture}
              onChange={(txRoughness) => previewFabricPatch({ txRoughness })}
              onChangeEnd={commitFabricGesture}
            />
            <Slider
              label="contrast"
                hint="pushes see-through spots more open and solid spots more solid"
              value={knobs.transmissionContrast}
              onChangeStart={beginFabricGesture}
              onChange={(transmissionContrast) =>
                previewFabricPatch({ transmissionContrast })
              }
              onChangeEnd={commitFabricGesture}
            />
          </section>

          <section
            className="panel-section"
            data-dye="madder"
            hidden={tuningView !== "fabric"}
          >
            <SectionLabel hint="the character of the fabric itself">material</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="force response"
                hint="how strongly the cloth resists pointer and wind forces; gravity remains constant"
                value={knobs.weight}
                min={0.2}
                max={3}
                step={0.05}
                onChangeStart={beginFabricGesture}
                onChange={(weight) => previewFabricPatch({ weight })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="sheen"
                hint="the soft shine that catches folds and edges, like silk"
                value={knobs.sheen}
                onChangeStart={beginFabricGesture}
                onChange={(sheen) => previewFabricPatch({ sheen })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="iridescence"
                hint="rainbow light play: color fringes through the cloth, thread shimmer, and the sun's lens flare"
                value={knobs.iridescence}
                onChangeStart={beginFabricGesture}
                onChange={(iridescence) => previewFabricPatch({ iridescence })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="openness curve"
                hint="the stored cube-root response behind the instrument's honest open-area percentage"
                value={knobs.openness}
                formatValue={(value) =>
                  `${Math.round(effectiveOpennessPercent(value))}%`
                }
                onChangeStart={beginFabricGesture}
                onChange={(openness) => previewFabricPatch({ openness })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="α boost"
                hint="extra thinning on top — makes worn, threadbare patches"
                value={knobs.alphaBoost}
                min={0}
                max={0.5}
                step={0.005}
                onChangeStart={beginFabricGesture}
                onChange={(alphaBoost) => previewFabricPatch({ alphaBoost })}
                onChangeEnd={commitFabricGesture}
              />
              {/* Which map the boost wears thin along. Dark regions of the
                  chosen map go threadbare; height preserves the original
                  weave-valley behavior. */}
              <div
                className="tx-mode-picker tx-mode-picker-wide"
                role="tablist"
                aria-label="α boost source"
              >
                <PixelPlay tone="ink" layer="over" />
                {(
                  [
                    { v: 0 as const, label: "height" },
                    { v: 1 as const, label: "albedo" },
                    { v: 2 as const, label: "rough" },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    role="tab"
                    aria-selected={knobs.alphaBoostSource === opt.v}
                    className="tx-mode-tab"
                    data-active={knobs.alphaBoostSource === opt.v}
                    onClick={() => commitFabricPatch({ alphaBoostSource: opt.v })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <Slider
                label="albedo mix"
                hint="blend between plain white cloth and the captured color"
                value={knobs.albedoAmount}
                onChangeStart={beginFabricGesture}
                onChange={(albedoAmount) => previewFabricPatch({ albedoAmount })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="tile ×"
                hint={narrowPreview
                  ? "saved repeats; the small-screen preview magnifies the pattern 1.5×"
                  : "how many times the fabric pattern repeats across the sheet"}
                value={knobs.tileScale}
                min={0.5}
                max={16}
                step={0.25}
                onChangeStart={beginFabricGesture}
                onChange={(tileScale) => previewFabricPatch({ tileScale })}
                onChangeEnd={commitFabricGesture}
              />
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="mugwort"
            hidden={tuningView !== "fabric"}
          >
            <SectionLabel hint="the four structural values driven together by behavior and construction above">
              structure calibration
            </SectionLabel>
            <div className="knob-stack">
              <Slider
                label="warp"
                hint="stiffness along the vertical threads"
                value={knobs.warpStiffness}
                onChangeStart={beginFabricGesture}
                onChange={(warpStiffness) =>
                  previewFabricPatch({ warpStiffness })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="weft"
                hint="stiffness along the horizontal threads"
                value={knobs.weftStiffness}
                onChangeStart={beginFabricGesture}
                onChange={(weftStiffness) =>
                  previewFabricPatch({ weftStiffness })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="shear"
                hint="resistance to diagonal skewing — low lets the cloth stretch on the bias"
                value={knobs.shearStiffness}
                onChangeStart={beginFabricGesture}
                onChange={(shearStiffness) =>
                  previewFabricPatch({ shearStiffness })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="bend"
                hint="resistance to folding — high reads stiff and papery"
                value={knobs.bendStiffness}
                onChangeStart={beginFabricGesture}
                onChange={(bendStiffness) =>
                  previewFabricPatch({ bendStiffness })
                }
                onChangeEnd={commitFabricGesture}
              />
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="persimmon"
            hidden={tuningView !== "fabric"}
          >
            <SectionLabel hint="the illusion of depth in the weave texture">parallax</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="pom depth"
                hint="how deep the weave relief looks — raised threads without extra geometry"
                value={knobs.pomScale}
                min={0}
                max={0.08}
                step={0.001}
                onChangeStart={beginFabricGesture}
                onChange={(pomScale) => previewFabricPatch({ pomScale })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="micro nrm"
                hint="how strongly the captured normal map bumps each thread"
                value={knobs.normalAmount}
                onChangeStart={beginFabricGesture}
                onChange={(normalAmount) => previewFabricPatch({ normalAmount })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="self shadow"
                hint="threads casting tiny shadows on each other inside the weave"
                value={knobs.pomShadow}
                onChangeStart={beginFabricGesture}
                onChange={(pomShadow) => previewFabricPatch({ pomShadow })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="stretch"
                hint="taut spots go sheer, flat, and shiny — like pulled fabric"
                value={knobs.stretch}
                onChangeStart={beginFabricGesture}
                onChange={(stretch) => previewFabricPatch({ stretch })}
                onChangeEnd={commitFabricGesture}
              />
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="gardenia"
            hidden={tuningView !== "fabric"}
          >
            <SectionLabel hint="the cut edges of the sheet and how they fray">edge</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="inset"
                hint="how far in from the edge the fraying starts"
                value={knobs.edgeInset}
                min={0}
                max={0.15}
                step={0.005}
                onChangeStart={beginFabricGesture}
                onChange={(edgeInset) => previewFabricPatch({ edgeInset })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="fray"
                hint="how ragged the cut edges are"
                value={knobs.edgeFray}
                onChangeStart={beginFabricGesture}
                onChange={(edgeFray) => previewFabricPatch({ edgeFray })}
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="crispness"
                hint="sharp vs soft boundary on the frayed edge"
                value={knobs.edgeSharpness}
                onChangeStart={beginFabricGesture}
                onChange={(edgeSharpness) =>
                  previewFabricPatch({ edgeSharpness })
                }
                onChangeEnd={commitFabricGesture}
              />
              <Slider
                label="detail"
                hint="scale of the fray noise — fine threads or chunky bites"
                value={knobs.edgeDetail}
                min={1}
                max={8}
                step={0.25}
                onChangeStart={beginFabricGesture}
                onChange={(edgeDetail) => previewFabricPatch({ edgeDetail })}
                onChangeEnd={commitFabricGesture}
              />
            </div>
          </section>

            </div>
          </details>

          <section
            className="panel-section"
            data-dye="indigo"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="debug views and how the cloth is pinned to the line">modes</SectionLabel>
            <div className="knob-toggles">
              <button
                type="button"
                className="btn btn-ghost btn-toggle"
                data-pressed={knobs.wireframe}
                onClick={() =>
                  setKnobs((k) => ({ ...k, wireframe: !k.wireframe }))
                }
              >
                wire
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-toggle"
                data-pressed={knobs.pinMode === "pegs"}
                onClick={() =>
                  setKnobs((k) => ({
                    ...k,
                    pinMode: k.pinMode === "pegs" ? "line" : "pegs",
                  }))
                }
              >
                {knobs.pinMode}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-toggle"
                data-pressed={knobs.pomDebug !== 0}
                onClick={() =>
                  setKnobs((k) => ({
                    ...k,
                    pomDebug: ((k.pomDebug + 1) % 3) as 0 | 1 | 2,
                  }))
                }
                title="press P to cycle"
              >
                {knobs.pomDebug === 0
                  ? "pom off"
                  : knobs.pomDebug === 1
                    ? "pom offset"
                    : "pom steps"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-toggle"
                data-pressed={knobs.stretchDebug}
                onClick={() =>
                  setKnobs((k) => ({ ...k, stretchDebug: !k.stretchDebug }))
                }
                title="heatmap the strain field (slate = slack, white = taut)"
              >
                strain
              </button>
            </div>
          </section>

          <section
            className="panel-section"
            data-dye="madder"
            hidden={tuningView !== "scene"}
          >
            <SectionLabel hint="live cost of this device drawing the scene">performance</SectionLabel>
            <PerformanceMeters
              ref={perfMetersRef}
              autoQuality={mobilePerformance === false && previewPerformance.autoQuality}
              quality={previewPerformance.quality}
              onQualityChange={applyAutoQuality}
            />

            <button
              type="button"
              className="btn btn-ghost btn-toggle perf-auto"
              disabled={mobilePerformance !== false}
              data-pressed={previewPerformance.autoQuality}
              onClick={() =>
                setKnobs((k) => ({ ...k, autoQuality: !k.autoQuality }))
              }
              title="auto-lower frag res when the frame rate sags (rendering only — never the sim)"
            >
              auto quality {previewPerformance.autoQuality ? "on" : "off"}
            </button>

            <div className="knob-stack">
              <IntSlider
                label="iterations"
                hint="solver passes per frame — more keeps the cloth taut and stable, fewer is faster"
                value={previewPerformance.iterations}
                min={2}
                max={mobilePerformance ? 3 : 8}
                onChange={(v) => setKnobs((k) => ({ ...k, iterations: v }))}
              />
            </div>

            <SectionLabel hint="how often the cloth checks for folding into itself; off is fastest but folds can pass through">self-collide</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay tone="ink" layer="over" />
              {(
                [
                  { v: "full" as const, label: "full" },
                  { v: "half" as const, label: "half" },
                  { v: "off" as const, label: "off" },
                ]
              ).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  role="tab"
                  disabled={mobilePerformance === true && opt.v === "full"}
                  aria-selected={previewPerformance.selfCollide === opt.v}
                  className="tx-mode-tab"
                  data-active={previewPerformance.selfCollide === opt.v}
                  onClick={() =>
                    setKnobs((k) => ({ ...k, selfCollide: opt.v }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <SectionLabel hint="final map sharpness at glancing angles; the repeated height march stays capped at 2×">anisotropy</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay tone="ink" layer="over" />
              {([2, 4, 8] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  disabled={mobilePerformance === true}
                  aria-selected={previewPerformance.anisotropy === v}
                  className="tx-mode-tab"
                  data-active={previewPerformance.anisotropy === v}
                  onClick={() => setKnobs((k) => ({ ...k, anisotropy: v }))}
                >
                  {v}×
                </button>
              ))}
            </div>
          </section>
                </div>
              </aside>
            }
          />
        }
      />
    </div>
  );
}
