"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClothScene, { type ClothStats } from "@/lib/ui/clothScene";
import { fabricFromPkg } from "@/lib/ui/fabricViewer";
import {
  FABRICS,
  FABRIC_ORDER,
  type FabricId,
} from "@/lib/cloth/fabrics";
import { runPatinaBaseline } from "@/lib/pipeline/patinaBaseline";
import {
  MAP_ORDER,
  pkgFromMaps,
  type MapEntry,
  type MapName,
  type MaterialPackage,
} from "@/lib/core/materialPackage";
import {
  type FabricKnobs,
  type Knobs,
  DEFAULT_KNOBS,
  MESH_PRESETS,
  QUALITY_PRESETS,
  fabricKnobsOf,
  paramSig,
} from "@/lib/ui/knobs";
import type { MaterialPreset } from "@/lib/presets/types";
import { WeaveDiagram } from "@/lib/ui/weaveDiagram";
import {
  IntSlider,
  PanelHeader,
  SectionLabel,
  Slider,
  shortHash,
} from "@/lib/ui/panelPrimitives";
import {
  NavBar,
  type PipelineStatus,
  type StageMode,
} from "@/lib/ui/navBar";
import { MapsStrip, type ExportState } from "@/lib/ui/mapsStrip";
import { PixelPlay } from "@/lib/ui/pixelPlay";
import { InsertPanel } from "@/lib/ui/insertPanel";
import {
  LibraryGrid,
  SampleGrid,
  useSwatchDrag,
} from "@/lib/ui/materialSwatches";

const OBJECT_MODEL_URL = "/model/whale.glb";

interface CacheEntry {
  hash: string;
  createdAt: string;
  prompt: string | null;
  sourceFilename: string | null;
  maps: { name: string; file: string; url: string }[];
}

// Order the mobile bottom sheet pages through (‹ prev / › next / swipe).
const MOBILE_PANELS = ["workshop", "tuning"] as const;

const PREGEN_MANIFEST = "/pregen/silk-sample/manifest.json";
const PREGEN_BASE = "/pregen/silk-sample";
// Content hash of the pregen silk-sample bundle — the boot material and the
// maps behind the curated "red silk" preset.
const PREGEN_HASH = "71871d958aa681541baf9159cbf98bc4";

// Per-fabric drawing parameters for the weave-picker diagrams. The four
// plain weaves share a renderer but differ in thread count / yarn width so
// fine silk, open ramie, everyday cotton, and coarse hemp read distinctly.
// (twill/knit ignore these — their geometry carries the identity.)
const WEAVE_DIAGRAM_PARAMS: Record<FabricId, { threads: number; yarn: number }> = {
  myeongju: { threads: 7, yarn: 0.62 }, // fine, dense
  mosi: { threads: 4, yarn: 0.38 },     // thin thread, open gaps
  mumyeong: { threads: 5, yarn: 0.55 }, // the everyday middle
  sambe: { threads: 4, yarn: 0.68 },    // fat coarse yarn
  jersey: { threads: 5, yarn: 0.55 },
  denim: { threads: 5, yarn: 0.55 },
};

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
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Mobile only: which editor the bottom sheet shows (the other is hidden).
  // Navigated by the ‹ › buttons or a sideways swipe. Ignored on desktop.
  const [mobileTab, setMobileTab] = useState<"workshop" | "tuning">("workshop");
  const mobileIdx = MOBILE_PANELS.indexOf(mobileTab);
  // Step the sheet by ±1, clamped to the ends (a 2-page pager).
  const stepMobile = useCallback((dir: 1 | -1) => {
    setMobileTab((cur) => {
      const next = MOBILE_PANELS.indexOf(cur) + dir;
      return MOBILE_PANELS[Math.min(MOBILE_PANELS.length - 1, Math.max(0, next))];
    });
  }, []);
  // Horizontal swipe on the sheet → step. Ignores mostly-vertical drags so it
  // doesn't fight the panel's own scrolling.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onSheetTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onSheetTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const s = swipeStart.current;
      swipeStart.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      stepMobile(dx < 0 ? 1 : -1); // swipe left → next, right → prev
    },
    [stepMobile],
  );
  const [knobs, setKnobs] = useState<Knobs>(DEFAULT_KNOBS);
  const [fabricId, setFabricId] = useState<FabricId>("myeongju");
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([]);
  const [presets, setPresets] = useState<MaterialPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  // Id of the material currently on the loom — the key its params autosave
  // under. A canonical material's id is its hash; a clone's id is its own slug.
  // null = nothing selected yet.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Last material signature loaded or saved. Keeping this in state makes the
  // autosave gate explicit and lets React sequence updates with material
  // selection instead of sharing mutable state across memoized callbacks.
  const [autosaveBaseline, setAutosaveBaseline] = useState<{
    id: string | null;
    sig: string;
  }>({ id: null, sig: "" });
  // The maps hash for the active material (a clone's differs from its id).
  const activePkgHashRef = useRef<string | null>(null);
  // User-defined order of the library section, by item id. Persists to
  // localStorage so drag-reordering sticks and nothing shuffles on its own.
  const [libraryOrder, setLibraryOrder] = useState<string[]>([]);
  // Cross-grid drag state (samples → library clone drags share it).
  const drag = useSwatchDrag();
  // Built-in sample materials (baked patina bundles under samples/).
  const [samples, setSamples] = useState<CacheEntry[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ w: 900, h: 700 });
  const [perfStats, setPerfStats] = useState<ClothStats | null>(null);
  // Hysteresis bookkeeping for auto-quality (timestamps, ms).
  const autoQualRef = useRef({ lowSince: 0, highSince: 0, lastStep: 0 });

  // Live mirrors of fast-changing state, so callbacks that only *read* these
  // at call time (clone, export) don't have to list them as deps — that keeps
  // the callbacks referentially stable and the memoized panels skipping
  // re-renders during slider drags.
  const knobsRef = useRef(knobs);
  const fabricIdRef = useRef(fabricId);
  const metalnessInputRef = useRef(metalnessInput);

  useEffect(() => {
    knobsRef.current = knobs;
    fabricIdRef.current = fabricId;
    metalnessInputRef.current = metalnessInput;
  }, [knobs, fabricId, metalnessInput]);

  // Apply a material's saved params (fabric + knobs + metalness) and arm the
  // autosave baseline at that signature so restoring doesn't rewrite the file.
  const applyParams = useCallback((preset: MaterialPreset) => {
    setFabricId(preset.fabricId);
    // Scene knobs (quality/mesh/sky/pins) are viewing prefs — never restored.
    setKnobs((current) => ({ ...current, ...preset.knobs }));
    setMetalnessInput(preset.metalness > 0 ? String(preset.metalness) : "");
    setAutosaveBaseline({
      id: preset.slug,
      sig: paramSig(preset.fabricId, preset.metalness, preset.knobs),
    });
  }, []);

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
        };
        const initial = pkgFromMaps("silk-sample", PREGEN_BASE, manifest.maps, {
          prompt: manifest.prompt,
          sourceFilename: manifest.sourceFilename,
          hash: manifest.hash,
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
  const refreshCache = useCallback(async () => {
    try {
      const r = await fetch("/api/cache", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { entries: CacheEntry[] };
      setCacheEntries(data.entries);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshCache();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCache]);

  // ── stage measure ──────────────────────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      // Keep it a wide 4:3-ish stage that snaps to the container size.
      const w = Math.max(320, Math.round(rect.width));
      const h = Math.max(240, Math.round(rect.height));
      setStageSize({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // ── run a fresh extraction ─────────────────────────────────────────────
  const runBaseline = useCallback(
    async (front: File | Blob, name: string) => {
      setStatus({ kind: "loading", message: "extracting patina maps…" });
      try {
        const result = await runPatinaBaseline(front, {
          fabricName: name,
          prompt,
        });
        setPkg(result.pkg);
        setStatus({
          kind: "done",
          cacheHit: result.cacheHit,
          hash: result.hash,
        });
        activePkgHashRef.current = result.hash;
        setActiveId(result.hash);
        void refreshCache();
        // Canonical params for a material use slug === hash.
        const saved = presets.find((preset) => preset.slug === result.hash);
        if (result.cacheHit && saved) {
          // Re-extracting a material we've already tuned — restore its params
          // rather than overwriting them with defaults.
          applyParams(saved);
        } else {
          // Fresh maps (or a cache hit we've never tuned): auto-tune off the
          // maps and let autosave persist that as the material's first preset.
          // Arm the baseline empty so the estimate writes once it settles.
          setAutosaveBaseline({ id: result.hash, sig: "" });
          try {
            const { estimateParams } = await import(
              "@/lib/pipeline/estimateParams"
            );
            const est = await estimateParams(result.pkg);
            setKnobs((k) => ({ ...k, ...est.knobs }));
            if (est.metalness > 0) {
              setMetalnessInput(String(est.metalness.toFixed(2)));
            }
          } catch {
            // estimation is a nicety — never let it break the extraction
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message: msg });
      }
    },
    [applyParams, presets, prompt, refreshCache],
  );

  // Stage a dropped/selected photo without running anything. The user reviews
  // the prompt + metalness, then presses submit.
  const stageFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const front = files[0];
    setStagedFile({ file: front, name: front.name.replace(/\.[^.]+$/, "") });
    setStatus((s) => (s.kind === "error" ? { kind: "idle" } : s));
  }, []);

  const submit = useCallback(() => {
    if (!stagedFile || status.kind === "loading") return;
    runBaseline(stagedFile.file, stagedFile.name);
  }, [stagedFile, status.kind, runBaseline]);

  const loadCachedEntry = useCallback((entry: CacheEntry) => {
    const name = entry.sourceFilename?.replace(/\.[^.]+$/, "") ?? "cached";
    const p = pkgFromMaps(name, "", entry.maps, {
      prompt: entry.prompt,
      sourceFilename: entry.sourceFilename,
      hash: entry.hash,
    });
    // For cached entries the map.url is already the full path.
    for (const m of entry.maps) {
      const key = m.name as MapName;
      if (p.maps[key]) p.maps[key]!.url = m.url;
    }
    setPkg(p);
    setStatus({ kind: "done", cacheHit: true, hash: entry.hash });
  }, []);

  // ── cache deletion (two-stage arm → confirm) ───────────────────────────
  const deleteCachedEntry = useCallback(
    async (entry: CacheEntry) => {
      try {
        const r = await fetch(`/api/cache/${entry.hash}`, { method: "DELETE" });
        if (!r.ok) return;
        // If the deleted run is what's on the loom, drop back to the base
        // fabric rather than leaving map URLs that will 404.
        setPkg((cur) => (cur?.id === entry.hash ? null : cur));
        void refreshCache();
      } catch {
        // network hiccup — leave the row; user can retry
      }
    },
    [refreshCache],
  );

  // ── material presets ───────────────────────────────────────────────────
  const refreshPresets = useCallback(async () => {
    try {
      const r = await fetch("/api/presets", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { presets: MaterialPreset[] };
      setPresets(data.presets);
    } catch {
      // ignore
    } finally {
      setPresetsLoaded(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshPresets();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshPresets]);

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
            maps: s.maps,
          })),
        );
      } catch {
        // no samples — fine
      }
    })();
  }, []);

  // ── library order persists to localStorage (a view preference, not a
  //    material) so drag-reordering sticks across reloads. ──────────────────
  const orderLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let savedOrder: string[] | null = null;
    try {
      const raw = localStorage.getItem("loom.libraryOrder");
      if (raw) savedOrder = JSON.parse(raw) as string[];
    } catch {
      // corrupt/absent — start unordered (falls back to createdAt)
    }
    queueMicrotask(() => {
      if (cancelled) return;
      if (savedOrder) setLibraryOrder(savedOrder);
      orderLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!orderLoadedRef.current) return; // don't clobber before the load runs
    try {
      localStorage.setItem("loom.libraryOrder", JSON.stringify(libraryOrder));
    } catch {
      // storage disabled — non-fatal
    }
  }, [libraryOrder]);

  // ── performance prefs persist to localStorage (device, not material) ────
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
  ]);

  // ── auto quality: step frag-res to hold frame rate (rendering only) ─────
  useEffect(() => {
    if (!knobs.autoQuality || !perfStats) return;
    const order = ["lo", "mid", "hi"] as const;
    const idx = order.indexOf(knobs.quality);
    const now = Date.now();
    const st = autoQualRef.current;
    const canStep = now - st.lastStep > 10_000; // ≤ one step / 10s
    if (perfStats.fps < 45) {
      st.highSince = 0;
      if (!st.lowSince) st.lowSince = now;
      else if (now - st.lowSince > 3_000 && canStep && idx > 0) {
        setKnobs((k) => ({ ...k, quality: order[idx - 1] }));
        st.lastStep = now;
        st.lowSince = 0;
      }
    } else if (perfStats.fps > 58) {
      st.lowSince = 0;
      if (!st.highSince) st.highSince = now;
      else if (now - st.highSince > 10_000 && canStep && idx < 2) {
        setKnobs((k) => ({ ...k, quality: order[idx + 1] }));
        st.lastStep = now;
        st.highSince = 0;
      }
    } else {
      st.lowSince = 0;
      st.highSince = 0;
    }
  }, [perfStats, knobs.autoQuality, knobs.quality]);

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
          };
          if (current() && m.hash === hash) {
            const pk = pkgFromMaps("silk-sample", PREGEN_BASE, m.maps, {
              prompt: m.prompt,
              sourceFilename: m.sourceFilename,
              hash: m.hash,
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
  const seedParamsFromEntry = useCallback(async (entry: CacheEntry) => {
    try {
      const p = pkgFromMaps(
        entry.sourceFilename ?? "material",
        "",
        entry.maps,
        {
          prompt: entry.prompt,
          sourceFilename: entry.sourceFilename,
          hash: entry.hash,
        },
      );
      for (const m of entry.maps) {
        const key = m.name as MapName;
        if (p.maps[key]) p.maps[key]!.url = m.url;
      }
      const { estimateParams } = await import("@/lib/pipeline/estimateParams");
      const est = await estimateParams(p);
      setKnobs((k) => ({ ...k, ...est.knobs }));
      if (est.metalness > 0) setMetalnessInput(String(est.metalness.toFixed(2)));
    } catch {
      // estimation is a nicety — leave defaults if it fails
    }
  }, []);

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
    ) => {
      try {
        const r = await fetch("/api/presets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: id, name, fabricId, pkgHash, metalness, knobs }),
        });
        if (!r.ok) return;
        const { preset } = (await r.json()) as { preset: MaterialPreset };
        setPresets((cur) => {
          const rest = cur.filter((p) => p.slug !== id);
          return [...rest, preset].sort((a, b) =>
            a.createdAt < b.createdAt ? -1 : 1,
          );
        });
      } catch {
        // network hiccup — the next edit will retry
      }
    },
    [],
  );

  // Select a material into the loom: load its maps, then either restore its
  // saved params or seed+persist fresh ones. Sets it as the autosave target.
  const selectMaterial = useCallback(
    (item: LibraryItem) => {
      activePkgHashRef.current = item.pkgHash;
      setActiveId(item.id);
      if (item.entry) loadCachedEntry(item.entry);
      else void resolveMapsForHash(item.pkgHash);
      if (item.preset) {
        applyParams(item.preset);
      } else if (item.entry) {
        // Arm the baseline empty so the seeded params write once they settle.
        setAutosaveBaseline({ id: item.id, sig: "" });
        void seedParamsFromEntry(item.entry);
      }
    },
    [loadCachedEntry, resolveMapsForHash, applyParams, seedParamsFromEntry],
  );

  // ── autosave: persist the active material's params as knobs change ───────
  // Debounced ~1s after the last edit. The baseline gate (id + signature) means
  // this fires only for real material-param drift on the armed material —
  // scene-knob drags and the initial restore of saved params write nothing.
  useEffect(() => {
    if (!activeId) return;
    if (autosaveBaseline.id !== activeId) return; // not armed/hydrated yet
    const metal = Math.min(1, Math.max(0, parseFloat(metalnessInput) || 0));
    const fk = fabricKnobsOf(knobs);
    const sig = paramSig(fabricId, metal, fk);
    if (sig === autosaveBaseline.sig) return; // nothing material changed
    const pkgHash = activePkgHashRef.current ?? activeId;
    const t = setTimeout(() => {
      setAutosaveBaseline({ id: activeId, sig });
      void postParams(activeId, pkgHash, labelForId(activeId), fabricId, metal, fk);
    }, 1000);
    return () => clearTimeout(t);
  }, [
    knobs,
    metalnessInput,
    fabricId,
    activeId,
    autosaveBaseline,
    labelForId,
    postParams,
  ]);

  // ── boot hydration: once the material and its presets are both loaded, apply
  //    the saved params for whatever's on the loom (pregen → red silk). Runs
  //    once; arms autosave without writing.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    if (!activeId || !presetsLoaded) return;
    const preset = presets.find((candidate) => candidate.slug === activeId);
    const metal = Math.min(1, Math.max(0, parseFloat(metalnessInput) || 0));
    const baseline = {
      id: activeId,
      sig: paramSig(fabricId, metal, fabricKnobsOf(knobs)),
    };
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || bootedRef.current) return;
      bootedRef.current = true;
      if (preset) applyParams(preset);
      else setAutosaveBaseline(baseline);
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeId,
    presets,
    presetsLoaded,
    applyParams,
    fabricId,
    metalnessInput,
    knobs,
  ]);

  // Remove a library material: its params file, plus the cache run behind it
  // when it's a user extraction. Clones drop their own file only; built-in
  // samples aren't deletable.
  const deleteLibraryItem = useCallback(
    async (item: LibraryItem) => {
      if (!item.clone && item.entry && item.pkgHash === item.id) {
        // A user cache run (not a clone, canonical id) — remove the extraction.
        await deleteCachedEntry(item.entry);
      }
      try {
        await fetch(`/api/presets?slug=${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        });
      } catch {
        // ignore
      }
      setPresets((cur) => cur.filter((p) => p.slug !== item.id));
      setLibraryOrder((cur) => cur.filter((id) => id !== item.id));
      if (activeId === item.id) setActiveId(null);
    },
    [deleteCachedEntry, activeId],
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
      const metal =
        src?.metalness ??
        Math.min(1, Math.max(0, parseFloat(metalnessInputRef.current) || 0));
      const knobsToClone = src?.knobs ?? fabricKnobsOf(knobsRef.current);
      const name = `${item.label} copy`;
      await postParams(slug, item.pkgHash, name, fId, metal, knobsToClone);
      // Drop the clone in right after its source in the library order.
      setLibraryOrder((cur) => {
        const next = cur.filter((id) => id !== slug);
        const at = next.indexOf(item.id);
        if (at === -1) next.push(slug);
        else next.splice(at + 1, 0, slug);
        return next;
      });
    },
    [postParams],
  );

  // ── reorder: drag a grip → move an item before another in the library.
  const reorderLibrary = useCallback((dragId: string, beforeId: string) => {
    if (dragId === beforeId) return;
    setLibraryOrder((cur) => {
      const next = cur.filter((id) => id !== dragId);
      const at = next.indexOf(beforeId);
      if (at === -1) next.push(dragId);
      else next.splice(at, 0, dragId);
      return next;
    });
  }, []);

  const fabric = useMemo(
    () => fabricFromPkg(pkg, knobs, fabricId),
    [pkg, knobs, fabricId],
  );

  // The openness slider is intentionally exponential: linear drag on the
  // range input rises as t³, so dense fabrics get most of the slider's
  // travel (fine control at the opaque end) while a small push near the top
  // takes you the rest of the way to organza-sheer. Applied at the boundary
  // so `knobs.openness` remains the raw slider position; ClothScene and
  // ObjectViewer only ever see the curved value.
  const opennessCurved = Math.pow(knobs.openness, 3);

  // Empty field → 0 (non-metallic). Clamp so stray input can't push the shader
  // past a physical 0..1 metalness.
  const metalness = Math.min(1, Math.max(0, parseFloat(metalnessInput) || 0));

  const mapEntries = useMemo<MapEntry[]>(() => {
    if (!pkg) return [];
    return MAP_ORDER.map((n) => pkg.maps[n]).filter((e): e is MapEntry => Boolean(e));
  }, [pkg]);

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
      if (sampleByHash.has(e.hash)) continue;
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

  // Keep libraryOrder in sync with the actual item set: append new ids at the
  // end (natural order) and drop ones that vanished, so the saved order is
  // authoritative and a fresh clone stays put instead of jumping to the top.
  useEffect(() => {
    if (!orderLoadedRef.current) return;
    const ids = libraryItems.map((i) => i.id);
    setLibraryOrder((cur) => {
      const kept = cur.filter((id) => ids.includes(id));
      const missing = ids.filter((id) => !kept.includes(id));
      if (missing.length === 0 && kept.length === cur.length) return cur;
      return [...kept, ...missing];
    });
  }, [libraryItems]);

  // ── material export (zip: PBR maps + ORM + glb + json + README) ─────────
  // Live knob/metalness values are read through refs at click time so the
  // callback stays stable and the memoized MapsStrip skips knob-drag renders.
  const [exportState, setExportState] = useState<ExportState>("idle");
  const handleExport = useCallback(async () => {
    if (!pkg || exportState === "working") return;
    setExportState("working");
    try {
      const { exportMaterial } = await import("@/lib/export/materialExport");
      const k = knobsRef.current;
      const fId = fabricIdRef.current;
      const metal = Math.min(
        1,
        Math.max(0, parseFloat(metalnessInputRef.current) || 0),
      );
      await exportMaterial({
        name: pkg.meta.fabricName || FABRICS[fId].nameRoman,
        pkg,
        knobs: fabricKnobsOf(k),
        metalness: metal,
        openness: Math.pow(k.openness, 3),
        fabric: FABRICS[fId],
      });
      setExportState("idle");
    } catch (e) {
      console.error("material export failed", e);
      setExportState("error");
    }
  }, [pkg, exportState]);

  // ── id → item adapters for the swatch grids (their callbacks report ids;
  //    the page resolves them back to rich LibraryItems). ───────────────────
  const selectById = useCallback(
    (id: string) => {
      const item =
        sampleItems.find((i) => i.id === id) ??
        libraryItems.find((i) => i.id === id);
      if (item) selectMaterial(item);
    },
    [sampleItems, libraryItems, selectMaterial],
  );
  const cloneById = useCallback(
    (id: string) => {
      const item =
        sampleItems.find((i) => i.id === id) ??
        libraryItems.find((i) => i.id === id);
      if (item) void cloneItem(item);
    },
    [sampleItems, libraryItems, cloneItem],
  );
  const deleteById = useCallback(
    (id: string) => {
      const item = libraryItems.find((i) => i.id === id);
      if (item) void deleteLibraryItem(item);
    },
    [libraryItems, deleteLibraryItem],
  );

  return (
    <div className="app">
      <NavBar mode={mode} onMode={setMode} status={status} />

      {/* Mobile-only bottom-sheet header: names the active editor and steps
          between them with ‹ ›. Hidden on desktop (both panels always show). */}
      <div className="mobile-nav" aria-label="editor navigation">
        <span className="mobile-nav-title">{mobileTab}</span>
        <button
          type="button"
          className="mobile-nav-btn"
          aria-label="previous editor"
          disabled={mobileIdx === 0}
          onClick={() => stepMobile(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="mobile-nav-btn"
          aria-label="next editor"
          disabled={mobileIdx === MOBILE_PANELS.length - 1}
          onClick={() => stepMobile(1)}
        >
          ›
        </button>
      </div>

      <div className="stage" ref={stageRef}>
        {/* One persistent scene. `mode` cross-fades the cloth and the object
            in place — no teardown, no remount. */}
        <ClothScene
          fabric={fabric}
          width={stageSize.w}
          height={stageSize.h}
          mode={mode}
          pkg={pkg}
          objectModelUrl={OBJECT_MODEL_URL}
          objectTileScale={knobs.tileScale * 5}
          wireframe={knobs.wireframe}
          pinMode={knobs.pinMode}
          openness={opennessCurved}
          alphaBoost={knobs.alphaBoost}
          alphaBoostSource={knobs.alphaBoostSource}
          roughnessMapURL={pkg?.maps.roughness?.url}
          porosityMapURL={pkg?.maps.transmission?.url}
          metalness={metalness}
          metalnessMapURL={pkg?.maps.metalness?.url}
          normalMapURL={pkg?.maps.normal?.url}
          normalAmount={knobs.normalAmount}
          pomShadow={knobs.pomShadow}
          stretch={knobs.stretch}
          stretchDebug={knobs.stretchDebug}
          albedoAmount={knobs.albedoAmount}
          pomScale={knobs.pomScale}
          pomMinSteps={knobs.pomMinSteps}
          pomMaxSteps={knobs.pomMaxSteps}
          pomDebug={knobs.pomDebug}
          edgeInset={knobs.edgeInset}
          edgeFray={knobs.edgeFray}
          edgeSharpness={knobs.edgeSharpness}
          edgeDetail={knobs.edgeDetail}
          tileScale={knobs.tileScale}
          txHeight={knobs.txHeight}
          txAlbedo={knobs.txAlbedo}
          txRoughness={knobs.txRoughness}
          transmissionContrast={knobs.transmissionContrast}
          pixelScale={QUALITY_PRESETS[knobs.quality].pixelScale}
          meshCols={MESH_PRESETS[knobs.meshRes].cols}
          meshRows={MESH_PRESETS[knobs.meshRes].rows}
          breeze={knobs.breeze}
          skyMode={knobs.skyMode === "sky" ? 0 : 1}
          iterations={knobs.iterations}
          selfCollide={knobs.selfCollide}
          anisotropy={knobs.anisotropy}
          onStats={setPerfStats}
        />
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

      {/* ─── LEFT PANEL: workshop (insert · past · maps) ─────────────── */}
      <aside
        className="side-panel side-panel-left glass"
        data-collapsed={leftCollapsed}
        data-mshow={mobileTab === "workshop"}
        onTouchStart={onSheetTouchStart}
        onTouchEnd={onSheetTouchEnd}
        aria-label="workshop"
      >
        <PanelHeader
          title="workshop"
          side="left"
          collapsed={leftCollapsed}
          onToggle={() => setLeftCollapsed((v) => !v)}
        />
        <div className="side-panel-scroll">
          <MapsStrip
            entries={mapEntries}
            exportState={exportState}
            canExport={Boolean(pkg)}
            onExport={handleExport}
          />
          <InsertPanel
            stagedName={stagedFile?.name ?? null}
            onFiles={stageFiles}
            prompt={prompt}
            onPrompt={setPrompt}
            metalness={metalnessInput}
            onMetalness={setMetalnessInput}
            onSubmit={submit}
            busy={status.kind === "loading"}
            error={status.kind === "error" ? status.message : null}
          />

          <SampleGrid
            items={sampleItems}
            activeId={activeId}
            drag={drag}
            onSelect={selectById}
          />
          <LibraryGrid
            items={libraryItems}
            activeId={activeId}
            drag={drag}
            onSelect={selectById}
            onClone={cloneById}
            onReorder={reorderLibrary}
            onDelete={deleteById}
          />
        </div>
      </aside>

      {/* ─── RIGHT PANEL: tuning (knobs) ─────────────────────────────── */}
      {/* No `glass` here — the tuning panel is chromeless, its knobs floating
          straight over the stage. */}
      <aside
        className="side-panel side-panel-right"
        data-collapsed={rightCollapsed}
        data-mshow={mobileTab === "tuning"}
        onTouchStart={onSheetTouchStart}
        onTouchEnd={onSheetTouchEnd}
        aria-label="tuning"
      >
        <PanelHeader
          title="tuning"
          side="right"
          collapsed={rightCollapsed}
          onToggle={() => setRightCollapsed((v) => !v)}
        />
        <div className="side-panel-scroll">
          <section className="panel-section" data-dye="gardenia">
            <SectionLabel>frag res</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay />
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
                  aria-selected={knobs.quality === opt.v}
                  className="tx-mode-tab"
                  data-active={knobs.quality === opt.v}
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

          <section className="panel-section" data-dye="persimmon">
            <SectionLabel>mesh res</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay />
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
                  aria-selected={knobs.meshRes === opt.v}
                  className="tx-mode-tab"
                  data-active={knobs.meshRes === opt.v}
                  onClick={() =>
                    setKnobs((k) => ({ ...k, meshRes: opt.v }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section" data-dye="mugwort">
            <SectionLabel>sky</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay />
              {(
                [
                  { v: "sky" as const, label: "sky" },
                  { v: "black" as const, label: "black" },
                ]
              ).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  role="tab"
                  aria-selected={knobs.skyMode === opt.v}
                  className="tx-mode-tab"
                  data-active={knobs.skyMode === opt.v}
                  onClick={() =>
                    setKnobs((k) => ({ ...k, skyMode: opt.v }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="panel-section" data-dye="indigo">
            <SectionLabel>transmission</SectionLabel>
            {/* Independent per-map weights: each map's pull on where the cloth
                goes sheer. Any can be zeroed out; they blend by relative
                weight. All three at 0 → opaque. */}
            <Slider
              label="from height"
              value={knobs.txHeight}
              onChange={(v) => setKnobs((k) => ({ ...k, txHeight: v }))}
            />
            <Slider
              label="from albedo"
              value={knobs.txAlbedo}
              onChange={(v) => setKnobs((k) => ({ ...k, txAlbedo: v }))}
            />
            <Slider
              label="from roughness"
              value={knobs.txRoughness}
              onChange={(v) => setKnobs((k) => ({ ...k, txRoughness: v }))}
            />
            <Slider
              label="contrast"
              value={knobs.transmissionContrast}
              onChange={(v) =>
                setKnobs((k) => ({ ...k, transmissionContrast: v }))
              }
            />
          </section>

          <section className="panel-section" data-dye="madder">
            <SectionLabel>material</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="weight"
                value={knobs.weight}
                min={0.2}
                max={3}
                step={0.05}
                onChange={(v) => setKnobs((k) => ({ ...k, weight: v }))}
              />
              <Slider
                label="breeze"
                value={knobs.breeze}
                min={0}
                max={0.25}
                step={0.005}
                onChange={(v) => setKnobs((k) => ({ ...k, breeze: v }))}
              />
              <Slider
                label="sheen"
                value={knobs.sheen}
                onChange={(v) => setKnobs((k) => ({ ...k, sheen: v }))}
              />
              <Slider
                label="openness"
                value={knobs.openness}
                onChange={(v) => setKnobs((k) => ({ ...k, openness: v }))}
              />
              <Slider
                label="α boost"
                value={knobs.alphaBoost}
                min={0}
                max={0.5}
                step={0.005}
                onChange={(v) => setKnobs((k) => ({ ...k, alphaBoost: v }))}
              />
              {/* Which map the boost wears thin along. Dark regions of the
                  chosen map go threadbare; height preserves the original
                  weave-valley behavior. */}
              <div
                className="tx-mode-picker tx-mode-picker-wide"
                role="tablist"
                aria-label="α boost source"
              >
                <PixelPlay />
                {(
                  [
                    { v: 0 as const, label: "height" },
                    { v: 1 as const, label: "albedo" },
                    { v: 2 as const, label: "rough" },
                    { v: 3 as const, label: "metal" },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    role="tab"
                    aria-selected={knobs.alphaBoostSource === opt.v}
                    className="tx-mode-tab"
                    data-active={knobs.alphaBoostSource === opt.v}
                    onClick={() =>
                      setKnobs((k) => ({ ...k, alphaBoostSource: opt.v }))
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <Slider
                label="albedo mix"
                value={knobs.albedoAmount}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, albedoAmount: v }))
                }
              />
              <Slider
                label="tile ×"
                value={knobs.tileScale}
                min={0.5}
                max={16}
                step={0.25}
                onChange={(v) => setKnobs((k) => ({ ...k, tileScale: v }))}
              />
            </div>
          </section>

          <section className="panel-section" data-dye="mugwort">
            <SectionLabel>weave</SectionLabel>
            {/* Weave-structure picker — an interlacing diagram per fabric,
                name as caption. This chooses the cloth's motion DNA (damping,
                wind response, crease memory, base mass); the sliders below
                tune the structural stiffnesses on top of it. */}
            <div className="weave-picker" role="radiogroup" aria-label="weave">
              {/* one pixel roams the whole grid, orbiting the chosen weave */}
              <PixelPlay layer="over" pixel={4} />
              {FABRIC_ORDER.map((id) => {
                const f = FABRICS[id];
                const d = WEAVE_DIAGRAM_PARAMS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={fabricId === id}
                    className="weave-tile"
                    data-active={fabricId === id}
                    title={`${f.nameKo} · ${f.nameEn}`}
                    onClick={() => setFabricId(id)}
                  >
                    <WeaveDiagram
                      type={f.core.weaveType}
                      threads={d.threads}
                      yarn={d.yarn}
                    />
                    <span className="weave-tile-caption">{f.nameRoman}</span>
                  </button>
                );
              })}
            </div>
            <div className="knob-stack">
              <Slider
                label="warp"
                value={knobs.warpStiffness}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, warpStiffness: v }))
                }
              />
              <Slider
                label="weft"
                value={knobs.weftStiffness}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, weftStiffness: v }))
                }
              />
              <Slider
                label="shear"
                value={knobs.shearStiffness}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, shearStiffness: v }))
                }
              />
              <Slider
                label="bend"
                value={knobs.bendStiffness}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, bendStiffness: v }))
                }
              />
            </div>
          </section>

          <section className="panel-section" data-dye="persimmon">
            <SectionLabel>parallax</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="pom depth"
                value={knobs.pomScale}
                min={0}
                max={0.08}
                step={0.001}
                onChange={(v) => setKnobs((k) => ({ ...k, pomScale: v }))}
              />
              <IntSlider
                label="pom min"
                value={knobs.pomMinSteps}
                min={2}
                max={32}
                onChange={(v) => setKnobs((k) => ({ ...k, pomMinSteps: v }))}
              />
              <IntSlider
                label="pom max"
                value={knobs.pomMaxSteps}
                min={8}
                max={64}
                onChange={(v) => setKnobs((k) => ({ ...k, pomMaxSteps: v }))}
              />
              <Slider
                label="micro nrm"
                value={knobs.normalAmount}
                onChange={(v) => setKnobs((k) => ({ ...k, normalAmount: v }))}
              />
              <Slider
                label="self shadow"
                value={knobs.pomShadow}
                onChange={(v) => setKnobs((k) => ({ ...k, pomShadow: v }))}
              />
              <Slider
                label="stretch"
                value={knobs.stretch}
                onChange={(v) => setKnobs((k) => ({ ...k, stretch: v }))}
              />
            </div>
          </section>

          <section className="panel-section" data-dye="gardenia">
            <SectionLabel>edge</SectionLabel>
            <div className="knob-stack">
              <Slider
                label="inset"
                value={knobs.edgeInset}
                min={0}
                max={0.15}
                step={0.005}
                onChange={(v) => setKnobs((k) => ({ ...k, edgeInset: v }))}
              />
              <Slider
                label="fray"
                value={knobs.edgeFray}
                onChange={(v) => setKnobs((k) => ({ ...k, edgeFray: v }))}
              />
              <Slider
                label="crispness"
                value={knobs.edgeSharpness}
                onChange={(v) =>
                  setKnobs((k) => ({ ...k, edgeSharpness: v }))
                }
              />
              <Slider
                label="detail"
                value={knobs.edgeDetail}
                min={1}
                max={8}
                step={0.25}
                onChange={(v) => setKnobs((k) => ({ ...k, edgeDetail: v }))}
              />
            </div>
          </section>

          <section className="panel-section" data-dye="indigo">
            <SectionLabel>modes</SectionLabel>
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

          <section className="panel-section" data-dye="madder">
            <SectionLabel>performance</SectionLabel>
            {/* Live meters (2 Hz) — this device, not the material. */}
            <div className="perf-meters" role="status" aria-live="off">
              <span className="perf-meter">
                <span className="perf-meter-val" data-warn={!!perfStats && perfStats.fps < 40}>
                  {perfStats ? Math.round(perfStats.fps) : "—"}
                </span>
                <span className="perf-meter-unit">fps</span>
              </span>
              <span className="perf-meter">
                <span className="perf-meter-val">
                  {perfStats ? perfStats.simMs.toFixed(1) : "—"}
                </span>
                <span className="perf-meter-unit">sim ms</span>
              </span>
              <span className="perf-meter">
                <span className="perf-meter-val">
                  {perfStats ? `${Math.round(perfStats.tris / 1000)}k` : "—"}
                </span>
                <span className="perf-meter-unit">tris</span>
              </span>
              <span className="perf-meter">
                <span className="perf-meter-val">
                  {perfStats ? perfStats.calls : "—"}
                </span>
                <span className="perf-meter-unit">calls</span>
              </span>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-toggle perf-auto"
              data-pressed={knobs.autoQuality}
              onClick={() =>
                setKnobs((k) => ({ ...k, autoQuality: !k.autoQuality }))
              }
              title="auto-lower frag res when the frame rate sags (rendering only — never the sim)"
            >
              auto quality {knobs.autoQuality ? "on" : "off"}
            </button>

            <div className="knob-stack">
              <IntSlider
                label="iterations"
                value={knobs.iterations}
                min={2}
                max={8}
                onChange={(v) => setKnobs((k) => ({ ...k, iterations: v }))}
              />
            </div>

            <SectionLabel>self-collide</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay />
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
                  aria-selected={knobs.selfCollide === opt.v}
                  className="tx-mode-tab"
                  data-active={knobs.selfCollide === opt.v}
                  onClick={() =>
                    setKnobs((k) => ({ ...k, selfCollide: opt.v }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <SectionLabel>anisotropy</SectionLabel>
            <div className="tx-mode-picker tx-mode-picker-wide" role="tablist">
              <PixelPlay />
              {([2, 4, 8] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={knobs.anisotropy === v}
                  className="tx-mode-tab"
                  data-active={knobs.anisotropy === v}
                  onClick={() => setKnobs((k) => ({ ...k, anisotropy: v }))}
                >
                  {v}×
                </button>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
