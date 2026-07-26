"use client";

// ─── panelPrimitives.tsx ──────────────────────────────────────────────────────
// Small React building blocks for the tuning + workshop panels. Extracted from
// the page component so that (a) the page reads as compositional glue rather
// than several hundred lines of slider markup, and (b) future consumers can
// reuse the same visual language.

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ── Info dot: ⓘ with a plain-words explanation on hover/focus. The bubble
// renders through a portal pinned to the trigger's viewport rect — panels
// clip overflow AND their backdrop-filter makes them the containing block
// even for fixed-position descendants, so a CSS-only bubble can't escape.
//
// The portal node is created on first show and then kept mounted (rect is
// sticky) — only `open` toggles from then on. That gives the bubble a real
// CSS transition in BOTH directions (fade + scale in on show, back out on
// hide) instead of a one-shot enter animation that vanishes instantly when
// React unmounts it on hide.

export function InfoDot({ hint }: { hint: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Clamp horizontally so the bubble (max-width 230) never leaves the
    // viewport — dots at a panel's edge would otherwise push it offscreen.
    const half = 115 + 12;
    setRect({
      x: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half),
      y: r.top,
    });
    // One frame so the browser paints the closed (opacity:0) state first —
    // otherwise a first-ever show mounts already-open and never transitions.
    requestAnimationFrame(() => setOpen(true));
  };
  const hide = () => setOpen(false);
  return (
    <span
      ref={ref}
      className="info-dot"
      tabIndex={0}
      role="note"
      aria-label={hint}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span className="info-icon" aria-hidden="true" />
      {rect
        ? createPortal(
            <span
              className="info-bubble"
              data-open={open}
              role="tooltip"
              style={{ left: rect.x, top: rect.y }}
            >
              {hint}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

// ── Section header for panels

export function SectionLabel({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="section-label">
      {children}
      {hint ? <InfoDot hint={hint} /> : null}
    </div>
  );
}

// ── Sliders

interface SliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Plain-words explanation surfaced on the ⓘ next to the label. */
  hint?: string;
}

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  hint,
}: SliderProps) {
  const digits = step >= 1 ? 0 : step >= 0.01 ? 2 : 3;
  return (
    <label className="slider">
      <span className="slider-label">
        <span className="slider-name">
          {label}
          {hint ? <InfoDot hint={hint} /> : null}
        </span>
        <span className="slider-value">{value.toFixed(digits)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}

interface IntSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  hint?: string;
}

export function IntSlider({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: IntSliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        <span className="slider-name">
          {label}
          {hint ? <InfoDot hint={hint} /> : null}
        </span>
        <span className="slider-value">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.currentTarget.value)))}
      />
    </label>
  );
}

// ── Side panel header + collapse toggle

interface PanelHeaderTabs<T extends string> {
  items: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onSelect: (id: T) => void;
}

interface PanelHeaderProps {
  title: string;
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
  /** When set, the header title becomes a tab strip (title is kept for the
   *  toggle's aria labels). */
  tabs?: PanelHeaderTabs<string>;
}

export function PanelHeader({
  title,
  side,
  collapsed,
  onToggle,
  tabs,
}: PanelHeaderProps) {
  // Panels collapse downward (roll up into the header bar); the caret points
  // down to invite the collapse and flips up (via CSS) once collapsed.
  const label = collapsed ? `expand ${title}` : `collapse ${title}`;
  const toggle = (
    <button
      type="button"
      className="side-panel-toggle"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={!collapsed}
    >
      <span className="chevron" aria-hidden="true" />
    </button>
  );
  const titleEl = tabs ? (
    <div className="side-panel-tabs" role="tablist" aria-label={title}>
      {tabs.items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          className="side-panel-tab"
          aria-selected={tabs.active === t.id}
          data-active={tabs.active === t.id}
          onClick={() => tabs.onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  ) : (
    <span className="side-panel-title">{title}</span>
  );
  return (
    <header className="side-panel-header">
      {side === "left" ? (
        <>
          {titleEl}
          {toggle}
        </>
      ) : (
        <>
          {toggle}
          {titleEl}
        </>
      )}
    </header>
  );
}

// ── Formatting helpers

export function shortHash(h: string): string {
  return h.slice(0, 8);
}

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
