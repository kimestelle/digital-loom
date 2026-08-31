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

export function isNormalMap(name: MapName): boolean {
  return name === "normal";
}

export function isColorMap(name: MapName): boolean {
  return name === "albedo";
}

export function buildMapFilter(settings: MapImageSettings): string {
  return [
    `brightness(${Math.max(0, 1 + settings.brightness)})`,
    `contrast(${Math.max(0, 1 + settings.contrast)})`,
    `saturate(${Math.max(0, settings.saturation)})`,
    `hue-rotate(${settings.hue}deg)`,
    `blur(${Math.max(0, settings.blur)}px)`,
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
    const [red, green, blue] = editNormalPixel(
      data[index],
      data[index + 1],
      data[index + 2],
      strength,
      flipY,
    );
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
  }
}

