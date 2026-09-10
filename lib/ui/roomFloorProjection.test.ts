import { describe, expect, it } from "vitest";
import type { ResolvedRoomLight } from "./roomLight";
import {
  ROOM_FLOOR_PROJECTION_BASE_LENGTH,
  ROOM_FLOOR_PROJECTION_BASE_WIDTH,
  resolveRoomFloorApertureRightBottom,
  resolveRoomFloorProjection,
  type RoomFloorProjectionLayout,
  type RoomFloorProjectionRect,
} from "./roomFloorProjection";

const SOURCE_ROOM_WIDTH = 1280;
const SOURCE_ROOM_HEIGHT = 832;
const FLOOR_SEAM = {
  left: { x: 0.5 / SOURCE_ROOM_WIDTH, y: 662.5 / SOURCE_ROOM_HEIGHT },
  corner: {
    x: 920.5 / SOURCE_ROOM_WIDTH,
    y: 554.5 / SOURCE_ROOM_HEIGHT,
  },
  right: {
    x: 1279.5 / SOURCE_ROOM_WIDTH,
    y: 717.865 / SOURCE_ROOM_HEIGHT,
  },
} as const;

const CALIBRATED_ANGLE = 45.8166;
const CALIBRATED_RADIANS = (CALIBRATED_ANGLE * Math.PI) / 180;

const CALIBRATED_LIGHT: Pick<ResolvedRoomLight, "beam" | "window"> = {
  beam: {
    screenDirectionX: Math.cos(CALIBRATED_RADIANS),
    screenDirectionY: Math.sin(CALIBRATED_RADIANS),
    rotation: CALIBRATED_ANGLE,
    reach: 0.5,
    opacity: 1,
  },
  window: {
    tint: { r: 1, g: 1, b: 1 },
    glow: 1,
    hotspotX: 0.445371,
    hotspotY: 0.250181,
  },
};

interface ProjectionFixture {
  name: string;
  layout: Omit<RoomFloorProjectionLayout, "apertureRightBottom">;
  rightBottom: number;
  expected: {
    x: number;
    y: number;
    length: number;
    width: number;
    scaleX: number;
    scaleY: number;
  };
}

const FIXTURES: readonly ProjectionFixture[] = [
  {
    name: "desktop",
    layout: {
      room: { left: 0, top: 0, width: 1144, height: 730 },
      planes: { left: 0, top: 0, width: 1144, height: 730 },
      aperture: {
        left: -42.86202114,
        top: 0,
        width: 772.1153863,
        height: 364.1743627,
      },
    },
    rightBottom: 0.8481103467,
    expected: {
      x: 704.537787,
      y: 500.1375926,
      length: 320.5388095,
      width: 592.2453652,
      scaleX: 0.6260523624,
      scaleY: 2.3134584577,
    },
  },
  {
    name: "mobile with an 80% measured plane",
    layout: {
      room: { left: 0, top: 0, width: 390, height: 844 },
      planes: { left: 0, top: 0, width: 390, height: 675.2 },
      aperture: {
        left: -644.67668464,
        top: 0,
        width: 892.69230964,
        height: 421.04542756,
      },
    },
    rightBottom: 0.6222273027,
    expected: {
      x: 145.9714078,
      y: 492.0505447,
      length: 350.1341743,
      width: 751.0185378,
      scaleX: 0.6838558091,
      scaleY: 2.9336661631,
    },
  },
  {
    name: "wide room with a client-coordinate offset",
    layout: {
      room: { left: 12, top: 20, width: 1600, height: 900 },
      planes: { left: 12, top: 20, width: 1600, height: 900 },
      aperture: {
        left: 95.4975938,
        top: 20,
        width: 951.923079,
        height: 448.982091,
      },
    },
    rightBottom: 0.8633511991,
    expected: {
      x: 1002.5153267,
      y: 614.8659702,
      length: 397.6140489,
      width: 725.3963302,
      scaleX: 0.7765899392,
      scaleY: 2.8335794149,
    },
  },
];

function withResolvedSill(
  layout: Omit<RoomFloorProjectionLayout, "apertureRightBottom">,
): RoomFloorProjectionLayout {
  return {
    ...layout,
    apertureRightBottom: resolveRoomFloorApertureRightBottom(
      layout.aperture,
      layout.room,
    ),
  };
}

function floorSeam(layout: RoomFloorProjectionLayout) {
  const left = layout.planes.left - layout.room.left;
  const top = layout.planes.top - layout.room.top;
  const point = (ratio: { x: number; y: number }) => ({
    x: left + layout.planes.width * ratio.x,
    y: top + layout.planes.height * ratio.y,
  });
  return {
    left: point(FLOOR_SEAM.left),
    corner: point(FLOOR_SEAM.corner),
    right: point(FLOOR_SEAM.right),
  };
}

function apertureHotspot(
  layout: RoomFloorProjectionLayout,
  light: Pick<ResolvedRoomLight, "beam" | "window">,
) {
  const u = light.window.hotspotX;
  return {
    x: layout.aperture.left - layout.room.left + layout.aperture.width * u,
    y:
      layout.aperture.top -
      layout.room.top +
      layout.aperture.height *
        light.window.hotspotY *
        (1 - (1 - layout.apertureRightBottom) * u),
  };
}

function expectFiniteHidden(
  result: ReturnType<typeof resolveRoomFloorProjection>,
) {
  for (const value of Object.values(result)) expect(Number.isFinite(value)).toBe(true);
  expect(result).toMatchObject({
    length: 0,
    width: 0,
    scaleX: 0,
    scaleY: 0,
    visible: 0,
  });
}

describe("room floor projection", () => {
  it("enters on the measured SVG floor seam along the aperture hotspot ray", () => {
    const layout = withResolvedSill(FIXTURES[0].layout);
    const result = resolveRoomFloorProjection(CALIBRATED_LIGHT, layout);
    const source = apertureHotspot(layout, CALIBRATED_LIGHT);
    const seam = floorSeam(layout);
    const segment = result.x <= seam.corner.x
      ? [seam.left, seam.corner]
      : [seam.corner, seam.right];
    const travel = { x: result.x - source.x, y: result.y - source.y };
    const travelLength = Math.hypot(travel.x, travel.y);
    const segmentVector = {
      x: segment[1].x - segment[0].x,
      y: segment[1].y - segment[0].y,
    };
    const hitFromStart = {
      x: result.x - segment[0].x,
      y: result.y - segment[0].y,
    };
    const seamCross =
      segmentVector.x * hitFromStart.y - segmentVector.y * hitFromStart.x;
    const seamProgress =
      (hitFromStart.x * segmentVector.x + hitFromStart.y * segmentVector.y) /
      (segmentVector.x ** 2 + segmentVector.y ** 2);

    expect(result.visible).toBe(1);
    expect(seamCross).toBeCloseTo(0, 7);
    expect(seamProgress).toBeGreaterThanOrEqual(0);
    expect(seamProgress).toBeLessThanOrEqual(1);
    expect(travel.x / travelLength).toBeCloseTo(
      CALIBRATED_LIGHT.beam.screenDirectionX,
      10,
    );
    expect(travel.y / travelLength).toBeCloseTo(
      CALIBRATED_LIGHT.beam.screenDirectionY,
      10,
    );
    expect(result.angle).toBeCloseTo(CALIBRATED_ANGLE, 10);

    const endpoint = {
      x: result.x + result.length * CALIBRATED_LIGHT.beam.screenDirectionX,
      y: result.y + result.length * CALIBRATED_LIGHT.beam.screenDirectionY,
    };
    expect(
      Math.min(
        Math.abs(endpoint.x),
        Math.abs(endpoint.y),
        Math.abs(endpoint.x - layout.room.width),
        Math.abs(endpoint.y - layout.room.height),
      ),
    ).toBeCloseTo(0, 7);
  });

  it.each(FIXTURES)(
    "keeps the calibrated projection registered after a $name resize",
    ({ layout: rawLayout, rightBottom, expected }) => {
      const layout = withResolvedSill(rawLayout);
      const result = resolveRoomFloorProjection(CALIBRATED_LIGHT, layout);

      expect(layout.apertureRightBottom).toBeCloseTo(rightBottom, 9);
      expect(result).toMatchObject({ visible: 1 });
      expect(result.angle).toBeCloseTo(CALIBRATED_ANGLE, 10);
      expect(result.x).toBeCloseTo(expected.x, 6);
      expect(result.y).toBeCloseTo(expected.y, 6);
      expect(result.length).toBeCloseTo(expected.length, 6);
      expect(result.width).toBeCloseTo(expected.width, 6);
      expect(result.scaleX).toBeCloseTo(expected.scaleX, 8);
      expect(result.scaleY).toBeCloseTo(expected.scaleY, 8);
      expect(result.scaleX).toBeCloseTo(
        result.length / ROOM_FLOOR_PROJECTION_BASE_LENGTH,
        12,
      );
      expect(result.scaleY).toBeCloseTo(
        result.width / ROOM_FLOOR_PROJECTION_BASE_WIDTH,
        12,
      );
    },
  );

  it("uses the measured mobile plane height instead of the obscured full room", () => {
    const mobile = FIXTURES[1].layout;
    const measuredLayout = withResolvedSill(mobile);
    const incorrectFullHeightLayout = withResolvedSill({
      ...mobile,
      planes: { ...mobile.planes, height: mobile.room.height },
    });
    const measured = resolveRoomFloorProjection(
      CALIBRATED_LIGHT,
      measuredLayout,
    );
    const fullHeight = resolveRoomFloorProjection(
      CALIBRATED_LIGHT,
      incorrectFullHeightLayout,
    );

    expect(mobile.planes.height / mobile.room.height).toBe(0.8);
    expect(measured.y).toBeCloseTo(492.0505447, 6);
    expect(measured.y).toBeLessThan(fullHeight.y);
    expect(Math.abs(measured.y - fullHeight.y)).toBeGreaterThan(80);
  });

  it("returns a finite hidden fallback for malformed and parallel rays", () => {
    const layout = withResolvedSill(FIXTURES[0].layout);
    const seam = floorSeam(layout);
    const parallelX = seam.corner.x - seam.left.x;
    const parallelY = seam.corner.y - seam.left.y;
    const parallelLength = Math.hypot(parallelX, parallelY);
    const parallelLight = {
      ...CALIBRATED_LIGHT,
      beam: {
        ...CALIBRATED_LIGHT.beam,
        screenDirectionX: parallelX / parallelLength,
        screenDirectionY: parallelY / parallelLength,
      },
    };
    const malformedLayout = {
      ...layout,
      planes: { ...layout.planes, width: Number.NaN },
    };
    const malformedLight = {
      ...CALIBRATED_LIGHT,
      beam: {
        ...CALIBRATED_LIGHT.beam,
        screenDirectionX: Number.POSITIVE_INFINITY,
      },
    };

    expectFiniteHidden(resolveRoomFloorProjection(parallelLight, layout));
    expectFiniteHidden(resolveRoomFloorProjection(CALIBRATED_LIGHT, malformedLayout));
    expectFiniteHidden(resolveRoomFloorProjection(malformedLight, layout));
    expect(resolveRoomFloorApertureRightBottom(malformedLayout.aperture, malformedLayout.planes)).toBe(0.846);
  });

  it("returns the finite hidden fallback when an offscreen source ray misses the floor", () => {
    const rawLayout = FIXTURES[0].layout;
    const offscreenAperture: RoomFloorProjectionRect = {
      left: rawLayout.room.left + rawLayout.room.width + 100,
      top: 0,
      width: 100,
      height: 160,
    };
    const layout = withResolvedSill({ ...rawLayout, aperture: offscreenAperture });

    expectFiniteHidden(resolveRoomFloorProjection(CALIBRATED_LIGHT, layout));
  });
});
