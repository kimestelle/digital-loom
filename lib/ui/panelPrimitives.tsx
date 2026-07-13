"use client";

// ─── panelPrimitives.tsx ──────────────────────────────────────────────────────
// Small React building blocks for the tuning + workshop panels. Extracted from
// the page component so that (a) the page reads as compositional glue rather
// than several hundred lines of slider markup, and (b) future consumers can
// reuse the same visual language.

import type { ReactNode } from "react";

// ── Section header for panels

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="section-label">{children}</div>;
}

// ── Sliders

interface SliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: SliderProps) {
  const digits = step >= 1 ? 0 : step >= 0.01 ? 2 : 3;
  return (
    <label className="slider">
      <span className="slider-label">
        <span>{label}</span>
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
}

export function IntSlider({
  label,
  value,
  onChange,
  min,
  max,
}: IntSliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        <span>{label}</span>
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

interface PanelHeaderProps {
  title: string;
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
}

export function PanelHeader({
  title,
  side,
  collapsed,
  onToggle,
}: PanelHeaderProps) {
  // Panels collapse downward (roll up into the header bar); the caret points
  // down to invite the collapse and flips up (via CSS) once collapsed.
  const chevron = "⌄";
  const label = collapsed ? `expand ${title}` : `collapse ${title}`;
  const toggle = (
    <button
      type="button"
      className="side-panel-toggle"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={!collapsed}
    >
      <span className="chevron" aria-hidden="true">
        {chevron}
      </span>
    </button>
  );
  const titleEl = <span className="side-panel-title">{title}</span>;
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
