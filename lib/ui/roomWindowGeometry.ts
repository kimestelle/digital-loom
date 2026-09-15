/** Shared source geometry for the depth-tested window and its SVG study. */
export const ROOM_WINDOW_PANEL_COUNT = 5;
export const ROOM_WINDOW_FORM_COUNT = 1;
/** Kept for the renderer diagnostic; one mesh is now one form. */
export const ROOM_WINDOW_INSTANCE_COUNT = ROOM_WINDOW_FORM_COUNT;
export const ROOM_WINDOW_MEMBER_COUNT =
  ROOM_WINDOW_PANEL_COUNT + 1 + ROOM_WINDOW_PANEL_COUNT + 1;
export const ROOM_WINDOW_TRIANGLE_COUNT = ROOM_WINDOW_MEMBER_COUNT * 2;
export const ROOM_WINDOW_DRAW_CALL_COUNT = 1;

/** Back-wall floor seam vanishing point on the room's y=.5 horizon. */
export const ROOM_BACK_WALL_VANISHING_POINT_X_RATIO = 5639.759259 / 1280;
export const ROOM_WINDOW_SOURCE_WIDTH = 856;
export const ROOM_WINDOW_SOURCE_HEIGHT = 415.059;

const OUTER_STROKE_PX = 9;
const INNER_STROKE_PX = 5.5;
const MIDDLE_POSITION = 0.46;

export interface RoomWindowApertureRect {
  /** CSS pixels, in the same coordinate system as the room rect. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RoomWindowRoomRect {
  /** CSS pixels, in the same coordinate system as the aperture rect. */
  left: number;
  width: number;
}

export interface RoomWindowPoint {
  x: number;
  y: number;
}

export interface RoomWindowQuad {
  kind: "frame" | "sill";
  /** TL, BL, BR, TR: matches the indexed Three geometry. */
  points: readonly [RoomWindowPoint, RoomWindowPoint, RoomWindowPoint, RoomWindowPoint];
}

export interface RoomWindowGeometry {
  rightVerticalScale: number;
  /** Six posts, five inset crossrails, then one uninterrupted sill. */
  quads: readonly RoomWindowQuad[];
  /** TL, TR, BR, BL. */
  aperture: readonly [RoomWindowPoint, RoomWindowPoint, RoomWindowPoint, RoomWindowPoint];
}

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export function resolveRoomWindowRightVerticalScale(
  aperture: RoomWindowApertureRect,
  room: RoomWindowRoomRect,
): number {
  const roomWidth = Math.max(1, finiteOr(room.width, 1280));
  const roomLeft = finiteOr(room.left, 0);
  const apertureLeft = finiteOr(aperture.left, 0);
  const apertureRight = apertureLeft + Math.max(1, finiteOr(aperture.width, 1));
  const vanishingPointX =
    roomLeft + roomWidth * ROOM_BACK_WALL_VANISHING_POINT_X_RATIO;
  const leftDistance = vanishingPointX - apertureLeft;
  const rightDistance = vanishingPointX - apertureRight;
  if (
    !Number.isFinite(leftDistance) ||
    !Number.isFinite(rightDistance) ||
    leftDistance <= 1 ||
    rightDistance <= 1
  ) {
    return 0.846;
  }
  return clamp(rightDistance / leftDistance, 0.35, 0.98);
}

/**
 * Project one authored window into CSS pixels without a camera or GPU.
 * Both renderers consume these exact quads; the Three adapter only lifts the
 * resulting pixels into its camera space to retain cloth depth masking.
 */
export function resolveRoomWindowGeometry(
  rawAperture: RoomWindowApertureRect,
  room: RoomWindowRoomRect,
): RoomWindowGeometry {
  const aperture = {
    left: finiteOr(rawAperture.left, 0),
    top: finiteOr(rawAperture.top, 0),
    width: Math.max(1, finiteOr(rawAperture.width, 1)),
    height: Math.max(1, finiteOr(rawAperture.height, 1)),
  };
  const rightVerticalScale = resolveRoomWindowRightVerticalScale(aperture, room);
  const projectiveDenominator = 1 / rightVerticalScale - 1;
  const project = (u: number, v: number): RoomWindowPoint => {
    const denominator = 1 + projectiveDenominator * u;
    return {
      x: aperture.left + ((1 + projectiveDenominator) * u / denominator) * aperture.width,
      y: aperture.top + (v / denominator) * aperture.height,
    };
  };
  const quads: RoomWindowQuad[] = [];
  const addQuad = (
    left: number, top: number, right: number, bottom: number,
    kind: RoomWindowQuad["kind"] = "frame",
  ) => {
    quads.push({
      kind,
      points: [project(left, top), project(left, bottom), project(right, bottom), project(right, top)],
    });
  };
  const outerWidth = OUTER_STROKE_PX / ROOM_WINDOW_SOURCE_WIDTH;
  const innerHalfWidth = INNER_STROKE_PX / ROOM_WINDOW_SOURCE_WIDTH / 2;
  const sillTop = 1 - OUTER_STROKE_PX / ROOM_WINDOW_SOURCE_HEIGHT;
  const middleHalfHeight = INNER_STROKE_PX / ROOM_WINDOW_SOURCE_HEIGHT / 2;
  const postRanges: Array<readonly [number, number]> = [];

  for (let post = 0; post <= ROOM_WINDOW_PANEL_COUNT; post += 1) {
    const center = post / ROOM_WINDOW_PANEL_COUNT;
    const left = post === 0 ? 0
      : post === ROOM_WINDOW_PANEL_COUNT ? 1 - outerWidth : center - innerHalfWidth;
    const right = post === 0 ? outerWidth
      : post === ROOM_WINDOW_PANEL_COUNT ? 1 : center + innerHalfWidth;
    postRanges.push([left, right]);
    addQuad(left, 0, right, sillTop);
  }
  for (let panel = 0; panel < ROOM_WINDOW_PANEL_COUNT; panel += 1) {
    addQuad(
      postRanges[panel][1], MIDDLE_POSITION - middleHalfHeight,
      postRanges[panel + 1][0], MIDDLE_POSITION + middleHalfHeight,
    );
  }
  addQuad(0, sillTop, 1, 1, "sill");

  return {
    rightVerticalScale,
    quads,
    aperture: [project(0, 0), project(1, 0), project(1, 1), project(0, 1)],
  };
}
