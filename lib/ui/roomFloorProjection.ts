import type { ResolvedRoomLight } from "./roomLight";
import {
  ROOM_BACK_WALL_VANISHING_POINT_X_RATIO,
  resolveRoomWindowRightVerticalScale,
} from "./roomWindowGeometry";

/** Canonical composited receiver size used by room.css. */
export const ROOM_FLOOR_PROJECTION_BASE_LENGTH = 512;
export const ROOM_FLOOR_PROJECTION_BASE_WIDTH = 256;

/**
 * Matches the back-wall vanishing point used by roomWindow3d without pulling
 * Three.js into the DOM light controller.
 */
export const ROOM_FLOOR_VANISHING_POINT_X_RATIO = ROOM_BACK_WALL_VANISHING_POINT_X_RATIO;

const ROOM_SOURCE_WIDTH = 1280;
const ROOM_SOURCE_HEIGHT = 832;
const EPSILON = 1e-6;

const FLOOR_SEAM_LEFT = {
  x: 0.5 / ROOM_SOURCE_WIDTH,
  y: 662.5 / ROOM_SOURCE_HEIGHT,
} as const;
const FLOOR_SEAM_CORNER = {
  x: 920.5 / ROOM_SOURCE_WIDTH,
  y: 554.5 / ROOM_SOURCE_HEIGHT,
} as const;
const FLOOR_SEAM_RIGHT = {
  x: 1279.5 / ROOM_SOURCE_WIDTH,
  y: 717.865 / ROOM_SOURCE_HEIGHT,
} as const;

export interface RoomFloorProjectionRect {
  /** Viewport/client coordinate. */
  left: number;
  /** Viewport/client coordinate. */
  top: number;
  width: number;
  height: number;
}

export interface RoomFloorProjectionLayout {
  room: RoomFloorProjectionRect;
  /** The measured SVG plane rect; mobile intentionally renders it at 80%. */
  planes: RoomFloorProjectionRect;
  /** The measured, responsive window aperture rect. */
  aperture: RoomFloorProjectionRect;
  /** Right sill height divided by left sill height. */
  apertureRightBottom: number;
}

export interface ResolvedRoomFloorProjection {
  /** Floor-entry point in CSS pixels relative to the room root. */
  x: number;
  y: number;
  /** CSS rotation: zero points right; positive angles point down. */
  angle: number;
  /** Ray travel from the floor seam to the first room viewport edge. */
  length: number;
  /** Full aperture sill span measured perpendicular to the light ray. */
  width: number;
  /** Transform scale for the canonical 512px receiver length. */
  scaleX: number;
  /** Transform scale for the canonical 256px receiver width. */
  scaleY: number;
  /** Numeric compositor gate. Invalid or offscreen projections resolve to 0. */
  visible: 0 | 1;
}

interface Point2 {
  x: number;
  y: number;
}

interface RaySegmentHit extends Point2 {
  distance: number;
}

const finiteRect = (rect: RoomFloorProjectionRect): boolean =>
  Number.isFinite(rect.left) &&
  Number.isFinite(rect.top) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > EPSILON &&
  rect.height > EPSILON;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const cross = (a: Point2, b: Point2): number => a.x * b.y - a.y * b.x;

const hiddenProjection = (
  target: ResolvedRoomFloorProjection,
  x = 0,
  y = 0,
  angle = 0,
): ResolvedRoomFloorProjection => {
  target.x = Number.isFinite(x) ? x : 0;
  target.y = Number.isFinite(y) ? y : 0;
  target.angle = Number.isFinite(angle) ? angle : 0;
  target.length = 0;
  target.width = 0;
  target.scaleX = 0;
  target.scaleY = 0;
  target.visible = 0;
  return target;
};

const intersectRaySegment = (
  source: Point2,
  direction: Point2,
  start: Point2,
  end: Point2,
): RaySegmentHit | null => {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const sourceToStart = {
    x: start.x - source.x,
    y: start.y - source.y,
  };
  const denominator = cross(direction, segment);
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) {
    return null;
  }
  const distance = cross(sourceToStart, segment) / denominator;
  const segmentPosition = cross(sourceToStart, direction) / denominator;
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(segmentPosition) ||
    distance < -EPSILON ||
    segmentPosition < -EPSILON ||
    segmentPosition > 1 + EPSILON
  ) {
    return null;
  }
  const boundedDistance = Math.max(0, distance);
  return {
    x: source.x + direction.x * boundedDistance,
    y: source.y + direction.y * boundedDistance,
    distance: boundedDistance,
  };
};

const viewportExitDistance = (
  point: Point2,
  direction: Point2,
  width: number,
  height: number,
): number => {
  let exit = Number.POSITIVE_INFINITY;
  if (direction.x > EPSILON) {
    exit = Math.min(exit, (width - point.x) / direction.x);
  } else if (direction.x < -EPSILON) {
    exit = Math.min(exit, -point.x / direction.x);
  }
  if (direction.y > EPSILON) {
    exit = Math.min(exit, (height - point.y) / direction.y);
  } else if (direction.y < -EPSILON) {
    exit = Math.min(exit, -point.y / direction.y);
  }
  if (!Number.isFinite(exit) || exit <= EPSILON) return 0;
  return Math.min(exit, Math.hypot(width, height));
};

/**
 * Resolve the window's right sill contraction from the same back-wall
 * vanishing point used by the Three window. Keeping this pure avoids a
 * mount-order dependency on the clip-path custom property that Three writes.
 */
export function resolveRoomFloorApertureRightBottom(
  aperture: RoomFloorProjectionRect,
  room: RoomFloorProjectionRect,
): number {
  if (!finiteRect(aperture) || !finiteRect(room)) return 0.846;
  return resolveRoomWindowRightVerticalScale(aperture, room);
}

/**
 * Project the existing soft light field onto the measured floor. This is a
 * calibrated 2D directional projection: the floor seam and aperture are real
 * layout geometry, while the radial field deliberately stays texture-free.
 */
export function resolveRoomFloorProjectionInto(
  target: ResolvedRoomFloorProjection,
  light: Pick<ResolvedRoomLight, "beam" | "window">,
  layout: RoomFloorProjectionLayout,
): ResolvedRoomFloorProjection {
  const { room, planes, aperture } = layout;
  if (!finiteRect(room) || !finiteRect(planes) || !finiteRect(aperture)) {
    return hiddenProjection(target);
  }

  const rawDirectionX = light.beam.screenDirectionX;
  const rawDirectionY = light.beam.screenDirectionY;
  const directionLength = Math.hypot(rawDirectionX, rawDirectionY);
  if (!Number.isFinite(directionLength) || directionLength <= EPSILON) {
    return hiddenProjection(target);
  }
  const direction = {
    x: rawDirectionX / directionLength,
    y: rawDirectionY / directionLength,
  };
  const angle = Math.atan2(direction.y, direction.x) * (180 / Math.PI);

  const rightBottom = Number.isFinite(layout.apertureRightBottom)
    ? clamp(layout.apertureRightBottom, 0.35, 1)
    : resolveRoomFloorApertureRightBottom(aperture, room);
  const hotspotU = clamp(light.window.hotspotX, 0, 1);
  const hotspotV = clamp(light.window.hotspotY, 0, 1);
  if (!Number.isFinite(hotspotU) || !Number.isFinite(hotspotV)) {
    return hiddenProjection(target, 0, 0, angle);
  }
  // Respect the aperture's sloping sill instead of sampling the enclosing
  // rectangle. `hotspotV` therefore remains normalized within the opening.
  const source = {
    x: aperture.left - room.left + aperture.width * hotspotU,
    y:
      aperture.top - room.top +
      aperture.height * hotspotV * (1 - (1 - rightBottom) * hotspotU),
  };

  const planeLeft = planes.left - room.left;
  const planeTop = planes.top - room.top;
  const seamLeft = {
    x: planeLeft + planes.width * FLOOR_SEAM_LEFT.x,
    y: planeTop + planes.height * FLOOR_SEAM_LEFT.y,
  };
  const seamCorner = {
    x: planeLeft + planes.width * FLOOR_SEAM_CORNER.x,
    y: planeTop + planes.height * FLOOR_SEAM_CORNER.y,
  };
  const seamRight = {
    x: planeLeft + planes.width * FLOOR_SEAM_RIGHT.x,
    y: planeTop + planes.height * FLOOR_SEAM_RIGHT.y,
  };

  const hits = [
    intersectRaySegment(source, direction, seamLeft, seamCorner),
    intersectRaySegment(source, direction, seamCorner, seamRight),
  ];
  let hit: RaySegmentHit | null = null;
  for (const candidate of hits) {
    if (candidate && (!hit || candidate.distance < hit.distance)) {
      hit = candidate;
    }
  }
  if (!hit) {
    return hiddenProjection(target, seamCorner.x, seamCorner.y, angle);
  }

  const length = viewportExitDistance(
    hit,
    direction,
    room.width,
    room.height,
  );

  // Use the full height-sized aperture, including its offscreen portion.
  // Cropping it to the viewport made the cast field shrink on narrow screens;
  // the measured floor polygon already owns visible clipping.
  const sill = {
    x: aperture.width,
    y: aperture.height * (rightBottom - 1),
  };
  let width = Math.abs(-direction.y * sill.x + direction.x * sill.y);
  // This guard catches corrupt/unbounded layout input without constraining a
  // normal portrait aperture, which can legitimately be wider than the room.
  width = Math.min(width, Math.hypot(room.width, room.height) * 4);

  if (
    !Number.isFinite(hit.x) ||
    !Number.isFinite(hit.y) ||
    !Number.isFinite(length) ||
    !Number.isFinite(width) ||
    length <= EPSILON ||
    width <= EPSILON
  ) {
    return hiddenProjection(target, hit.x, hit.y, angle);
  }

  target.x = hit.x;
  target.y = hit.y;
  target.angle = angle;
  target.length = length;
  target.width = width;
  target.scaleX = length / ROOM_FLOOR_PROJECTION_BASE_LENGTH;
  target.scaleY = width / ROOM_FLOOR_PROJECTION_BASE_WIDTH;
  target.visible = 1;
  return target;
}

export function resolveRoomFloorProjection(
  light: Pick<ResolvedRoomLight, "beam" | "window">,
  layout: RoomFloorProjectionLayout,
): ResolvedRoomFloorProjection {
  return resolveRoomFloorProjectionInto(
    {
      x: 0,
      y: 0,
      angle: 0,
      length: 0,
      width: 0,
      scaleX: 0,
      scaleY: 0,
      visible: 0,
    },
    light,
    layout,
  );
}
