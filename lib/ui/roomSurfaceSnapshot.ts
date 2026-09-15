/** Mobile architecture only: spend pixel density on the cloth, not plaster. */
export const ROOM_SURFACE_MAX_DPR = 1.5;
export const ROOM_SURFACE_MAX_PIXELS = 1_500_000;
export const ROOM_SURFACE_INVALIDATE_EVENT = "room-surface-invalidate";
export const ROOM_SURFACE_MOBILE_MEDIA = "(max-width: 820px), (hover: none) and (pointer: coarse)";

export function roomSurfaceBitmapSize(width: number, height: number, dpr: number) {
  if (![width, height, dpr].every(Number.isFinite) || width <= 0 || height <= 0 || dpr <= 0) return null;
  const scale = Math.min(dpr, ROOM_SURFACE_MAX_DPR, Math.sqrt(ROOM_SURFACE_MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Computed fill URLs may contain the current document URL. Detached images
 * need the same fragment to point inside their own SVG, not back at the page. */
export function roomSurfaceLocalPaint(value: string): string {
  return value.replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, 'url("#$1")');
}

const PAINT_PROPERTIES = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "paint-order", "vector-effect", "opacity", "stop-color",
  "stop-opacity", "mix-blend-mode", "mask-image", "mask-size", "mask-position",
  "mask-repeat", "mask-mode", "mask-origin", "mask-clip", "-webkit-mask-image",
  "-webkit-mask-size", "-webkit-mask-position", "-webkit-mask-repeat",
  "color-interpolation", "color-interpolation-filters", "image-rendering",
] as const;

/** Clone the real planes and computed paint. No parallel drawing or geometry
 * model: the cache is a rasterization of exactly the production SVG. */
export function roomSurfaceSnapshot(source: SVGSVGElement, width: number, height: number): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const sources = [source, ...source.querySelectorAll<SVGElement>("*")];
  const targets = [clone, ...clone.querySelectorAll<SVGElement>("*")];
  for (let index = 0; index < sources.length; index += 1) {
    const style = getComputedStyle(sources[index]);
    const target = targets[index];
    target.removeAttribute("class");
    target.removeAttribute("style");
    for (const property of PAINT_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (value) target.style.setProperty(property, roomSurfaceLocalPaint(value));
    }
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  return clone;
}

const embeddedTextures = new Map<string, Promise<string>>();

/** SVG-as-image cannot load external images. Embed only the two trusted,
 * same-origin production plates and share these immutable bytes per page. */
export function roomSurfaceTexture(url: string): Promise<string> {
  const resolved = new URL(url, location.href);
  if (resolved.origin !== location.origin || !/^\/2d-textures\/room-(walls|floor)-perspective\.png$/.test(resolved.pathname)) {
    return Promise.reject(new Error("Unexpected room substrate texture"));
  }
  let embedded = embeddedTextures.get(resolved.href);
  if (!embedded) {
    embedded = fetch(resolved.href, { credentials: "same-origin" }).then(async response => {
      if (!response.ok) throw new Error("Room substrate texture unavailable");
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Room substrate texture could not be read"));
        reader.readAsDataURL(blob);
      });
    });
    embeddedTextures.set(resolved.href, embedded);
    embedded.catch(() => embeddedTextures.delete(resolved.href));
  }
  return embedded;
}

export async function embedRoomSurfaceTextures(snapshot: SVGSVGElement): Promise<void> {
  await Promise.all([...snapshot.querySelectorAll<SVGImageElement>("image")].map(async image => {
    image.setAttribute("href", await roomSurfaceTexture(image.getAttribute("href") ?? ""));
  }));
}
