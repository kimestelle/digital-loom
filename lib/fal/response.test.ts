import { describe, expect, it } from "vitest";
import {
  missingRequiredPatinaMaps,
  parsePatinaMapRefs,
} from "./response";

describe("Patina response parsing", () => {
  it("maps fal names and ignores the untyped preview image", () => {
    const parsed = parsePatinaMapRefs({
      data: {
        images: [
          { url: "https://fal.test/preview.png" },
          {
            map_type: "basecolor",
            url: "https://fal.test/albedo.png",
            content_type: "IMAGE/PNG",
          },
          { map_type: "normal", url: "https://fal.test/normal.png" },
          { map_type: "roughness", url: "https://fal.test/roughness.png" },
          { map_type: "height", url: "https://fal.test/height.png" },
          { map_type: "metallic", url: "https://fal.test/metalness.png" },
        ],
      },
    });

    expect(parsed.albedo).toEqual({
      url: "https://fal.test/albedo.png",
      contentType: "image/png",
    });
    expect(parsed.metalness?.url).toBe("https://fal.test/metalness.png");
    expect(missingRequiredPatinaMaps(parsed)).toEqual([]);
  });

  it("reports an incomplete material instead of accepting it", () => {
    const parsed = parsePatinaMapRefs({
      images: [{ map_type: "basecolor", url: "https://fal.test/albedo.png" }],
    });
    expect(missingRequiredPatinaMaps(parsed)).toEqual([
      "normal",
      "roughness",
      "height",
    ]);
  });
});
