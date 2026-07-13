// Contract test for the checked-in fabrics/*.json dumps. Verifies each file
// matches what serializeFabric() would produce for FABRICS[id] byte-for-byte
// and that parseFabric(json) reconstructs the profile.
//
// To regenerate after intentionally changing a preset:
//     UPDATE_FIXTURES=1 npm test

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFabric, serializeFabric } from "../fabricSerial";
import { FABRICS, type FabricId } from "../fabrics";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FABRICS_DIR = resolve(REPO_ROOT, "fabrics");
const IDS = Object.keys(FABRICS) as FabricId[];
const UPDATE = process.env.UPDATE_FIXTURES === "1";

describe("fabrics/*.json checked-in dumps", () => {
  if (UPDATE) {
    it("regenerates every preset dump (UPDATE_FIXTURES=1)", () => {
      if (!existsSync(FABRICS_DIR)) mkdirSync(FABRICS_DIR, { recursive: true });
      for (const id of IDS) {
        writeFileSync(
          resolve(FABRICS_DIR, `${id}.json`),
          serializeFabric(FABRICS[id]),
        );
      }
    });
    return;
  }

  for (const id of IDS) {
    describe(id, () => {
      const path = resolve(FABRICS_DIR, `${id}.json`);

      it("exists on disk", () => {
        expect(existsSync(path)).toBe(true);
      });

      it("matches serializeFabric(FABRICS[id]) byte-for-byte", () => {
        const onDisk = readFileSync(path, "utf8");
        expect(onDisk).toBe(serializeFabric(FABRICS[id]));
      });

      it("parseFabric(json) round-trips back to FABRICS[id]", () => {
        const onDisk = readFileSync(path, "utf8");
        expect(parseFabric(onDisk)).toEqual(FABRICS[id]);
      });
    });
  }
});
