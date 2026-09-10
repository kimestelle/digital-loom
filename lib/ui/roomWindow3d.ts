import * as THREE from "three/webgpu";
import { screenUV, smoothstep } from "three/tsl";

export const ROOM_WINDOW_PANEL_COUNT = 5;
export const ROOM_WINDOW_FORM_COUNT = 1;
/** Kept for the existing renderer diagnostic; one mesh is now one form. */
export const ROOM_WINDOW_INSTANCE_COUNT = ROOM_WINDOW_FORM_COUNT;
export const ROOM_WINDOW_MEMBER_COUNT =
  ROOM_WINDOW_PANEL_COUNT + 1 + ROOM_WINDOW_PANEL_COUNT + 1;
export const ROOM_WINDOW_TRIANGLE_COUNT = ROOM_WINDOW_MEMBER_COUNT * 2;
export const ROOM_WINDOW_DRAW_CALL_COUNT = 1;

// The back-wall floor seam reaches this point on the y=.5 room horizon.
// Keeping the window sill incident with it makes the two lines converge in
// perspective instead of running as a conspicuous parallel pair.
export const ROOM_BACK_WALL_VANISHING_POINT_X_RATIO =
  5639.759259 / 1280;

const WINDOW_SOURCE_WIDTH = 856;
const WINDOW_SOURCE_HEIGHT = 415.059;
const WINDOW_LEFT_DEPTH = 1_800;
const WINDOW_OUTER_STROKE_PX = 9;
const WINDOW_INNER_STROKE_PX = 5.5;
const WINDOW_MIDDLE_POSITION = 0.46;
// Submit after the default-order cloth so its existing depth writes mask the
// frame. The window remains physically behind the specimen and still appears
// through shader-discarded fray holes, but partial fabric alpha no longer
// color-composites a sharp grid through the material.
const WINDOW_BACKGROUND_RENDER_ORDER = 1;
const WINDOW_FRAME_COLOR = 0xe2d1b6;
const WINDOW_SILL_COLOR = 0xf7eed9;

const QUAD_VERTEX_COUNT = 4;
const QUAD_INDEX_COUNT = 6;
const FRAME_VERTEX_COUNT = ROOM_WINDOW_MEMBER_COUNT * QUAD_VERTEX_COUNT;
const FRAME_INDEX_COUNT = ROOM_WINDOW_MEMBER_COUNT * QUAD_INDEX_COUNT;

if (ROOM_WINDOW_TRIANGLE_COUNT !== FRAME_INDEX_COUNT / 3) {
  throw new Error("Room window geometry budget is out of sync");
}

export interface RoomWindowApertureRect {
  /** CSS pixels relative to the renderer canvas. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RoomWindowRoomRect {
  /** CSS pixels relative to the renderer canvas. */
  left: number;
  width: number;
}

export interface RoomWindowLayoutResult {
  /** Right sill position as a fraction of the aperture height. */
  rightVerticalScale: number;
}

export interface RoomWindowMetrics {
  instances: number;
  panels: number;
  members: number;
  triangles: number;
  drawCalls: number;
}

export interface RoomWindow3d {
  root: THREE.Group;
  frame: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  /** TL, TR, BR, BL. Mutated in place by layout(). */
  apertureCorners: readonly [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
  ];
  metrics: Readonly<RoomWindowMetrics>;
  layout: (
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
    aperture: RoomWindowApertureRect,
    room?: RoomWindowRoomRect,
  ) => RoomWindowLayoutResult;
  dispose: () => void;
}

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

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
  return THREE.MathUtils.clamp(rightDistance / leftDistance, 0.35, 0.98);
}

/**
 * One shallow, non-overlapping window form for the shared room renderer.
 *
 * Six post quads, five inset middle spans, and one flush sill quad are packed
 * into a single BufferGeometry. Every joint shares the same projected edge:
 * there are no intersecting boxes, protruding ends, or separately lit corners.
 * Equal source-space panels pass through the back wall's vanishing point, so
 * their screen widths and post heights contract coherently toward the corner.
 */
export function createRoomWindow3d(
  camera: THREE.PerspectiveCamera,
  sillColor: THREE.ColorRepresentation = WINDOW_SILL_COLOR,
): RoomWindow3d {
  const root = new THREE.Group();
  root.name = "room-window-low-poly";
  root.matrixAutoUpdate = true;

  const positions = new THREE.BufferAttribute(
    new Float32Array(FRAME_VERTEX_COUNT * 3),
    3,
  );
  positions.setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.BufferAttribute(
    new Float32Array(FRAME_VERTEX_COUNT * 3),
    3,
  );
  const frameColor = new THREE.Color(WINDOW_FRAME_COLOR);
  const resolvedSillColor = new THREE.Color(sillColor);
  const sillVertex = (ROOM_WINDOW_MEMBER_COUNT - 1) * QUAD_VERTEX_COUNT;
  for (let vertex = 0; vertex < FRAME_VERTEX_COUNT; vertex += 1) {
    const color = vertex >= sillVertex ? resolvedSillColor : frameColor;
    colors.setXYZ(vertex, color.r, color.g, color.b);
  }
  const indices = new Uint16Array(FRAME_INDEX_COUNT);
  for (let quad = 0; quad < ROOM_WINDOW_MEMBER_COUNT; quad += 1) {
    const vertex = quad * QUAD_VERTEX_COUNT;
    const offset = quad * QUAD_INDEX_COUNT;
    // TL, BL, BR, TR faces the room camera.
    indices.set(
      [vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3],
      offset,
    );
  }

  const frameGeometry = new THREE.BufferGeometry();
  frameGeometry.setAttribute("position", positions);
  frameGeometry.setAttribute("color", colors);
  frameGeometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const frameMaterial = new THREE.MeshBasicNodeMaterial({
    // White remains the uniform day/night multiplier; the static vertex
    // palette keeps the frame warm while matching only the sill to plaster.
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
  });
  // Fade only toward the screen top. The operation lives in this material,
  // adds no pass or draw call, and does not touch either side of the canvas.
  frameMaterial.opacityNode = smoothstep(0.015, 0.3, screenUV.y).mul(0.78);

  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  frame.name = "room-window-frame-one-form";
  // Transparent objects normally sort back-to-front, which makes this sharp
  // grid survive every partially transparent cloth texel. Draw the physically
  // distant form after the cloth instead: depth testing masks it wherever the
  // specimen rendered, while true discarded holes retain the background.
  frame.renderOrder = WINDOW_BACKGROUND_RENDER_ORDER;
  frame.frustumCulled = false;
  frame.castShadow = false;
  frame.receiveShadow = false;
  frame.raycast = () => {};
  root.add(frame);

  const apertureCorners = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ] as const;
  const scratchPoint = new THREE.Vector3();

  const layout = (
    nextCamera: THREE.PerspectiveCamera,
    rawViewportWidth: number,
    rawViewportHeight: number,
    rawAperture: RoomWindowApertureRect,
    rawRoom: RoomWindowRoomRect = {
      left: 0,
      width: rawViewportWidth,
    },
  ): RoomWindowLayoutResult => {
    const viewportWidth = Math.max(1, finiteOr(rawViewportWidth, 1));
    const viewportHeight = Math.max(1, finiteOr(rawViewportHeight, 1));
    const aperture = {
      left: finiteOr(rawAperture.left, 0),
      top: finiteOr(rawAperture.top, 0),
      width: Math.max(1, finiteOr(rawAperture.width, viewportWidth * 0.8)),
      height: Math.max(1, finiteOr(rawAperture.height, viewportHeight * 0.5)),
    };
    const room = {
      left: finiteOr(rawRoom.left, 0),
      width: Math.max(1, finiteOr(rawRoom.width, viewportWidth)),
    };
    const rightVerticalScale = resolveRoomWindowRightVerticalScale(
      aperture,
      room,
    );
    const projectiveDenominator = 1 / rightVerticalScale - 1;
    const rightDepth = WINDOW_LEFT_DEPTH / rightVerticalScale;

    // The model mirrors the static room camera without entering its subtree;
    // the material loupe renders another layer and therefore never copies it.
    root.position.copy(nextCamera.position);
    root.quaternion.copy(nextCamera.quaternion);
    root.scale.set(1, 1, 1);

    const setProjectedPoint = (
      target: THREE.Vector3,
      sourceU: number,
      sourceV: number,
    ) => {
      const u = THREE.MathUtils.clamp(sourceU, 0, 1);
      const v = THREE.MathUtils.clamp(sourceV, 0, 1);
      const denominator = 1 + projectiveDenominator * u;
      const projectedU =
        ((1 + projectiveDenominator) * u) / denominator;
      const projectedV = v / denominator;
      const screenX = aperture.left + projectedU * aperture.width;
      const screenY = aperture.top + projectedV * aperture.height;
      const depth = THREE.MathUtils.lerp(
        WINDOW_LEFT_DEPTH,
        rightDepth,
        projectedU,
      );
      const ndcX = (screenX / viewportWidth) * 2 - 1;
      const ndcY = 1 - (screenY / viewportHeight) * 2;
      const halfHeight =
        Math.tan(THREE.MathUtils.degToRad(nextCamera.fov * 0.5)) * depth;
      target.set(
        ndcX * halfHeight * nextCamera.aspect,
        ndcY * halfHeight,
        -depth,
      );
    };

    const writeQuad = (
      quad: number,
      leftU: number,
      topV: number,
      rightU: number,
      bottomV: number,
    ) => {
      const base = quad * QUAD_VERTEX_COUNT;
      setProjectedPoint(scratchPoint, leftU, topV);
      positions.setXYZ(base, scratchPoint.x, scratchPoint.y, scratchPoint.z);
      setProjectedPoint(scratchPoint, leftU, bottomV);
      positions.setXYZ(base + 1, scratchPoint.x, scratchPoint.y, scratchPoint.z);
      setProjectedPoint(scratchPoint, rightU, bottomV);
      positions.setXYZ(base + 2, scratchPoint.x, scratchPoint.y, scratchPoint.z);
      setProjectedPoint(scratchPoint, rightU, topV);
      positions.setXYZ(base + 3, scratchPoint.x, scratchPoint.y, scratchPoint.z);
    };

    const outerWidth = WINDOW_OUTER_STROKE_PX / WINDOW_SOURCE_WIDTH;
    const innerHalfWidth =
      WINDOW_INNER_STROKE_PX / WINDOW_SOURCE_WIDTH / 2;
    const sillTop = 1 - WINDOW_OUTER_STROKE_PX / WINDOW_SOURCE_HEIGHT;
    const middleHalfHeight =
      WINDOW_INNER_STROKE_PX / WINDOW_SOURCE_HEIGHT / 2;
    const postRanges: Array<readonly [number, number]> = [];
    let quad = 0;

    for (let post = 0; post <= ROOM_WINDOW_PANEL_COUNT; post += 1) {
      const center = post / ROOM_WINDOW_PANEL_COUNT;
      const left =
        post === 0
          ? 0
          : post === ROOM_WINDOW_PANEL_COUNT
            ? 1 - outerWidth
            : center - innerHalfWidth;
      const right =
        post === 0
          ? outerWidth
          : post === ROOM_WINDOW_PANEL_COUNT
            ? 1
            : center + innerHalfWidth;
      postRanges.push([left, right]);
      writeQuad(quad++, left, 0, right, sillTop);
    }

    for (let panel = 0; panel < ROOM_WINDOW_PANEL_COUNT; panel += 1) {
      writeQuad(
        quad++,
        postRanges[panel][1],
        WINDOW_MIDDLE_POSITION - middleHalfHeight,
        postRanges[panel + 1][0],
        WINDOW_MIDDLE_POSITION + middleHalfHeight,
      );
    }

    // The sill is one uninterrupted strip and ends at the jamb silhouette.
    // Posts terminate on its upper edge, so every lower corner is shared once.
    writeQuad(quad++, 0, sillTop, 1, 1);
    if (quad !== ROOM_WINDOW_MEMBER_COUNT) {
      throw new Error("Room window member count is out of sync");
    }

    setProjectedPoint(apertureCorners[0], 0, 0);
    setProjectedPoint(apertureCorners[1], 1, 0);
    setProjectedPoint(apertureCorners[2], 1, 1);
    setProjectedPoint(apertureCorners[3], 0, 1);

    positions.needsUpdate = true;
    frameGeometry.computeVertexNormals();
    const normals = frameGeometry.getAttribute("normal");
    if (normals) normals.needsUpdate = true;
    root.updateMatrixWorld(true);

    return { rightVerticalScale };
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.remove(frame);
    root.removeFromParent();
    frameGeometry.dispose();
    frameMaterial.dispose();
  };

  // Seed finite data before the first real ResizeObserver delivery.
  layout(
    camera,
    851,
    832,
    { left: -66, top: 0, width: 880, height: WINDOW_SOURCE_HEIGHT },
    { left: 0, width: 1280 },
  );

  return {
    root,
    frame,
    apertureCorners,
    metrics: Object.freeze({
      instances: ROOM_WINDOW_INSTANCE_COUNT,
      panels: ROOM_WINDOW_PANEL_COUNT,
      members: ROOM_WINDOW_MEMBER_COUNT,
      triangles: ROOM_WINDOW_TRIANGLE_COUNT,
      drawCalls: ROOM_WINDOW_DRAW_CALL_COUNT,
    }),
    layout,
    dispose,
  };
}
