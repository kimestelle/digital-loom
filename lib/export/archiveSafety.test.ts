import { describe, expect, it } from "vitest";
import {
  assertArchiveInputSize,
  assertSafeArchiveContents,
  type ArchiveLimits,
} from "./archiveSafety";

const limits: ArchiveLimits = {
  maxCompressedBytes: 100,
  maxEntries: 3,
  maxEntryBytes: 80,
  maxTotalBytes: 100,
  maxManifestBytes: 30,
  maxInflationRatio: 4,
};

const entry = (name: string, compressedSize: number, uncompressedSize: number) => ({
  name,
  dir: false,
  _data: { compressedSize, uncompressedSize },
});

describe("archive inflation bounds", () => {
  it("accepts a bounded central directory", () => {
    expect(() => assertArchiveInputSize(50, limits)).not.toThrow();
    expect(() =>
      assertSafeArchiveContents(
        {
          "manifest.json": entry("manifest.json", 10, 20),
          "map.png": entry("map.png", 40, 70),
        },
        limits,
      ),
    ).not.toThrow();
  });

  it("rejects oversized inputs, entries, manifests, and totals", () => {
    expect(() => assertArchiveInputSize(101, limits)).toThrow(/compressed-size/);
    expect(() =>
      assertSafeArchiveContents({ map: entry("map", 2, 81) }, limits),
    ).toThrow(/entry map exceeds/);
    expect(() =>
      assertSafeArchiveContents(
        { manifest: entry("manifest.json", 20, 31) },
        limits,
      ),
    ).toThrow(/manifest/);
    expect(() =>
      assertSafeArchiveContents(
        { a: entry("a", 30, 60), b: entry("b", 30, 60) },
        limits,
      ),
    ).toThrow(/total-size/);
  });
});
