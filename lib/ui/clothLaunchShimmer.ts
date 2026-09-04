// One-shot launch treatment for the real cloth material. The ordering map is
// generated once on the CPU, uploaded as a tiny repeating texture, and sampled
// only while the launch uniform is below 1. The steady-state material therefore
// pays no noise work after the cloth has arrived.

export const CLOTH_LAUNCH_SHIMMER_DURATION_MS = 560;
export const CLOTH_LAUNCH_NOISE_WINDOW_MS = 160;
export const CLOTH_LAUNCH_TOTAL_MS =
  CLOTH_LAUNCH_SHIMMER_DURATION_MS + CLOTH_LAUNCH_NOISE_WINDOW_MS;
export const CLOTH_LAUNCH_MAP_WAIT_MS = 900;

// Launch only: an O(vertices) catenary seed establishes the silhouette, then a
// handful of constraint passes removes local error. The live solver gets a
// short hidden head start before the shimmer. Later resolution swaps still
// receive the full off-screen settle.
export const CLOTH_LAUNCH_SETTLE_STEPS = 8;
export const CLOTH_LAUNCH_SETTLE_ITERATIONS = 6;
export const CLOTH_LAUNCH_HIDDEN_SETTLE_TICKS = 16;

export const CLOTH_LAUNCH_MAP_SIZE = 64;
const MAP_PERIOD = 192;
const DEFAULT_SEED = seedShimmerMap("digital-loom:cloth-launch");

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function easeGrid(value: number) {
  return value * value * (3 - 2 * value);
}

function hashGridPoint(x: number, y: number, seed: number) {
  let hash = seed ^ Math.imul(x + 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(y + 0xc2b2ae35, 0x27d4eb2f);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

function samplePeriodicGrid(
  x: number,
  y: number,
  cells: number,
  seed: number,
) {
  const gridX = (positiveModulo(x, MAP_PERIOD) / MAP_PERIOD) * cells;
  const gridY = (positiveModulo(y, MAP_PERIOD) / MAP_PERIOD) * cells;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const tx = easeGrid(gridX - x0);
  const ty = easeGrid(gridY - y0);
  const top =
    hashGridPoint(x0, y0, seed) +
    (hashGridPoint(x1, y0, seed) - hashGridPoint(x0, y0, seed)) * tx;
  const bottom =
    hashGridPoint(x0, y1, seed) +
    (hashGridPoint(x1, y1, seed) - hashGridPoint(x0, y1, seed)) * tx;
  return top + (bottom - top) * ty;
}

function sampleClusteredNoise(x: number, y: number, seed: number) {
  const broad = samplePeriodicGrid(x, y, 4, seed);
  const medium = samplePeriodicGrid(x, y, 8, seed ^ 0x68bc21eb);
  const fine = samplePeriodicGrid(x, y, 16, seed ^ 0x02e5be93);
  return broad * 0.82 + medium * 0.16 + fine * 0.02;
}

export function seedShimmerMap(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface LaunchDrapeTarget {
  readonly cols: number;
  readonly rows: number;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly pinned: Uint8Array;
}

/**
 * O(vertices) launch pose. `snapPins` must run first so pinned top-row values
 * already sit on the live rope. A vertical sheet is translated to that line,
 * then its free top edge receives a shallow catenary between pegs. Vertical
 * warp lengths remain exact, so the live solver has very little correction
 * debt and no visible gravity drop to work through.
 */
export function seedClothLaunchDrape(
  target: LaunchDrapeTarget,
  spacing: number,
) {
  const pinnedColumns: number[] = [];
  for (let column = 0; column < target.cols; column++) {
    if (target.pinned[column]) pinnedColumns.push(column);
  }
  if (pinnedColumns.length === 0) return;

  const topY = new Float32Array(target.cols);
  const first = pinnedColumns[0];
  const last = pinnedColumns[pinnedColumns.length - 1];
  let segment = 0;
  for (let column = 0; column < target.cols; column++) {
    if (target.pinned[column]) {
      topY[column] = target.pos[column * 3 + 1];
      continue;
    }
    if (column < first) {
      const distance = (first - column) / Math.max(1, first);
      topY[column] = target.pos[first * 3 + 1] + 10 * distance * distance;
      continue;
    }
    if (column > last) {
      const distance =
        (column - last) / Math.max(1, target.cols - 1 - last);
      topY[column] = target.pos[last * 3 + 1] + 10 * distance * distance;
      continue;
    }

    while (
      segment + 1 < pinnedColumns.length - 1 &&
      column > pinnedColumns[segment + 1]
    ) {
      segment++;
    }
    const left = pinnedColumns[segment];
    const right = pinnedColumns[segment + 1];
    const amount = (column - left) / Math.max(1, right - left);
    const leftY = target.pos[left * 3 + 1];
    const rightY = target.pos[right * 3 + 1];
    const span = (right - left) * spacing;
    const sag =
      right - left <= 2
        ? 0
        : Math.sin(Math.PI * amount) * Math.min(28, span * 0.07);
    topY[column] = leftY + (rightY - leftY) * amount + sag;
  }

  for (let row = 0; row < target.rows; row++) {
    for (let column = 0; column < target.cols; column++) {
      const index = (row * target.cols + column) * 3;
      target.pos[index + 1] = topY[column] + row * spacing;
      target.prev[index] = target.pos[index];
      target.prev[index + 1] = target.pos[index + 1];
      target.prev[index + 2] = target.pos[index + 2];
    }
  }
}

/** RGBA8 map: R = normalized reveal order, G = independent palette sample. */
export function createClothLaunchShimmerData(
  size = CLOTH_LAUNCH_MAP_SIZE,
  seed = DEFAULT_SEED,
) {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error("cloth launch shimmer size must be an integer >= 2");
  }

  const order = new Float32Array(size * size);
  const hue = new Float32Array(size * size);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x / size) * MAP_PERIOD;
      const py = (y / size) * MAP_PERIOD;
      const index = y * size + x;
      const sampled = sampleClusteredNoise(px, py, seed);
      order[index] = sampled;
      hue[index] = sampleClusteredNoise(
        px + MAP_PERIOD * 0.37,
        py + MAP_PERIOD * 0.19,
        seed,
      );
      minimum = Math.min(minimum, sampled);
      maximum = Math.max(maximum, sampled);
    }
  }

  const range = Math.max(0.00001, maximum - minimum);
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < order.length; index++) {
    data[index * 4] = Math.round(((order[index] - minimum) / range) * 255);
    data[index * 4 + 1] = Math.round(hue[index] * 255);
    data[index * 4 + 2] = 0;
    data[index * 4 + 3] = 255;
  }
  return data;
}
