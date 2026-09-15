import type { RoomFloorProjectionRect } from "./roomFloorProjection";
import type { ResolvedRoomLight } from "./roomLight";

export const ROOM_CLOTH_SHADOW_SAMPLES_PER_EDGE = 5;

export interface RoomClothShadowPoint {
  x: number;
  y: number;
}

export interface RoomClothShadowLayout {
  room: RoomFloorProjectionRect;
  planes: RoomFloorProjectionRect;
}

export interface ResolvedRoomClothShadow {
  /** Convex silhouette inside the padded paint surface, normalized to 0..1. */
  points: RoomClothShadowPoint[];
  /** Room-local CSS pixels; the fixed backing canvas is only scaled here. */
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
}

const EPSILON = 1e-6;
// Corrupt layout must not produce an effectively unbounded CSS transform.
const MAX_LAYOUT_EXTENT = 65_536;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const finiteRect = (rect: RoomFloorProjectionRect) =>
  Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
  Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
  rect.width > EPSILON && rect.height > EPSILON &&
  rect.width <= MAX_LAYOUT_EXTENT && rect.height <= MAX_LAYOUT_EXTENT;

function cross(
  origin: RoomClothShadowPoint,
  a: RoomClothShadowPoint,
  b: RoomClothShadowPoint,
): number {
  return (a.x - origin.x) * (b.y - origin.y) -
    (a.y - origin.y) * (b.x - origin.x);
}

/** A folded perimeter may cross itself; its hull remains one soft form. */
function convexHull(points: readonly RoomClothShadowPoint[]): RoomClothShadowPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((point, index) =>
    index === 0 || point.x !== sorted[index - 1].x || point.y !== sorted[index - 1].y,
  );
  const lower: RoomClothShadowPoint[] = [];
  const upper: RoomClothShadowPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= EPSILON) {
      lower.pop();
    }
    lower.push(point);
  }
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= EPSILON) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Lowest visible point of the coarse silhouette at this screen-space X. */
function lowerHemAtX(hull: readonly RoomClothShadowPoint[], x: number): number {
  let lowerHem = -Infinity;
  for (let index = 0; index < hull.length; index++) {
    const start = hull[index];
    const end = hull[(index + 1) % hull.length];
    if (x < Math.min(start.x, end.x) - EPSILON || x > Math.max(start.x, end.x) + EPSILON) continue;
    const width = end.x - start.x;
    if (Math.abs(width) <= EPSILON) {
      lowerHem = Math.max(lowerHem, start.y, end.y);
    } else {
      const fraction = clamp01((x - start.x) / width);
      lowerHem = Math.max(lowerHem, start.y + fraction * (end.y - start.y));
    }
  }
  return lowerHem;
}

/** Interpolate the same two floor seams drawn in RoomFrame's 1280×832 SVG. */
function floorSeamY(x: number, layout: RoomClothShadowLayout): number {
  const { room, planes } = layout;
  const sourceX = Math.min(1279.5, Math.max(0.5,
    (x - (planes.left - room.left)) / planes.width * 1280,
  ));
  const left = sourceX <= 920.5;
  const x0 = left ? 0.5 : 920.5;
  const x1 = left ? 920.5 : 1279.5;
  const y0 = left ? 662.5 : 554.5;
  const y1 = left ? 554.5 : 717.865;
  const y = y0 + (y1 - y0) * (sourceX - x0) / (x1 - x0);
  return planes.top - room.top + planes.height * y / 832;
}

/**
 * A calibrated 2D grounding cue, not a physical ray-traced shadow. The live
 * cloth silhouette supplies shape and motion; the existing room beam supplies
 * direction. The measured floor owns its anchor, including the 80%-height
 * mobile planes. No Three objects, layout reads, or solver traversal belong
 * here. Call with a small perimeter sample from the existing render loop.
 */
export function resolveRoomClothShadow(
  points: readonly RoomClothShadowPoint[],
  light: Pick<ResolvedRoomLight, "beam" | "direct">,
  layout: RoomClothShadowLayout,
  visibility: number,
  coverage: number,
): ResolvedRoomClothShadow | null {
  if (
    points.length < 3 || points.length > 256 ||
    !finiteRect(layout.room) || !finiteRect(layout.planes) ||
    !Number.isFinite(visibility) || !Number.isFinite(coverage) ||
    visibility <= 0 || coverage <= 0 ||
    !Number.isFinite(light.direct.intensity) ||
    points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) return null;

  const directionX = light.beam.screenDirectionX;
  const directionY = light.beam.screenDirectionY;
  const directionLength = Math.hypot(directionX, directionY);
  if (!Number.isFinite(directionLength) || directionLength <= EPSILON || directionY <= EPSILON) {
    return null;
  }
  const dx = directionX / directionLength;
  const dy = directionY / directionLength;
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const clothWidth = maxX - minX;
  const clothHeight = maxY - minY;
  if (
    !Number.isFinite(clothWidth) || !Number.isFinite(clothHeight) ||
    clothWidth <= EPSILON || clothHeight <= EPSILON ||
    clothWidth > layout.room.width * 2 || clothHeight > layout.room.height * 2 ||
    maxY < -layout.room.height
  ) return null;

  const centerX = minX + clothWidth / 2;
  const base = Math.max(
    maxY + clothHeight * 0.035,
    floorSeamY(centerX, layout) + layout.planes.height * 0.025,
  );
  const remainingFloor = layout.room.height - base;
  if (!Number.isFinite(base) || remainingFloor <= EPSILON) return null;

  const daylight = clamp01(light.direct.intensity);
  const depth = Math.min(
    clothHeight * (0.12 + daylight * 0.18),
    remainingFloor * 0.8 / Math.max(0.1, dy),
  );
  const silhouette = convexHull(points);
  if (silhouette.length < 3) return null;
  // At an extreme X, a sloping upper corner can have zero vertical span.
  // Sampling hull-edge midpoints retains the upper span after this nonlinear
  // hem-relative cast, even for sparse outlines, without more solver reads.
  const samples = points.concat(silhouette.map((point, index) => {
    const next = silhouette[(index + 1) % silhouette.length];
    return { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
  }));
  const cast = samples.map(point => {
    const hemY = lowerHemAtX(silhouette, point.x);
    const localBase = Math.max(
      hemY + clothHeight * 0.035,
      floorSeamY(point.x, layout) + layout.planes.height * 0.025,
    );
    const travel = Math.min(
      Math.max(0, hemY - point.y) / clothHeight * depth,
      Math.max(0, layout.room.height - localBase) * 0.8 / Math.max(0.1, dy),
    );
    return { x: point.x + dx * travel, y: localBase + dy * travel };
  });
  const hull = convexHull(cast);
  if (hull.length < 3) return null;

  const hullMinX = Math.min(...hull.map(point => point.x));
  const hullMaxX = Math.max(...hull.map(point => point.x));
  const hullMinY = Math.min(...hull.map(point => point.y));
  const hullMaxY = Math.max(...hull.map(point => point.y));
  const hullWidth = hullMaxX - hullMinX;
  const hullHeight = hullMaxY - hullMinY;
  if (hullWidth <= EPSILON || hullHeight <= EPSILON) return null;

  // Padding keeps the blur off the fixed raster's edges; it is not extra room
  // geometry. The outer floor clip still prevents spill onto the walls.
  const paddingX = Math.max(2, hullWidth * 0.12);
  const paddingY = Math.max(2, hullHeight * 0.25);
  const left = hullMinX - paddingX;
  const top = hullMinY - paddingY;
  const width = hullWidth + paddingX * 2;
  const height = hullHeight + paddingY * 2;
  if (
    ![left, top, width, height].every(Number.isFinite) ||
    left >= layout.room.width || left + width <= 0 ||
    top >= layout.room.height || top + height <= 0
  ) return null;

  return {
    points: hull.map(point => ({
      x: clamp01((point.x - left) / width),
      y: clamp01((point.y - top) / height),
    })),
    left,
    top,
    width,
    height,
    // Keep only a faint ambient grounding cue when direct sunlight is absent.
    opacity: (0.1 + daylight * 0.1) * clamp01(visibility) * clamp01(coverage),
  };
}
