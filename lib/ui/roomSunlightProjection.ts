import type { RoomFloorProjectionLayout } from "./roomFloorProjection";
import type { ResolvedRoomLight } from "./roomLight";

export interface RoomSunlightBake {
  width: number;
  height: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  aperture: { width: number; bottom: number; top: number };
  direction: { x: number; y: number; z: number };
  pathPosition: number;
  image: string;
}

type Matrix3 = [number, number, number, number, number, number, number, number, number];
type Point = { x: number; y: number };

export interface RoomSunlightSourceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Same projective floor as scripts/bake-room-textures.py, calibrated to a
// 3.4m wall span / 4m floor depth. Vertical lines remain vertical in the drawing.
// This is a scene-layout proxy, not a claim that the stylized room and the
// oblique cloth camera share a fully reconstructed physical camera.
const FLOOR: Matrix3 = [1099.447653, 80.802732, 0.5, 0.097473, -0.136062, 662.5, 0.194946, -0.272124, 1];
const WALL_METRES = 3.4;
const DEPTH_METRES = 4;
const VERTICAL_PIXELS_PER_METRE = 250;

const multiply = (a: Matrix3, b: Matrix3): Matrix3 => {
  const out = new Array<number>(9).fill(0) as Matrix3;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    for (let k = 0; k < 3; k++) out[row * 3 + col] += a[row * 3 + k] * b[k * 3 + col];
  }
  return out;
};

export function morningSunlightWeight(position: number, bakedPosition = 0.375): number {
  if (!Number.isFinite(position) || !Number.isFinite(bakedPosition)) return 0;
  // Compatibility envelope for the original single-image study. The daylight
  // atlas supplies temporalWeight explicitly instead of using this window.
  const distance = Math.abs(position - bakedPosition);
  const t = Math.max(0, Math.min(1, (distance - 0.0125) / 0.0375));
  return 1 - t * t * (3 - 2 * t);
}

export interface RoomSunlightProjection {
  transform: string;
  weight: number;
  /** CSS-pixel corners, useful for alignment checks without a second renderer. */
  corners: { x: number; y: number }[];
  /** Crop wrapper dimensions; the original image sits at (-x, -y) inside it. */
  sourceBounds?: RoomSunlightSourceBounds;
}

export interface RoomSunlightProjectionOptions {
  /**
   * Atlas selection supplies its own temporal envelope. Omit to retain the
   * original single-morning study; pass 1 for a fully active atlas sample.
   * Solar intensity remains the room light's responsibility.
   */
  temporalWeight?: number;
  /** Trim offscreen source pixels before projecting, including horizon crossings. */
  cropToReceiver?: boolean;
}

const hidden = (): RoomSunlightProjection => ({ transform: "scale(0)", weight: 0, corners: [] });

const denominator = (matrix: Matrix3, point: Point) => matrix[6] * point.x + matrix[7] * point.y + matrix[8];
const rectangle = (bounds: RoomSunlightSourceBounds): Point[] => [
  { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
  { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
];
const project = (matrix: Matrix3, point: Point): Point => {
  const w = denominator(matrix, point);
  return { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / w,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / w };
};

/** Intersect a convex source polygon with one homogeneous half-plane. */
function clipPolygon(polygon: Point[], a: number, b: number, c: number): Point[] {
  if (!polygon.length) return polygon;
  const result: Point[] = [];
  let previous = polygon[polygon.length - 1];
  let previousDistance = a * previous.x + b * previous.y + c;
  for (const current of polygon) {
    const distance = a * current.x + b * current.y + c;
    if ((distance >= 0) !== (previousDistance >= 0)) {
      const t = previousDistance / (previousDistance - distance);
      result.push({ x: previous.x + (current.x - previous.x) * t, y: previous.y + (current.y - previous.y) * t });
    }
    if (distance >= 0) result.push(current);
    previous = current;
    previousDistance = distance;
  }
  return result;
}

function visibleSourceBounds(
  matrix: Matrix3,
  bake: RoomSunlightBake,
  layout: RoomFloorProjectionLayout,
  receiver: "floor" | "right-wall",
): RoomSunlightSourceBounds | null {
  const { room, planes } = layout;
  const offsetX = planes.left - room.left;
  const offsetY = planes.top - room.top;
  const corner = { x: offsetX + planes.width * 920.5 / 1280, y: offsetY + planes.height * 554.5 / 832 };
  const rightX = offsetX + planes.width;
  const rightY = offsetY + planes.height * 717.865 / 832;
  const leftY = offsetY + planes.height * 662.5 / 832;
  const screenPolygon = receiver === "right-wall" ? [
    { x: corner.x, y: offsetY }, { x: rightX, y: offsetY },
    { x: rightX, y: rightY }, corner,
  ] : [corner, { x: rightX, y: rightY }, { x: rightX, y: room.height },
    { x: offsetX, y: room.height }, { x: offsetX, y: leftY }];
  let polygon = clipPolygon(rectangle({ x: 0, y: 0, width: bake.width, height: bake.height }),
    matrix[6], matrix[7], matrix[8] - 1e-5);
  for (let index = 0; index < screenPolygon.length; index++) {
    const start = screenPolygon[index];
    const end = screenPolygon[(index + 1) % screenPolygon.length];
    const a = start.y - end.y;
    const b = end.x - start.x;
    const c = start.x * end.y - end.x * start.y;
    polygon = clipPolygon(polygon,
      a * matrix[0] + b * matrix[3] + c * matrix[6],
      a * matrix[1] + b * matrix[4] + c * matrix[7],
      a * matrix[2] + b * matrix[5] + c * matrix[8]);
  }
  if (polygon.length < 3) return null;
  const minX = Math.min(...polygon.map(point => point.x));
  const maxX = Math.max(...polygon.map(point => point.x));
  const minY = Math.min(...polygon.map(point => point.y));
  const maxY = Math.max(...polygon.map(point => point.y));
  // Three sigma of the approved 32px source-space bloom. Reduce only its
  // invisible padding if it approaches the projective horizon on narrow rooms.
  const padded = (padding: number): RoomSunlightSourceBounds | null => {
    const x = Math.max(0, minX - padding);
    const y = Math.max(0, minY - padding);
    const bounds = { x, y, width: Math.min(bake.width, maxX + padding) - x,
      height: Math.min(bake.height, maxY + padding) - y };
    const points = rectangle(bounds);
    if (bounds.width < 1e-5 || bounds.height < 1e-5 || points.some(point => denominator(matrix, point) <= 1e-5)) return null;
    const projected = points.map(point => project(matrix, point));
    if (projected.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= -room.width * 2 && point.x <= room.width * 3
      && point.y >= -room.height * 2 && point.y <= room.height * 3)) return bounds;
    return null;
  };
  const fullPadding = padded(96);
  if (fullPadding) return fullPadding;
  let best = padded(0);
  if (!best) return null;
  let low = 0;
  let high = 96;
  // Continuous padding avoids a crop pop while crossing an interval or resizing.
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2;
    const candidate = padded(middle);
    if (candidate) { low = middle; best = candidate; } else high = middle;
  }
  return best;
}

/**
 * Map the baked floor irradiance through the window onto a room receiver.
 * Resize changes the measured aperture, never the baked glass pattern. The
 * affine middle step preserves the ray slopes and the sill's physical height;
 * a final homography supplies each plane's perspective, sharing its seam.
 */
export function resolveRoomSunlightProjection(
  bake: RoomSunlightBake,
  light: Pick<ResolvedRoomLight, "pathPosition" | "lightDirection">,
  layout: RoomFloorProjectionLayout,
  receiver: "floor" | "right-wall" = "floor",
  options: RoomSunlightProjectionOptions = {},
): RoomSunlightProjection {
  const { room, planes, aperture } = layout;
  if (![bake.pathPosition, light.pathPosition, ...Object.values(bake.direction), ...Object.values(light.lightDirection)].every(Number.isFinite)) return hidden();
  if ([room, planes, aperture].some(rect => !Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)) return hidden();
  if (![bake.width, bake.height, bake.aperture.width, bake.aperture.top - bake.aperture.bottom,
    bake.bounds.maxX - bake.bounds.minX, bake.bounds.maxY - bake.bounds.minY].every(value => Number.isFinite(value) && value > 0)) return hidden();

  if (options.temporalWeight !== undefined && !Number.isFinite(options.temporalWeight)) return hidden();
  const weight = options.temporalWeight === undefined
    ? morningSunlightWeight(light.pathPosition, bake.pathPosition)
    : Math.max(0, Math.min(1, options.temporalWeight));
  if (weight === 0 || light.lightDirection.y >= -1e-5 || bake.direction.z >= -1e-5) return hidden();
  const x0 = (aperture.left - planes.left) * 1280 / planes.width;
  const x1 = x0 + aperture.width * 1280 / planes.width;
  const y0 = (aperture.top - planes.top) * 832 / planes.height;
  const y1 = y0 + aperture.height * 832 / planes.height;
  const wallX = (screenX: number) => (FLOOR[2] - screenX) / (screenX * FLOOR[6] - FLOOR[0]);
  const s0 = wallX(x0);
  const s1 = wallX(x1);
  const heightAt = (screenY: number) => (FLOOR[3] * s0 + FLOOR[5] - screenY * (FLOOR[6] * s0 + 1)) / VERTICAL_PIXELS_PER_METRE;
  const bottom = heightAt(y1);
  const top = heightAt(y0);
  if (bottom <= 0 || top <= bottom || s1 <= s0) return hidden();

  const widthRatio = (s1 - s0) * WALL_METRES / bake.aperture.width;
  const heightRatio = (top - bottom) / (bake.aperture.top - bake.aperture.bottom);
  const heightShift = bottom - heightRatio * bake.aperture.bottom;
  const refX = bake.direction.x / -bake.direction.z;
  const refY = bake.direction.y / -bake.direction.z;
  // Three: Y up, -Z into room. Bake: Z up, +Y into room.
  const rayX = light.lightDirection.x / -light.lightDirection.y;
  const rayY = -light.lightDirection.z / -light.lightDirection.y;
  if (refY <= 1e-5 || rayY <= 1e-5) return hidden();

  const pixelToMetres: Matrix3 = [
    (bake.bounds.maxX - bake.bounds.minX) / bake.width, 0, bake.bounds.minX,
    0, (bake.bounds.maxY - bake.bounds.minY) / bake.height, bake.bounds.minY,
    0, 0, 1,
  ];
  const resizeWindow: Matrix3 = [
    widthRatio / WALL_METRES, (rayX * heightRatio - widthRatio * refX) / refY / WALL_METRES,
    s0 + rayX * heightShift / WALL_METRES,
    0, rayY * heightRatio / refY / DEPTH_METRES, rayY * heightShift / DEPTH_METRES,
    0, 0, 1,
  ];
  const drawingToViewport: Matrix3 = [
    planes.width / 1280, 0, planes.left - room.left,
    0, planes.height / 832, planes.top - room.top,
    0, 0, 1,
  ];
  let receiverProjection = FLOOR;
  if (receiver === "right-wall") {
    if (rayX <= 1e-5) return hidden();
    // Continue the same source ray from its hypothetical floor landing (s,t)
    // back to the right wall s=1. At s=1, wall height is zero and this matrix
    // is exactly the floor matrix: the pane edges cannot drift at the seam.
    const p = WALL_METRES / rayX;
    const q = rayY * WALL_METRES / (DEPTH_METRES * rayX);
    receiverProjection = [
      -FLOOR[1] * q, FLOOR[1], FLOOR[0] + FLOOR[2] + FLOOR[1] * q,
      -FLOOR[4] * q - VERTICAL_PIXELS_PER_METRE * p, FLOOR[4],
      FLOOR[3] + FLOOR[5] + FLOOR[4] * q + VERTICAL_PIXELS_PER_METRE * p,
      -FLOOR[7] * q, FLOOR[7], FLOOR[6] + FLOOR[8] + FLOOR[7] * q,
    ];
  }
  let matrix = multiply(drawingToViewport, multiply(receiverProjection, multiply(resizeWindow, pixelToMetres)));
  if (!matrix.every(Number.isFinite)) return hidden();
  const sourceBounds = options.cropToReceiver ? visibleSourceBounds(matrix, bake, layout, receiver) : undefined;
  if (sourceBounds === null) return hidden();
  if (sourceBounds) matrix = multiply(matrix, [1, 0, sourceBounds.x, 0, 1, sourceBounds.y, 0, 0, 1]);
  const width = sourceBounds?.width ?? bake.width;
  const height = sourceBounds?.height ?? bake.height;
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => {
    const w = matrix[6] * x + matrix[7] * y + matrix[8];
    return w > 1e-5 ? { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / w, y: (matrix[3] * x + matrix[4] * y + matrix[5]) / w } : { x: NaN, y: NaN };
  });
  if (!matrix.every(Number.isFinite) || corners.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return hidden();
  const css = [matrix[0], matrix[3], 0, matrix[6], matrix[1], matrix[4], 0, matrix[7], 0, 0, 1, 0, matrix[2], matrix[5], 0, matrix[8]];
  return { transform: `matrix3d(${css.map(value => Number(value.toFixed(9))).join(",")})`, weight, corners,
    ...(sourceBounds ? { sourceBounds } : {}) };
}
