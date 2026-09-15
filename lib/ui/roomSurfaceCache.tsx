"use client";

import { useEffect, useRef } from "react";
import {
  embedRoomSurfaceTextures, roomSurfaceBitmapSize, roomSurfaceSnapshot,
  ROOM_SURFACE_INVALIDATE_EVENT, ROOM_SURFACE_MOBILE_MEDIA,
} from "./roomSurfaceSnapshot";

/** One viewport-sized substrate bitmap on phones. Light, the cloth shadow,
 * and the specimen stay live above it. The original SVG keeps its layout box
 * so the light/cloth controllers continue measuring the real room geometry. */
export function attachRoomSurfaceCache(canvas: HTMLCanvasElement | null): (() => void) | undefined {
    const root = canvas?.closest<HTMLElement>(".room-frame");
    const source = root?.querySelector<SVGSVGElement>(".room-frame__planes");
    if (!canvas || !root || !source || typeof ResizeObserver === "undefined") return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const mobile = matchMedia(ROOM_SURFACE_MOBILE_MEDIA);
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let rerun = false;
    let lastKey = "";
    let paintedWidth = 0;
    let paintedHeight = 0;
    let activeUrl: string | undefined;
    const releaseImageUrl = () => {
      if (activeUrl) URL.revokeObjectURL(activeUrl);
      activeUrl = undefined;
    };
    const revealSource = () => {
      delete root.dataset.roomSurfaceCached;
      delete canvas.dataset.ready;
    };
    const bake = async () => {
      if (disposed || !mobile.matches) return;
      if (running) { rerun = true; return; }
      const version = generation;
      const rect = source.getBoundingClientRect();
      const size = roomSurfaceBitmapSize(rect.width, rect.height, devicePixelRatio || 1);
      if (!size) return;
      const snapshot = roomSurfaceSnapshot(source, rect.width, rect.height);
      const serializer = new XMLSerializer();
      const key = `${size.width}:${size.height}:${serializer.serializeToString(snapshot)}`;
      if (key === lastKey) return;
      running = true;
      try {
        await embedRoomSurfaceTextures(snapshot);
        if (disposed || version !== generation || !mobile.matches) return;
        activeUrl = URL.createObjectURL(new Blob([serializer.serializeToString(snapshot)], { type: "image/svg+xml" }));
        const image = new Image();
        image.src = activeUrl;
        await image.decode();
        if (disposed || version !== generation || !mobile.matches) return;
        // Do not hide the original until the complete, embedded image decoded.
        canvas.width = size.width;
        canvas.height = size.height;
        context.drawImage(image, 0, 0, size.width, size.height);
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.dataset.ready = "true";
        root.dataset.roomSurfaceCached = "true";
        paintedWidth = rect.width;
        paintedHeight = rect.height;
        lastKey = key;
      } catch {
        // Unsupported SVG paint/image decoding never replaces the real room
        // with an incomplete approximation. Keep its ordinary DOM rendering.
        if (!disposed && version === generation) {
          lastKey = "";
          revealSource();
        }
      } finally {
        releaseImageUrl();
        running = false;
        if (rerun && !disposed) { rerun = false; schedule(); }
      }
    };
    const schedule = () => {
      generation += 1;
      if (timer) clearTimeout(timer);
      if (!mobile.matches) {
        revealSource();
        lastKey = "";
        // Release the GPU/CPU bitmap when returning to the desktop path.
        canvas.width = 1;
        canvas.height = 1;
        releaseImageUrl();
        return;
      }
      // Coalesce orientation/layout changes or a directly manipulated paint.
      // No animation-frame loop, mutation observer, or daylight-tick work.
      timer = setTimeout(() => { timer = undefined; void bake(); }, 120);
    };
    const resize = new ResizeObserver(() => {
      const rect = source.getBoundingClientRect();
      if (canvas.dataset.ready && (rect.width !== paintedWidth || rect.height !== paintedHeight)) {
        // The old bitmap has fixed CSS bounds. Keep the real SVG visible
        // through orientation changes until a correctly-sized bake is ready.
        revealSource();
        lastKey = "";
      }
      schedule();
    });
    resize.observe(source);
    mobile.addEventListener("change", schedule);
    root.addEventListener(ROOM_SURFACE_INVALIDATE_EVENT, schedule);
    schedule();
    return () => {
      disposed = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      resize.disconnect();
      mobile.removeEventListener("change", schedule);
      root.removeEventListener(ROOM_SURFACE_INVALIDATE_EVENT, schedule);
      releaseImageUrl();
      revealSource();
      canvas.width = 1;
      canvas.height = 1;
    };
}

export function RoomSurfaceCache({ paletteRevision = "" }: { paletteRevision?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => attachRoomSurfaceCache(canvasRef.current), [paletteRevision]);
  return <canvas ref={canvasRef} className="room-frame__surface-cache" width={1} height={1} aria-hidden="true" />;
}
