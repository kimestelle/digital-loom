import * as THREE from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_BACK_WALL_VANISHING_POINT_X_RATIO,
  ROOM_WINDOW_DRAW_CALL_COUNT,
  ROOM_WINDOW_FORM_COUNT,
  ROOM_WINDOW_INSTANCE_COUNT,
  ROOM_WINDOW_MEMBER_COUNT,
  ROOM_WINDOW_PANEL_COUNT,
  ROOM_WINDOW_TRIANGLE_COUNT,
  createRoomWindow3d,
  resolveRoomWindowRightVerticalScale,
  type RoomWindowApertureRect,
  type RoomWindowRoomRect,
} from "./roomWindow3d";

const SCREEN_TOLERANCE_PX = 3;
const QUAD_VERTEX_COUNT = 4;
const QUAD_INDEX_COUNT = 6;

interface ScreenPoint {
  x: number;
  y: number;
}

interface LayoutFixture {
  name: string;
  viewport: { width: number; height: number };
  room: RoomWindowRoomRect;
  aperture: RoomWindowApertureRect;
  leftJambVisible: boolean;
}

const DESKTOP_LAYOUT: LayoutFixture = {
  name: "desktop",
  viewport: { width: 851, height: 832 },
  room: { left: 0, width: 1280 },
  aperture: { left: -66, top: 0, width: 880, height: 415.059 },
  leftJambVisible: false,
};

const WIDE_LAYOUT: LayoutFixture = {
  name: "wide",
  viewport: { width: 1063.75, height: 832 },
  room: { left: 0, width: 1600 },
  aperture: {
    left: 164.124998,
    top: 0,
    width: 880.000002,
    height: 415.059,
  },
  leftJambVisible: true,
};

const NARROW_LAYOUT: LayoutFixture = {
  name: "narrow/mobile",
  viewport: { width: 393, height: 568 },
  room: { left: 0, width: 393 },
  aperture: {
    left: -651.230411,
    top: 0,
    width: 901.153848,
    height: 425.036379,
  },
  leftJambVisible: false,
};

const LAYOUTS = [DESKTOP_LAYOUT, WIDE_LAYOUT, NARROW_LAYOUT] as const;

function makeRoomCamera(viewportWidth: number, viewportHeight: number) {
  const camera = new THREE.PerspectiveCamera(
    30,
    viewportWidth / viewportHeight,
    1,
    8000,
  );
  camera.position.set(890, 0, -966);
  camera.lookAt(20, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function projectToScreen(
  point: THREE.Vector3,
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  viewportWidth: number,
  viewportHeight: number,
): ScreenPoint {
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const projected = point.clone().applyMatrix4(root.matrixWorld).project(camera);
  return {
    x: ((projected.x + 1) * viewportWidth) / 2,
    y: ((1 - projected.y) * viewportHeight) / 2,
  };
}

function projectAperture(
  apertureCorners: readonly THREE.Vector3[],
  root: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  viewportWidth: number,
  viewportHeight: number,
) {
  return apertureCorners.map((corner) =>
    projectToScreen(corner, root, camera, viewportWidth, viewportHeight),
  );
}

function expectedRightVerticalScale(fixture: LayoutFixture) {
  const vanishingPointX =
    fixture.room.left +
    fixture.room.width * ROOM_BACK_WALL_VANISHING_POINT_X_RATIO;
  const apertureRight = fixture.aperture.left + fixture.aperture.width;
  return (
    (vanishingPointX - apertureRight) /
    (vanishingPointX - fixture.aperture.left)
  );
}

function expectScreenPointWithin(
  actual: ScreenPoint,
  expected: ScreenPoint,
  tolerance = SCREEN_TOLERANCE_PX,
) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
}

function geometryPoint(
  geometry: THREE.BufferGeometry,
  vertex: number,
): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("position"),
    vertex,
  );
}

describe("room window 3D", () => {
  it("packs five panels and twelve members into one 24-triangle form", () => {
    const camera = makeRoomCamera(851, 832);
    const roomWindow = createRoomWindow3d(camera);
    const meshes: THREE.Mesh[] = [];

    roomWindow.root.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });

    expect(roomWindow.metrics).toEqual({
      instances: 1,
      panels: 5,
      members: 12,
      triangles: 24,
      drawCalls: 1,
    });
    expect(Object.isFrozen(roomWindow.metrics)).toBe(true);
    expect(ROOM_WINDOW_FORM_COUNT).toBe(1);
    expect(ROOM_WINDOW_INSTANCE_COUNT).toBe(1);
    expect(ROOM_WINDOW_PANEL_COUNT).toBe(5);
    expect(ROOM_WINDOW_MEMBER_COUNT).toBe(12);
    expect(ROOM_WINDOW_TRIANGLE_COUNT).toBe(24);
    expect(ROOM_WINDOW_DRAW_CALL_COUNT).toBe(1);
    expect(meshes).toEqual([roomWindow.frame]);
    expect(roomWindow.frame).toBeInstanceOf(THREE.Mesh);
    expect(roomWindow.frame).not.toBeInstanceOf(THREE.InstancedMesh);
    expect(roomWindow.frame.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(roomWindow.frame.geometry.getAttribute("position").count).toBe(48);
    expect(roomWindow.frame.geometry.getAttribute("color").count).toBe(48);
    expect(roomWindow.frame.geometry.index?.count).toBe(72);
    expect(roomWindow.frame.geometry.groups).toHaveLength(0);
    expect(roomWindow.frame.material.color.getHex()).toBe(0xffffff);
    expect(roomWindow.frame.material.vertexColors).toBe(true);
    expect(meshes.some((mesh) => /pane/i.test(mesh.name))).toBe(false);
    expect(
      Object.values(roomWindow.frame.material).some(
        (value) => value instanceof THREE.Texture,
      ),
    ).toBe(false);

    roomWindow.dispose();
  });

  it("colors only the four sill vertices like the plaster wall", () => {
    const camera = makeRoomCamera(851, 832);
    const roomWindow = createRoomWindow3d(camera);
    const colors = roomWindow.frame.geometry.getAttribute("color");
    const sillVertex = (ROOM_WINDOW_MEMBER_COUNT - 1) * QUAD_VERTEX_COUNT;
    const nonFrameVertices: number[] = [];

    for (let vertex = 0; vertex < colors.count; vertex += 1) {
      const color = new THREE.Color().fromBufferAttribute(colors, vertex);
      const expected = vertex >= sillVertex ? 0xf7eed9 : 0xe2d1b6;
      expect(color.getHex()).toBe(expected);
      if (color.getHex() !== 0xe2d1b6) nonFrameVertices.push(vertex);
    }

    expect(nonFrameVertices).toEqual([
      sillVertex,
      sillVertex + 1,
      sillVertex + 2,
      sillVertex + 3,
    ]);
    expect(roomWindow.frame.geometry.groups).toHaveLength(0);
    expect(roomWindow.root.children).toEqual([roomWindow.frame]);
    expect(roomWindow.metrics.drawCalls).toBe(1);

    roomWindow.dispose();
  });

  it("uses the cloth depth buffer as a late background mask", () => {
    const camera = makeRoomCamera(851, 832);
    const roomWindow = createRoomWindow3d(camera);
    const defaultClothOrder = new THREE.Mesh().renderOrder;

    expect(roomWindow.root.position).toEqual(camera.position);
    expect(roomWindow.frame.material.transparent).toBe(true);
    expect(roomWindow.frame.material.depthTest).toBe(true);
    expect(roomWindow.frame.material.depthWrite).toBe(false);
    expect(roomWindow.frame.renderOrder).toBeGreaterThan(defaultClothOrder);
    expect(roomWindow.frame.renderOrder).toBeLessThan(999);
    expect(roomWindow.metrics.drawCalls).toBe(1);

    roomWindow.dispose();
  });

  it.each(LAYOUTS)(
    "projects the $name aperture through the real room camera",
    (fixture) => {
      const { viewport, aperture, room } = fixture;
      const camera = makeRoomCamera(viewport.width, viewport.height);
      const roomWindow = createRoomWindow3d(camera);
      const result = roomWindow.layout(
        camera,
        viewport.width,
        viewport.height,
        aperture,
        room,
      );
      const expectedScale = expectedRightVerticalScale(fixture);
      const projected = projectAperture(
        roomWindow.apertureCorners,
        roomWindow.root,
        camera,
        viewport.width,
        viewport.height,
      );
      const apertureRight = aperture.left + aperture.width;

      expect(result.rightVerticalScale).toBeCloseTo(expectedScale, 10);
      expect(
        resolveRoomWindowRightVerticalScale(aperture, room),
      ).toBeCloseTo(expectedScale, 10);
      expectScreenPointWithin(projected[0], {
        x: aperture.left,
        y: aperture.top,
      });
      expectScreenPointWithin(projected[1], {
        x: apertureRight,
        y: aperture.top,
      });
      expectScreenPointWithin(projected[2], {
        x: apertureRight,
        y: aperture.top + aperture.height * result.rightVerticalScale,
      });
      expectScreenPointWithin(projected[3], {
        x: aperture.left,
        y: aperture.top + aperture.height,
      });
      expect(projected[0].x >= 0).toBe(fixture.leftJambVisible);

      roomWindow.dispose();
    },
  );

  it("uses the shared wall vanishing point for nonlinear equal-source panels", () => {
    expect(ROOM_BACK_WALL_VANISHING_POINT_X_RATIO).toBeCloseTo(
      5639.759259 / 1280,
      12,
    );
    const { viewport, aperture, room } = DESKTOP_LAYOUT;
    const camera = makeRoomCamera(viewport.width, viewport.height);
    const roomWindow = createRoomWindow3d(camera);
    const { rightVerticalScale } = roomWindow.layout(
      camera,
      viewport.width,
      viewport.height,
      aperture,
      room,
    );
    const denominator = 1 / rightVerticalScale - 1;
    const expectedPostX = (post: number) => {
      const sourceU = post / ROOM_WINDOW_PANEL_COUNT;
      const projectedU =
        ((1 + denominator) * sourceU) / (1 + denominator * sourceU);
      return aperture.left + projectedU * aperture.width;
    };
    const position = roomWindow.frame.geometry.getAttribute("position");
    const postCenters = Array.from(
      { length: ROOM_WINDOW_PANEL_COUNT + 1 },
      (_, post) => {
        if (post === 0) return aperture.left;
        if (post === ROOM_WINDOW_PANEL_COUNT) {
          return aperture.left + aperture.width;
        }
        const base = post * QUAD_VERTEX_COUNT;
        const left = projectToScreen(
          new THREE.Vector3().fromBufferAttribute(position, base),
          roomWindow.root,
          camera,
          viewport.width,
          viewport.height,
        );
        const right = projectToScreen(
          new THREE.Vector3().fromBufferAttribute(position, base + 3),
          roomWindow.root,
          camera,
          viewport.width,
          viewport.height,
        );
        return (left.x + right.x) / 2;
      },
    );

    for (let post = 0; post < postCenters.length; post += 1) {
      expect(postCenters[post]).toBeCloseTo(expectedPostX(post), 1);
    }
    const panelWidths = postCenters
      .slice(1)
      .map((right, panel) => right - postCenters[panel]);
    for (let panel = 1; panel < panelWidths.length; panel += 1) {
      expect(panelWidths[panel]).toBeLessThan(panelWidths[panel - 1]);
    }

    roomWindow.dispose();
  });

  it("keeps all twelve quads indexed separately and flush at their joints", () => {
    const camera = makeRoomCamera(851, 832);
    const roomWindow = createRoomWindow3d(camera);
    const geometry = roomWindow.frame.geometry;
    const index = geometry.index;
    expect(index).not.toBeNull();
    if (!index) throw new Error("Expected indexed room window geometry");

    for (let quad = 0; quad < ROOM_WINDOW_MEMBER_COUNT; quad += 1) {
      const vertex = quad * QUAD_VERTEX_COUNT;
      const offset = quad * QUAD_INDEX_COUNT;
      expect(Array.from(index.array.slice(offset, offset + 6))).toEqual([
        vertex,
        vertex + 1,
        vertex + 2,
        vertex,
        vertex + 2,
        vertex + 3,
      ]);
    }

    const expectSameColumn = (a: THREE.Vector3, b: THREE.Vector3) => {
      expect(a.x).toBeCloseTo(b.x, 4);
      expect(a.z).toBeCloseTo(b.z, 4);
    };
    const firstRail = ROOM_WINDOW_PANEL_COUNT + 1;
    for (let panel = 0; panel < ROOM_WINDOW_PANEL_COUNT; panel += 1) {
      const rail = (firstRail + panel) * QUAD_VERTEX_COUNT;
      const leftPost = panel * QUAD_VERTEX_COUNT;
      const rightPost = (panel + 1) * QUAD_VERTEX_COUNT;
      expectSameColumn(
        geometryPoint(geometry, rail),
        geometryPoint(geometry, leftPost + 3),
      );
      expectSameColumn(
        geometryPoint(geometry, rail + 1),
        geometryPoint(geometry, leftPost + 2),
      );
      expectSameColumn(
        geometryPoint(geometry, rail + 3),
        geometryPoint(geometry, rightPost),
      );
      expectSameColumn(
        geometryPoint(geometry, rail + 2),
        geometryPoint(geometry, rightPost + 1),
      );
    }

    const sill = (ROOM_WINDOW_MEMBER_COUNT - 1) * QUAD_VERTEX_COUNT;
    const toScreenPlane = (vertex: number) => {
      const point = projectToScreen(
        geometryPoint(geometry, vertex),
        roomWindow.root,
        camera,
        DESKTOP_LAYOUT.viewport.width,
        DESKTOP_LAYOUT.viewport.height,
      );
      return new THREE.Vector3(point.x, point.y, 0);
    };
    const sillTop = new THREE.Line3(
      toScreenPlane(sill),
      toScreenPlane(sill + 3),
    );
    const closest = new THREE.Vector3();
    for (let post = 0; post <= ROOM_WINDOW_PANEL_COUNT; post += 1) {
      const base = post * QUAD_VERTEX_COUNT;
      for (const bottomVertex of [base + 1, base + 2]) {
        const point = toScreenPlane(bottomVertex);
        sillTop.closestPointToPoint(point, true, closest);
        expect(closest.distanceTo(point)).toBeLessThan(0.01);
      }
    }

    roomWindow.dispose();
  });

  it("keeps the merged frame out of the scene raycast path", () => {
    const { viewport, aperture, room } = WIDE_LAYOUT;
    const camera = makeRoomCamera(viewport.width, viewport.height);
    const roomWindow = createRoomWindow3d(camera);
    roomWindow.layout(
      camera,
      viewport.width,
      viewport.height,
      aperture,
      room,
    );

    const geometry = roomWindow.frame.geometry;
    const triangleCenter = geometryPoint(geometry, 0)
      .add(geometryPoint(geometry, 1))
      .add(geometryPoint(geometry, 2))
      .multiplyScalar(1 / 3)
      .applyMatrix4(roomWindow.frame.matrixWorld);
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(
      cameraPosition,
      triangleCenter.clone().sub(cameraPosition).normalize(),
    );
    const controlIntersections: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(
      roomWindow.frame,
      raycaster,
      controlIntersections,
    );

    expect(controlIntersections.length).toBeGreaterThan(0);
    expect(raycaster.intersectObject(roomWindow.frame, false)).toEqual([]);

    roomWindow.dispose();
  });

  it("disposes the merged geometry and material exactly once", () => {
    const camera = makeRoomCamera(851, 832);
    const roomWindow = createRoomWindow3d(camera);
    const host = new THREE.Group();
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    roomWindow.frame.geometry.addEventListener("dispose", geometryDisposed);
    roomWindow.frame.material.addEventListener("dispose", materialDisposed);
    host.add(roomWindow.root);

    roomWindow.dispose();
    roomWindow.dispose();

    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(roomWindow.frame.parent).toBeNull();
    expect(roomWindow.root.parent).toBeNull();
    expect(roomWindow.root.children).toEqual([]);
  });
});
