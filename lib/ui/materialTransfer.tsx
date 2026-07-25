"use client";

import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { stampMaskImage } from "@/lib/ui/stampMask";

const GRID = 64;
const BOX_SCREEN_MS = 240;
const SCREEN_MESH_MS = 260;

type Rect = { x: number; y: number; w: number; h: number };
// box-screen: swatch flies to the stage (hover preview + click incoming).
// screen-box: it flies home (hover release).
// screen-mesh: canvas cells vanish while the same cells reveal on the mesh.
// (The outgoing fabric never rides the canvas — it dissolves on the mesh
// itself, so there is no mesh-screen phase.)
type Phase = "box-screen" | "screen-box" | "screen-mesh";

interface Source {
  id: string;
  image: HTMLImageElement;
}

export interface MaterialTransferCommand {
  key: number;
  source: Source;
  box: Rect;
  screen: Rect;
  phase: Phase;
  duration: number;
  reveal: MutableRefObject<number>;
  onComplete: () => void;
}

type Intent =
  | { kind: "hover"; id: string }
  | { kind: "click"; id: string }
  | {
      kind: "swap";
      /** Applies the material-affecting state changes while the mesh is fully
       *  dissolved. Runs inside the serialized pump, so it can never race
       *  another transition. */
      commit: () => void;
      /** Albedo URL whose load gates the reveal-in. Omitted → the scene falls
       *  back to matching the resolved fabric's own albedo URL. */
      expectedAlbedoURL?: string;
      /** New mesh owner id once the swap lands; `undefined` leaves ownership
       *  untouched (e.g. weave changes), `null` clears it (deletion). */
      ownerAfter?: string | null;
    };

const isCommitting = (i: Intent | null) =>
  i?.kind === "click" || i?.kind === "swap";

const CELL_NOISE = new Float32Array(GRID * GRID);
for (let y = 0; y < GRID; y++) {
  for (let x = 0; x < GRID; x++) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    CELL_NOISE[y * GRID + x] = n - Math.floor(n);
  }
}

function coverSrc(nw: number, nh: number, w: number, h: number) {
  const scale = Math.max(w / nw, h / nh);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (nw - sw) / 2, sy: (nh - sh) / 2, sw, sh };
}

function makeImageLayer(
  img: HTMLImageElement,
  rect: Rect,
  dpr: number,
  stamp?: HTMLImageElement | null,
): HTMLCanvasElement {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  const layer = document.createElement("canvas");
  layer.width = Math.max(1, Math.ceil(rect.w * dpr));
  layer.height = Math.max(1, Math.ceil(rect.h * dpr));
  if (!nw || !nh) return layer;
  const ctx = layer.getContext("2d");
  if (!ctx) return layer;
  const cover = coverSrc(nw, nh, rect.w, rect.h);
  ctx.drawImage(
    img,
    cover.sx,
    cover.sy,
    cover.sw,
    cover.sh,
    0,
    0,
    layer.width,
    layer.height,
  );
  // Box-side layers carry the swatch's frayed-stamp silhouette so the mask
  // survives the flight instead of snapping to a plain rectangle mid-air.
  if (stamp) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(stamp, 0, 0, layer.width, layer.height);
    ctx.globalCompositeOperation = "source-over";
  }
  return layer;
}

function makeScratch(source: HTMLCanvasElement): HTMLCanvasElement {
  const scratch = document.createElement("canvas");
  scratch.width = source.width;
  scratch.height = source.height;
  return scratch;
}

function paintMaskedLayer(
  target: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  rect: Rect,
) {
  const ctx = scratch.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mask, 0, 0, scratch.width, scratch.height);
  ctx.globalCompositeOperation = "source-over";
  target.drawImage(scratch, rect.x, rect.y, rect.w, rect.h);
}

/** One viewport canvas for every swatch. A command is deliberately serial:
 *  the coordinator never lets two fabric copies bloom at once. */
export function MaterialTransferLayer({
  command,
}: {
  command: MaterialTransferCommand | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!command || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Both flight endpoints carry the frayed-stamp silhouette: the swatch is
    // a stamp in its grid AND while parked over the stage, so the transfer
    // reads as one object moving rather than a swatch becoming a rectangle.
    const stamp = stampMaskImage();
    const boxSource = makeImageLayer(command.source.image, command.box, dpr, stamp);
    const screenSource = makeImageLayer(
      command.source.image,
      command.screen,
      dpr,
      stamp,
    );
    const boxScratch = makeScratch(boxSource);
    const screenScratch = makeScratch(screenSource);
    const movedMask = document.createElement("canvas");
    const remainingMask = document.createElement("canvas");
    movedMask.width = remainingMask.width = GRID;
    movedMask.height = remainingMask.height = GRID;
    const movedCtx = movedMask.getContext("2d");
    const remainingCtx = remainingMask.getContext("2d");
    if (!movedCtx || !remainingCtx) return;
    const movedPixels = movedCtx.createImageData(GRID, GRID);
    const remainingPixels = remainingCtx.createImageData(GRID, GRID);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? Math.min(120, command.duration) : command.duration;
    let raf = 0;
    let start = 0;

    const draw = (now: number) => {
      if (!start) start = now;
      const raw = Math.min(1, (now - start) / duration);
      // Strong ease-in-out without moving geometry: the pixel frontier starts
      // promptly, then lands softly at the destination.
      const p = raw * raw * (3 - 2 * raw);
      for (let i = 0; i < CELL_NOISE.length; i++) {
        const moved = CELL_NOISE[i] < p;
        movedPixels.data[i * 4 + 3] = moved ? 255 : 0;
        remainingPixels.data[i * 4 + 3] = moved ? 0 : 255;
      }
      movedCtx.putImageData(movedPixels, 0, 0);
      remainingCtx.putImageData(remainingPixels, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (command.phase === "box-screen") {
        paintMaskedLayer(ctx, boxSource, boxScratch, remainingMask, command.box);
        paintMaskedLayer(ctx, screenSource, screenScratch, movedMask, command.screen);
      } else if (command.phase === "screen-box") {
        paintMaskedLayer(ctx, screenSource, screenScratch, remainingMask, command.screen);
        paintMaskedLayer(ctx, boxSource, boxScratch, movedMask, command.box);
      } else {
        paintMaskedLayer(ctx, screenSource, screenScratch, remainingMask, command.screen);
        command.reveal.current = p;
      }

      if (raw < 1) raf = requestAnimationFrame(draw);
      else command.onComplete();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [command]);

  if (!command) return null;
  return createPortal(
    <canvas ref={canvasRef} className="material-transfer-canvas" aria-hidden="true" />,
    document.body,
  );
}

export interface MaterialTransferController {
  command: MaterialTransferCommand | null;
  awayId: string | null;
  meshOwnerId: string | null;
  revealRef: MutableRefObject<number>;
  transitionKey: number;
  expectedAlbedoURL: string;
  register: (id: string, image: HTMLImageElement | null) => void;
  hoverIn: (id: string) => void;
  hoverOut: (id: string) => void;
  click: (id: string) => void;
  /** Mesh-only pixel dissolve for material changes with no swatch to fly
   *  (weave change, Patina completion, deletion): dissolve out → commit →
   *  wait for the maps → dissolve in. Serialized with clicks and hovers. */
  swap: (
    commit: () => void,
    opts?: { expectedAlbedoURL?: string; ownerAfter?: string | null },
  ) => void;
  materialReady: (key: number) => void;
}

/** Serializes hover previews and committed material changes (swatch clicks
 *  AND imageless swaps — weave changes, Patina completions, deletions).
 *  Queue capacity is exactly two: the in-flight intent plus one pending slot.
 *  A new committing intent replaces anything pending; hover can never
 *  displace a committing intent. One transition runs at a time — that is the
 *  no-overlap guarantee. */
export function useMaterialTransfer({
  activeId,
  stageRef,
  commit,
}: {
  activeId: string | null;
  stageRef: RefObject<HTMLElement | null>;
  commit: (id: string) => void;
}): MaterialTransferController {
  const sources = useRef(new Map<string, HTMLImageElement>());
  const revealRef = useRef(1);
  const [command, setCommand] = useState<MaterialTransferCommand | null>(null);
  const [awayId, setAwayId] = useState<string | null>(null);
  const [meshOwnerId, setMeshOwnerId] = useState<string | null>(activeId);
  const [transitionKey, setTransitionKey] = useState(0);
  const [expectedAlbedoURL, setExpectedAlbedoURL] = useState("");
  const ownerRef = useRef<string | null>(activeId);
  const runningRef = useRef(false);
  const currentRef = useRef<Intent | null>(null);
  const pendingRef = useRef<Intent | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const releaseHoverRef = useRef<(() => void) | null>(null);
  // Hover→click handoff: id whose preview was left parked at the stage by
  // runHover so the click can continue from it without a retreat/re-fly.
  const parkedPreviewRef = useRef<string | null>(null);
  const commandKeyRef = useRef(0);
  const transitionKeyRef = useRef(0);
  const readyRef = useRef(new Map<number, () => void>());
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  const register = useCallback((id: string, image: HTMLImageElement | null) => {
    if (image) sources.current.set(id, image);
    else sources.current.delete(id);
  }, []);

  const screenRect = useCallback((): Rect => {
    const r = stageRef.current?.getBoundingClientRect();
    const size = Math.min(360, (r?.width ?? window.innerWidth) * 0.58);
    const cx = r ? r.left + r.width / 2 : window.innerWidth / 2;
    const cy = r ? r.top + r.height / 2 : window.innerHeight / 2;
    return { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
  }, [stageRef]);

  const animate = useCallback(
    (id: string, phase: Phase, duration: number): Promise<void> => {
      const image = sources.current.get(id);
      if (!image) return Promise.resolve();
      const r = image.getBoundingClientRect();
      const box = { x: r.left, y: r.top, w: r.width, h: r.height };
      setAwayId(id);
      return new Promise((resolve) => {
        setCommand({
          key: ++commandKeyRef.current,
          source: { id, image },
          box,
          screen: screenRect(),
          phase,
          duration,
          reveal: revealRef,
          onComplete: resolve,
        });
      });
    },
    [screenRect],
  );

  // Standalone reveal driver for transitions with no canvas fly-layer. Same
  // smoothstep easing and reduced-motion cap as the layer's draw loop; the
  // serial pump guarantees it never runs concurrently with that loop's own
  // revealRef writes.
  const animateReveal = useCallback(
    (to: number, duration: number): Promise<void> =>
      new Promise((resolve) => {
        const from = revealRef.current;
        if (from === to) {
          resolve();
          return;
        }
        const reduced = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const dur = reduced ? Math.min(120, duration) : duration;
        let start = 0;
        const step = (now: number) => {
          if (!start) start = now;
          const raw = Math.min(1, (now - start) / dur);
          const p = raw * raw * (3 - 2 * raw);
          revealRef.current = from + (to - from) * p;
          if (raw < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    [],
  );

  const waitForMaterial = useCallback((key: number) => {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        readyRef.current.delete(key);
        resolve();
      };
      readyRef.current.set(key, finish);
      window.setTimeout(finish, 1200);
    });
  }, []);

  const materialReady = useCallback((key: number) => {
    readyRef.current.get(key)?.();
  }, []);

  const runHover = useCallback(
    async (intent: Extract<Intent, { kind: "hover" }>) => {
      if (intent.id === ownerRef.current || !sources.current.has(intent.id)) return;
      await animate(intent.id, "box-screen", BOX_SCREEN_MS);
      if (hoveredRef.current === intent.id && !pendingRef.current) {
        await new Promise<void>((resolve) => {
          releaseHoverRef.current = resolve;
        });
        releaseHoverRef.current = null;
      }
      // Click handoff: when the very next intent commits this same swatch,
      // leave the preview parked at the stage — runClick continues straight
      // from it (dissolve + reveal) instead of retreating it home and flying
      // it out all over again.
      if (
        pendingRef.current?.kind === "click" &&
        pendingRef.current.id === intent.id
      ) {
        parkedPreviewRef.current = intent.id;
        return;
      }
      await animate(intent.id, "screen-box", BOX_SCREEN_MS);
      setCommand(null);
      setAwayId(null);
    },
    [animate],
  );

  const runClick = useCallback(
    async (intent: Extract<Intent, { kind: "click" }>) => {
      // A parked hover preview (handoff from runHover) is consumed here; a
      // stale one for a different id gets overwritten by the fly below.
      const parked = parkedPreviewRef.current === intent.id;
      parkedPreviewRef.current = null;
      if (intent.id === ownerRef.current) {
        if (parked) {
          // Preview of the already-worn material — nothing to commit; just
          // drop the parked canvas image.
          setCommand(null);
          setAwayId(null);
        }
        return;
      }

      // Two overlapping movements, nothing more: the OLD fabric pixel-
      // dissolves straight off the mesh (no round-trip through the canvas
      // layer) while the NEW fabric's swatch flies from its box toward the
      // cloth — or, after a hover handoff, is already parked there. The fly
      // phase never writes revealRef, so the two can run concurrently
      // without contention.
      ownerRef.current = null;
      setMeshOwnerId(null);
      // A swatch whose thumb never registered (still loading, or failed)
      // must still commit — it just skips the fly and keeps the mesh-only
      // dissolve, gated on the resolved fabric's own albedo.
      const incomingImage = sources.current.get(intent.id) ?? null;
      await Promise.all([
        animateReveal(0, SCREEN_MESH_MS),
        incomingImage && !parked
          ? animate(intent.id, "box-screen", BOX_SCREEN_MS)
          : Promise.resolve(),
      ]);
      const key = ++transitionKeyRef.current;
      setExpectedAlbedoURL(
        incomingImage ? incomingImage.currentSrc || incomingImage.src : "",
      );
      setTransitionKey(key);
      const ready = waitForMaterial(key);
      commitRef.current(intent.id);
      await ready;
      if (incomingImage) {
        // Canvas cells vanish as the same cells appear on the mesh.
        await animate(intent.id, "screen-mesh", SCREEN_MESH_MS);
        revealRef.current = 1;
      } else {
        await animateReveal(1, SCREEN_MESH_MS);
      }
      ownerRef.current = intent.id;
      setMeshOwnerId(intent.id);
      setCommand(null);
      setAwayId(null);
    },
    [animate, animateReveal, waitForMaterial],
  );

  // Imageless material change: dissolve the mesh out, apply the change while
  // fully hidden, reveal once the (possibly unchanged) maps are ready. When
  // nothing actually reloads, the ready ack lands on the next frame and the
  // whole gesture is a tight out-and-in.
  const runSwap = useCallback(
    async (intent: Extract<Intent, { kind: "swap" }>) => {
      // A parked hover preview whose click got replaced by this swap would
      // otherwise linger on the canvas forever — drop it.
      if (parkedPreviewRef.current) {
        parkedPreviewRef.current = null;
        setCommand(null);
        setAwayId(null);
      }
      await animateReveal(0, SCREEN_MESH_MS);
      const key = ++transitionKeyRef.current;
      setExpectedAlbedoURL(intent.expectedAlbedoURL ?? "");
      setTransitionKey(key);
      const ready = waitForMaterial(key);
      intent.commit();
      await ready;
      await animateReveal(1, SCREEN_MESH_MS);
      if (intent.ownerAfter !== undefined) {
        ownerRef.current = intent.ownerAfter;
        setMeshOwnerId(intent.ownerAfter);
      }
    },
    [animateReveal, waitForMaterial],
  );

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (pendingRef.current) {
      const intent = pendingRef.current;
      pendingRef.current = null;
      currentRef.current = intent;
      if (intent.kind === "click") await runClick(intent);
      else if (intent.kind === "swap") await runSwap(intent);
      else await runHover(intent);
      currentRef.current = null;
    }
    runningRef.current = false;
  }, [runClick, runHover, runSwap]);

  const hoverIn = useCallback((id: string) => {
    hoveredRef.current = id;
    if (isCommitting(currentRef.current) || isCommitting(pendingRef.current)) {
      return;
    }
    pendingRef.current = { id, kind: "hover" };
    releaseHoverRef.current?.();
    void pump();
  }, [pump]);

  const hoverOut = useCallback((id: string) => {
    if (hoveredRef.current === id) hoveredRef.current = null;
    if (pendingRef.current?.kind === "hover" && pendingRef.current.id === id) {
      pendingRef.current = null;
    }
    if (currentRef.current?.kind === "hover" && currentRef.current.id === id) {
      releaseHoverRef.current?.();
    }
  }, []);

  const click = useCallback((id: string) => {
    hoveredRef.current = null;
    // A committing intent owns the sole pending slot, replacing a hover or
    // an older committing intent (newest user intent wins).
    pendingRef.current = { id, kind: "click" };
    releaseHoverRef.current?.();
    void pump();
  }, [pump]);

  const swap = useCallback(
    (
      commit: () => void,
      opts?: { expectedAlbedoURL?: string; ownerAfter?: string | null },
    ) => {
      hoveredRef.current = null;
      // Same slot rules as click: newest committing intent wins.
      pendingRef.current = { kind: "swap", commit, ...opts };
      releaseHoverRef.current?.();
      void pump();
    },
    [pump],
  );

  // Non-picker changes (boot hydration, a fresh extraction, deletion) still
  // establish a coherent owner without replaying a transfer.
  useEffect(() => {
    if (runningRef.current || activeId === ownerRef.current) return;
    ownerRef.current = activeId;
    setMeshOwnerId(activeId);
    revealRef.current = 1;
  }, [activeId]);

  return {
    command,
    awayId,
    meshOwnerId,
    revealRef,
    transitionKey,
    expectedAlbedoURL,
    register,
    hoverIn,
    hoverOut,
    click,
    swap,
    materialReady,
  };
}
