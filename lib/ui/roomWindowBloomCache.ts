/** The window has no moving optics: only its parent opacity follows the sun.
 * Rasterize its existing filter once per measured geometry, never per tick. */
export const ROOM_WINDOW_BLOOM = {
  wideRadius: 18,
  wideAlpha: 0.3,
  nearRadius: 3,
  nearAlpha: 0.55,
  maxPixels: 2_000_000,
  resizeDelay: 120,
} as const;

interface Rect { left: number; top: number; width: number; height: number }
export interface RoomWindowBloomPlan {
  key: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}

/** Clip the bitmap, not the source path. Offscreen glass can still scatter
 * into the visible room; the original filter sees the entire aperture. */
export function planRoomWindowBloom(
  viewBox: string, path: string, screen: Rect, visible: Rect, dpr: number,
): RoomWindowBloomPlan | null {
  const box = viewBox.trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || !path
    || !Object.values(screen).every(Number.isFinite) || !Object.values(visible).every(Number.isFinite)
    || box[2] <= 0 || box[3] <= 0 || screen.width <= 0 || screen.height <= 0
    || visible.width <= 0 || visible.height <= 0) return null;
  const [left, top, width, height] = box;
  const scaleX = screen.width / width;
  const scaleY = screen.height / height;
  // Three sigma outside the visible crop prevents a crop edge from entering
  // the room during fractional-pixel layout/compositing. Source blur is exact.
  const guard = ROOM_WINDOW_BLOOM.wideRadius * 3;
  const x = Math.max(left - width * 0.15, left + (visible.left - screen.left) / scaleX - guard);
  const y = Math.max(top - height * 0.3, top + (visible.top - screen.top) / scaleY - guard);
  const right = Math.min(left + width * 1.15,
    left + (visible.left + visible.width - screen.left) / scaleX + guard);
  const bottom = Math.min(top + height * 1.3,
    top + (visible.top + visible.height - screen.top) / scaleY + guard);
  if (right <= x || bottom <= y) return null;
  const cropWidth = right - x;
  const cropHeight = bottom - y;
  const density = Number.isFinite(dpr) ? Math.min(2, Math.max(1, dpr)) : 1;
  const desiredWidth = Math.ceil(cropWidth * scaleX * density);
  const desiredHeight = Math.ceil(cropHeight * scaleY * density);
  const budgetScale = Math.min(1, Math.sqrt(ROOM_WINDOW_BLOOM.maxPixels / (desiredWidth * desiredHeight)));
  const pixelWidth = Math.max(1, Math.floor(desiredWidth * budgetScale));
  const pixelHeight = Math.max(1, Math.floor(desiredHeight * budgetScale));
  return {
    key: JSON.stringify([viewBox, path, x, y, cropWidth, cropHeight, pixelWidth, pixelHeight]),
    path, x, y, width: cropWidth, height: cropHeight, pixelWidth, pixelHeight,
  };
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function roomWindowBloomSvg(plan: RoomWindowBloomPlan): string {
  const optics = ROOM_WINDOW_BLOOM;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.pixelWidth}" height="${plan.pixelHeight}" viewBox="${plan.x} ${plan.y} ${plan.width} ${plan.height}" preserveAspectRatio="none"><defs>
<filter id="bloom" x="-15%" y="-30%" width="130%" height="160%" color-interpolation-filters="sRGB">
<feGaussianBlur in="SourceGraphic" stdDeviation="${optics.wideRadius}" result="wide"/>
<feComponentTransfer in="wide" result="wide-bloom"><feFuncA type="linear" slope="${optics.wideAlpha}"/></feComponentTransfer>
<feGaussianBlur in="SourceGraphic" stdDeviation="${optics.nearRadius}" result="near"/>
<feComponentTransfer in="near" result="near-bloom"><feFuncA type="linear" slope="${optics.nearAlpha}"/></feComponentTransfer>
<feMerge><feMergeNode in="wide-bloom"/><feMergeNode in="near-bloom"/></feMerge></filter></defs>
<path d="${escapeAttribute(plan.path)}" fill="#fff" filter="url(#bloom)"/></svg>`;
}

type Rasterizer = (plan: RoomWindowBloomPlan, ready: (url: string) => void, failed: () => void) => () => void;

/** The returned disposer owns both URLs, including the successfully published
 * PNG. No canvas/context survives the bake and no WebGL context is created. */
export const rasterizeRoomWindowBloom: Rasterizer = (plan, ready, failed) => {
  let disposed = false;
  let sourceUrl = URL.createObjectURL(new Blob([roomWindowBloomSvg(plan)], { type: "image/svg+xml" }));
  let rasterUrl = "";
  const source = new Image();
  const raster = new Image();
  const releaseSource = () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = "";
    source.onload = source.onerror = null;
    source.src = "";
  };
  const fail = () => {
    releaseSource();
    raster.onload = raster.onerror = null;
    raster.src = "";
    if (rasterUrl) URL.revokeObjectURL(rasterUrl);
    rasterUrl = "";
    if (!disposed) failed();
  };
  source.onerror = fail;
  source.onload = () => {
    if (disposed) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = plan.pixelWidth;
      canvas.height = plan.pixelHeight;
      const context = canvas.getContext("2d");
      if (!context) { fail(); return; }
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      releaseSource();
      canvas.toBlob(blob => {
        // Release the temporary backing store as soon as encoding finishes.
        canvas.width = canvas.height = 0;
        if (disposed) return;
        if (!blob) { fail(); return; }
        rasterUrl = URL.createObjectURL(blob);
        raster.onerror = fail;
        raster.onload = () => {
          if (!disposed) ready(rasterUrl);
          raster.onload = raster.onerror = null;
          raster.src = "";
        };
        raster.src = rasterUrl;
      }, "image/png");
    } catch { fail(); }
  };
  source.src = sourceUrl;
  return () => {
    disposed = true;
    releaseSource();
    raster.onload = raster.onerror = null;
    source.src = raster.src = "";
    if (rasterUrl) URL.revokeObjectURL(rasterUrl);
  };
};

export function attachRoomWindowBloomCache(svg: SVGSVGElement, rasterize: Rasterizer = rasterizeRoomWindowBloom): () => void {
  const aperture = svg.querySelector<SVGPathElement>('[data-window-path="aperture"]');
  const fallback = svg.querySelector<SVGGElement>("[data-window-bloom-source]");
  const image = svg.querySelector<SVGImageElement>("[data-window-bloom-cache]");
  if (!aperture || !fallback || !image) return () => {};
  let key: string | undefined;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposeRaster: (() => void) | undefined;
  const sync = () => {
    if (disposed) return;
    const screen = svg.getBoundingClientRect();
    const room = svg.closest(".room-frame")?.getBoundingClientRect();
    const left = Math.max(0, room?.left ?? 0);
    const top = Math.max(0, room?.top ?? 0);
    const right = Math.min(window.innerWidth, room ? room.left + room.width : window.innerWidth);
    const bottom = Math.min(window.innerHeight, room ? room.top + room.height : window.innerHeight);
    const plan = planRoomWindowBloom(svg.getAttribute("viewBox") ?? "", aperture.getAttribute("d") ?? "",
      screen, { left, top, width: right - left, height: bottom - top }, window.devicePixelRatio);
    if ((plan?.key ?? "") === key) return;
    key = plan?.key ?? "";
    const current = ++generation;
    clearTimeout(timer);
    disposeRaster?.();
    disposeRaster = undefined;
    image.style.display = "none";
    image.removeAttribute("href");
    fallback.style.display = plan ? "" : "none";
    svg.dataset.windowBloom = plan ? "pending" : "empty";
    if (!plan) return;
    timer = setTimeout(() => {
      try {
        disposeRaster = rasterize(plan, url => {
          if (current !== generation) return;
          for (const [name, value] of Object.entries({ x: plan.x, y: plan.y, width: plan.width, height: plan.height })) {
            image.setAttribute(name, String(value));
          }
          image.setAttribute("href", url);
          image.style.display = "";
          fallback.style.display = "none";
          svg.dataset.windowBloom = "cached";
        }, () => {
          if (current === generation) svg.dataset.windowBloom = "fallback";
        });
      } catch {
        // Blob/canvas allocation can fail under memory pressure. Retain the
        // existing vector result instead of blanking the window or retrying.
        if (current === generation) svg.dataset.windowBloom = "fallback";
      }
    }, ROOM_WINDOW_BLOOM.resizeDelay);
  };
  const observer = new MutationObserver(sync);
  // Daylight changes styles, not geometry: deliberately do not observe style.
  observer.observe(svg, { attributes: true, attributeFilter: ["viewBox"] });
  observer.observe(aperture, { attributes: true, attributeFilter: ["d"] });
  window.addEventListener("resize", sync, { passive: true });
  sync();
  return () => {
    disposed = true;
    generation += 1;
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener("resize", sync);
    disposeRaster?.();
    image.removeAttribute("href");
    image.style.display = "none";
    fallback.style.display = "";
    delete svg.dataset.windowBloom;
  };
}
