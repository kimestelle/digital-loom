"use client";

// The top chrome: the logo opens the environment rail; status stays separate.
// Also home of `PipelineStatus`, the one union every stage of the
// extract pipeline reports through — the page owns the state, this renders it.
// Styles live in app/styles/layout.css (.nav-bar / .status-*).

import { memo, useLayoutEffect, useRef } from "react";
import { PixelPlay } from "@/lib/ui/pixelPlay";
import {
  SaveStatus,
  type SaveStatusKind,
} from "@/lib/ui/saveStatus";

const WORDMARK = Array.from("digital loom");

/** Each letter gathers at the mark, then travels to its natural text position.
 * Measure only when fonts or layout change; playback is entirely CSS. */
function LoomWordmark() {
  const ref = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const wordmark = ref.current;
    const symbol = wordmark?.parentElement?.querySelector<HTMLElement>(".nav-logo-symbol");
    if (!wordmark || !symbol) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const anchor = symbol.offsetLeft + symbol.offsetWidth / 2;
      const origin = wordmark.offsetLeft;
      const letters = Array.from(wordmark.children) as HTMLElement[];
      const offsets = letters.map((letter) => anchor - origin - letter.offsetLeft);
      letters.forEach((letter, index) => {
        letter.style.setProperty("--logo-collapse-x", `${offsets[index]}px`);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wordmark);
    observer.observe(symbol);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, []);

  return (
    <span ref={ref} className="nav-logo-wordmark" aria-hidden="true">
      {WORDMARK.map((letter, index) => (
        <span className="nav-logo-letter" key={index}>{letter}</span>
      ))}
    </span>
  );
}

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
  onOpenLight: () => void;
  lightDialogOpen?: boolean;
  status: PipelineStatus;
  saveStatus: SaveStatusKind;
  saveMessage?: string | null;
  onRetrySave: () => void;
}

export const NavBar = memo(function NavBar({
  onOpenLight,
  lightDialogOpen = false,
  status,
  saveStatus,
  saveMessage,
  onRetrySave,
}: NavBarProps) {
  return (
    <header className="nav-bar" data-controls-open={lightDialogOpen}>
      <svg className="nav-environment-guide" aria-hidden="true" focusable="false">
        <line x1="0.5" y1="0" x2="0.5" y2="100%" />
      </svg>
      <div className="nav-bar-inner">
        <div className="nav-brand">
          <button
            type="button"
            className="nav-logo-button"
            aria-label="environment controls"
            aria-controls="room-environment-controls"
            aria-expanded={lightDialogOpen}
            title={lightDialogOpen ? "close environment controls" : "environment controls"}
            onClick={onOpenLight}
          >
            <span className="nav-logo-symbol" aria-hidden="true">
              <span className="nav-logo-mark" aria-hidden="true" />
              <span
                className="nav-logo-pixel-home"
                data-pressed={lightDialogOpen}
                aria-hidden="true"
              >
                <PixelPlay pixel={3} layer="over" className="nav-logo-pixel" />
              </span>
            </span>
            <LoomWordmark />
          </button>
        </div>
        <div className="nav-status-group">
          <StatusPill status={status} />
          <SaveStatus
            status={saveStatus}
            message={saveMessage}
            onRetry={onRetrySave}
          />
        </div>
      </div>
    </header>
  );
});
