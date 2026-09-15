import display from "../../public/2d-textures/room-sunlight-display-day.json";
import { ROOM_SUNLIGHT_FRAMES } from "./roomSunlightAtlas";

export interface RoomSunlightSource {
  image: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  baked: boolean;
}

/** Keep transport coordinates unchanged; padding belongs only to the image. */
export function roomSunlightSource(index: number, baked: boolean): RoomSunlightSource {
  const original = ROOM_SUNLIGHT_FRAMES[index];
  const ready = baked ? display.frames.find(frame => frame.originalImage === original.image
    && frame.checks.originalPngSha256 === original.checks.pngSha256) : undefined;
  const source = ready ?? original;
  return {
    image: `${source.image}?v=${source.checks.pngSha256.slice(0, 12)}`,
    width: source.width,
    height: source.height,
    offsetX: ready?.offsetX ?? 0,
    offsetY: ready?.offsetY ?? 0,
    baked: Boolean(ready),
  };
}

export function canUseRoomSunlightDisplay(bloom: number, softness: number, tone: string): boolean {
  return tone === "sunlit" && bloom === display.settings.bloom && softness === display.settings.softness;
}
