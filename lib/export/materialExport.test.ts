import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { FABRICS } from "../cloth/fabrics";
import type { MaterialPackage } from "../core/materialPackage";
import { DEFAULT_FABRIC_KNOBS } from "../ui/knobs";
import {
  buildMaterialBundle,
  detectMapFormat,
  readMaterialBundle,
  type ExportInput,
  type MaterialMapResolver,
} from "./materialExport";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).buffer;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer;

function input(): ExportInput {
  const pkg: MaterialPackage = {
    id: "runtime-package",
    maps: {
      albedo: {
        name: "albedo",
        url: "/api/cache/source-hash/albedo.jpeg",
        provenance: "patina",
        sourceHash: "source-hash",
      },
      normal: {
        name: "normal",
        url: "/api/cache/source-hash/normal.png",
        provenance: "patina",
        sourceHash: "source-hash",
      },
    },
    params: {},
    meta: {
      fabricName: "sage linen",
      captureNotes: "prompt: sage linen",
      createdAt: "2026-08-29T12:00:00.000Z",
    },
  };
  return {
    name: "sage linen",
    pkg,
    knobs: { ...DEFAULT_FABRIC_KNOBS, tileScale: 2.5, edgeFray: 0.4 },
    metalness: 0.15,
    openness: Math.pow(DEFAULT_FABRIC_KNOBS.openness, 3),
    fabric: FABRICS.mumyeong,
  };
}

describe("map format detection", () => {
  it("uses magic bytes and preserves a matching real extension", () => {
    expect(detectMapFormat(JPEG, { url: "/map.jpeg" })).toEqual({
      mimeType: "image/jpeg",
      extension: "jpeg",
    });
    expect(detectMapFormat(PNG, { extension: "png" })).toEqual({
      mimeType: "image/png",
      extension: "png",
    });
  });

  it("does not let a false .png suffix override JPEG bytes", () => {
    expect(detectMapFormat(JPEG, { url: "/wrong.png" })).toEqual({
      mimeType: "image/jpeg",
      extension: "jpg",
    });
  });
});

describe("single-material bundle", () => {
  it("resolves every source map once, preserves extensions, and reopens", async () => {
    const calls = new Map<string, number>();
    const resolveMap: MaterialMapResolver = async (name) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return name === "albedo"
        ? { bytes: JPEG, mimeType: "image/jpeg", extension: "jpeg" }
        : { bytes: PNG, mimeType: "image/png", extension: "png" };
    };
    const result = await buildMaterialBundle(input(), {
      resolveMap,
      includeDerivedArtifacts: false,
    });

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect([...calls.entries()]).toEqual([
      ["albedo", 1],
      ["normal", 1],
    ]);
    expect(result.document.source.identity).toBe("source-hash");
    expect(result.document.maps.albedo).toMatchObject({
      file: "sage-linen_BaseColor.jpeg",
      mimeType: "image/jpeg",
      extension: "jpeg",
      colorSpace: "srgb",
    });
    expect(result.document.maps.normal).toMatchObject({
      file: "sage-linen_Normal.png",
      normalConvention: "opengl-y+",
      colorSpace: "linear",
    });

    const reopened = await readMaterialBundle(result.bytes);
    expect(reopened.document).toEqual(result.document);
    expect(reopened.knobs.tileScale).toBe(2.5);
    expect(reopened.knobs.edgeFray).toBe(0.4);
    expect(reopened.metalness).toBe(0.15);
    expect(reopened.mapBytes.albedo).toBeInstanceOf(ArrayBuffer);
    expect(reopened.pkg.maps.albedo?.url).toMatch(/^(blob:|data:)/);
    reopened.revoke();
  });

  it("reports a partial map failure and never lists absent files", async () => {
    const result = await buildMaterialBundle(input(), {
      includeDerivedArtifacts: false,
      resolveMap: async (name) =>
        name === "albedo"
          ? { bytes: JPEG, mimeType: "image/jpeg", extension: "jpeg" }
          : null,
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        stage: "map",
        code: "map-unavailable",
        map: "normal",
      }),
    ]);
    expect(result.document.maps.normal).toBeUndefined();

    const zip = await JSZip.loadAsync(result.bytes);
    const readme = await zip.file("sage-linen/README.md")!.async("string");
    expect(readme).toContain("sage-linen_BaseColor.jpeg");
    expect(readme).not.toContain("sage-linen_Normal.png");
    expect(readme).not.toContain("sage-linen.glb");
    expect(readme).toContain("normal map was unavailable");
  });

  it("refuses a bundle whose manifest references a missing map", async () => {
    const result = await buildMaterialBundle(input(), {
      includeDerivedArtifacts: false,
      resolveMap: async (name) => ({
        bytes: name === "albedo" ? JPEG : PNG,
        extension: name === "albedo" ? "jpeg" : "png",
      }),
    });
    const zip = await JSZip.loadAsync(result.bytes);
    zip.remove("sage-linen/sage-linen_Normal.png");
    const broken = await zip.generateAsync({ type: "uint8array" });
    await expect(readMaterialBundle(broken)).rejects.toThrow(/missing sage-linen_Normal/);
  });
});
