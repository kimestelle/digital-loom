import { describe, expect, it, vi } from "vitest";
import type { ResolvedRoomClothShadow } from "./roomClothShadow";
import { createRoomClothShadowCanvas } from "./roomClothShadowCanvas";

const SHADOW: ResolvedRoomClothShadow = {
  points: [
    { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 },
    { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 },
  ],
  left: 12.34,
  top: 56.78,
  width: 512,
  height: 128,
  opacity: 0.18,
};

function mockCanvas(hasContext = true) {
  const context = {
    clearRect: vi.fn<CanvasRenderingContext2D["clearRect"]>(),
    beginPath: vi.fn<CanvasRenderingContext2D["beginPath"]>(),
    moveTo: vi.fn<CanvasRenderingContext2D["moveTo"]>(),
    lineTo: vi.fn<CanvasRenderingContext2D["lineTo"]>(),
    closePath: vi.fn<CanvasRenderingContext2D["closePath"]>(),
    fill: vi.fn<CanvasRenderingContext2D["fill"]>(),
    fillStyle: "",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
  };
  const style = {
    opacity: "",
    transform: "",
    removeProperty: vi.fn<CSSStyleDeclaration["removeProperty"]>(),
  };
  style.removeProperty.mockImplementation((property) => {
    if (property !== "transform") throw new Error(`Unexpected removal: ${property}`);
    const previous = style.transform;
    style.transform = "";
    return previous;
  });
  const getContext = vi.fn(() => hasContext ? context : null);
  const canvas = { width: 256, height: 128, style, getContext };
  const painter = createRoomClothShadowCanvas(canvas as unknown as HTMLCanvasElement);
  return { canvas, context, painter };
}

describe("room cloth shadow canvas", () => {
  it("paints a soft silhouette inside the fixed 256×128 backing surface", () => {
    const { canvas, context, painter } = mockCanvas();
    painter.paint(SHADOW);

    expect(canvas.getContext).toHaveBeenCalledExactlyOnceWith("2d");
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 256, 128);
    expect(context.beginPath).toHaveBeenCalledOnce();
    expect(context.closePath).toHaveBeenCalledOnce();
    expect(context.fill).toHaveBeenCalledOnce();
    expect(context.shadowBlur).toBeGreaterThan(0);
    const source = [...context.moveTo.mock.calls, ...context.lineTo.mock.calls];
    expect(source).toHaveLength(SHADOW.points.length);
    for (const [x, y] of source) {
      expect(x).toBeLessThan(0);
      expect(x + context.shadowOffsetX).toBeGreaterThanOrEqual(0);
      expect(x + context.shadowOffsetX).toBeLessThanOrEqual(256);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(128);
    }
    expect(canvas.style.transform).toBe("translate3d(12.3px, 56.8px, 0) scale(2.0000, 1.0000)");
    expect(canvas.style.opacity).toBe("0.180");
    expect([canvas.width, canvas.height]).toEqual([256, 128]);
  });

  it("reuses the raster for identical hulls and solver movement below a backing pixel", () => {
    const { context, painter } = mockCanvas();
    painter.paint(SHADOW);
    painter.paint({ ...SHADOW, points: SHADOW.points.map(point => ({ ...point })) });
    painter.paint({
      ...SHADOW,
      points: SHADOW.points.map(point => ({ x: point.x + 0.2 / 256, y: point.y - 0.2 / 128 })),
    });

    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.fill).toHaveBeenCalledOnce();
  });

  it("repaints when a hull point moves into another backing pixel", () => {
    const { context, painter } = mockCanvas();
    painter.paint(SHADOW);
    painter.paint({
      ...SHADOW,
      points: SHADOW.points.map((point, index) => index === 0 ? { ...point, x: point.x + 1 / 256 } : point),
    });

    expect(context.clearRect).toHaveBeenCalledTimes(2);
    expect(context.fill).toHaveBeenCalledTimes(2);
    const [firstX] = context.moveTo.mock.calls[0];
    expect(context.moveTo.mock.calls[1][0]).toBe(firstX + 1);
  });

  it("changes opacity without repainting the silhouette", () => {
    const { canvas, context, painter } = mockCanvas();
    painter.paint(SHADOW);
    painter.paint({ ...SHADOW, opacity: 0.075 });

    expect(canvas.style.opacity).toBe("0.075");
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.fill).toHaveBeenCalledOnce();
  });

  it("moves and scales the plate without enlarging or repainting its raster", () => {
    const { canvas, context, painter } = mockCanvas();
    painter.paint(SHADOW);
    painter.paint({ ...SHADOW, left: 120, top: 240, width: 1536, height: 384 });

    expect(canvas.style.transform).toBe("translate3d(120.0px, 240.0px, 0) scale(6.0000, 3.0000)");
    expect([canvas.width, canvas.height]).toEqual([256, 128]);
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.fill).toHaveBeenCalledOnce();
  });

  it.each([null, { ...SHADOW, opacity: 0 }, { ...SHADOW, opacity: 0.0009 }])(
    "hides an absent or imperceptible shadow and can reveal its cached raster",
    (hidden) => {
      const { canvas, context, painter } = mockCanvas();
      painter.paint(SHADOW);
      painter.paint(hidden);
      expect(canvas.style.opacity).toBe("0");
      expect(context.fill).toHaveBeenCalledOnce();

      painter.paint(SHADOW);
      expect(canvas.style.opacity).toBe("0.180");
      expect(context.clearRect).toHaveBeenCalledOnce();
      expect(context.fill).toHaveBeenCalledOnce();
    },
  );

  it("hides safely when the browser cannot supply a 2D context", () => {
    const { canvas, context, painter } = mockCanvas(false);
    painter.paint(SHADOW);
    expect(canvas.style.opacity).toBe("0");
    expect(canvas.style.transform).toBe("");
    expect(context.fill).not.toHaveBeenCalled();

    expect(() => painter.dispose()).not.toThrow();
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it("allows the renderer to hide the plate without discarding the raster", () => {
    const { canvas, context, painter } = mockCanvas();
    painter.paint(SHADOW);
    painter.hide();
    painter.hide();
    expect(canvas.style.opacity).toBe("0");

    painter.paint(SHADOW);
    expect(canvas.style.opacity).toBe("0.180");
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.fill).toHaveBeenCalledOnce();
  });

  it("clears the backing pixels and removes the transform on disposal", () => {
    const { canvas, context, painter } = mockCanvas();
    painter.paint(SHADOW);
    context.clearRect.mockClear();
    painter.dispose();

    expect(canvas.style.opacity).toBe("0");
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 256, 128);
    expect(canvas.style.removeProperty).toHaveBeenCalledExactlyOnceWith("transform");
    expect(canvas.style.transform).toBe("");
    expect(context.fill).toHaveBeenCalledOnce();
  });
});
