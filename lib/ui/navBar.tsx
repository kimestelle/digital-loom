"use client";

// ─── appHeader.tsx ────────────────────────────────────────────────────────────
// The top chrome: brand, cloth/object mode toggle, and the pipeline status
// pill. Also home of `PipelineStatus`, the one union every stage of the
// extract pipeline reports through — the page owns the state, this renders it.
// Styles live in app/styles/layout.css (.app-header / .mode-tabs / .status-*).

import { memo } from "react";
import ModeButton from "@/lib/ui/modeButton";


/** Lifecycle of the current extraction/selection, as shown in the pill. */
export type PipelineStatus =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; cacheHit: boolean; hash: string };

export type StageMode = "cloth" | "object";

export function StatusPill({ status }: { status: PipelineStatus }) {
  // "done" surfaces nothing actionable — a cache-hit/fresh hash only ever
  // meant something to a developer watching the network tab, not the
  // person using the instrument. Loading/error still earn a pill; a
  // successful load speaks for itself in the viewport.
  if (status.kind === "done") return null;

  let label: string;
  let tone: "idle" | "loading" | "error";
  switch (status.kind) {
    case "idle":
      label = "ready";
      tone = "idle";
      break;
    case "loading":
      label = status.message;
      tone = "loading";
      break;
    case "error":
      label = "error";
      tone = "error";
      break;
  }
  return (
    <div className="status-pill" data-tone={tone}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{label}</span>
    </div>
  );
}

export interface NavBarProps {
  mode: StageMode;
  onMode: (m: StageMode) => void;
  status: PipelineStatus;
}

export const NavBar = memo(function NavBar({
  mode,
  onMode,
  status,
}: NavBarProps) {
  return (
    <header className="nav-bar glass">
      <div className="nav-bar-inner">
        <div className="nav-brand">
          <span className="nav-brand-name">digital loom</span>
          <span className="nav-brand-sub">fabric material instrument</span>
        </div>
        <ModeButton mode={mode} onMode={onMode} />
        <StatusPill status={status} />
      </div>
    </header>
  );
});
