"use client";

// ─── appHeader.tsx ────────────────────────────────────────────────────────────
// The top chrome: brand, cloth/object mode toggle, and the pipeline status
// pill. Also home of `PipelineStatus`, the one union every stage of the
// extract pipeline reports through — the page owns the state, this renders it.
// Styles live in app/styles/layout.css (.app-header / .mode-tabs / .status-*).

import { memo } from "react";
import { shortHash } from "@/lib/ui/panelPrimitives";
import ModeButton from "@/lib/ui/modeButton";


/** Lifecycle of the current extraction/selection, as shown in the pill. */
export type PipelineStatus =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done"; cacheHit: boolean; hash: string };

export type StageMode = "cloth" | "object";

export function StatusPill({ status }: { status: PipelineStatus }) {
  let label: string;
  let tone: "idle" | "loading" | "error" | "done";
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
    case "done":
      label = status.cacheHit
        ? `cache · ${shortHash(status.hash)}`
        : `fresh · ${shortHash(status.hash)}`;
      tone = "done";
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
    <header className="nav-bar">
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
