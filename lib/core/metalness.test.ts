import { describe, expect, it } from "vitest";
import { resolveMetalnessAmount } from "./metalness";

describe("metalness source truth", () => {
  it("uses a present map at neutral strength when no scalar was authored", () => {
    expect(resolveMetalnessAmount("", true)).toBe(1);
    expect(resolveMetalnessAmount("", false)).toBe(0);
  });

  it("preserves an explicit imported zero and clamps authored values", () => {
    expect(resolveMetalnessAmount("0", true)).toBe(0);
    expect(resolveMetalnessAmount(0, true)).toBe(0);
    expect(resolveMetalnessAmount(2, true)).toBe(1);
    expect(resolveMetalnessAmount(-1, false)).toBe(0);
  });
});
