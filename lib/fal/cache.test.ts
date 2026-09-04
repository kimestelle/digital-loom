import { describe, expect, it } from "vitest";
import { isManifestShape } from "./cache";

const manifest = {
  endpoint: "fal-ai/patina/material/extract",
  hash: "12345678abcdef00",
  createdAt: "2026-08-31T00:00:00.000Z",
  maps: [
    { name: "albedo", file: "albedo.png" },
    { name: "normal", file: "normal.png" },
  ],
  rawResponsePath: "response.json",
};

describe("fal cache manifests", () => {
  it("accepts a coherent manifest", () => {
    expect(isManifestShape(manifest, manifest.hash)).toBe(true);
  });

  it("rejects identity drift, duplicate maps, and unsafe files", () => {
    expect(isManifestShape(manifest, "aaaaaaaaaaaaaaaa")).toBe(false);
    expect(
      isManifestShape({
        ...manifest,
        maps: [
          ...manifest.maps,
          { name: "normal", file: "normal-copy.png" },
        ],
      }),
    ).toBe(false);
    expect(
      isManifestShape({
        ...manifest,
        maps: [{ name: "albedo", file: "../albedo.png" }],
      }),
    ).toBe(false);
    expect(
      isManifestShape({
        ...manifest,
        maps: [
          {
            name: "albedo",
            file: "albedo.png",
            asset: { sha256: "bad", byteLength: 1, width: 1, height: 1 },
          },
        ],
      }),
    ).toBe(false);
  });
});
