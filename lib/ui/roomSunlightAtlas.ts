import atlas from "../../public/2d-textures/room-sunlight-day.json";
import { DEFAULT_DAYLIGHT_POSITION } from "./roomLight";

/** Compact metadata only. Image bytes load for the selected pair, not the day. */
export const ROOM_SUNLIGHT_FRAMES = atlas.frames;
export const ROOM_SUNLIGHT_INTERVAL_EVENT = "room-sunlight-interval";
const initialFrame = Math.max(0, ROOM_SUNLIGHT_FRAMES.findIndex(frame => frame.pathPosition === DEFAULT_DAYLIGHT_POSITION));
export const INITIAL_ROOM_SUNLIGHT_INTERVAL = `${initialFrame}:${initialFrame}`;

export function roomSunlightFrameIndices(key: string): number[] {
  const indices = key.split(":").map(Number);
  if (indices.length !== 2 || indices.some(index => !Number.isInteger(index) || index < 0 || index >= ROOM_SUNLIGHT_FRAMES.length)) return [initialFrame];
  return [...new Set(indices)];
}
