import type { MapName } from "@/lib/core/materialPackage";

export interface MapImageSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
  invert: boolean;
  normalStrength: number;
  flipNormalY: boolean;
}

export const DEFAULT_MAP_IMAGE_SETTINGS: MapImageSettings = {
  brightness: 0,
  contrast: 0,
  saturation: 1,
  hue: 0,
  blur: 0,
  invert: false,
  normalStrength: 1,
  flipNormalY: false,
};

// A 4096 x 4096 texture is the largest common square authoring map. Keep that
// native size, while rejecting larger allocations before a browser canvas is
// created. Very wide maps can still use an 8192px edge if they stay inside the
// same total pixel budget.
export const MAX_MAP_BAKE_DIMENSION = 8192;
export const MAX_MAP_BAKE_PIXELS = 4096 * 4096;

const NORMAL_EDIT_TILE_PIXELS = 512 * 1024;
const NORMAL_EDIT_MAX_TILE_ROWS = 256;

export function mapBakeSafetyError(width: number, height: number): string | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "This map has invalid pixel dimensions and cannot be edited.";
  }

  if (
    width > MAX_MAP_BAKE_DIMENSION ||
    height > MAX_MAP_BAKE_DIMENSION ||
    width * height > MAX_MAP_BAKE_PIXELS
  ) {
    return `This map is too large to edit safely. Use at most ${MAX_MAP_BAKE_DIMENSION}px on either side and 4096 × 4096 pixels total.`;
  }

  return null;
}

/** Bound each normal-map ImageData allocation to roughly 2 MiB. */
export function normalEditTileRows(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(
    1,
    Math.min(
      NORMAL_EDIT_MAX_TILE_ROWS,
      Math.floor(NORMAL_EDIT_TILE_PIXELS / width),
    ),
  );
}

export function isNormalMap(name: MapName): boolean {
  return name === "normal";
}

export function isColorMap(name: MapName): boolean {
  return name === "albedo";
}

/** Build the browser canvas filter for an image pass. `pixelScale` keeps blur
 * visually consistent when a native image is shown through a smaller preview. */
export function buildMapFilter(
  settings: MapImageSettings,
  pixelScale = 1,
): string {
  return [
    `brightness(${Math.max(0, 1 + settings.brightness)})`,
    `contrast(${Math.max(0, 1 + settings.contrast)})`,
    `saturate(${Math.max(0, settings.saturation)})`,
    `hue-rotate(${settings.hue}deg)`,
    `blur(${Math.max(0, settings.blur * pixelScale)}px)`,
    `invert(${settings.invert ? 1 : 0})`,
  ].join(" ");
}

/** Decode, strengthen, normalize, and re-encode one tangent-space normal. */
export function editNormalPixel(
  red: number,
  green: number,
  blue: number,
  strength: number,
  flipY: boolean,
): [number, number, number] {
  let x = (red / 255) * 2 - 1;
  let y = (green / 255) * 2 - 1;
  let z = (blue / 255) * 2 - 1;
  x *= strength;
  y *= strength * (flipY ? -1 : 1);
  const length = Math.hypot(x, y, z) || 1;
  x /= length;
  y /= length;
  z /= length;
  return [
    Math.round((x * 0.5 + 0.5) * 255),
    Math.round((y * 0.5 + 0.5) * 255),
    Math.round((z * 0.5 + 0.5) * 255),
  ];
}

export function editNormalImageData(
  imageData: ImageData,
  strength: number,
  flipY: boolean,
): void {
  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    let x = ((data[index] / 255) * 2 - 1) * strength;
    let y = ((data[index + 1] / 255) * 2 - 1) * strength;
    let z = (data[index + 2] / 255) * 2 - 1;
    if (flipY) y *= -1;
    const length = Math.hypot(x, y, z) || 1;
    x /= length;
    y /= length;
    z /= length;
    data[index] = Math.round((x * 0.5 + 0.5) * 255);
    data[index + 1] = Math.round((y * 0.5 + 0.5) * 255);
    data[index + 2] = Math.round((z * 0.5 + 0.5) * 255);
  }
}
