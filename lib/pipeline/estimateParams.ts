"use client";

// ─── estimateParams.ts ────────────────────────────────────────────────────────
// A cheap, dependency-free auto-tune. When a new material is extracted we don't
// want the user to start from flat defaults on every fabric — so we look at the
// maps the Patina model produced and estimate a starting point for the knobs
// the maps can actually inform:
//
//   sheen        ← roughness map mean   (shiny cloth = low roughness = high sheen)
//   pomScale     ← height map contrast  (deep weave relief = stronger parallax)
//   openness     ← albedo dark fraction (gaps/sheer sections read as holes)
//   normalAmount ← normal map deviation (flat normal → dial the perturbation down)
//   metalness    ← metalness map mean   (bright metal areas → suggest an amount)
//
// Deliberately conservative: it nudges toward the material, it doesn't override
// taste, and it only touches params the pixels genuinely speak to (weight,
// weave stiffness, edge fray, tiling are left at their defaults — no map tells
// you those). Everything is sampled at a tiny 64² downscale, so the whole pass
// is a few milliseconds on the GPU-backed canvas. Same-origin maps → no taint.
//
// This is the "or an algorithm" path; a vision model could later replace the
// heuristics wholesale behind the same signature.

import type { MaterialPackage } from "@/lib/core/materialPackage";
import type { FabricKnobs } from "@/lib/ui/knobs";

export interface EstimatedParams {
  knobs: Partial<FabricKnobs>;
  /** Suggested insert-panel metalness amount (0..1), or 0 if none. */
  metalness: number;
}

const SAMPLE = 64;

interface MapStats {
  /** mean luminance 0..1 */
  mean: number;
  /** std-dev of luminance 0..1 */
  std: number;
  /** fraction of pixels below 0.18 luminance */
  darkFrac: number;
  /** mean saturation 0..1 */
  sat: number;
}

async function statsFor(url: string): Promise<MapStats | null> {
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = c.height = SAMPLE;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch {
    return null; // cross-origin taint — bail, keep defaults
  }
  const n = SAMPLE * SAMPLE;
  let sum = 0, sumSq = 0, dark = 0, satSum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const r = data[j] / 255, g = data[j + 1] / 255, b = data[j + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    sumSq += lum * lum;
    if (lum < 0.18) dark++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx > 1e-4 ? (mx - mn) / mx : 0;
  }
  const mean = sum / n;
  return {
    mean,
    std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    darkFrac: dark / n,
    sat: satSum / n,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Analyse the package's maps and propose starting knob values. Never throws —
 *  any map that won't sample is simply skipped, leaving that knob untouched. */
export async function estimateParams(
  pkg: MaterialPackage,
): Promise<EstimatedParams> {
  const knobs: Partial<FabricKnobs> = {};
  let metalness = 0;

  const [rough, height, albedo, normal, metal] = await Promise.all([
    pkg.maps.roughness ? statsFor(pkg.maps.roughness.url) : null,
    pkg.maps.height ? statsFor(pkg.maps.height.url) : null,
    pkg.maps.albedo ? statsFor(pkg.maps.albedo.url) : null,
    pkg.maps.normal ? statsFor(pkg.maps.normal.url) : null,
    pkg.maps.metalness ? statsFor(pkg.maps.metalness.url) : null,
  ]);

  // Sheen: inverse of roughness. A glossy silk (roughness ~0.2) → sheen ~0.9;
  // a matte hemp (roughness ~0.7) → sheen ~0.2.
  if (rough) knobs.sheen = clamp(1.0 - rough.mean * 1.15, 0.08, 1.0);

  // POM depth: how much the height field varies. Flat weave → shallow; deep
  // slub/relief → stronger parallax. std ~0.03 → 0.008, std ~0.18 → ~0.035.
  if (height) knobs.pomScale = clamp(0.006 + height.std * 0.16, 0.005, 0.04);

  // Openness: sheer fabrics photograph with dark gaps between threads. Use the
  // albedo's dark fraction as a proxy, gently — most fabric is opaque.
  if (albedo) knobs.openness = clamp(0.4 + albedo.darkFrac * 1.2, 0.35, 0.85);

  // Normal strength: a near-flat normal map (little deviation from blue) means
  // there's not much micro-relief to lean on — ease the perturbation off.
  if (normal) knobs.normalAmount = clamp(0.4 + normal.sat * 3.5, 0.4, 1.0);

  // Metalness suggestion: only if the map actually has bright (metallic) areas.
  // Mostly-black metalness map → leave at 0 (dielectric fabric).
  if (metal && metal.mean > 0.08) metalness = clamp(metal.mean * 1.8, 0, 1);

  return { knobs, metalness };
}
