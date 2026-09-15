#!/usr/bin/env node
/** Five optical keyframes from the application's actual authored daylight path.
 * Node 22.18+ can load this import without adding another TypeScript runtime.
 * The approved 09:00 field is verified and reused, never overwritten.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveRoomLight } from "../lib/ui/roomLight.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledPython = "/Applications/Blender.app/Contents/Resources/5.1/python/bin/python3.13";
const { values } = parseArgs({
  options: {
    python: { type: "string", default: existsSync(bundledPython) ? bundledPython : "python3" },
    "aperture-samples": { type: "string", default: "1536" },
    "output-dir": { type: "string", default: resolve(repository, "public/2d-textures") },
  },
});
const sampleCount = Number(values["aperture-samples"]);
if (!Number.isInteger(sampleCount) || sampleCount < 256) {
  throw new Error("--aperture-samples must be an integer of at least 256");
}
const output = resolve(values["output-dir"]);
mkdirSync(output, { recursive: true });
const sourceDirectory = resolve(repository, "public/2d-textures");
const approved = JSON.parse(readFileSync(resolve(sourceDirectory, "room-sunlight-morning.json"), "utf8"));
const approvedHash = "ddcf9fce0bf1adec30bc7ba4046706f15aad7decca9d9167b0966878a3970c11";
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
if (digest(resolve(sourceDirectory, "room-sunlight-morning.png")) !== approvedHash
  || approved.checks.pngSha256 !== approvedHash) {
  throw new Error("The approved morning optical field changed; review it before extending the set");
}
const frames = [];
const results = [];
for (const [hour, name] of [[6, "dawn"], [9, "morning"], [12, "noon"], [15, "afternoon"], [18, "dusk"]]) {
  const pathPosition = hour / 24;
  const light = resolveRoomLight(pathPosition);
  const direction = { x: light.lightDirection.x, y: -light.lightDirection.z, z: light.lightDirection.y };
  const basename = `room-sunlight-${name}`;
  const metadataPath = resolve(output, `${basename}.json`);
  const imagePath = resolve(output, `${basename}.png`);
  if (hour !== 9 && !existsSync(metadataPath) && !existsSync(imagePath)) {
    const child = spawnSync(values.python, [
      "-u", resolve(repository, "scripts/bake-room-sunlight.py"),
      "--output-dir", output, "--name", basename,
      "--aperture-samples", String(sampleCount),
      "--path-position", String(pathPosition),
      "--direction", ...Object.values(direction).map(String),
      "--exposure", String(approved.encoding.exposure),
    ], { stdio: "inherit" });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${basename} bake failed (${child.status})`);
  }
  const metadata = hour === 9 ? approved : JSON.parse(readFileSync(metadataPath, "utf8"));
  const pngPath = hour === 9 ? resolve(sourceDirectory, `${basename}.png`) : imagePath;
  const validDirection = Object.keys(direction).every((axis) => Math.abs(direction[axis] - metadata.direction[axis]) < 1e-10);
  if (!validDirection || metadata.pathPosition !== pathPosition
    || metadata.encoding.exposure !== approved.encoding.exposure
    || digest(pngPath) !== metadata.checks.pngSha256) {
    throw new Error(`${basename} does not match the actual resolver, shared exposure, or recorded hash`);
  }
  if (hour !== 9 && metadata.transport.apertureSamples[0] !== sampleCount) {
    throw new Error(`${basename} exists with a different sample count; choose a separate output directory to rebake`);
  }
  const { image, width, height, bounds, aperture, checks } = metadata;
  frames.push({ pathPosition, image, width, height, bounds, aperture, direction: metadata.direction, checks: { pngSha256: checks.pngSha256 } });
  results.push({ hour, bytes: readFileSync(pngPath).byteLength, apertureSamples: metadata.transport.apertureSamples,
    rays: metadata.transport.raysTotal, seconds: checks.bakeSeconds ?? null });
}
writeFileSync(resolve(output, "room-sunlight-day.json"), JSON.stringify({ schemaVersion: 1, frames }, null, 2) + "\n");
console.log(JSON.stringify({ frames: results, pngBytes: results.reduce((total, frame) => total + frame.bytes, 0),
  exposure: approved.encoding.exposure, morningPreserved: true }, null, 2));
