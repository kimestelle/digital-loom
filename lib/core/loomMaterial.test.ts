import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_KNOBS } from "../ui/knobs";
import { FABRICS } from "../cloth/fabrics";
import {
  LOOM_MATERIAL_SCHEMA,
  migrateLoomMaterial,
  parseLoomMaterial,
  serializeLoomMaterial,
  type LoomMaterialV3,
} from "./loomMaterial";

function document(): LoomMaterialV3 {
  return {
    schema: LOOM_MATERIAL_SCHEMA,
    id: "variant-a",
    name: "sage linen",
    createdAt: "2026-08-29T12:00:00.000Z",
    source: {
      identity: "source-hash",
      packageId: "runtime-package",
      extractor: "fal-ai/patina/material/extract",
      captureNotes: "prompt: sage linen",
    },
    fabric: {
      id: "mumyeong",
      names: { ko: "무명", roman: "mumyeong", en: "cotton" },
      core: { ...FABRICS.mumyeong.core },
    },
    authored: {
      knobs: { ...DEFAULT_FABRIC_KNOBS, sheen: 0.42, tileScale: 3.25 },
      metalness: 0.1,
    },
    maps: {
      albedo: {
        name: "albedo",
        file: "sage-linen_BaseColor.jpeg",
        mimeType: "image/jpeg",
        extension: "jpeg",
        colorSpace: "srgb",
        provenance: "patina",
        sourceHash: "source-hash",
        asset: {
          sha256: "a".repeat(64),
          byteLength: 1234,
          width: 1024,
          height: 1024,
        },
      },
      normal: {
        name: "normal",
        file: "sage-linen_Normal.png",
        mimeType: "image/png",
        extension: "png",
        colorSpace: "linear",
        normalConvention: "opengl-y+",
        provenance: "patina",
        sourceHash: "source-hash",
      },
    },
    artifacts: {},
  };
}

describe("loom.material/3 contract", () => {
  it("round-trips the full authored material state", () => {
    const original = document();
    const parsed = parseLoomMaterial(serializeLoomMaterial(original));
    expect(parsed).toEqual(original);
    expect(Object.keys(parsed.authored.knobs).sort()).toEqual(
      Object.keys(DEFAULT_FABRIC_KNOBS).sort(),
    );
  });

  it("rejects scene/device state rather than silently persisting it", () => {
    const raw = structuredClone(document()) as unknown as Record<string, unknown>;
    const authored = raw.authored as { knobs: Record<string, unknown> };
    authored.knobs.quality = "hi";
    expect(() => parseLoomMaterial(raw)).toThrow(/authored\.knobs\.quality/);
  });

  it("requires every FabricKnobs field", () => {
    const raw = structuredClone(document());
    delete (raw.authored.knobs as Partial<typeof raw.authored.knobs>).edgeFray;
    expect(() => parseLoomMaterial(raw)).toThrow(/missing authored\.knobs\.edgeFray/);
  });

  it("rejects map descriptors whose bytes-facing metadata disagrees", () => {
    const raw = structuredClone(document());
    raw.maps.albedo!.mimeType = "image/png";
    expect(() => parseLoomMaterial(raw)).toThrow(/extension jpeg does not match/);

    const wrongNormal = structuredClone(document());
    delete wrongNormal.maps.normal!.normalConvention;
    expect(() => parseLoomMaterial(wrongNormal)).toThrow(/opengl-y\+/);

    const wrongAsset = structuredClone(document());
    wrongAsset.maps.albedo!.asset!.sha256 = "not-a-digest";
    expect(() => parseLoomMaterial(wrongAsset)).toThrow(/sha256/);
  });
});

describe("loom.material/2 migration", () => {
  it("opens the former strict document without inventing byte metadata", () => {
    const legacy = structuredClone(document()) as unknown as Record<
      string,
      unknown
    >;
    legacy.schema = "loom.material/2";
    const maps = legacy.maps as Record<string, Record<string, unknown>>;
    delete maps.albedo.asset;

    const migrated = migrateLoomMaterial(legacy);

    expect(migrated.schema).toBe(LOOM_MATERIAL_SCHEMA);
    expect(migrated.maps.albedo?.asset).toBeUndefined();
    expect(migrated.authored).toEqual(document().authored);
  });

  it("does not disguise v3 asset metadata as a v2 document", () => {
    const mislabeled = structuredClone(document()) as unknown as Record<
      string,
      unknown
    >;
    mislabeled.schema = "loom.material/2";
    expect(() => migrateLoomMaterial(mislabeled)).toThrow(
      /asset metadata requires loom\.material\/3/,
    );
  });
});

describe("loom.material/1 migration", () => {
  it("migrates the old outbound manifest through the version entry point", () => {
    const migrated = migrateLoomMaterial({
      schema: "loom.material/1",
      name: "legacy silk",
      createdAt: "2026-07-10T03:52:26.890Z",
      provenance: {
        extractor: "fal-ai/patina/material/extract",
        prompt: "prompt: silk",
        sourceHash: "legacy-source",
        note: "old note",
      },
      files: {
        baseColor: "legacy-silk_BaseColor.png",
        normal: "legacy-silk_Normal.png",
        orm: "legacy-silk_ORM.png",
        glb: "legacy-silk.glb",
      },
      pbr: {
        metalness: 0,
        sheen: 0.8,
        transmission: 0.1,
        transmissionSource: "openness × 0.4",
        albedoAmount: 1,
        tileScale: 2,
      },
      physics: {
        weaveType: "plain",
        fiberType: "filament",
        warpStiffness: 0.95,
        weftStiffness: 0.92,
        shearStiffness: 0.55,
        bendStiffness: 0.06,
        weight: 1,
        openness: 0.5,
        note: "old note",
      },
      identity: {
        fabricId: "myeongju",
        nameKo: "명주",
        nameRoman: "myeongju",
        nameEn: "silk",
      },
    });

    expect(migrated.schema).toBe(LOOM_MATERIAL_SCHEMA);
    expect(migrated.source.identity).toBe("legacy-source");
    expect(migrated.authored.knobs).toMatchObject({
      sheen: 0.8,
      tileScale: 2,
      openness: 0.5,
      warpStiffness: 0.95,
    });
    expect(Object.keys(migrated.authored.knobs)).toHaveLength(
      Object.keys(DEFAULT_FABRIC_KNOBS).length,
    );
    expect(migrated.maps.normal?.normalConvention).toBe("opengl-y+");
    expect(migrated.artifacts.glb?.file).toBe("legacy-silk.glb");
  });

  it("rejects unknown future schemas", () => {
    expect(() => migrateLoomMaterial({ schema: "loom.material/99" })).toThrow(
      /unsupported schema/,
    );
  });
});
