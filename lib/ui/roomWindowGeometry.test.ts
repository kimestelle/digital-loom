import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { createRoomWindow3d } from "./roomWindow3d";
import { resolveRoomFloorApertureRightBottom } from "./roomFloorProjection";
import {
  ROOM_WINDOW_MEMBER_COUNT,
  ROOM_WINDOW_PANEL_COUNT,
  resolveRoomWindowGeometry,
  type RoomWindowApertureRect,
  type RoomWindowRoomRect,
} from "./roomWindowGeometry";

const layouts = [
  {
    name: "desktop",
    viewport: { width: 851, height: 832 },
    room: { left: 0, width: 1280 },
    aperture: { left: -66, top: 0, width: 880, height: 415.059 },
  },
  {
    name: "mobile",
    viewport: { width: 393, height: 568 },
    room: { left: 0, width: 393 },
    aperture: { left: -651.230411, top: 0, width: 901.153848, height: 425.036379 },
  },
] as const;

describe("shared room window geometry", () => {
  it.each(layouts)("matches every depth-tested vertex in the $name renderer", ({ viewport, room, aperture }) => {
    const pixels = resolveRoomWindowGeometry(aperture, room);
    const camera = new THREE.PerspectiveCamera(30, viewport.width / viewport.height, 1, 8000);
    camera.position.set(890, 0, -966);
    camera.lookAt(20, 0, 0);
    camera.updateMatrixWorld(true);
    const model = createRoomWindow3d(camera);
    model.layout(camera, viewport.width, viewport.height, aperture, room);
    const positions = model.frame.geometry.getAttribute("position");
    pixels.quads.forEach((quad, index) => {
      quad.points.forEach((expected, vertex) => {
        const point = new THREE.Vector3().fromBufferAttribute(positions, index * 4 + vertex)
          .applyMatrix4(model.root.matrixWorld).project(camera);
        expect((point.x + 1) * viewport.width / 2).toBeCloseTo(expected.x, 3);
        expect((1 - point.y) * viewport.height / 2).toBeCloseTo(expected.y, 3);
      });
    });
    model.dispose();
  });

  it.each(layouts)("shares the $name floor aperture and keeps the sill flush", ({ room, aperture }) => {
    const geometry = resolveRoomWindowGeometry(aperture, room);
    expect(geometry.quads).toHaveLength(ROOM_WINDOW_MEMBER_COUNT);
    expect(geometry.quads.map(quad => quad.kind)).toEqual([
      ...Array(ROOM_WINDOW_MEMBER_COUNT - 1).fill("frame"), "sill",
    ]);
    expect(geometry.aperture[0]).toEqual({ x: aperture.left, y: aperture.top });
    expect(geometry.aperture[2].x).toBeCloseTo(aperture.left + aperture.width, 10);
    expect(geometry.aperture[2].y).toBeCloseTo(aperture.top + aperture.height * geometry.rightVerticalScale, 10);
    expect(geometry.rightVerticalScale).toBe(resolveRoomFloorApertureRightBottom(
      aperture, { ...room, top: 0, height: 832 },
    ));
    const sill = geometry.quads.at(-1)!;
    expect(sill.points[1]).toEqual(geometry.aperture[3]);
    expect(sill.points[2]).toEqual(geometry.aperture[2]);
    const left = sill.points[0];
    const right = sill.points[3];
    geometry.quads.slice(0, ROOM_WINDOW_PANEL_COUNT + 1).forEach(quad => {
      for (const point of [quad.points[1], quad.points[2]]) {
        const lineY = left.y + (right.y - left.y) * (point.x - left.x) / (right.x - left.x);
        expect(point.y).toBeCloseTo(lineY, 10);
      }
    });
  });

  it("translates with the shared room origin without changing perspective", () => {
    const { aperture, room } = layouts[0];
    const original = resolveRoomWindowGeometry(aperture, room);
    const translated = resolveRoomWindowGeometry(
      { ...aperture, left: aperture.left + 125, top: aperture.top + 47 },
      { ...room, left: room.left + 125 },
    );
    expect(translated.rightVerticalScale).toBe(original.rightVerticalScale);
    translated.quads.forEach((quad, index) => {
      quad.points.forEach((point, vertex) => {
        expect(point.x).toBeCloseTo(original.quads[index].points[vertex].x + 125, 10);
        expect(point.y).toBeCloseTo(original.quads[index].points[vertex].y + 47, 10);
      });
    });
  });

  it("does not mutate caller layout and resolves malformed dimensions to finite points", () => {
    const aperture: RoomWindowApertureRect = { left: NaN, top: Infinity, width: -10, height: NaN };
    const room: RoomWindowRoomRect = { left: NaN, width: Infinity };
    const apertureBefore = { ...aperture };
    const roomBefore = { ...room };
    const geometry = resolveRoomWindowGeometry(aperture, room);
    expect(aperture).toEqual(apertureBefore);
    expect(room).toEqual(roomBefore);
    expect(Number.isFinite(geometry.rightVerticalScale)).toBe(true);
    for (const point of [...geometry.aperture, ...geometry.quads.flatMap(quad => quad.points)]) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});
