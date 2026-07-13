"use client";

// ─── previewBox.tsx ───────────────────────────────────────────────────────────
// A thumbnail that dissolves into an enlarged preview. On hover the small image
// disintegrates into pixel noise — its cells vanish in a random order, leaving
// the original slot as an empty dashed silhouette — while those same cells, in
// the same order, reassemble into a large image in the centre of the screen.
// Pointer-leave runs it in reverse (the centre image dissolves back into the
// slot). Switching between swatches is the same effect: each box owns its own
// PreviewBox, so leaving one dissolves it back as entering the next dissolves
// out — no special cross-component handoff needed.
//
// The dissolve is drawn on one full-viewport <canvas> (portalled to <body> so
// it escapes the panel's clip/scroll): each frame it paints the not-yet-moved
// cells at the slot and the already-moved cells at the centre. The silhouette
// is a separate portalled outline. Everything is anchored in viewport
// coordinates captured at hover, so we dismiss on scroll/resize rather than
// chase a moving slot. Styles: .preview-ghost / .preview-canvas in library.css.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Named preview sizes → longest edge of the centred preview, in px. */
const PREVIEW_SIZES = { small: 200, large: 360 } as const;
export type PreviewSize = keyof typeof PREVIEW_SIZES;

/** Dissolve granularity (GRID × GRID cells) and sweep duration (ms). */
const GRID = 128;
const DURATION = 300;

interface Geom {
  box: { x: number; y: number; w: number; h: number };
  center: { x: number; y: number; w: number; h: number };
}

/** Fisher–Yates shuffle of [0, n) — the shared "pixel order" for a dissolve. */
function shuffledIndices(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Source rect of `img` that maps onto a dest of w×h under object-fit: cover. */
function coverSrc(nw: number, nh: number, w: number, h: number) {
  const scale = Math.max(w / nw, h / nh);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (nw - sw) / 2, sy: (nh - sh) / 2, sw, sh };
}

export interface PreviewBoxProps {
  /** Image to show both small (inline) and enlarged (on hover). */
  src: string;
  alt?: string;
  /** Centred-preview size: "small" (200px) or "large" (360px, default). */
  size?: PreviewSize;
  /** Class for the inline thumbnail <img> (so it inherits swatch/chip sizing). */
  imgClassName?: string;
}

export default function PreviewBox({
  src,
  alt = "",
  size = "large",
  imgClassName,
}: PreviewBoxProps) {
  const px = PREVIEW_SIZES[size];
  const [mounted, setMounted] = useState(false);
  const [overlayGeom, setOverlayGeom] = useState<Geom | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Animation state lives in refs — this is a per-frame canvas loop, not React
  // render state. target: 1 = open, 0 = closed; p: current progress.
  const targetRef = useRef(0);
  const pRef = useRef(0);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const orderRef = useRef<number[]>([]);
  const geomRef = useRef<Geom | null>(null);
  const backstopRef = useRef<number | null>(null);
  const loopRef = useRef<FrameRequestCallback>(() => undefined);

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    lastRef.current = 0;
    if (backstopRef.current !== null) clearTimeout(backstopRef.current);
    backstopRef.current = null;
    pRef.current = 0;
    setMounted(false);
    setOverlayGeom(null);
  }, []);

  // Paint one frame: not-yet-moved cells at the slot, already-moved cells at
  // the centre. Cell order[i] is the i-th to leave the slot AND the i-th to
  // arrive at the centre → identical order in both directions.
  const draw = useCallback(
    (p: number) => {
      const cv = canvasRef.current;
      const img = imgRef.current;
      const g = geomRef.current;
      const order = orderRef.current;
      if (!cv || !img || !g) return;
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const N = order.length;
      const k = Math.floor(p * N);
      const paint = (
        rect: Geom["box"],
        from: number,
        to: number,
      ) => {
        if (to <= from) return;
        const { x, y, w, h } = rect;
        const cover = coverSrc(nw, nh, w, h);
        const cw = w / GRID;
        const ch = h / GRID;
        const csw = cover.sw / GRID;
        const csh = cover.sh / GRID;
        for (let i = from; i < to; i++) {
          const idx = order[i];
          const cx = idx % GRID;
          const cy = (idx / GRID) | 0;
          ctx.drawImage(
            img,
            cover.sx + cx * csw,
            cover.sy + cy * csh,
            csw,
            csh,
            x + cx * cw,
            y + cy * ch,
            cw + 0.7, // slight overlap kills subpixel seams between cells
            ch + 0.7,
          );
        }
      };
      // slot: the cells that haven't moved yet (dissolving out)
      paint(g.box, k, N);
      // centre: the cells that have arrived (assembling in)
      paint(g.center, 0, k);
    },
    [],
  );

  const loop = useCallback(
    (now: number) => {
      const dt = lastRef.current ? now - lastRef.current : 16;
      lastRef.current = now;
      const step = Math.min(dt / DURATION, 1);
      const target = targetRef.current;
      pRef.current =
        target === 1
          ? Math.min(1, pRef.current + step)
          : Math.max(0, pRef.current - step);
      draw(pRef.current);
      const settled =
        (target === 1 && pRef.current >= 1) ||
        (target === 0 && pRef.current <= 0);
      if (settled) {
        rafRef.current = 0;
        lastRef.current = 0;
        if (target === 0) teardown();
        return; // open + settled: idle with the centre image fully assembled
      }
      rafRef.current = requestAnimationFrame(loopRef.current);
    },
    [draw, teardown],
  );

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  const ensureLoop = useCallback(() => {
    if (!rafRef.current) {
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    }
  }, [loop]);

  const open = useCallback(
    (el: HTMLImageElement) => {
      if (mounted) {
        // Currently open or dissolving back — reverse toward fully open.
        targetRef.current = 1;
        if (backstopRef.current !== null) clearTimeout(backstopRef.current);
        backstopRef.current = null;
        ensureLoop();
        return;
      }
      const r = el.getBoundingClientRect();
      const geom: Geom = {
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
        center: {
          x: (window.innerWidth - px) / 2,
          y: (window.innerHeight - px) / 2,
          w: px,
          h: px,
        },
      };
      geomRef.current = geom;
      orderRef.current = shuffledIndices(GRID * GRID);
      pRef.current = 0;
      targetRef.current = 1;
      setOverlayGeom(geom);
      setMounted(true); // the [mounted] effect sizes the canvas and starts the loop
    },
    [mounted, px, ensureLoop],
  );

  const close = useCallback(() => {
    if (!mounted) return;
    targetRef.current = 0;
    ensureLoop();
    // Wall-clock backstop: if rAF is throttled (occluded tab) the loop can't
    // land the dissolve — don't leave the overlay stuck up.
    if (backstopRef.current === null) {
      backstopRef.current = window.setTimeout(teardown, DURATION + 500);
    }
  }, [mounted, ensureLoop, teardown]);

  // Size the canvas backing store and kick the loop once the overlay mounts.
  useEffect(() => {
    if (!mounted || !canvasRef.current) return;
    const cv = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    ensureLoop();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [mounted, ensureLoop]);

  // Dismiss on scroll/resize: the dissolve is pinned to viewport coords from
  // hover time, so a moving page would strand it. Snap shut instead.
  useEffect(() => {
    if (!mounted) return;
    const dismiss = () => teardown();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", dismiss, { passive: true });
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", dismiss);
    };
  }, [mounted, teardown]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={imgClassName}
        loading="lazy"
        draggable={false}
        // While projected the thumbnail is "away" — the canvas paints the
        // dissolving cells over the ghost outline in its place.
        style={mounted ? { opacity: 0 } : undefined}
        onPointerEnter={(e) => open(e.currentTarget)}
        onPointerLeave={close}
        onPointerDown={teardown} // drag needs the real thumbnail back instantly
      />
      {/* Portal target always exists here: `mounted` is only set by pointer
          events, which can't fire before the client has mounted. */}
      {mounted && overlayGeom
        ? createPortal(
            <>
              <span
                className="preview-ghost"
                style={{
                  left: overlayGeom.box.x,
                  top: overlayGeom.box.y,
                  width: overlayGeom.box.w,
                  height: overlayGeom.box.h,
                }}
                aria-hidden="true"
              />
              <canvas
                className="preview-canvas"
                ref={canvasRef}
                aria-hidden="true"
              />
            </>,
            document.body,
          )
        : null}
    </>
  );
}
