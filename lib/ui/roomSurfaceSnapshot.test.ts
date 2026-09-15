import { describe, expect, it } from "vitest";
import { roomSurfaceBitmapSize, roomSurfaceLocalPaint, ROOM_SURFACE_MAX_PIXELS } from "./roomSurfaceSnapshot";

describe("mobile room substrate cache", () => {
  it("uses the visible phone bounds, not the full desktop room width", () => {
    expect(roomSurfaceBitmapSize(390, 675.2, 3)).toEqual({ width: 585, height: 1012 });
  });

  it("bounds landscape/tablet memory independently of device pixel density", () => {
    const size = roomSurfaceBitmapSize(1366, 1024, 3)!;
    expect(size.width * size.height).toBeLessThanOrEqual(ROOM_SURFACE_MAX_PIXELS);
    expect(roomSurfaceBitmapSize(390, 675, 1)).toEqual({ width: 390, height: 675 });
  });

  it("rejects collapsed or nonfinite measurement before image work", () => {
    for (const values of [[0, 10, 2], [10, 0, 2], [Infinity, 10, 2], [10, 10, NaN]]) {
      expect(roomSurfaceBitmapSize(...values as [number, number, number])).toBeNull();
    }
  });

  it("keeps paint-server fragments local in a detached SVG image", () => {
    expect(roomSurfaceLocalPaint('url("http://localhost:3003/room#room-floor-plane")')).toBe('url("#room-floor-plane")');
    expect(roomSurfaceLocalPaint("url(#room-floor-plane)")).toBe('url("#room-floor-plane")');
    expect(roomSurfaceLocalPaint("oklab(0.89 0.01 0.02)")).toBe("oklab(0.89 0.01 0.02)");
    expect(roomSurfaceLocalPaint("linear-gradient(rgb(0, 0, 0), transparent)")).toBe("linear-gradient(rgb(0, 0, 0), transparent)");
  });
});
