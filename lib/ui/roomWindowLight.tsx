"use client";

import { useEffect, useId, useRef, type CSSProperties } from "react";
import { attachRoomWindowBloomCache, ROOM_WINDOW_BLOOM } from "./roomWindowBloomCache";

export const DEFAULT_ROOM_SUNLIGHT_BLOOM = 1;

export function clampRoomSunlightBloom(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_ROOM_SUNLIGHT_BLOOM;
}

/** Geometry is published by the room's existing resize measurement. The live
 * scene keeps its depth-tested frame; only canvas-free studies draw it here. */
export function RoomWindowLight({ vectorFrame = false, bloom = DEFAULT_ROOM_SUNLIGHT_BLOOM }: {
  vectorFrame?: boolean;
  bloom?: number;
}) {
  const id = `room-window-scatter-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (ref.current) return attachRoomWindowBloomCache(ref.current);
  }, []);
  return <svg ref={ref} className="room-frame__window-vector" data-room-window-vector=""
    data-frame-renderer={vectorFrame ? "vector" : "stage"}
    style={{ "--room-window-bloom": clampRoomSunlightBloom(bloom) } as CSSProperties}
    aria-hidden="true" focusable="false" preserveAspectRatio="none">
    <defs>
      <filter id={id} x="-15%" y="-30%" width="130%" height="160%" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={ROOM_WINDOW_BLOOM.wideRadius} result="wide" />
        <feComponentTransfer in="wide" result="wide-bloom"><feFuncA type="linear" slope={ROOM_WINDOW_BLOOM.wideAlpha} /></feComponentTransfer>
        <feGaussianBlur in="SourceGraphic" stdDeviation={ROOM_WINDOW_BLOOM.nearRadius} result="near" />
        <feComponentTransfer in="near" result="near-bloom"><feFuncA type="linear" slope={ROOM_WINDOW_BLOOM.nearAlpha} /></feComponentTransfer>
        <feMerge><feMergeNode in="wide-bloom" /><feMergeNode in="near-bloom" /></feMerge>
      </filter>
    </defs>
    {vectorFrame ? <g className="room-frame__window-form">
      <path data-window-path="frame" fill="#e2d1b6" />
      <path data-window-path="sill" fill="var(--room-wall-mid)" />
    </g> : null}
    {/* Deliberately no sharp source in this filter: its spill can sit beneath
        the cloth without recreating a second visible window frame. */}
    <g className="room-frame__window-bloom">
      <g data-window-bloom-source="" filter={`url(#${id})`} fill="#fff">
        <path data-window-path="aperture" />
      </g>
      <image data-window-bloom-cache="" preserveAspectRatio="none" style={{ display: "none" }} />
    </g>
  </svg>;
}
