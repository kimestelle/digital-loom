// ─── fabricSerial.test.ts ────────────────────────────────────────────────────
// Wire-format contract for FabricProfile. Every preset must survive a
// serialize → parse round-trip losslessly, and the parser must reject shapes
// that leak resolved values or unknown keys — that's the guarantee the
// tuning tool relies on when it edits the on-disk JSON.

import { describe, expect, it } from "vitest";
import {
  FABRIC_SERIAL_VERSION,
  parseFabric,
  serializeFabric,
} from "../fabricSerial";
import { FABRICS, type FabricId } from "../fabrics";

const IDS = Object.keys(FABRICS) as FabricId[];

describe("serializeFabric / parseFabric round-trip", () => {
  for (const id of IDS) {
    it(`${id} — parse(serialize(p)) deep-equals p`, () => {
      const original = FABRICS[id];
      const round = parseFabric(serializeFabric(original));
      expect(round).toEqual(original);
    });
  }
});

describe("serializeFabric output shape", () => {
  it("emits only { version, id, names, urls, core, overrides }", () => {
    const s = JSON.parse(serializeFabric(FABRICS.myeongju)) as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual([
      "core",
      "id",
      "names",
      "overrides",
      "urls",
      "version",
    ]);
    expect(s.version).toBe(FABRIC_SERIAL_VERSION);
  });

  it("never emits resolved (derived) fields at the top level", () => {
    const s = JSON.parse(serializeFabric(FABRICS.mosi)) as Record<string, unknown>;
    for (const forbidden of [
      "translucency",
      "warpStiffness",
      "bendStiffness",
      "openness",
      "particleMass",
    ]) {
      expect(forbidden in s).toBe(false);
    }
  });

  it("always emits an overrides object, even when empty", () => {
    const stripped = { ...FABRICS.myeongju, overrides: {} };
    const s = JSON.parse(serializeFabric(stripped)) as Record<string, unknown>;
    expect(s.overrides).toEqual({});
  });
});

describe("parseFabric rejection cases", () => {
  const good = serializeFabric(FABRICS.mumyeong);

  it("rejects invalid JSON", () => {
    expect(() => parseFabric("{not json")).toThrow(/invalid JSON/);
  });

  it("rejects a wrong version", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    obj.version = 999;
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(/unsupported version/);
  });

  it("rejects unknown top-level keys", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    obj.extra = 1;
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(/unknown key "extra"/);
  });

  it("rejects an unknown key inside core", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    (obj.core as Record<string, unknown>).mystery = 0;
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(/unknown key "core.mystery"/);
  });

  it("rejects a resolved value pasted into overrides that isn't a legal knob", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    (obj.overrides as Record<string, unknown>).madeUpKnob = 0.5;
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(/madeUpKnob/);
  });

  it("rejects a non-numeric override value", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    (obj.overrides as Record<string, unknown>).sheen = "shiny";
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(
      /overrides.sheen must be a finite number/,
    );
  });

  it("rejects an unknown fiberType enum value", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    (obj.core as Record<string, unknown>).fiberType = "carbonNanotube";
    expect(() => parseFabric(JSON.stringify(obj))).toThrow(/fiberType/);
  });

  it("treats missing overrides as {}", () => {
    const obj = JSON.parse(good) as Record<string, unknown>;
    delete obj.overrides;
    const p = parseFabric(JSON.stringify(obj));
    expect(p.overrides).toEqual({});
  });
});
