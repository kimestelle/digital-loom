import { describe, expect, it } from "vitest";
import { roomPreviewTileScale } from "./roomPatternScale";

describe("room responsive pattern preview", () => {
  it("enlarges the visible mobile repeat by 50%, not its UV repeat count", () => {
    const authored = 2;
    expect(roomPreviewTileScale(authored, true)).toBeCloseTo(4 / 3);
    expect(authored / roomPreviewTileScale(authored, true)).toBe(1.5);
    expect(roomPreviewTileScale(authored, false)).toBe(authored);
  });

  it("does not accumulate through resizing or mutate the saved material", () => {
    const material = Object.freeze({ tileScale: 2, quality: "hi" });
    const sequence = [false, true, true, false, true, false];
    expect(sequence.map(narrow => roomPreviewTileScale(material.tileScale, narrow)))
      .toEqual([2, 4 / 3, 4 / 3, 2, 4 / 3, 2]);
    expect(material).toEqual({ tileScale: 2, quality: "hi" });
  });

  it("preserves the authored scale relationship for edited and imported patterns", () => {
    for (const scale of [0.1, 0.5, 1, 2, 5, 20]) {
      expect(roomPreviewTileScale(scale, true) * 1.5).toBeCloseTo(scale);
      expect(roomPreviewTileScale(scale, false)).toBe(scale);
    }
  });
});
