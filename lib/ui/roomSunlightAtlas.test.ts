import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOM_SUNLIGHT_FRAMES, roomSunlightFrameIndices } from "./roomSunlightAtlas";
import { resolveRoomLight } from "./roomLight";

describe("shipped daylight optical fields", () => {
  it("ships five bounded fields and preserves the approved morning bytes", () => {
    expect(ROOM_SUNLIGHT_FRAMES.map(frame => frame.pathPosition * 24)).toEqual([6, 9, 12, 15, 18]);
    let total = 0;
    for (const frame of ROOM_SUNLIGHT_FRAMES) {
      const image = readFileSync(resolve(process.cwd(), `public${frame.image}`));
      total += image.byteLength;
      expect(image.byteLength).toBeLessThan(410_000);
      expect(image.readUInt32BE(16)).toBe(1024);
      expect(image.readUInt32BE(20)).toBe(512);
      expect(createHash("sha256").update(image).digest("hex")).toBe(frame.checks.pngSha256);
    }
    expect(total).toBeLessThan(2_000_000);
    expect(ROOM_SUNLIGHT_FRAMES[1].checks.pngSha256).toBe("ddcf9fce0bf1adec30bc7ba4046706f15aad7decca9d9167b0966878a3970c11");
  });

  it("shares exposure, glass and spectrum and follows the actual room source", () => {
    const metadata = ROOM_SUNLIGHT_FRAMES.map(frame => JSON.parse(readFileSync(resolve(process.cwd(), `public${frame.image.replace(/\.png$/, ".json")}`), "utf8")));
    for (let index = 0; index < metadata.length; index++) {
      const bake = metadata[index];
      const light = resolveRoomLight(ROOM_SUNLIGHT_FRAMES[index].pathPosition);
      expect(bake.direction.x).toBeCloseTo(light.lightDirection.x, 10);
      expect(bake.direction.y).toBeCloseTo(-light.lightDirection.z, 10);
      expect(bake.direction.z).toBeCloseTo(light.lightDirection.y, 10);
      expect(bake.encoding.exposure).toBe(metadata[1].encoding.exposure);
      expect(bake.transport.frontCoefficients).toEqual(metadata[1].transport.frontCoefficients);
      expect(bake.transport.thicknessCoefficients).toEqual(metadata[1].transport.thicknessCoefficients);
      expect(bake.transport.wavelengthsNm).toEqual(metadata[1].transport.wavelengthsNm);
      expect(bake.checks.allFinite).toBe(true);
      expect(bake.checks.conservativeDeposition).toBe(true);
    }
  });

  it("bounds selected image indices and deduplicates exact keyframes", () => {
    expect(roomSunlightFrameIndices("1:1")).toEqual([1]);
    expect(roomSunlightFrameIndices("1:2")).toEqual([1, 2]);
    for (const invalid of ["bad", "0:1:2", "-1:2", "0:999", "0:1.5"]) {
      expect(roomSunlightFrameIndices(invalid)).toEqual([1]);
    }
  });
});
