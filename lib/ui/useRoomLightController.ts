"use client";

import {
  type MutableRefObject,
  type RefObject,
  useEffect,
  useState,
} from "react";
import {
  DEFAULT_ROOM_LIGHT_SETTINGS,
  type MaterialLightProfile,
  type ResolvedRoomLight,
  type RoomLightSettings,
  clamp01,
  resolveRoomLight,
  resolveRoomLightInto,
  sanitizeRoomLightSettings,
  writeRoomLightCompositeCssVariables,
  writeRoomLightCssVariables,
} from "./roomLight";
import {
  type ResolvedRoomFloorProjection,
  type RoomFloorProjectionLayout,
  type RoomFloorProjectionRect,
  resolveRoomFloorApertureRightBottom,
  resolveRoomFloorProjectionInto,
} from "./roomFloorProjection";

export const DEFAULT_ROOM_LIGHT_DRIFT_RATE =
  DEFAULT_ROOM_LIGHT_SETTINGS.driftRate;
export const ROOM_LIGHT_MAX_FRAME_DELTA_SECONDS = 0.1;
/**
 * The Three snapshot still resolves every animation frame, but the baked DOM
 * room only needs its slow light cues published at this cadence.
 */
export const ROOM_LIGHT_DOM_UPDATE_HZ = 24;
export const ROOM_LIGHT_DOM_MIN_INTERVAL_MS =
  1000 / ROOM_LIGHT_DOM_UPDATE_HZ;

const ROOM_FLOOR_PROJECTION_CSS_VARIABLES = {
  x: "--room-projection-x",
  y: "--room-projection-y",
  angle: "--room-projection-angle",
  scaleX: "--room-projection-scale-x",
  scaleY: "--room-projection-scale-y",
  visible: "--room-projection-visible",
} as const;

const conciseProjectionValue = (value: number): string =>
  String(Math.round((Number.isFinite(value) ? value : 0) * 10_000) / 10_000);

/** Publish only compositor inputs for the fixed-size floor receiver. */
export function applyRoomFloorProjectionCssVariables(
  root: HTMLElement,
  projection: ResolvedRoomFloorProjection,
): void {
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.x,
    `${conciseProjectionValue(projection.x)}px`,
  );
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.y,
    `${conciseProjectionValue(projection.y)}px`,
  );
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.angle,
    `${conciseProjectionValue(projection.angle)}deg`,
  );
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.scaleX,
    conciseProjectionValue(projection.scaleX),
  );
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.scaleY,
    conciseProjectionValue(projection.scaleY),
  );
  root.style.setProperty(
    ROOM_FLOOR_PROJECTION_CSS_VARIABLES.visible,
    String(projection.visible),
  );
}

export type RoomLightDriftDirection = -1 | 1;
export type RoomLightPauseReason = string;

export interface DaylightAdvance {
  position: number;
  direction: RoomLightDriftDirection;
}

export interface UseRoomLightControllerOptions {
  /** Complete or partial authored state used only when the controller is made. */
  initialSettings?: Partial<RoomLightSettings>;
  /** @deprecated Prefer initialSettings.position. */
  initialDaylight?: number;
  materialProfile?: MaterialLightProfile;
  roomRootRef?: RefObject<HTMLElement | null>;
  /** Turn off the authored drift while retaining direct slider control. */
  autoDrift?: boolean;
  /** Day cycles per second. The default completes one cycle in 120s. */
  driftRate?: number;
}

export interface RoomLightController {
  settingsRef: MutableRefObject<RoomLightSettings>;
  daylightRef: MutableRefObject<number>;
  resolvedRef: MutableRefObject<ResolvedRoomLight>;
  /** Copy the current authored state, including the live drift position. */
  getSettings: () => RoomLightSettings;
  /** Patch authored room state and immediately update DOM + Three consumers. */
  setSettings: (
    patch: Partial<RoomLightSettings>,
  ) => ResolvedRoomLight;
  /** @deprecated Prefer getSettings().position. */
  getDaylight: () => number;
  /** @deprecated Prefer setSettings({ position }). */
  setDaylight: (position: number) => ResolvedRoomLight;
  setMaterialProfile: (
    profile: MaterialLightProfile,
  ) => ResolvedRoomLight;
  pause: (reason?: RoomLightPauseReason) => void;
  resume: (reason?: RoomLightPauseReason) => void;
  isPaused: (reason?: RoomLightPauseReason) => boolean;
  /** Re-resolve and apply CSS vars without moving the light. */
  applyNow: () => ResolvedRoomLight;
}

export interface RoomLightControllerRuntime extends RoomLightController {
  configure: (
    options: Omit<
      UseRoomLightControllerOptions,
      "initialDaylight" | "initialSettings"
    >,
  ) => void;
  mount: () => () => void;
  destroy: () => void;
}

export function clampRoomLightFrameDelta(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.min(
    ROOM_LIGHT_MAX_FRAME_DELTA_SECONDS,
    milliseconds / 1000,
  );
}

export function shouldPublishRoomLightCss(
  timestamp: number,
  lastPublishedAt: number | null,
): boolean {
  if (lastPublishedAt === null) return true;
  if (!Number.isFinite(timestamp) || !Number.isFinite(lastPublishedAt)) {
    return true;
  }
  return timestamp - lastPublishedAt >= ROOM_LIGHT_DOM_MIN_INTERVAL_MS;
}

/**
 * Advance a reusable result around the normalized day clock. The direction is
 * retained for legacy callers, but crossing either endpoint wraps rather than
 * reversing, including distances spanning several complete days.
 */
export function advanceDaylightInto(
  target: DaylightAdvance,
  position: number,
  direction: RoomLightDriftDirection,
  distance: number,
): DaylightAdvance {
  const start = clamp01(position);
  if (!Number.isFinite(distance) || distance <= 0) {
    target.position = start;
    target.direction = direction;
    return target;
  }

  const signedDistance = direction === 1 ? distance : -distance;
  target.position = ((start + signedDistance) % 1 + 1) % 1;
  target.direction = direction;
  return target;
}

/** Allocating convenience wrapper for tests and non-animation callers. */
export function advanceDaylight(
  position: number,
  direction: RoomLightDriftDirection,
  distance: number,
): DaylightAdvance {
  return advanceDaylightInto(
    { position: 0, direction: 1 },
    position,
    direction,
    distance,
  );
}

/** Apply the resolved snapshot to the flat room without involving React. */
export function applyRoomLightCssVariables(
  root: HTMLElement,
  light: ResolvedRoomLight,
): void {
  writeRoomLightCssVariables(root.style, light);
  const pathPosition = String(light.pathPosition);
  root.dataset.lightPosition = pathPosition;
  root.dataset.roomLightPosition = pathPosition;
}

/**
 * Automatic drift only updates transform/opacity-linked variables. Paint
 * values and data attributes remain on the last explicit state until the user
 * moves the daylight control or the material changes.
 */
export function applyRoomLightCompositeCssVariables(
  root: HTMLElement,
  light: ResolvedRoomLight,
): void {
  writeRoomLightCompositeCssVariables(root.style, light);
}

interface SaveDataConnection {
  saveData?: boolean;
  addEventListener?: (type: "change", listener: EventListener) => void;
  removeEventListener?: (type: "change", listener: EventListener) => void;
}

interface NavigatorWithConnection extends Navigator {
  connection?: SaveDataConnection;
  mozConnection?: SaveDataConnection;
  webkitConnection?: SaveDataConnection;
}

const currentConnection = (): SaveDataConnection | undefined => {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as NavigatorWithConnection;
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
};

const listenToMediaQuery = (
  query: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): (() => void) => {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  // Older Safari retains this API even though TypeScript marks it deprecated.
  query.addListener(listener);
  return () => query.removeListener(listener);
};

const EMPTY_PROFILE: MaterialLightProfile = Object.freeze({});

class BrowserRoomLightController implements RoomLightControllerRuntime {
  readonly settingsRef: MutableRefObject<RoomLightSettings>;
  readonly daylightRef: MutableRefObject<number>;
  readonly resolvedRef: MutableRefObject<ResolvedRoomLight>;

  private direction: RoomLightDriftDirection = 1;
  private profile: MaterialLightProfile;
  private roomRootRef?: RefObject<HTMLElement | null>;
  private readonly pauseReasons = new Set<RoomLightPauseReason>();
  private mounted = false;
  private frame: number | null = null;
  private lastFrame: number | null = null;
  private lastCssFrame: number | null = null;
  private readonly daylightAdvance: DaylightAdvance = {
    position: 0,
    direction: 1,
  };
  private reducedMotion?: MediaQueryList;
  private connection?: SaveDataConnection;
  private stopMediaListener?: () => void;
  private floorProjectionObserver?: ResizeObserver;
  private floorProjectionRoot?: HTMLElement;
  private floorProjectionAperture?: HTMLElement;
  private floorProjectionPlanes?: Element;
  private floorProjectionLayout?: RoomFloorProjectionLayout;
  private readonly floorProjection: ResolvedRoomFloorProjection = {
    x: 0,
    y: 0,
    angle: 0,
    length: 0,
    width: 0,
    scaleX: 0,
    scaleY: 0,
    visible: 0,
  };

  constructor(options: UseRoomLightControllerOptions) {
    const settings = sanitizeRoomLightSettings({
      ...options.initialSettings,
      ...(options.initialDaylight === undefined
        ? null
        : { position: options.initialDaylight }),
      ...(options.autoDrift === undefined
        ? null
        : { autoDrift: options.autoDrift }),
      ...(options.driftRate === undefined
        ? null
        : { driftRate: options.driftRate }),
    });
    this.profile = options.materialProfile ?? EMPTY_PROFILE;
    this.roomRootRef = options.roomRootRef;
    this.settingsRef = { current: settings };
    const settingsRef = this.settingsRef;
    // Keep the legacy ref as a live view into the canonical settings object;
    // there is no duplicated position for the animation loop to reconcile.
    this.daylightRef = {
      get current() {
        return settingsRef.current.position;
      },
      set current(position: number) {
        settingsRef.current.position = clamp01(position);
      },
    };
    this.resolvedRef = {
      current: resolveRoomLight(settings, this.profile),
    };
  }

  configure(
    options: Omit<
      UseRoomLightControllerOptions,
      "initialDaylight" | "initialSettings"
    >,
  ) {
    const current = this.settingsRef.current;
    const previousRoot = this.roomRootRef?.current;
    const next = sanitizeRoomLightSettings({
      ...current,
      ...(options.autoDrift === undefined
        ? null
        : { autoDrift: options.autoDrift }),
      ...(options.driftRate === undefined
        ? null
        : { driftRate: options.driftRate }),
    });
    const motionPolicyChanged =
      current.autoDrift !== next.autoDrift ||
      current.driftRate !== next.driftRate;
    Object.assign(current, next);
    this.roomRootRef = options.roomRootRef;
    this.profile = options.materialProfile ?? EMPTY_PROFILE;
    if (this.mounted && previousRoot !== this.roomRootRef?.current) {
      this.connectFloorProjectionMeasurement();
    }
    if (motionPolicyChanged) this.lastFrame = null;
    this.applyNow();
    this.syncLoop();
  }

  mount(): () => void {
    if (
      this.mounted ||
      typeof window === "undefined" ||
      typeof document === "undefined"
    ) {
      return () => this.destroy();
    }

    this.mounted = true;
    this.reducedMotion =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;
    this.connection = currentConnection();

    document.addEventListener("visibilitychange", this.onPolicyChange);
    this.connection?.addEventListener?.("change", this.onPolicyChange);
    if (this.reducedMotion) {
      this.stopMediaListener = listenToMediaQuery(
        this.reducedMotion,
        this.onPolicyChange,
      );
    }

    this.connectFloorProjectionMeasurement();
    this.syncPolicies();
    this.applyNow();
    return () => this.destroy();
  }

  destroy(): void {
    if (this.frame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.frame);
    }
    this.frame = null;
    this.lastFrame = null;
    this.lastCssFrame = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onPolicyChange);
    }
    this.connection?.removeEventListener?.("change", this.onPolicyChange);
    this.stopMediaListener?.();
    this.stopMediaListener = undefined;
    this.reducedMotion = undefined;
    this.connection = undefined;
    this.floorProjectionObserver?.disconnect();
    this.floorProjectionObserver = undefined;
    this.floorProjectionRoot = undefined;
    this.floorProjectionAperture = undefined;
    this.floorProjectionPlanes = undefined;
    this.floorProjectionLayout = undefined;
    this.mounted = false;
    this.pauseReasons.delete("document-hidden");
    this.pauseReasons.delete("reduced-motion");
    this.pauseReasons.delete("data-saver");
  }

  getSettings = (): RoomLightSettings => ({ ...this.settingsRef.current });

  setSettings = (
    patch: Partial<RoomLightSettings>,
  ): ResolvedRoomLight => {
    const current = this.settingsRef.current;
    const previousAutoDrift = current.autoDrift;
    const previousDriftRate = current.driftRate;
    const next = sanitizeRoomLightSettings({ ...current, ...patch });
    Object.assign(current, next);
    if (
      previousAutoDrift !== current.autoDrift ||
      previousDriftRate !== current.driftRate
    ) {
      this.lastFrame = null;
    }
    const resolved = this.applyNow();
    this.syncLoop();
    return resolved;
  };

  getDaylight = (): number => this.settingsRef.current.position;

  setDaylight = (position: number): ResolvedRoomLight => {
    return this.setSettings({ position });
  };

  setMaterialProfile = (
    profile: MaterialLightProfile,
  ): ResolvedRoomLight => {
    this.profile = profile;
    return this.applyNow();
  };

  pause = (reason: RoomLightPauseReason = "manual"): void => {
    this.pauseReasons.add(reason);
    this.syncLoop();
  };

  resume = (reason: RoomLightPauseReason = "manual"): void => {
    this.pauseReasons.delete(reason);
    this.lastFrame = null;
    this.syncLoop();
  };

  isPaused = (reason?: RoomLightPauseReason): boolean =>
    reason === undefined
      ? this.pauseReasons.size > 0
      : this.pauseReasons.has(reason);

  applyNow = (): ResolvedRoomLight => {
    const resolved = this.resolveCurrent();
    const root = this.roomRootRef?.current;
    if (root) {
      applyRoomLightCssVariables(root, resolved);
      this.applyFloorProjection(root, resolved);
    }
    // If this immediate update happened between drift frames, the prior frame
    // timestamp is still a useful throttle anchor. A null anchor intentionally
    // allows the first moving frame to publish as well.
    this.lastCssFrame = this.lastFrame;
    return resolved;
  };

  private resolveCurrent(): ResolvedRoomLight {
    return resolveRoomLightInto(
      this.resolvedRef.current,
      this.settingsRef.current,
      this.profile,
    );
  }

  private readonly measureFloorProjection = (): void => {
    const root = this.floorProjectionRoot;
    const aperture = this.floorProjectionAperture;
    const planes = this.floorProjectionPlanes;
    if (!root || !aperture || !planes) {
      this.floorProjectionLayout = undefined;
      return;
    }
    const roomRect = root.getBoundingClientRect();
    const apertureRect = aperture.getBoundingClientRect();
    const planesRect = planes.getBoundingClientRect();
    const room: RoomFloorProjectionRect = {
      left: roomRect.left,
      top: roomRect.top,
      width: roomRect.width,
      height: roomRect.height,
    };
    const measuredAperture: RoomFloorProjectionRect = {
      left: apertureRect.left,
      top: apertureRect.top,
      width: apertureRect.width,
      height: apertureRect.height,
    };
    this.floorProjectionLayout = {
      room,
      planes: {
        left: planesRect.left,
        top: planesRect.top,
        width: planesRect.width,
        height: planesRect.height,
      },
      aperture: measuredAperture,
      apertureRightBottom: resolveRoomFloorApertureRightBottom(
        measuredAperture,
        room,
      ),
    };
  };

  private connectFloorProjectionMeasurement(): void {
    this.floorProjectionObserver?.disconnect();
    this.floorProjectionObserver = undefined;
    this.floorProjectionRoot = undefined;
    this.floorProjectionAperture = undefined;
    this.floorProjectionPlanes = undefined;
    this.floorProjectionLayout = undefined;

    const root = this.roomRootRef?.current;
    if (
      !root ||
      typeof root.querySelector !== "function" ||
      typeof root.getBoundingClientRect !== "function"
    ) {
      return;
    }
    const aperture = root.querySelector<HTMLElement>(
      "[data-room-window-mask]",
    );
    const planes = root.querySelector(".room-frame__planes");
    if (
      !aperture ||
      !planes ||
      typeof aperture.getBoundingClientRect !== "function" ||
      typeof planes.getBoundingClientRect !== "function"
    ) {
      return;
    }

    this.floorProjectionRoot = root;
    this.floorProjectionAperture = aperture;
    this.floorProjectionPlanes = planes;
    this.measureFloorProjection();

    if (typeof ResizeObserver === "undefined") return;
    this.floorProjectionObserver = new ResizeObserver(() => {
      this.measureFloorProjection();
      const currentRoot = this.roomRootRef?.current;
      if (currentRoot) {
        this.applyFloorProjection(currentRoot, this.resolvedRef.current);
      }
    });
    this.floorProjectionObserver.observe(root);
    this.floorProjectionObserver.observe(aperture);
    this.floorProjectionObserver.observe(planes);
  }

  private applyFloorProjection(
    root: HTMLElement,
    light: ResolvedRoomLight,
  ): void {
    const layout = this.floorProjectionLayout;
    if (layout) {
      resolveRoomFloorProjectionInto(this.floorProjection, light, layout);
    } else {
      this.floorProjection.x = 0;
      this.floorProjection.y = 0;
      this.floorProjection.angle = 0;
      this.floorProjection.length = 0;
      this.floorProjection.width = 0;
      this.floorProjection.scaleX = 0;
      this.floorProjection.scaleY = 0;
      this.floorProjection.visible = 0;
    }
    applyRoomFloorProjectionCssVariables(root, this.floorProjection);
  }

  private readonly onPolicyChange: EventListener = () => {
    this.syncPolicies();
  };

  private syncPolicies(): void {
    const hidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden";
    this.setPolicyPause("document-hidden", hidden);
    this.setPolicyPause("reduced-motion", this.reducedMotion?.matches === true);
    this.setPolicyPause("data-saver", this.connection?.saveData === true);
    this.lastFrame = null;
    this.syncLoop();
  }

  private setPolicyPause(reason: RoomLightPauseReason, paused: boolean): void {
    if (paused) this.pauseReasons.add(reason);
    else this.pauseReasons.delete(reason);
  }

  private shouldRun(): boolean {
    return (
      this.mounted &&
      this.settingsRef.current.autoDrift &&
      this.pauseReasons.size === 0 &&
      Number.isFinite(this.settingsRef.current.driftRate) &&
      this.settingsRef.current.driftRate > 0
    );
  }

  private syncLoop(): void {
    if (!this.shouldRun()) {
      if (this.frame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(this.frame);
      }
      this.frame = null;
      this.lastFrame = null;
      return;
    }
    if (this.frame === null) {
      this.lastFrame = null;
      this.frame = window.requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (timestamp: number): void => {
    this.frame = null;
    if (!this.shouldRun()) return;

    const previous = this.lastFrame;
    this.lastFrame = timestamp;
    if (previous !== null) {
      const elapsed = clampRoomLightFrameDelta(timestamp - previous);
      const advanced = advanceDaylightInto(
        this.daylightAdvance,
        this.settingsRef.current.position,
        this.direction,
        elapsed * Math.max(0, this.settingsRef.current.driftRate),
      );
      this.settingsRef.current.position = advanced.position;
      this.direction = advanced.direction;
      const resolved = this.resolveCurrent();
      if (shouldPublishRoomLightCss(timestamp, this.lastCssFrame)) {
        const root = this.roomRootRef?.current;
        if (root) {
          applyRoomLightCompositeCssVariables(root, resolved);
          this.applyFloorProjection(root, resolved);
        }
        this.lastCssFrame = timestamp;
      }
    }
    this.frame = window.requestAnimationFrame(this.tick);
  };
}

export function createRoomLightController(
  options: UseRoomLightControllerOptions = {},
): RoomLightControllerRuntime {
  return new BrowserRoomLightController(options);
}

/**
 * Own the authored daylight position and its autonomous motion. Fast-changing
 * values live in mutable cells; React never re-renders for drift frames.
 */
export function useRoomLightController(
  options: UseRoomLightControllerOptions = {},
): RoomLightController {
  const {
    initialSettings,
    initialDaylight,
    materialProfile = EMPTY_PROFILE,
    roomRootRef,
    autoDrift,
    driftRate,
  } = options;
  const [controller] = useState(
    () =>
      createRoomLightController({
        initialSettings,
        initialDaylight,
        materialProfile,
        roomRootRef,
        autoDrift,
        driftRate,
      }),
  );

  useEffect(() => {
    controller.configure({
      materialProfile,
      roomRootRef,
      autoDrift,
      driftRate,
    });
  }, [controller, materialProfile, roomRootRef, autoDrift, driftRate]);

  useEffect(() => controller.mount(), [controller]);

  return controller;
}
