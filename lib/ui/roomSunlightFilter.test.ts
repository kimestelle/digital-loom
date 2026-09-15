import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import atlas from "../../public/2d-textures/room-sunlight-day.json";
import display from "../../public/2d-textures/room-sunlight-display-day.json";
import { ROOM_SUNLIGHT_DISPLAY_SETTINGS, roomSunlightFilterMarkup } from "./roomSunlightFilter";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const file = (image: string) => readFileSync(resolve(process.cwd(), "public", image.slice(1)));

describe("sunlight display filter", () => {
  it("preserves exposure, two scatter radii, ordering and filter extent", () => {
    const filter = roomSunlightFilterMarkup("test-filter");
    expect(filter).toContain('x="-10%" y="-22%" width="120%" height="144%"');
    expect(filter).toContain('color-interpolation-filters="sRGB"');
    expect(filter).toContain('slope="2.85" intercept="0"');
    expect(filter).toContain('slope="2" intercept="-1"');
    expect(filter).toContain('flood-color="#fff1cf"');
    expect(filter).toContain('stdDeviation="6"');
    expect(filter).toContain('stdDeviation="32"');
    expect(filter).toContain('slope="1.1"');
    expect(filter).toContain('slope="1.25"');
    expect(filter).toContain('<feMergeNode in="wide-bloom" /><feMergeNode in="near-bloom" /><feMergeNode in="direct" />');
  });

  it("clamps authored strengths without changing the direct illumination", () => {
    expect(roomSunlightFilterMarkup("test", 2)).toBe(roomSunlightFilterMarkup("test", 1));
    expect(roomSunlightFilterMarkup("test", Number.NaN)).toBe(roomSunlightFilterMarkup("test", 1));
    expect(roomSunlightFilterMarkup("test", -1)).toBe(roomSunlightFilterMarkup("test", 0));
    expect(roomSunlightFilterMarkup("test", 0.5)).toContain('slope="0.55"');
    expect(roomSunlightFilterMarkup("test", 0.5)).toContain('slope="0.625"');
    expect(roomSunlightFilterMarkup("test", 0)).toContain('slope="2.85"');
  });

  it("rejects markup in IDs", () => {
    expect(() => roomSunlightFilterMarkup('invalid" onload="bad')).toThrow("Invalid sunlight filter ID");
  });
});

describe("reviewed sunlight display derivatives", () => {
  it("records the actual shared filter and approved controls", () => {
    expect(display.schemaVersion).toBe(1);
    expect(display.settings).toEqual(ROOM_SUNLIGHT_DISPLAY_SETTINGS);
    expect(display.filterSha256).toBe(hash(roomSunlightFilterMarkup("room-display-bake", display.settings.bloom)));
  });

  it("keeps every source intact and preserves the clipped source extent", () => {
    expect(display.frames).toHaveLength(atlas.frames.length);
    for (const [index, derivative] of display.frames.entries()) {
      const source = atlas.frames[index];
      expect(derivative.originalImage).toBe(source.image);
      expect(derivative.pathPosition).toBe(source.pathPosition);
      expect(derivative.checks.originalPngSha256).toBe(source.checks.pngSha256);
      expect(hash(file(source.image))).toBe(source.checks.pngSha256);
      expect(derivative.width).toBe(source.width);
      expect(derivative.height).toBe(source.height);
      expect(derivative.offsetX).toBe(0);
      expect(derivative.offsetY).toBe(0);
    }
  });

  it("verifies encoded dimensions, hashes and the full-size/mobile comparison gates", () => {
    for (const derivative of display.frames) {
      const bytes = file(derivative.image);
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(derivative.width);
      expect(bytes.readUInt32BE(20)).toBe(derivative.height);
      expect(bytes.length).toBe(derivative.checks.bytes);
      expect(hash(bytes)).toBe(derivative.checks.pngSha256);
      expect(derivative.checks.validation.map(check => check.scale)).toEqual([1, 0.6, 0.35]);
      expect(derivative.checks.validation[0].maximumByteError).toBe(0);
      for (const check of derivative.checks.validation) {
        expect(check.meanAbsoluteByteError).toBeLessThan(1);
        expect(check.maximumByteError).toBeLessThan(8);
      }
    }
  });
});
