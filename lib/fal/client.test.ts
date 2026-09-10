import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveFalCredentials } from "./client";

describe("fal credential resolution", () => {
  it("lets an explicit per-request user key override server credentials", () => {
    expect(
      resolveFalCredentials("  user-key  ", {
        FAL_KEY: "server-key",
        FAL_API_KEY: "legacy-key",
      }),
    ).toBe("user-key");
  });

  it("prefers FAL_KEY while retaining FAL_API_KEY as a migration fallback", () => {
    expect(
      resolveFalCredentials(undefined, {
        FAL_KEY: " canonical-key ",
        FAL_API_KEY: "legacy-key",
      }),
    ).toBe("canonical-key");
    expect(
      resolveFalCredentials(undefined, {
        FAL_KEY: "   ",
        FAL_API_KEY: " legacy-key ",
      }),
    ).toBe("legacy-key");
  });

  it("returns an actionable FAL_KEY error without echoing credential input", () => {
    const secretLikeInput = "   ";
    expect(() =>
      resolveFalCredentials(secretLikeInput, {
        FAL_KEY: "",
        FAL_API_KEY: "  ",
      }),
    ).toThrowError(
      "No fal key: set FAL_KEY in the server environment, or paste your own key in the material import panel.",
    );
  });
});
