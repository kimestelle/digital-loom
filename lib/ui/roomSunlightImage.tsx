"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { INITIAL_ROOM_SUNLIGHT_INTERVAL, ROOM_SUNLIGHT_FRAMES, ROOM_SUNLIGHT_INTERVAL_EVENT, roomSunlightFrameIndices } from "./roomSunlightAtlas";
import { clampRoomSunlightBloom, DEFAULT_ROOM_SUNLIGHT_BLOOM } from "./roomWindowLight";

/** At most two decoded source plates per receiver. React changes only when
 * the interval changes; the existing controller moves and blends the pair. */
export function RoomSunlightImage({ bloom = DEFAULT_ROOM_SUNLIGHT_BLOOM, receiver = "floor" }: {
  bloom?: number;
  receiver?: "floor" | "right-wall";
}) {
  const bloomStrength = clampRoomSunlightBloom(bloom);
  const exposureId = `room-sunlight-exposure-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLDivElement | null>(null);
  const [interval, setInterval] = useState(INITIAL_ROOM_SUNLIGHT_INTERVAL);
  const indices = roomSunlightFrameIndices(interval);
  const readyKey = receiver === "floor" ? "roomSunlightReady" : "roomSunlightWallReady";
  const publish = () => {
    const element = ref.current;
    const root = element?.closest<HTMLElement>(".room-frame");
    if (!element || !root) return;
    const images = Array.from(element.querySelectorAll<HTMLImageElement>("img"));
    for (const image of images) element.style.setProperty(`--room-ready-${image.dataset.sunlightFrame}`, image.dataset.sunlightDecoded === "true" ? "1" : "0");
    root.dataset[readyKey] = String(images.some(image => image.dataset.sunlightDecoded === "true"));
  };
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(".room-frame");
    if (!root) return;
    const sync = () => {
      const key = root.dataset.roomSunlightInterval ?? INITIAL_ROOM_SUNLIGHT_INTERVAL;
      const selected = roomSunlightFrameIndices(key);
      // Preserve an already decoded shared endpoint across a boundary. Only
      // fall back when none of the new interval's sources is available.
      const images = Array.from(ref.current?.querySelectorAll<HTMLImageElement>("img") ?? []);
      root.dataset[receiver === "floor" ? "roomSunlightReady" : "roomSunlightWallReady"] = String(images.some(image =>
        selected.includes(Number(image.dataset.sunlightFrame)) && image.dataset.sunlightDecoded === "true"));
      setInterval(key);
    };
    root.addEventListener(ROOM_SUNLIGHT_INTERVAL_EVENT, sync);
    sync();
    return () => root.removeEventListener(ROOM_SUNLIGHT_INTERVAL_EVENT, sync);
  }, [receiver]);
  useEffect(() => {
    const element = ref.current;
    const root = element?.closest<HTMLElement>(".room-frame");
    if (!element || !root) return;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const images = Array.from(element.querySelectorAll<HTMLImageElement>("img"));
      for (const image of images) element.style.setProperty(`--room-ready-${image.dataset.sunlightFrame}`, image.dataset.sunlightDecoded === "true" ? "1" : "0");
      root.dataset[readyKey] = String(images.some(image => image.dataset.sunlightDecoded === "true"));
    };
    sync();
    for (const image of element.querySelectorAll<HTMLImageElement>("img")) {
      if (image.complete && image.naturalWidth > 0 && image.dataset.sunlightDecoded !== "true") {
        void image.decode().then(() => { if (!disposed) { image.dataset.sunlightDecoded = "true"; sync(); } }).catch(() => {});
      }
    }
    return () => { disposed = true; delete root.dataset[readyKey]; };
  }, [interval, readyKey]);
  return (
    <div ref={ref} className="room-frame__sunlight-receiver" data-receiver={receiver}
      style={{ "--room-pair-coverage": `calc(${indices.map(index => `var(--room-bake-mix-${index}, 0) * var(--room-ready-${index}, 0)`).join(" + ")})` } as CSSProperties}>
      <svg className="room-frame__sunlight-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          {/* Lift display exposure, not optical ray energy. The broad panes
              become near-white; the underlying floor remains visible. */}
          <filter id={exposureId} x="-10%" y="-22%" width="120%" height="144%" colorInterpolationFilters="sRGB">
            <feComponentTransfer in="SourceGraphic" result="direct">
              <feFuncA type="linear" slope="2.85" intercept="0" />
            </feComponentTransfer>
            {/* Bloom is light spilling outside the footprint, not an edge
                blur. Extract only bright light, then keep its two fixed
                scatter radii local to this plate rather than the canvas. */}
            <feComponentTransfer in="direct" result="highlights">
              <feFuncA type="linear" slope="2" intercept="-1" />
            </feComponentTransfer>
            <feFlood floodColor="#fff1cf" result="scatter-color" />
            <feComposite in="scatter-color" in2="highlights" operator="in" result="scatter" />
            <feGaussianBlur in="scatter" stdDeviation="6" result="near-scatter" />
            <feComponentTransfer in="near-scatter" result="near-bloom">
              <feFuncA type="linear" slope={bloomStrength * 1.1} />
            </feComponentTransfer>
            <feGaussianBlur in="scatter" stdDeviation="32" result="wide-scatter" />
            <feComponentTransfer in="wide-scatter" result="wide-bloom">
              <feFuncA type="linear" slope={bloomStrength * 1.25} />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode in="wide-bloom" />
              <feMergeNode in="near-bloom" />
              <feMergeNode in="direct" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      {indices.map(index => {
        const bake = ROOM_SUNLIGHT_FRAMES[index];
        const prefix = receiver === "floor" ? `--room-bake-${index}` : `--room-wall-bake-${index}`;
        return <div key={index} className="room-frame__sunlight-plate" data-sunlight-frame={index}
          style={{
            transform: `var(${prefix}-transform, scale(0))`,
            width: `var(${prefix}-width, ${bake.width}px)`,
            height: `var(${prefix}-height, ${bake.height}px)`,
            opacity: `calc(var(--room-bake-mix-${index}, 0) * var(--room-ready-${index}, 0) / max(0.000001, var(--room-pair-coverage)))`,
          }}>
          {/* Native image avoids an optimizer round trip. The filter stays in
              source pixels, preserving the approved morning bloom exactly. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={receiver === "floor" ? "room-frame__sunlight-bake" : "room-frame__wall-sunlight-bake"}
            data-sunlight-frame={index} src={`${bake.image}?v=${bake.checks.pngSha256.slice(0, 12)}`}
            width={bake.width} height={bake.height} alt="" aria-hidden="true"
            style={{
              "--room-bake-exposure-filter": `url("#${exposureId}")`,
              transform: `translate3d(var(${prefix}-left, 0px), var(${prefix}-top, 0px), 0)`,
            } as CSSProperties}
            draggable={false} decoding="async"
            onLoad={async event => {
              const image = event.currentTarget;
              try { await image.decode(); image.dataset.sunlightDecoded = "true"; }
              catch { image.dataset.sunlightDecoded = "false"; }
              if (image.isConnected) publish();
            }}
            onError={event => { event.currentTarget.dataset.sunlightDecoded = "false"; publish(); }} />
        </div>;
      })}
    </div>
  );
}
