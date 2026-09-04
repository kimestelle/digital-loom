import { describe, expect, it } from "vitest";
import { pkgFromMaps } from "./materialPackage";

describe("pkgFromMaps", () => {
  it("preserves hydrated map metadata, URLs, and the original timestamp", () => {
    const pkg = pkgFromMaps(
      "edited linen",
      "",
      [
        {
          name: "albedo",
          file: "albedo.png",
          url: "blob:hydrated-albedo",
          provenance: "derived",
          sourceHash: "parent:albedo-edit",
        },
      ],
      {
        hash: "package-hash",
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    );

    expect(pkg.meta.createdAt).toBe("2026-08-29T12:00:00.000Z");
    expect(pkg.maps.albedo).toEqual({
      name: "albedo",
      url: "blob:hydrated-albedo",
      provenance: "derived",
      sourceHash: "parent:albedo-edit",
    });
  });

  it("projects older Patina manifests onto their package source identity", () => {
    const pkg = pkgFromMaps(
      "silk",
      "/pregen/silk",
      [{ name: "normal", file: "normal.png" }],
      { hash: "extraction-hash" },
    );

    expect(pkg.maps.normal).toMatchObject({
      url: "/pregen/silk/normal.png",
      provenance: "patina",
      sourceHash: "extraction-hash",
    });
  });
});
