// Pure daylight resolver shared by the DOM room and the Three.js specimen.
// Keep this file free of React, Three, and browser globals: the same authored
// input must always resolve to the same room state in tests and at runtime.

export interface RgbColor {
  /** Linear-looking authored channel in the normalized 0..1 range. */
  r: number;
  g: number;
  b: number;
}

export interface Vec3Value {
  x: number;
  y: number;
  z: number;
}

export interface DaylightPathState {
  /**
   * Cyclic normalized time: 0/1 = midnight, 0.25 = sunrise, 0.5 = noon,
   * and 0.75 = sunset. The spatial source still follows the existing path.
   */
  position: number;
}

/**
 * Authored room controls. Geometry that must stay physically coherent (source
 * elevation, direction, hotspot, projection travel, and dapple footprint) is
 * still derived from `position`; these values are the deliberately small set
 * of art-direction offsets around that path.
 *
 * Every visual modifier is normalized to 0..1 and uses 0.5 as the neutral
 * value, so the defaults preserve the original authored room exactly.
 */
export interface RoomLightSettings extends DaylightPathState {
  exposure: number;
  warmth: number;
  ambient: number;
  beam: number;
  dapple: number;
  dappleSoftness: number;
  autoDrift: boolean;
  /** Day cycles per second. */
  driftRate: number;
}

/**
 * Aggregate material properties used only to condition the room's transmitted
 * light cue. They are deliberately separate from persisted material state.
 */
export interface MaterialLightProfile {
  /** More open fabric passes more of the projected cue. */
  openness?: number;
  /** 1 means the photographed weave is fully covered/dense. */
  cover?: number;
  /** Normalized physical/visual thickness. */
  thickness?: number;
  /** Aggregate transmission response, independent of openness. */
  transmission?: number;
  /** Adds bounded separation to the transmitted cue. */
  transmissionContrast?: number;
  /** Mean albedo, sampled from the active albedo map. */
  albedoTint?: RgbColor | null;
}

export interface ResolvedRoomLight {
  pathPosition: number;
  atmosphere: {
    /** Full daylight after the sun clears the twilight band. */
    daylight: number;
    /** Full night after the sun falls below the twilight band. */
    night: number;
    /** Dawn/dusk halo, peaking when the sun meets the horizon. */
    twilight: number;
  };
  sourcePosition: Vec3Value;
  /** Shared aiming point for the Three light and custom cloth shader. */
  specimenTarget: Vec3Value;
  /** Unit vector in the direction light travels: source -> specimen. */
  lightDirection: Vec3Value;
  direct: {
    tint: RgbColor;
    intensity: number;
  };
  ambient: {
    skyTint: RgbColor;
    groundTint: RgbColor;
    intensity: number;
  };
  window: {
    tint: RgbColor;
    glow: number;
    /** Normalized hotspot coordinates inside the wide left window. */
    hotspotX: number;
    hotspotY: number;
  };
  beam: {
    /** Normalized right/down screen-space travel vector. */
    screenDirectionX: number;
    screenDirectionY: number;
    /** CSS-space degrees; zero points right and positive angles point down. */
    rotation: number;
    /** 0..1 proxy for how far the ray continues across the floor. */
    reach: number;
    /** Bounded atmosphere cue; the room may render this as a cheap gradient. */
    opacity: number;
  };
  dapple: {
    /** CSS-space offset in px; deliberately opposes sourcePosition.x. */
    translateX: number;
    translateY: number;
    /** CSS-space degrees. */
    rotation: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
    /** 0 selects the crisp mask, 1 selects the pre-softened mask. */
    softnessMix: number;
    tint: RgbColor;
  };
  transmitted: {
    tint: RgbColor;
    amount: number;
  };
}

export const DEFAULT_DAYLIGHT_POSITION = 9 / 24;
export const ROOM_LIGHT_MAX_DRIFT_RATE = 0.06;
/** Indirect fill remains even at midnight with the ambient slider at zero. */
export const ROOM_AMBIENT_INTENSITY_FLOOR = 0.22;

export const DEFAULT_ROOM_LIGHT_SETTINGS: Readonly<RoomLightSettings> =
  Object.freeze({
    position: DEFAULT_DAYLIGHT_POSITION,
    exposure: 0.5,
    warmth: 0.5,
    ambient: 0.5,
    beam: 0.5,
    dapple: 0.5,
    dappleSoftness: 0.5,
    autoDrift: true,
    driftRate: 0.008333333333,
  });

// Room-space authoring constants. The source stays behind the canonical
// cloth plane (+Z) and to the left of the specimen for the full path. That
// keeps both the shader and the DOM room on one legible, diagonal light story.
const SOURCE_FAR_X = -1_520;
const SOURCE_NEAR_X = -720;
const SOURCE_LOW_Y = 540;
const SOURCE_HIGH_Y = 1_220;
const SOURCE_LOW_Z = 1_180;
const SOURCE_HIGH_Z = 1_300;
const SPECIMEN_TARGET_X = 110;
const SPECIMEN_TARGET_Y = -105;
const SPECIMEN_TARGET_Z = 0;
const TAU = Math.PI * 2;
const TWILIGHT_ALTITUDE = 0.25;
const TWILIGHT_SOLAR_VISIBILITY = 0.28;

export const DEFAULT_MATERIAL_LIGHT_PROFILE: Readonly<
  Required<Omit<MaterialLightProfile, "albedoTint">> & {
    albedoTint: RgbColor;
  }
> = Object.freeze({
  openness: 0.5,
  cover: 0.5,
  thickness: 0.5,
  transmission: 0.5,
  transmissionContrast: 0.5,
  albedoTint: Object.freeze({ r: 0.5, g: 0.5, b: 0.5 }),
});

export const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const finiteSetting = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? clamp01(value)
    : fallback;

const finiteDriftRate = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(ROOM_LIGHT_MAX_DRIFT_RATE, Math.max(0, value))
    : fallback;

/**
 * Validate settings loaded from local storage or another untrusted boundary.
 * A partial document is useful for forward-compatible migrations: missing or
 * malformed fields resolve independently to the authored defaults.
 */
export function sanitizeRoomLightSettings(input: unknown): RoomLightSettings {
  const raw =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    position: finiteSetting(
      raw.position,
      DEFAULT_ROOM_LIGHT_SETTINGS.position,
    ),
    exposure: finiteSetting(
      raw.exposure,
      DEFAULT_ROOM_LIGHT_SETTINGS.exposure,
    ),
    warmth: finiteSetting(raw.warmth, DEFAULT_ROOM_LIGHT_SETTINGS.warmth),
    ambient: finiteSetting(raw.ambient, DEFAULT_ROOM_LIGHT_SETTINGS.ambient),
    beam: finiteSetting(raw.beam, DEFAULT_ROOM_LIGHT_SETTINGS.beam),
    dapple: finiteSetting(raw.dapple, DEFAULT_ROOM_LIGHT_SETTINGS.dapple),
    dappleSoftness: finiteSetting(
      raw.dappleSoftness,
      DEFAULT_ROOM_LIGHT_SETTINGS.dappleSoftness,
    ),
    autoDrift:
      typeof raw.autoDrift === "boolean"
        ? raw.autoDrift
        : DEFAULT_ROOM_LIGHT_SETTINGS.autoDrift,
    driftRate: finiteDriftRate(
      raw.driftRate,
      DEFAULT_ROOM_LIGHT_SETTINGS.driftRate,
    ),
  };
}

/**
 * Restore saved art direction without restoring yesterday's clock. Each page
 * visit begins at the authored morning, while every other valid preference is
 * preserved and the persisted object itself remains untouched.
 */
export function restoreRoomLightSettings(input: unknown): RoomLightSettings {
  return {
    ...sanitizeRoomLightSettings(input),
    position: DEFAULT_DAYLIGHT_POSITION,
  };
}

const mix = (a: number, b: number, amount: number): number =>
  a + (b - a) * amount;

const smoothstep = (value: number): number => {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
};

const rgb = (r: number, g: number, b: number): RgbColor => ({
  r: clamp01(r),
  g: clamp01(g),
  b: clamp01(b),
});

const setRgb = (target: RgbColor, r: number, g: number, b: number): void => {
  target.r = clamp01(r);
  target.g = clamp01(g);
  target.b = clamp01(b);
};

const mixRgbInto = (
  target: RgbColor,
  a: RgbColor,
  b: RgbColor,
  amount: number,
): void => {
  const x = clamp01(amount);
  setRgb(
    target,
    mix(a.r, b.r, x),
    mix(a.g, b.g, x),
    mix(a.b, b.b, x),
  );
};

// Preserve the original sky renderer's sunlight endpoints. The room changes
// the receiving architecture, not the established light palette.
const WARM_DIRECT = Object.freeze(rgb(1, 0.7, 0.42));
const HIGH_DIRECT = Object.freeze(rgb(1, 0.95, 0.86));
const COOL_DIRECT = Object.freeze(rgb(0.76, 0.88, 1));
const WARMEST_DIRECT = Object.freeze(rgb(1, 0.55, 0.28));
const LOW_AMBIENT_SKY = Object.freeze(rgb(0.62, 0.69, 0.73));
const HIGH_AMBIENT_SKY = Object.freeze(rgb(0.78, 0.84, 0.87));
const LOW_AMBIENT_GROUND = Object.freeze(rgb(0.31, 0.25, 0.2));
const HIGH_AMBIENT_GROUND = Object.freeze(rgb(0.49, 0.46, 0.41));
const NIGHT_AMBIENT_SKY = Object.freeze(rgb(0.56, 0.61, 0.7));
const NIGHT_AMBIENT_GROUND = Object.freeze(rgb(0.32, 0.3, 0.29));
const NIGHT_AMBIENT_INTENSITY = 0.32;

const finiteChannel = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : clamp01(value);

const transmittedAmountFromChannels = (
  openness: number,
  cover: number,
  thickness: number,
  transmission: number,
  transmissionContrast: number,
): number => {
  const base =
    0.06 +
    openness * 0.34 +
    (1 - cover) * 0.2 +
    (1 - thickness) * 0.18 +
    transmission * 0.18;
  const contrastGain = mix(0.92, 1.08, transmissionContrast);
  return Math.min(0.92, Math.max(0.08, base * contrastGain));
};

/**
 * Resolve the aggregate amount of light passing through a material. Every
 * input is clamped before use. Openness and transmission can only increase
 * the result; cover and thickness can only decrease it.
 */
export function resolveTransmittedAmount(
  profile: MaterialLightProfile = DEFAULT_MATERIAL_LIGHT_PROFILE,
): number {
  return transmittedAmountFromChannels(
    finiteChannel(
      profile.openness,
      DEFAULT_MATERIAL_LIGHT_PROFILE.openness,
    ),
    finiteChannel(profile.cover, DEFAULT_MATERIAL_LIGHT_PROFILE.cover),
    finiteChannel(
      profile.thickness,
      DEFAULT_MATERIAL_LIGHT_PROFILE.thickness,
    ),
    finiteChannel(
      profile.transmission,
      DEFAULT_MATERIAL_LIGHT_PROFILE.transmission,
    ),
    finiteChannel(
      profile.transmissionContrast,
      DEFAULT_MATERIAL_LIGHT_PROFILE.transmissionContrast,
    ),
  );
}

/**
 * Mutate a previously-created light snapshot. The autonomous controller uses
 * this path so daylight drift does not replace the object held by Three.js.
 */
export function resolveRoomLightInto(
  target: ResolvedRoomLight,
  state: number | Partial<RoomLightSettings>,
  material: MaterialLightProfile = DEFAULT_MATERIAL_LIGHT_PROFILE,
): ResolvedRoomLight {
  const authored = typeof state === "number" ? undefined : state;
  const pathPosition = clamp01(
    typeof state === "number"
      ? state
      : finiteSetting(state.position, DEFAULT_ROOM_LIGHT_SETTINGS.position),
  );
  const exposure = finiteSetting(
    authored?.exposure,
    DEFAULT_ROOM_LIGHT_SETTINGS.exposure,
  );
  const warmth = finiteSetting(
    authored?.warmth,
    DEFAULT_ROOM_LIGHT_SETTINGS.warmth,
  );
  const ambient = finiteSetting(
    authored?.ambient,
    DEFAULT_ROOM_LIGHT_SETTINGS.ambient,
  );
  const beamAmount = finiteSetting(
    authored?.beam,
    DEFAULT_ROOM_LIGHT_SETTINGS.beam,
  );
  const dappleAmount = finiteSetting(
    authored?.dapple,
    DEFAULT_ROOM_LIGHT_SETTINGS.dapple,
  );
  const dappleSoftness = finiteSetting(
    authored?.dappleSoftness,
    DEFAULT_ROOM_LIGHT_SETTINGS.dappleSoftness,
  );
  // Normalized settings use their midpoint as identity so loading the new
  // settings surface cannot restyle an existing room.
  const exposureGain = mix(0.55, 1.45, exposure);
  const beamGain = beamAmount * 2;
  const dappleGain = dappleAmount * 2;
  const horizontal = smoothstep(pathPosition);
  // Keep the source on its existing far→high→near spatial path, while the
  // light itself follows a real cyclic altitude. The path can jump invisibly
  // from near to far at midnight because every solar cue is fully dark there.
  const pathElevation = smoothstep(Math.sin(Math.PI * pathPosition));
  const rawAltitude = -Math.cos(TAU * pathPosition);
  const altitude = Math.abs(rawAltitude) < 1e-12 ? 0 : rawAltitude;
  const daylight = smoothstep(altitude / TWILIGHT_ALTITUDE);
  const night = smoothstep(-altitude / TWILIGHT_ALTITUDE);
  const twilight = clamp01(1 - daylight - night);
  const solarVisibility =
    daylight + twilight * TWILIGHT_SOLAR_VISIBILITY;
  const solarHeight = smoothstep(Math.max(0, altitude));
  const openness = finiteChannel(
    material.openness,
    DEFAULT_MATERIAL_LIGHT_PROFILE.openness,
  );
  const cover = finiteChannel(
    material.cover,
    DEFAULT_MATERIAL_LIGHT_PROFILE.cover,
  );
  const thickness = finiteChannel(
    material.thickness,
    DEFAULT_MATERIAL_LIGHT_PROFILE.thickness,
  );
  const transmission = finiteChannel(
    material.transmission,
    DEFAULT_MATERIAL_LIGHT_PROFILE.transmission,
  );
  const transmissionContrast = finiteChannel(
    material.transmissionContrast,
    DEFAULT_MATERIAL_LIGHT_PROFILE.transmissionContrast,
  );
  const albedoR = finiteChannel(
    material.albedoTint?.r,
    DEFAULT_MATERIAL_LIGHT_PROFILE.albedoTint.r,
  );
  const albedoG = finiteChannel(
    material.albedoTint?.g,
    DEFAULT_MATERIAL_LIGHT_PROFILE.albedoTint.g,
  );
  const albedoB = finiteChannel(
    material.albedoTint?.b,
    DEFAULT_MATERIAL_LIGHT_PROFILE.albedoTint.b,
  );
  const transmittedAmount = transmittedAmountFromChannels(
    openness,
    cover,
    thickness,
    transmission,
    transmissionContrast,
  );

  target.pathPosition = pathPosition;
  target.atmosphere.daylight = daylight;
  target.atmosphere.night = night;
  target.atmosphere.twilight = twilight;
  target.sourcePosition.x = mix(SOURCE_FAR_X, SOURCE_NEAR_X, horizontal);
  target.sourcePosition.y = mix(
    SOURCE_LOW_Y,
    SOURCE_HIGH_Y,
    pathElevation,
  );
  target.sourcePosition.z = mix(
    SOURCE_LOW_Z,
    SOURCE_HIGH_Z,
    pathElevation,
  );
  target.specimenTarget.x = SPECIMEN_TARGET_X;
  target.specimenTarget.y = SPECIMEN_TARGET_Y;
  target.specimenTarget.z = SPECIMEN_TARGET_Z;

  const directionX = target.specimenTarget.x - target.sourcePosition.x;
  const directionY = target.specimenTarget.y - target.sourcePosition.y;
  const directionZ = target.specimenTarget.z - target.sourcePosition.z;
  const directionLength = Math.hypot(directionX, directionY, directionZ);
  if (!Number.isFinite(directionLength) || directionLength < 1e-8) {
    target.lightDirection.x = 0;
    target.lightDirection.y = 0;
    target.lightDirection.z = -1;
  } else {
    target.lightDirection.x = directionX / directionLength;
    target.lightDirection.y = directionY / directionLength;
    target.lightDirection.z = directionZ / directionLength;
  }

  const baseDirectR = mix(WARM_DIRECT.r, HIGH_DIRECT.r, solarHeight);
  const baseDirectG = mix(WARM_DIRECT.g, HIGH_DIRECT.g, solarHeight);
  const baseDirectB = mix(WARM_DIRECT.b, HIGH_DIRECT.b, solarHeight);
  setRgb(target.direct.tint, baseDirectR, baseDirectG, baseDirectB);
  if (warmth < 0.5) {
    mixRgbInto(
      target.direct.tint,
      target.direct.tint,
      COOL_DIRECT,
      (0.5 - warmth) * 0.8,
    );
  } else if (warmth > 0.5) {
    mixRgbInto(
      target.direct.tint,
      target.direct.tint,
      WARMEST_DIRECT,
      (warmth - 0.5) * 0.8,
    );
  }
  target.direct.intensity =
    mix(0.9, 1.52, solarHeight) * exposureGain * solarVisibility;
  mixRgbInto(
    target.ambient.skyTint,
    LOW_AMBIENT_SKY,
    HIGH_AMBIENT_SKY,
    solarHeight,
  );
  mixRgbInto(
    target.ambient.groundTint,
    LOW_AMBIENT_GROUND,
    HIGH_AMBIENT_GROUND,
    solarHeight,
  );
  mixRgbInto(
    target.ambient.skyTint,
    target.ambient.skyTint,
    NIGHT_AMBIENT_SKY,
    night,
  );
  mixRgbInto(
    target.ambient.groundTint,
    target.ambient.groundTint,
    NIGHT_AMBIENT_GROUND,
    night,
  );
  const cycleAmbientIntensity = mix(
    mix(0.34, 0.58, solarHeight),
    NIGHT_AMBIENT_INTENSITY,
    night,
  );
  // The control adjusts bounce above a protected fill, not a gain that can
  // crush it. Its midpoint preserves authored daytime levels. Both the cloth
  // shader and mesh hemisphere light consume this without another light/pass.
  target.ambient.intensity = ROOM_AMBIENT_INTENSITY_FLOOR +
    (cycleAmbientIntensity - ROOM_AMBIENT_INTENSITY_FLOOR) * ambient * 2;

  // Albedo belongs only to the transmitted cue. It never repaints the direct
  // room light or the projected window grid.
  setRgb(
    target.transmitted.tint,
    mix(baseDirectR, albedoR, 0.3),
    mix(baseDirectG, albedoG, 0.3),
    mix(baseDirectB, albedoB, 0.3),
  );
  target.transmitted.amount = transmittedAmount;

  // The aperture and its floor projection show the source daylight. Fabric
  // color enters only after the ray reaches the separate transmission cue.
  setRgb(
    target.window.tint,
    target.direct.tint.r,
    target.direct.tint.g,
    target.direct.tint.b,
  );
  target.window.glow = Math.min(
    1,
    (0.34 + solarHeight * 0.25 + transmittedAmount * 0.24) *
      exposureGain *
      solarVisibility,
  );
  target.window.hotspotX = mix(0.12, 0.88, horizontal);
  target.window.hotspotY = mix(0.72, 0.25, pathElevation);

  // Convert the world-space source -> specimen ray to a normalized DOM-space
  // right/down vector. Since the source never crosses the specimen, this
  // remains an unmistakable left-to-right angle for the entire slider path.
  const screenX = Math.max(0, target.lightDirection.x);
  const screenY = Math.max(0, -target.lightDirection.y);
  const screenLength = Math.max(1e-8, Math.hypot(screenX, screenY));
  target.beam.screenDirectionX = screenX / screenLength;
  target.beam.screenDirectionY = screenY / screenLength;
  target.beam.rotation =
    Math.atan2(
      target.beam.screenDirectionY,
      target.beam.screenDirectionX,
    ) *
    (180 / Math.PI);
  const lateralPerDrop = screenX / Math.max(0.08, screenY);
  target.beam.reach = clamp01((lateralPerDrop - 0.72) / 2);
  target.beam.opacity = Math.min(
    0.9,
    (0.12 + mix(0.9, 1.52, solarHeight) * 0.12 + transmittedAmount * 0.18) *
      exposureGain *
      beamGain *
      solarVisibility,
  );

  const endpointDistance = Math.abs(pathPosition - 0.5) * 2;
  target.dapple.translateX =
    72 + target.beam.reach * 132 + (1 - horizontal) * 22;
  target.dapple.translateY = 18 + target.beam.reach * 54;
  target.dapple.rotation = target.beam.rotation * 0.52;
  target.dapple.scaleX =
    0.96 + endpointDistance * 0.34 + target.beam.reach * 0.2;
  target.dapple.scaleY =
    0.72 + endpointDistance * 0.58 + target.beam.reach * 0.24;
  const naturalDappleOpacity = Math.min(
    0.72,
    Math.max(
      0.08,
      mix(0.22, 0.38, solarHeight) * mix(0.58, 1.1, transmittedAmount),
    ),
  );
  // This folds the former CSS `+ .32`/minimum into the resolved value before
  // applying the authored amount. The default remains pixel-equivalent, while
  // dapple=0 can now honestly remove the projection instead of hitting a CSS
  // opacity floor.
  const authoredDappleOpacity = Math.min(
    0.9,
    Math.max(0.5, naturalDappleOpacity + 0.32),
  );
  target.dapple.opacity = Math.min(
    1,
    authoredDappleOpacity * exposureGain * dappleGain * solarVisibility,
  );
  target.dapple.softnessMix = clamp01(
    mix(0.18, 0.86, endpointDistance) + (dappleSoftness - 0.5) * 0.9,
  );
  // The floor form is the window's daylight projection, not a cloth-colored
  // shadow. Only the separate transmitted cue is conditioned by the fabric.
  setRgb(
    target.dapple.tint,
    target.window.tint.r,
    target.window.tint.g,
    target.window.tint.b,
  );

  return target;
}

const createResolvedRoomLight = (): ResolvedRoomLight => ({
  pathPosition: 0,
  atmosphere: { daylight: 0, night: 1, twilight: 0 },
  sourcePosition: { x: 0, y: 0, z: 0 },
  specimenTarget: { x: 0, y: 0, z: 0 },
  lightDirection: { x: 0, y: 0, z: -1 },
  direct: { tint: rgb(0, 0, 0), intensity: 0 },
  ambient: {
    skyTint: rgb(0, 0, 0),
    groundTint: rgb(0, 0, 0),
    intensity: 0,
  },
  window: {
    tint: rgb(0, 0, 0),
    glow: 0,
    hotspotX: 0,
    hotspotY: 0,
  },
  beam: {
    screenDirectionX: 1,
    screenDirectionY: 0,
    rotation: 0,
    reach: 0,
    opacity: 0,
  },
  dapple: {
    translateX: 0,
    translateY: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 0,
    softnessMix: 0,
    tint: rgb(0, 0, 0),
  },
  transmitted: { tint: rgb(0, 0, 0), amount: 0 },
});

/**
 * Deterministically resolve the one-dimensional daylight path into every
 * value consumed by the renderer and DOM room.
 */
export function resolveRoomLight(
  state: number | Partial<RoomLightSettings>,
  material: MaterialLightProfile = DEFAULT_MATERIAL_LIGHT_PROFILE,
): ResolvedRoomLight {
  return resolveRoomLightInto(createResolvedRoomLight(), state, material);
}

const concise = (value: number): string => {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const cssRgb = (color: RgbColor): string =>
  `rgb(${Math.round(clamp01(color.r) * 255)} ${Math.round(clamp01(color.g) * 255)} ${Math.round(clamp01(color.b) * 255)})`;

const visibleSolarAmount = (light: ResolvedRoomLight): number =>
  light.atmosphere.daylight +
  light.atmosphere.twilight * TWILIGHT_SOLAR_VISIBILITY;

export interface RoomLightCssVariableTarget {
  setProperty(property: string, value: string): void;
}

type RoomLightCssVariableDefinition = readonly [
  property: string,
  value: (light: ResolvedRoomLight) => string,
];

// These variables only feed transform or opacity on bounded, composited room
// overlays. The autonomous controller is deliberately limited to this list so
// slow daylight drift cannot trigger gradient repaints. `--room-beam-angle` is
// already converted to CSS's right/down coordinate system. The definition list
// is module-static so applying a drift frame creates no intermediate object or
// Object.entries array.
const ROOM_LIGHT_COMPOSITE_CSS_VARIABLES: readonly RoomLightCssVariableDefinition[] = [
  ["--room-night-opacity", (light) => concise(light.atmosphere.night)],
  [
    "--room-twilight-opacity",
    (light) => concise(light.atmosphere.twilight),
  ],
  ["--room-beam-angle", (light) => `${concise(light.beam.rotation)}deg`],
  ["--room-beam-reach", (light) => concise(light.beam.reach)],
  ["--room-beam-opacity", (light) => concise(light.beam.opacity)],
  ["--room-window-glow", (light) => concise(light.window.glow)],
  [
    "--room-window-x",
    (light) => `${concise(light.window.hotspotX * 100)}%`,
  ],
  [
    "--room-window-y",
    (light) => `${concise(light.window.hotspotY * 100)}%`,
  ],
  ["--room-dapple-x", (light) => `${concise(light.dapple.translateX)}px`],
  ["--room-dapple-y", (light) => `${concise(light.dapple.translateY)}px`],
  [
    "--room-dapple-rotation",
    (light) => `${concise(light.dapple.rotation)}deg`,
  ],
  ["--room-dapple-scale-x", (light) => concise(light.dapple.scaleX)],
  ["--room-dapple-scale-y", (light) => concise(light.dapple.scaleY)],
  ["--room-dapple-opacity", (light) => concise(light.dapple.opacity)],
  ["--room-dapple-softness", (light) => concise(light.dapple.softnessMix)],
  [
    "--room-transmitted-amount",
    (light) => concise(light.transmitted.amount * visibleSolarAmount(light)),
  ],
];

// Direct manipulation is allowed to update this bounded paint value
// immediately. It is intentionally excluded from autonomous drift because it
// changes a radial-gradient paint rather than only compositing. Window x/y are
// safe above because the room shell consumes them exclusively as transforms.
const ROOM_LIGHT_PAINT_CSS_VARIABLES: readonly RoomLightCssVariableDefinition[] = [
  ["--room-window-color", (light) => cssRgb(light.window.tint)],
  ["--room-dapple-color", (light) => cssRgb(light.dapple.tint)],
  ["--room-transmitted-color", (light) => cssRgb(light.transmitted.tint)],
];

const writeDefinitions = (
  target: RoomLightCssVariableTarget,
  light: ResolvedRoomLight,
  definitions: readonly RoomLightCssVariableDefinition[],
): void => {
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    target.setProperty(definition[0], definition[1](light));
  }
};

/**
 * Publish only values consumed by transform or opacity. This is the safe path
 * for automatic drift: it avoids gradient-position and color repaints.
 */
export function writeRoomLightCompositeCssVariables(
  target: RoomLightCssVariableTarget,
  light: ResolvedRoomLight,
): void {
  writeDefinitions(target, light, ROOM_LIGHT_COMPOSITE_CSS_VARIABLES);
}

/**
 * Write one resolved snapshot directly to a style-like sink. The controller
 * uses this imperative path; the DOM room and Three renderer therefore read
 * the same source/target/direction without a React render between them.
 */
export function writeRoomLightCssVariables(
  target: RoomLightCssVariableTarget,
  light: ResolvedRoomLight,
): void {
  writeRoomLightCompositeCssVariables(target, light);
  writeDefinitions(target, light, ROOM_LIGHT_PAINT_CSS_VARIABLES);
}

/** CSS variables for the DOM room, derived from the exact renderer snapshot. */
export function roomLightCssVariables(
  light: ResolvedRoomLight,
): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  writeRoomLightCssVariables(
    {
      setProperty(property, value) {
        variables[property] = value;
      },
    },
    light,
  );
  return variables;
}
