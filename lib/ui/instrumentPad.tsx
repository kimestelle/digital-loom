"use client";

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

interface InstrumentPadProps {
  label: string;
  x: number;
  y: number;
  xLow: string;
  xHigh: string;
  yLow: string;
  yHigh: string;
  valueText?: string;
  onChange: (x: number, y: number) => void;
  /** Invalidates delayed material work without opening an edit transaction. */
  onPreviewStart?: () => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * A compact two-axis material control. A gesture moves only the field cursor;
 * the material transaction starts and finishes once the value is released.
 * Keyboard users move the same point with the arrow keys (shift = fine step).
 */
export function InstrumentPad({
  label,
  x,
  y,
  xLow,
  xHigh,
  yLow,
  yHigh,
  valueText,
  onChange,
  onPreviewStart,
  onGestureStart,
  onGestureEnd,
}: InstrumentPadProps) {
  const instructionsId = useId();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const keyboardGestureRef = useRef(false);
  const previewRef = useRef({ x, y });
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);

  const showPreview = (next: { x: number; y: number }) => {
    previewRef.current = next;
    setPreview(next);
  };

  const pointFromPointer = (
    event: PointerEvent<HTMLDivElement>,
  ): { x: number; y: number } | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01(1 - (event.clientY - rect.top) / rect.height),
    };
  };

  const finishPointer = (
    event: PointerEvent<HTMLDivElement>,
    includeFinalPosition: boolean,
  ) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const finalPoint = includeFinalPosition
      ? pointFromPointer(event) ?? previewRef.current
      : null;
    pointerIdRef.current = null;
    if (surfaceRef.current?.hasPointerCapture(event.pointerId)) {
      surfaceRef.current.releasePointerCapture(event.pointerId);
    }
    if (finalPoint) {
      onGestureStart?.();
      onChange(finalPoint.x, finalPoint.y);
      onGestureEnd?.();
    }
    setPreview(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && keyboardGestureRef.current) {
      event.preventDefault();
      keyboardGestureRef.current = false;
      setPreview(null);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    if (!keyboardGestureRef.current) {
      keyboardGestureRef.current = true;
      previewRef.current = { x, y };
      setPreview(previewRef.current);
      onPreviewStart?.();
    }
    if (event.key === "Home") {
      showPreview({ x: 0.5, y: 0.5 });
      return;
    }
    const step = event.shiftKey ? 0.01 : 0.05;
    const current = previewRef.current;
    showPreview({
      x: clamp01(
        current.x +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
      ),
      y: clamp01(
        current.y +
          (event.key === "ArrowUp"
            ? step
            : event.key === "ArrowDown"
              ? -step
              : 0),
      ),
    });
  };

  const finishKeyboard = () => {
    if (!keyboardGestureRef.current) return;
    keyboardGestureRef.current = false;
    onGestureStart?.();
    onChange(previewRef.current.x, previewRef.current.y);
    onGestureEnd?.();
    setPreview(null);
  };

  const display = preview ?? { x, y };
  const active = preview !== null;

  return (
    <div className="instrument-pad">
      <span className="instrument-pad-title">{label}</span>
      <div
        ref={surfaceRef}
        className="instrument-pad-surface"
        data-active={active}
        tabIndex={0}
        role="group"
        aria-roledescription="two-dimensional material control"
        aria-label={`${label}: ${xLow} to ${xHigh} ${Math.round(display.x * 100)}%; ${yLow} to ${yHigh} ${Math.round(display.y * 100)}%. ${active ? "Preview; release to apply." : (valueText ?? "")}`}
        aria-describedby={instructionsId}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          if (pointerIdRef.current !== null) return;
          pointerIdRef.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          onPreviewStart?.();
          const point = pointFromPointer(event);
          if (point) showPreview(point);
        }}
        onPointerMove={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          const point = pointFromPointer(event);
          if (point) showPreview(point);
        }}
        onPointerUp={(event) => finishPointer(event, true)}
        onPointerCancel={(event) => finishPointer(event, false)}
        onLostPointerCapture={(event) => finishPointer(event, false)}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home") finishKeyboard();
        }}
        onBlur={finishKeyboard}
      >
        <span className="instrument-pad-axis instrument-pad-axis-top">{yHigh}</span>
        <span className="instrument-pad-axis instrument-pad-axis-bottom">{yLow}</span>
        <span className="instrument-pad-axis instrument-pad-axis-left">{xLow}</span>
        <span className="instrument-pad-axis instrument-pad-axis-right">{xHigh}</span>
        <span
          className="instrument-pad-handle"
          style={{ left: `${display.x * 100}%`, bottom: `${display.y * 100}%` }}
          aria-hidden="true"
        />
      </div>
      <span id={instructionsId} className="sr-only">
        Use left and right arrows for the horizontal axis, up and down arrows
        for the vertical axis, hold shift for fine adjustments, or press Escape
        to cancel before release.
      </span>
    </div>
  );
}
