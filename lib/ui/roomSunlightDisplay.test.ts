import { describe, expect, it } from "vitest";
import { canUseRoomSunlightDisplay, roomSunlightSource } from "./roomSunlightDisplay";

describe("display-ready sunlight selection", () => {
  it("uses the approved bake only at its exact authored settings", () => {
    expect(canUseRoomSunlightDisplay(1, 1, "sunlit")).toBe(true);
    for (const [bloom, softness, tone] of [[0.9, 1, "sunlit"], [1, 0.9, "sunlit"], [1, 1, "neutral"], [NaN, 1, "sunlit"]] as const) {
      expect(canUseRoomSunlightDisplay(bloom, softness, tone)).toBe(false);
    }
  });
  it("keeps source-space registration and original maps available for tuning/failure", () => {
    for (let index = 0; index < 5; index++) {
      const baked = roomSunlightSource(index, true);
      const source = roomSunlightSource(index, false);
      expect(baked.baked).toBe(true);
      expect(source.baked).toBe(false);
      expect(baked.width + baked.offsetX * 2).toBe(source.width);
      expect(baked.height + baked.offsetY * 2).toBe(source.height);
      expect(source.offsetX).toBe(0);
      expect(source.offsetY).toBe(0);
      expect(baked.image).toContain("room-sunlight-display-");
      expect(source.image).not.toContain("room-sunlight-display-");
    }
  });
});
