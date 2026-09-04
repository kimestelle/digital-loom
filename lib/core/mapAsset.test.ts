import { describe, expect, it } from "vitest";
import {
  inspectMapAsset,
  mapPackageSha256,
  verifyMapAsset,
} from "./mapAsset";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x05,
]).buffer;

describe("map asset identity", () => {
  it("records digest, byte length, and dimensions from the bytes", async () => {
    const metadata = await inspectMapAsset(PNG);
    expect(metadata).toMatchObject({
      byteLength: 24,
      width: 7,
      height: 5,
    });
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyMapAsset(PNG, metadata)).resolves.toEqual(metadata);
  });

  it("rejects changed bytes even when dimensions and length are unchanged", async () => {
    const metadata = await inspectMapAsset(PNG);
    const changed = PNG.slice(0);
    new Uint8Array(changed)[11] ^= 1;
    await expect(verifyMapAsset(changed, metadata)).rejects.toThrow(/sha256 mismatch/);
  });

  it("derives package identity from every named map byte set", async () => {
    const first = new Map([["albedo.png", PNG]]);
    const same = new Map([["albedo.png", PNG.slice(0)]]);
    const changedBytes = PNG.slice(0);
    new Uint8Array(changedBytes)[23] ^= 1;
    const changed = new Map([["albedo.png", changedBytes]]);

    await expect(mapPackageSha256(first)).resolves.toBe(
      await mapPackageSha256(same),
    );
    await expect(mapPackageSha256(changed)).resolves.not.toBe(
      await mapPackageSha256(first),
    );
  });
});
