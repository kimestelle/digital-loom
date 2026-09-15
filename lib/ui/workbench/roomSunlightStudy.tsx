"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { RoomFrame } from "../roomFrame";
import { useRoomLightController } from "../useRoomLightController";
import { DEFAULT_ROOM_LIGHT_SETTINGS } from "../roomLight";
import { DEFAULT_ROOM_SUNLIGHT_BLOOM } from "../roomWindowLight";
import { ROOM_SUNLIGHT_FRAMES } from "../roomSunlightAtlas";
import { resolveRoomSunlightInterval } from "../roomSunlightTimeline";

/** Production architecture/controller, no cloth GPU cost or persisted edits. */
export function RoomSunlightStudy() {
  const root = useRef<HTMLElement | null>(null);
  const [sunlight, setSunlight] = useState<"baked" | "legacy">("baked");
  const [referenceContrast, setReferenceContrast] = useState(true);
  const [position, setPosition] = useState(0.375);
  const [amount, setAmount] = useState(0.5);
  const [softness, setSoftness] = useState(DEFAULT_ROOM_LIGHT_SETTINGS.dappleSoftness);
  const [bloom, setBloom] = useState(DEFAULT_ROOM_SUNLIGHT_BLOOM);
  const light = useRoomLightController({
    roomRootRef: root, autoDrift: false,
    initialSettings: { position: 0.375, dapple: 0.5, dappleSoftness: DEFAULT_ROOM_LIGHT_SETTINGS.dappleSoftness },
  });
  const minutes = Math.round(position * 24 * 60) % (24 * 60);
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const interval = resolveRoomSunlightInterval(ROOM_SUNLIGHT_FRAMES, position)!;
  const frameClock = (index: number) => `${String(Math.round(ROOM_SUNLIGHT_FRAMES[index].pathPosition * 24)).padStart(2, "0")}:00`;
  return <main className="workbench-preview-document workbench-sunlight-study">
    <RoomFrame ref={root} sunlight={sunlight} sunlightTone={referenceContrast ? "sunlit" : "neutral"} sunlightBloom={bloom} stage={null} />
    <section className="workbench-sunlight-tools" aria-label="sunlight study">
      <p>sunlight · five daylight bakes</p>
      <div role="group" aria-label="light treatment">
        <button type="button" aria-pressed={sunlight === "baked"} onClick={() => setSunlight("baked")}>baked glass</button>
        <button type="button" aria-pressed={sunlight === "legacy"} onClick={() => setSunlight("legacy")}>previous light</button>
      </div>
      <button type="button" aria-pressed={referenceContrast} disabled={sunlight !== "baked"}
        onClick={() => setReferenceContrast(value => !value)}>reference contrast</button>
      <label>time of day
        <output aria-hidden="true">{clock}</output>
        <input aria-label="time of day" aria-valuetext={clock} type="range" min={0} max={1} step={0.001} value={position} onChange={event => {
          const next = Number(event.target.value); setPosition(next); light.setSettings({ position: next });
        }} />
      </label>
      <label>light patch strength
        <output aria-hidden="true">{Math.round(amount * 100)}%</output>
        <input aria-label="light patch strength" aria-valuetext={`${Math.round(amount * 100)}%`} type="range" min={0} max={1} step={0.01} value={amount} onChange={event => {
          const next = Number(event.target.value); setAmount(next); light.setSettings({ dapple: next });
        }} />
      </label>
      <label>edge softness
        <output aria-hidden="true">{Math.round(softness * 100)}%</output>
        <input aria-label="edge softness" aria-valuetext={`${Math.round(softness * 100)}%`} type="range" min={0} max={1} step={0.01} value={softness} onChange={event => {
          const next = Number(event.target.value); setSoftness(next); light.setSettings({ dappleSoftness: next });
        }} />
      </label>
      <label>bloom
        <output aria-hidden="true">{Math.round(bloom * 100)}%</output>
        <input aria-label="bloom" aria-valuetext={`${Math.round(bloom * 100)}%`} type="range"
          min={0} max={1} step={0.01} value={bloom} disabled={sunlight !== "baked" || !referenceContrast}
          onChange={event => setBloom(Number(event.target.value))} />
      </label>
      <button type="button" onClick={() => { setPosition(0.375); light.setSettings({ position: 0.375 }); }}>return to 09:00</button>
      <p aria-label="active bake interval">{interval.lowerIndex === interval.upperIndex ? `${frameClock(interval.lowerIndex)} bake`
        : `${frameClock(interval.lowerIndex)} → ${frameClock(interval.upperIndex)} · ${Math.round(interval.upperWeight * 100)}% blend`}</p>
      <p>Only the neighboring bakes blend. Softness and bloom stay at your settings; night keeps ambient light. <Link href="/" prefetch={false}>view with live cloth</Link>.</p>
    </section>
  </main>;
}
