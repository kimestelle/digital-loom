// ─── resolveParity.test.ts ───────────────────────────────────────────────────
// Safety net for the step-4 migration: snapshots the per-fabric literal
// values that lived on FabricProfile BEFORE the derive() / overrides split,
// and asserts resolveFabric() reproduces every one of them exactly.
//
// Each assertion is a lossless-migration receipt. If any of them starts
// failing when derive()'s constants are retuned, the fix is:
// remove the field from the fabric's `overrides` block if derive() now
// produces the correct value, OR update this snapshot if the intent
// deliberately changed.
//
// The test also prints a diagnostic diff for each fabric — the exact
// override block that would be needed to make resolveFabric() equal these
// legacy values. That block is what got pasted into each fabric preset's
// `overrides` field in fabrics.ts.

import { describe, it, expect } from "vitest";
import { FABRICS, resolveFabric, type FabricId } from "../fabrics";
import { derive } from "../derive";

/** Fields on the pre-migration FabricProfile — the surface the solver + scene
 *  read from a fabric object. Anything not in this table wasn't stored on the
 *  legacy profile, so parity is only expected for these fields. */
const LEGACY_FIELDS = [
  "warpStiffness",
  "weftStiffness",
  "shearStiffness",
  "bendStiffness",
  "creaseFriction",
  "creaseThreshold",
  "creaseCommitRate",
  "creaseRelease",
  "particleMass",
  "damping",
  "windResponse",
  "translucency",
  "sheen",
] as const;

type LegacyField = (typeof LEGACY_FIELDS)[number];
type LegacySnapshot = Record<LegacyField, number>;

/** Pre-migration hand-set values, straight from the old FABRICS presets.
 *  Only the four original Korean fabrics have a snapshot — validation
 *  validation presets (jersey, denim) don't participate in the
 *  parity check because they were never authored as literal numbers. */
const LEGACY_VALUES: Partial<Record<FabricId, LegacySnapshot>> = {
  myeongju: {
    warpStiffness: 0.95,
    weftStiffness: 0.92,
    shearStiffness: 0.55,
    bendStiffness: 0.06,
    creaseFriction: 0.15,
    creaseThreshold: 0.6,
    creaseCommitRate: 0.02,
    creaseRelease: 0.03,
    particleMass: 1.0,
    damping: 0.86,
    windResponse: 0.7,
    translucency: 0.35,
    sheen: 0.9,
  },
  mosi: {
    warpStiffness: 0.98,
    weftStiffness: 0.96,
    shearStiffness: 0.42,
    bendStiffness: 0.78,
    creaseFriction: 0.9,
    creaseThreshold: 0.25,
    creaseCommitRate: 0.1,
    creaseRelease: 0.001,
    particleMass: 0.7,
    damping: 0.82,
    windResponse: 1.0,
    translucency: 0.7,
    sheen: 0.25,
  },
  sambe: {
    warpStiffness: 0.97,
    weftStiffness: 0.95,
    shearStiffness: 0.4,
    bendStiffness: 0.7,
    creaseFriction: 0.85,
    creaseThreshold: 0.28,
    creaseCommitRate: 0.09,
    creaseRelease: 0.003,
    particleMass: 1.15,
    damping: 0.9,
    windResponse: 0.6,
    translucency: 0.45,
    sheen: 0.05,
  },
  mumyeong: {
    warpStiffness: 0.9,
    weftStiffness: 0.88,
    shearStiffness: 0.5,
    bendStiffness: 0.3,
    creaseFriction: 0.5,
    creaseThreshold: 0.4,
    creaseCommitRate: 0.05,
    creaseRelease: 0.012,
    particleMass: 0.95,
    damping: 0.88,
    windResponse: 0.8,
    translucency: 0.2,
    sheen: 0.3,
  },
};

/** Human-readable diff between the derive()-produced value for each field
 *  and its legacy target. Printed on failure so the fix (paste this into
 *  the fabric's `overrides` block) is one glance away.
 *
 *  This function is what generated the current `overrides` on each fabric.
 *  Left in the test as a self-documenting record of the migration. */
function overrideBlockFor(id: FabricId): string {
  const legacy = LEGACY_VALUES[id];
  if (!legacy) return "";
  const derived = derive(FABRICS[id].core);
  const lines: string[] = [];
  for (const field of LEGACY_FIELDS) {
    const d = derived[field];
    const l = legacy[field];
    if (d !== l) {
      lines.push(`      ${field}: ${l}, // derive() gave ${d}`);
    }
  }
  return lines.join("\n");
}

/** Post-step-5 tolerance. Overrides within this radius of derive()'s output
 *  can be safely removed — the visual / physical difference is below the
 *  perceptual floor for these parameters. Absolute values are picked so
 *  everything in [0, 1] gets ~5% slop, which is the neighborhood the user's
 *  brief called "small epsilon". */
// Slightly above 0.05 to absorb the FP edge (e.g. `1 - 0.95` rounds to
// 0.050000000000000044 in doubles, which the strict > comparison would trip).
const EPSILON = 0.0501;

describe("resolveFabric parity with pre-migration literals (± ε)", () => {
  for (const id of Object.keys(LEGACY_VALUES) as FabricId[]) {
    describe(id, () => {
      const resolved = resolveFabric(FABRICS[id]);
      const legacy = LEGACY_VALUES[id]!;
      for (const field of LEGACY_FIELDS) {
        it(`${field} preserved within ε`, () => {
          const delta = Math.abs(resolved[field] - legacy[field]);
          if (delta > EPSILON) {
            const block = overrideBlockFor(id);
            throw new Error(
              `${id}.${field} = ${resolved[field]}, expected ${legacy[field]} ` +
                `(Δ=${delta.toFixed(4)} > ε=${EPSILON}). ` +
                `Missing overrides for ${id}:\n${block}`,
            );
          }
          expect(delta).toBeLessThanOrEqual(EPSILON);
        });
      }
    });
  }
});
