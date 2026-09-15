"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { INITIAL_ROOM_SUNLIGHT_INTERVAL, ROOM_SUNLIGHT_FRAMES, ROOM_SUNLIGHT_INTERVAL_EVENT, roomSunlightFrameIndices } from "./roomSunlightAtlas";
import { clampRoomSunlightBloom, DEFAULT_ROOM_SUNLIGHT_BLOOM } from "./roomWindowLight";
import { roomSunlightFilterMarkup } from "./roomSunlightFilter";
import { canUseRoomSunlightDisplay, roomSunlightSource, type RoomSunlightSource } from "./roomSunlightDisplay";

/** Retain the decoded image while a different display treatment loads. */
function SunlightSource({ index, baked, prefix, receiver, filterId, publish }: {
  index: number; baked: boolean; prefix: string; receiver: "floor" | "right-wall";
  filterId: string; publish: () => void;
}) {
  const desired = roomSunlightSource(index, baked);
  const [source, setSource] = useState<RoomSunlightSource>(desired);
  const [failedDisplay, setFailedDisplay] = useState(false);
  const requested = failedDisplay ? roomSunlightSource(index, false) : desired;
  const requestedImage = requested.image;
  useEffect(() => {
    // Also verify the initial source: an SSR image may have failed before
    // hydration attached onError, so relying on that event loses fallback.
    let disposed = false;
    const image = new Image();
    image.src = requestedImage;
    void image.decode().then(() => {
      if (!disposed && source.image !== requestedImage) setSource(roomSunlightSource(index, baked && !failedDisplay));
    }).catch(() => { if (!disposed && baked && !failedDisplay) setFailedDisplay(true); });
    return () => { disposed = true; };
  }, [requestedImage, source.image, index, baked, failedDisplay]);
  // Native PNGs retain the bake's registration and decoded browser cache.
  // eslint-disable-next-line @next/next/no-img-element
  return <img key={source.image}
    ref={element => { if (element?.complete && element.naturalWidth > 0) {
      element.dataset.sunlightDecoded = "true"; publish();
    } }}
    className={receiver === "floor" ? "room-frame__sunlight-bake" : "room-frame__wall-sunlight-bake"}
    data-sunlight-frame={index} data-sunlight-display={source.baked ? "baked" : "live"}
    src={source.image} width={source.width} height={source.height} alt="" aria-hidden="true"
    style={{
      "--room-bake-exposure-filter": `url("#${filterId}")`,
      filter: source.baked ? "none" : undefined,
      transform: `translate3d(calc(var(${prefix}-left, 0px) + ${source.offsetX}px), calc(var(${prefix}-top, 0px) + ${source.offsetY}px), 0)`,
    } as CSSProperties}
    draggable={false} decoding="async"
    onLoad={async event => {
      const image = event.currentTarget;
      try { await image.decode(); image.dataset.sunlightDecoded = "true"; }
      catch { image.dataset.sunlightDecoded = "false"; }
      if (image.isConnected) publish();
    }}
    onError={event => {
      event.currentTarget.dataset.sunlightDecoded = "false";
      if (source.baked) setFailedDisplay(true);
      publish();
    }} />;
}

/** At most two decoded source plates per receiver. React changes only when
 * the interval changes; the existing controller moves and blends the pair. */
export function RoomSunlightImage({ bloom = DEFAULT_ROOM_SUNLIGHT_BLOOM, receiver = "floor", tone = "sunlit" }: {
  bloom?: number;
  receiver?: "floor" | "right-wall";
  tone?: "sunlit" | "neutral";
}) {
  const bloomStrength = clampRoomSunlightBloom(bloom);
  const exposureId = `room-sunlight-exposure-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLDivElement | null>(null);
  const [interval, setInterval] = useState(INITIAL_ROOM_SUNLIGHT_INTERVAL);
  const [softness, setSoftness] = useState(1);
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(".room-frame");
    if (!root) return;
    const sync = () => setSoftness(Number(root.dataset.roomSunlightSoftness ?? 1));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-room-sunlight-softness"] });
    sync();
    return () => observer.disconnect();
  }, []);
  const baked = canUseRoomSunlightDisplay(bloomStrength, softness, tone);
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
        <defs dangerouslySetInnerHTML={{ __html: roomSunlightFilterMarkup(exposureId, bloomStrength) }} />
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
          <SunlightSource index={index} baked={baked} prefix={prefix} receiver={receiver} filterId={exposureId} publish={publish} />
        </div>;
      })}
    </div>
  );
}
