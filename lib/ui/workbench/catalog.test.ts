import { describe, expect, it } from "vitest";
import { COMPONENTS, exportTokens, safeTokenValue, sanitizeDrafts } from "./catalog";

describe("component workbench drafts", () => {
  it("keeps only known specimens and known token names", () => {
    expect(sanitizeDrafts({ logo: { "--room-control-size": "52px", secret: "value" }, unrelated: { "--room-control-size": "80px" } }, { "--room-control-size": "44px" }))
      .toEqual({ logo: { "--room-control-size": "52px" } });
  });
  it("rejects malformed saved data and CSS rule injection", () => {
    expect(sanitizeDrafts(null, {})).toEqual({});
    for (const value of [null, 1, "", "red; body{display:none}", "x".repeat(257)]) expect(safeTokenValue(value)).toBe(false);
    expect(safeTokenValue("rgba(255, 255, 255, 0.5)")).toBe(true);
    expect(safeTokenValue("var(--room-ui-ink)")).toBe(true);
  });
  it("exports a reviewable CSS draft, not an implicit application write", () => {
    const css = exportTokens("logo", { "--room-control-size": "52px" });
    expect(css).toContain("logo specimen draft");
    expect(css).toContain("--room-control-size: 52px;");
    expect(css).toContain("Review shared effects");
  });
  it("has unique specimen identities", () => {
    expect(new Set(COMPONENTS.map(c => c.id)).size).toBe(COMPONENTS.length);
  });
});
