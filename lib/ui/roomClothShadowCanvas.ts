import type { resolveRoomClothShadow } from "./roomClothShadow";

type Shadow = ReturnType<typeof resolveRoomClothShadow>;

/** A bounded, low-resolution alpha plate. No CSS/SVG blur over the viewport. */
export function createRoomClothShadowCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  let lastShape = "";
  let lastTransform = "";
  let lastOpacity = "";

  const hide = () => {
    if (lastOpacity === "0") return;
    canvas.style.opacity = "0";
    lastOpacity = "0";
  };

  return {
    paint(shadow: Shadow) {
      if (!context || !shadow || shadow.opacity < 0.001) {
        hide();
        return;
      }
      const { width, height } = canvas;
      // Quantization avoids repainting the plate for subpixel solver noise.
      const points = shadow.points.map((point) => ({
        x: Math.round(point.x * width),
        y: Math.round(point.y * height),
      }));
      const shape = points.map((point) => `${point.x},${point.y}`).join(" ");
      if (shape !== lastShape) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#25232a";
        context.shadowColor = "#25232a";
        context.shadowBlur = 12;
        // Draw the source outside the plate and only its soft shadow inside.
        // Canvas shadowBlur works on Safari too; no Canvas filter dependency.
        context.shadowOffsetX = width * 2;
        context.beginPath();
        points.forEach((point, index) => {
          const x = point.x - width * 2;
          if (index === 0) context.moveTo(x, point.y);
          else context.lineTo(x, point.y);
        });
        context.closePath();
        context.fill();
        lastShape = shape;
      }
      const transform = `translate3d(${shadow.left.toFixed(1)}px, ${shadow.top.toFixed(1)}px, 0) scale(${(shadow.width / width).toFixed(4)}, ${(shadow.height / height).toFixed(4)})`;
      const opacity = shadow.opacity.toFixed(3);
      if (transform !== lastTransform) {
        canvas.style.transform = transform;
        lastTransform = transform;
      }
      if (opacity !== lastOpacity) {
        canvas.style.opacity = opacity;
        lastOpacity = opacity;
      }
    },
    hide,
    dispose() {
      hide();
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.removeProperty("transform");
    },
  };
}
