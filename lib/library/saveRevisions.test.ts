import { describe, expect, it } from "vitest";
import { SaveRevisionRegistry } from "./saveRevisions";

describe("SaveRevisionRegistry", () => {
  it("keeps the newest revision current for each resource", () => {
    const registry = new SaveRevisionRegistry();
    const first = registry.reserve("preset:a");
    const other = registry.reserve("preset:b");
    const second = registry.reserve("preset:a");

    expect(registry.isCurrent(first)).toBe(false);
    expect(registry.isCurrent(second)).toBe(true);
    expect(registry.isCurrent(other)).toBe(true);
  });
});
