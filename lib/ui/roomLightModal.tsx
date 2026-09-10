"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { PixelPlay } from "./pixelPlay";
import type { StageMode } from "./navBar";
import {
  DEFAULT_ROOM_LIGHT_SETTINGS,
  ROOM_LIGHT_MAX_DRIFT_RATE,
  type ResolvedRoomLight,
  type RoomLightSettings,
} from "./roomLight";

export interface RoomLightModalProps {
  open: boolean;
  settings: RoomLightSettings;
  resolved: ResolvedRoomLight;
  onChange: (settings: RoomLightSettings) => void;
  onReset: () => void;
  onClose: () => void;
  mode: StageMode;
  onMode: (mode: StageMode) => void;
}

interface RangeControlProps {
  id: string;
  label: string;
  hint: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  valueText: string;
  ariaValueText?: string;
  onChange: (value: number) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function percent(value: number): string {
  return `${Math.round(clamp(value, 0, 1, 0) * 100)}%`;
}

function daylightLabel(value: number): string {
  const minutes = Math.round(clamp(value, 0, 1, 0) * 24 * 60) % (24 * 60);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function warmthLabel(value: number): string {
  const safeValue = clamp(value, 0, 1, 0.5);
  const temperature = safeValue < 0.4 ? "cool" : safeValue > 0.6 ? "warm" : "neutral";
  return `${temperature} · ${percent(safeValue)}`;
}

function driftLabel(value: number): string {
  const safeValue = clamp(value, 0, ROOM_LIGHT_MAX_DRIFT_RATE, 0);
  if (safeValue <= 0) return "still";
  return `~${Math.round(1 / safeValue)}s / day`;
}

function channelByte(value: number): number {
  return Math.round(clamp(value, 0, 1, 0) * 255);
}

function tintValue(light: ResolvedRoomLight): { css: string; label: string } {
  const r = channelByte(light.transmitted.tint.r);
  const g = channelByte(light.transmitted.tint.g);
  const b = channelByte(light.transmitted.tint.b);
  return {
    css: `rgb(${r} ${g} ${b})`,
    label: `rgb ${r} / ${g} / ${b}`,
  };
}

function RangeControl({
  id,
  label,
  hint,
  min = 0,
  max = 1,
  step = 0.01,
  value,
  valueText,
  ariaValueText = valueText,
  onChange,
  inputRef,
  disabled = false,
}: RangeControlProps) {
  const hintId = `${id}-hint`;
  const safeValue = clamp(value, min, max, min);

  return (
    <div className="room-light-modal__control">
      <label htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id}>{valueText}</output>
      </label>
      <input
        ref={inputRef}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeValue}
        disabled={disabled}
        aria-describedby={hintId}
        aria-valuetext={ariaValueText}
        onChange={(event) =>
          onChange(clamp(event.currentTarget.valueAsNumber, min, max, safeValue))
        }
      />
      <p id={hintId} className="room-light-modal__hint">
        {hint}
      </p>
    </div>
  );
}

export function RoomLightModal({
  open,
  settings,
  resolved,
  onChange,
  onReset,
  onClose,
  mode,
  onMode,
}: RoomLightModalProps) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  const idPrefix = useId();
  const safeSettings: RoomLightSettings = {
    position: clamp(settings.position, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.position),
    exposure: clamp(settings.exposure, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.exposure),
    warmth: clamp(settings.warmth, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.warmth),
    ambient: clamp(settings.ambient, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.ambient),
    beam: clamp(settings.beam, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.beam),
    dapple: clamp(settings.dapple, 0, 1, DEFAULT_ROOM_LIGHT_SETTINGS.dapple),
    dappleSoftness: clamp(
      settings.dappleSoftness,
      0,
      1,
      DEFAULT_ROOM_LIGHT_SETTINGS.dappleSoftness,
    ),
    autoDrift: settings.autoDrift,
    driftRate: clamp(
      settings.driftRate,
      0,
      ROOM_LIGHT_MAX_DRIFT_RATE,
      DEFAULT_ROOM_LIGHT_SETTINGS.driftRate,
    ),
  };
  const responseTint = tintValue(resolved);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-controls="room-environment-controls"]',
    );
    const rail = dialogRef.current;
    let pointerStartedInside = false;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node && (rail?.contains(target) || trigger?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      pointerStartedInside = Boolean(isInside(event.target));
    };
    const onOutsideClick = (event: MouseEvent) => {
      // A slider drag can end outside its bounds. Dismiss only independent
      // outside clicks, and leave the underlying click/focus action untouched.
      const draggedFromInside = event.detail > 0 && pointerStartedInside;
      pointerStartedInside = false;
      if (!isInside(event.target) && !draggedFromInside) onCloseRef.current();
    };
    const focusFrame = window.requestAnimationFrame(() => sliderRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        if (rail?.contains(document.activeElement)) trigger?.focus();
        onCloseRef.current();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onOutsideClick, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onOutsideClick, true);
      if (rail?.contains(document.activeElement)) trigger?.focus();
    };
  }, [open]);

  if (!mounted) return null;
  const update = <Key extends keyof RoomLightSettings>(
    key: Key,
    value: RoomLightSettings[Key],
  ) => onChange({ ...safeSettings, [key]: value });
  const controlId = (name: string) => `${idPrefix}-${name}`;

  return createPortal(
    <div className="room-light-modal" data-open={open}>
      <div className="room-light-modal__reveal">
      <section
        ref={dialogRef}
        id="room-environment-controls"
        className="room-light-modal__dialog"
        role="region"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-hidden={!open}
        inert={!open ? true : undefined}
        tabIndex={-1}
      >
        <header className="room-light-modal__header">
          <div>
            <h2 id={titleId}>environment controls</h2>
            <p id={descriptionId} className="room-light-modal__note">
              Place the daylight, then tune the room&apos;s illumination and soft light patch. These settings stay with the room, not the material.
            </p>
          </div>
          <button
            type="button"
            className="room-light-modal__close"
            aria-label="close daylight controls"
            onClick={() => {
              document.querySelector<HTMLButtonElement>(
                '[aria-controls="room-environment-controls"]',
              )?.focus();
              onClose();
            }}
          >
            close
          </button>
        </header>

        <div className="room-light-modal__body">
          <fieldset className="room-light-modal__group" style={{ "--cascade-index": 0 } as CSSProperties}>
            <legend>light</legend>
            <p className="room-light-modal__group-note">
              One source lights the specimen, window, and room from the same resolved state.
            </p>
            <RangeControl
              inputRef={sliderRef}
              id={controlId("path")}
              label="time of day"
              hint="Scrub midnight, sunrise, noon, and sunset. The window, fabric lighting, lens flare, and floor projection follow the same time."
              step={0.001}
              value={safeSettings.position}
              valueText={daylightLabel(safeSettings.position)}
              ariaValueText={daylightLabel(safeSettings.position).split(" · ")[0]}
              onChange={(position) => update("position", position)}
            />
            <RangeControl
              id={controlId("exposure")}
              label="exposure"
              hint="Raises or lowers direct daylight and the window glow together."
              value={safeSettings.exposure}
              valueText={percent(safeSettings.exposure)}
              onChange={(exposure) => update("exposure", exposure)}
            />
            <RangeControl
              id={controlId("warmth")}
              label="warmth"
              hint="Shifts direct light from cooler daylight toward late-day amber without moving it."
              value={safeSettings.warmth}
              valueText={warmthLabel(safeSettings.warmth)}
              onChange={(warmth) => update("warmth", warmth)}
            />
            <RangeControl
              id={controlId("ambient")}
              label="ambient fill"
              hint="Adds sky and floor bounce above a faint base light that stays on, even at night."
              value={safeSettings.ambient}
              valueText={percent(safeSettings.ambient)}
              onChange={(ambient) => update("ambient", ambient)}
            />
          </fieldset>

          <details className="room-light-modal__group" style={{ "--cascade-index": 1 } as CSSProperties}>
            <summary>projection</summary>
            <p className="room-light-modal__group-note">
              These controls alter the aggregate light on the room, not a simulated cloth shadow.
            </p>
            <RangeControl
              id={controlId("beam")}
              label="beam"
              hint="Sets the strength of the broad daylight path crossing the wall and floor."
              value={safeSettings.beam}
              valueText={percent(safeSettings.beam)}
              onChange={(beam) => update("beam", beam)}
            />
            <RangeControl
              id={controlId("dapple")}
              label="light patch"
              hint="Sets the strength of the warm floor light around the fabric's shadow."
              value={safeSettings.dapple}
              valueText={percent(safeSettings.dapple)}
              onChange={(dapple) => update("dapple", dapple)}
            />
            <RangeControl
              id={controlId("dapple-softness")}
              label="edge softness"
              hint="Adjusts the soft light field without changing its position."
              value={safeSettings.dappleSoftness}
              valueText={percent(safeSettings.dappleSoftness)}
              onChange={(dappleSoftness) => update("dappleSoftness", dappleSoftness)}
            />
          </details>

          <fieldset className="room-light-modal__group" style={{ "--cascade-index": 2 } as CSSProperties}>
            <legend>motion</legend>
            <p className="room-light-modal__group-note">
              Automatic travel pauses while this panel is open. Manual positioning always remains available.
            </p>
            <div className="room-light-modal__toggle-row">
              <div>
                <label htmlFor={controlId("auto-drift")}>day / night cycle</label>
                <p id={controlId("auto-drift-hint")} className="room-light-modal__hint">
                  Resumes the day and night cycle from the chosen time after closing.
                </p>
              </div>
              <input
                id={controlId("auto-drift")}
                type="checkbox"
                role="switch"
                checked={safeSettings.autoDrift}
                aria-describedby={controlId("auto-drift-hint")}
                onChange={(event) => update("autoDrift", event.currentTarget.checked)}
              />
            </div>
            {safeSettings.autoDrift && (
              <p className="room-light-modal__cycle-note">resumes when controls close</p>
            )}
            <RangeControl
              id={controlId("drift-rate")}
              label="cycle speed"
              hint="Controls the cycle after the panel closes; the readout is the duration of one full day and night."
              min={0}
              max={ROOM_LIGHT_MAX_DRIFT_RATE}
              step={0.001}
              value={safeSettings.driftRate}
              valueText={driftLabel(safeSettings.driftRate)}
              disabled={!safeSettings.autoDrift}
              onChange={(driftRate) => update("driftRate", driftRate)}
            />
          </fieldset>

          <details className="room-light-modal__group room-light-modal__response" style={{ "--cascade-index": 3 } as CSSProperties}>
            <summary>fabric response</summary>
            <p className="room-light-modal__group-note">
              Read-only evidence from the active fabric conditions the transmitted floor cue.
            </p>
            <dl>
              <div>
                <dt>transmitted amount</dt>
                <dd>{percent(resolved.transmitted.amount)}</dd>
              </div>
              <div>
                <dt>transmitted tint</dt>
                <dd>
                  <span
                    className="room-light-modal__tint"
                    style={{ "--room-response-tint": responseTint.css } as CSSProperties}
                    aria-hidden="true"
                  />
                  {responseTint.label}
                </dd>
              </div>
            </dl>
          </details>

          <fieldset className="room-light-modal__group room-light-modal__preview" style={{ "--cascade-index": 4 } as CSSProperties}>
            <legend>preview</legend>
            <label className="tx-mode-picker room-light-modal__mode-picker" data-dye="indigo">
              <PixelPlay tone="ink" layer="over" />
              <input
                type="checkbox"
                role="switch"
                aria-label="mesh preview"
                checked={mode === "object"}
                onChange={(event) => onMode(event.currentTarget.checked ? "object" : "cloth")}
              />
              <span className="tx-mode-tab" data-active={mode === "cloth"}>cloth</span>
              <span className="tx-mode-tab" data-active={mode === "object"}>mesh</span>
            </label>
          </fieldset>

          <footer className="room-light-modal__actions">
            <p>Reset changes only the room. The active material remains untouched.</p>
            <button type="button" onClick={onReset}>
              reset room
            </button>
          </footer>
        </div>
      </section>
      </div>
    </div>,
    document.body,
  );
}
