import { describe, expect, it } from "vitest";
import {
  collectionOrderIds,
  validateCollectionManifest,
} from "./collectionManifest";
import { LOOM_MATERIAL_SCHEMA } from "../core/loomMaterial";
import { DEFAULT_FABRIC_KNOBS } from "../ui/knobs";
import { FABRICS } from "../cloth/fabrics";

const HASH = "71871d958aa681541baf9159cbf98bc4";

function validManifest(): unknown {
  return {
    app: "digital-loom",
    kind: "collection",
    version: 1,
    exportedAt: "2026-08-29T00:00:00.000Z",
    // Clone deliberately comes first: display order is independent of which
    // material owns the package bytes.
    order: ["copy", "source"],
    materials: [
      {
        slug: "source",
        id: HASH,
        name: "source",
        pkgHash: HASH,
        maps: {
          albedo: "source/albedo.png",
          normal: "source/normal.png",
        },
      },
      {
        slug: "copy",
        id: "7ea3072c-11f0-42e0-b515-472a01d7fbd1",
        name: "copy",
        pkgHash: HASH,
        mapsOf: "source",
        params: {
          fabricId: "myeongju",
          metalness: 0,
          knobs: {},
        },
      },
    ],
  };
}

function canonicalCopy() {
  const fabric = FABRICS.myeongju;
  return {
    schema: LOOM_MATERIAL_SCHEMA,
    id: "7ea3072c-11f0-42e0-b515-472a01d7fbd1",
    name: "copy",
    createdAt: "2026-08-29T00:00:00.000Z",
    source: {
      identity: HASH,
      packageId: HASH,
      extractor: null,
      captureNotes: null,
    },
    fabric: {
      id: fabric.id,
      names: {
        ko: fabric.nameKo,
        roman: fabric.nameRoman,
        en: fabric.nameEn,
      },
      core: fabric.core,
    },
    authored: { knobs: DEFAULT_FABRIC_KNOBS, metalness: 0 },
    maps: {
      albedo: {
        name: "albedo",
        file: "albedo.png",
        mimeType: "image/png",
        extension: "png",
        colorSpace: "srgb",
        provenance: "patina",
        sourceHash: HASH,
      },
      normal: {
        name: "normal",
        file: "normal.png",
        mimeType: "image/png",
        extension: "png",
        colorSpace: "linear",
        normalConvention: "opengl-y+",
        provenance: "patina",
        sourceHash: HASH,
      },
    },
    artifacts: {},
  };
}

describe("collection manifest validation", () => {
  it("round-trips display order rather than packaging-owner order", () => {
    const manifest = validateCollectionManifest(validManifest());
    expect(collectionOrderIds(manifest)).toEqual([
      "7ea3072c-11f0-42e0-b515-472a01d7fbd1",
      HASH,
    ]);
  });

  it("rejects an order that omits a material", () => {
    const input = validManifest() as { order: string[] };
    input.order = ["source"];
    expect(() => validateCollectionManifest(input)).toThrow(
      /order must name every material exactly once/,
    );
  });

  it("rejects a clone whose declared map owner is absent", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    input.materials[1].mapsOf = "missing";
    expect(() => validateCollectionManifest(input)).toThrow(
      /map owner missing is missing or incompatible/,
    );
  });

  it("rejects unsafe archive paths before reading any files", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    input.materials[0].maps = { albedo: "../outside.png" };
    expect(() => validateCollectionManifest(input)).toThrow(/invalid map path/);
  });

  it("requires new map asset metadata to cover the complete owned map set", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    input.materials[0].mapAssets = {
      albedo: {
        sha256: "a".repeat(64),
        byteLength: 10,
        width: 2,
        height: 2,
      },
    };
    expect(() => validateCollectionManifest(input)).toThrow(
      /must describe every owned map/,
    );
  });

  it("rejects non-addressable package identities", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    input.materials[0].pkgHash = "not-a-content-hash";
    expect(() => validateCollectionManifest(input)).toThrow(
      /invalid package hash/,
    );
  });

  it("uses the canonical material contract inside a collection", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    delete input.materials[1].params;
    input.materials[1].material = canonicalCopy();
    const manifest = validateCollectionManifest(input);
    expect(manifest.materials[1].material?.authored.knobs).toEqual(
      DEFAULT_FABRIC_KNOBS,
    );
  });

  it("rejects a canonical document whose maps disagree with its owner", () => {
    const input = validManifest() as {
      materials: Array<Record<string, unknown>>;
    };
    const material = canonicalCopy();
    material.maps.normal.file = "different.png";
    delete input.materials[1].params;
    input.materials[1].material = material;
    expect(() => validateCollectionManifest(input)).toThrow(
      /map filename disagrees/,
    );
  });
});
