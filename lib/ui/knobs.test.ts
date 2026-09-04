import { describe, expect, it } from "vitest";
import { DEFAULT_KNOBS, fabricKnobsOf } from "./knobs";

describe("tuning state boundary", () => {
  it("keeps mouse interaction strength out of material serialization", () => {
    expect(DEFAULT_KNOBS.mouseForce).toBe(3);
    expect(fabricKnobsOf(DEFAULT_KNOBS)).not.toHaveProperty("mouseForce");
  });
});
