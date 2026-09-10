// Bounded map sampling shared by auto-tuning and the room-light material cue.
// The luminance/saturation math intentionally matches estimateParams.ts so
// moving that caller onto this module does not change its output.

export const MAP_STATS_SAMPLE_SIZE = 64;

export interface MapRgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface MapStats {
  /** Mean Rec.709 luminance in 0..1. */
  readonly mean: number;
  /** Standard deviation of Rec.709 luminance in 0..1. */
  readonly std: number;
  /** Fraction of pixels below 0.18 luminance. */
  readonly darkFrac: number;
  /** Mean HSV-style saturation in 0..1. */
  readonly sat: number;
  /** Mean normalized source RGB, used to tint transmitted room light. */
  readonly meanRgb: MapRgbColor;
}

export type MapStatsStatus = "ready" | "stale" | "fallback";

export interface ResolvedMapStats {
  readonly url: string;
  readonly status: MapStatsStatus;
  readonly stats: MapStats;
}

export interface MapStatsPixelSample {
  /** Packed RGBA channels in the 0..255 range. */
  readonly data: ArrayLike<number>;
}

export type MapStatsPixelLoader = (
  url: string,
  sampleSize: number,
) => Promise<MapStatsPixelSample | null>;

export interface ReadMapStatsOptions {
  /**
   * Called after sampling. Return false when the URL no longer belongs to the
   * active material; a neutral `stale` result is returned instead.
   */
  isCurrent?: (url: string) => boolean;
  /** Optional loader for workers, tests, or a future OffscreenCanvas path. */
  loadPixels?: MapStatsPixelLoader;
}

const neutralRgb = Object.freeze({ r: 0.5, g: 0.5, b: 0.5 });

/** A visually neutral room-light result. Estimation callers should use the
 * nullable `getMapStats` API so failure continues to leave knobs untouched. */
export const NEUTRAL_MAP_STATS: MapStats = Object.freeze({
  mean: 0.5,
  std: 0,
  darkFrac: 0,
  sat: 0,
  meanRgb: neutralRgb,
});

const successfulStats = new Map<string, MapStats>();
const inFlightStats = new Map<string, Promise<MapStats | null>>();

const freezeStats = (stats: MapStats): MapStats =>
  Object.freeze({
    ...stats,
    meanRgb: Object.freeze({ ...stats.meanRgb }),
  });

/** Calculate statistics from packed RGBA bytes. Alpha intentionally does not
 * affect the result, matching the original estimateParams implementation. */
export function mapStatsFromRgba(data: ArrayLike<number>): MapStats | null {
  const pixelCount = Math.floor(data.length / 4);
  if (pixelCount < 1) return null;

  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let satSum = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const red = Math.min(255, Math.max(0, Number(data[offset]) || 0)) / 255;
    const green =
      Math.min(255, Math.max(0, Number(data[offset + 1]) || 0)) / 255;
    const blue =
      Math.min(255, Math.max(0, Number(data[offset + 2]) || 0)) / 255;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sum += luminance;
    sumSq += luminance * luminance;
    if (luminance < 0.18) dark++;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    satSum +=
      maxChannel > 1e-4 ? (maxChannel - minChannel) / maxChannel : 0;
    redSum += red;
    greenSum += green;
    blueSum += blue;
  }

  const mean = sum / pixelCount;
  return freezeStats({
    mean,
    std: Math.sqrt(Math.max(0, sumSq / pixelCount - mean * mean)),
    darkFrac: dark / pixelCount,
    sat: satSum / pixelCount,
    meanRgb: {
      r: redSum / pixelCount,
      g: greenSum / pixelCount,
      b: blueSum / pixelCount,
    },
  });
}

const loadPixelsFromDom: MapStatsPixelLoader = async (url, sampleSize) => {
  if (
    typeof Image === "undefined" ||
    typeof document === "undefined" ||
    !url
  ) {
    return null;
  }

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const next = new Image();
    next.crossOrigin = "anonymous";
    next.onload = () => resolve(next);
    next.onerror = () => resolve(null);
    next.src = url;
  });
  if (!image) return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, sampleSize, sampleSize);
    return {
      data: context.getImageData(0, 0, sampleSize, sampleSize).data,
    };
  } catch {
    // CORS-tainted canvases, decoding trouble, and unavailable contexts are
    // all non-fatal. The estimator keeps its current knobs; the room uses its
    // explicit neutral fallback.
    return null;
  }
};

/**
 * Read and cache a map by URL. Only successful statistics are cached; a map
 * that failed while unavailable may be retried later. Concurrent reads share
 * one in-flight sample.
 */
export async function getMapStats(
  url: string,
  loadPixels: MapStatsPixelLoader = loadPixelsFromDom,
): Promise<MapStats | null> {
  if (!url) return null;
  const cached = successfulStats.get(url);
  if (cached) return cached;

  const inFlight = inFlightStats.get(url);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const sample = await loadPixels(url, MAP_STATS_SAMPLE_SIZE);
      const stats = sample ? mapStatsFromRgba(sample.data) : null;
      if (stats) successfulStats.set(url, stats);
      return stats;
    } catch {
      return null;
    }
  })();
  inFlightStats.set(url, request);

  try {
    return await request;
  } finally {
    if (inFlightStats.get(url) === request) inFlightStats.delete(url);
  }
}

/**
 * Room-light-facing read. It never throws or returns null, and it performs the
 * active-material check after the asynchronous sampling boundary.
 */
export async function readMapStats(
  url: string,
  options: ReadMapStatsOptions = {},
): Promise<ResolvedMapStats> {
  const stats = await getMapStats(url, options.loadPixels);
  if (options.isCurrent && !options.isCurrent(url)) {
    return { url, status: "stale", stats: NEUTRAL_MAP_STATS };
  }
  if (!stats) {
    return { url, status: "fallback", stats: NEUTRAL_MAP_STATS };
  }
  return { url, status: "ready", stats };
}

/** Primarily for deterministic tests and explicit asset invalidation. */
export function clearMapStatsCache(url?: string): void {
  if (url === undefined) {
    successfulStats.clear();
    inFlightStats.clear();
    return;
  }
  successfulStats.delete(url);
  inFlightStats.delete(url);
}

export function hasCachedMapStats(url: string): boolean {
  return successfulStats.has(url);
}
