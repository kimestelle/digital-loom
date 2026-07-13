"use client";

// ─── insertPanel.tsx ──────────────────────────────────────────────────────────
// The "insert" section of the workshop panel: photo drop/click target, prompt
// and metalness fields, and the submit button that kicks off an extraction.
// Purely presentational — staging, validation, and the pipeline run stay in
// the page. Styles live in app/styles/workshop.css (.mini-drop / .prompt-*).

import { memo, useRef, useState } from "react";
import { SectionLabel } from "@/lib/ui/panelPrimitives";

export interface InsertPanelProps {
  /** Name of the staged photo, or null when nothing is staged yet. */
  stagedName: string | null;
  onFiles: (files: FileList | null) => void;
  prompt: string;
  onPrompt: (v: string) => void;
  /** Raw metalness field text (parsed/clamped by the page). */
  metalness: string;
  onMetalness: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error?: string | null;
}

export const InsertPanel = memo(function InsertPanel({
  stagedName,
  onFiles,
  prompt,
  onPrompt,
  metalness,
  onMetalness,
  onSubmit,
  busy,
  error,
}: InsertPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <section className="panel-section" data-dye="madder">
      <SectionLabel>insert</SectionLabel>
      <div
        className="mini-drop"
        data-over={dragOver}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onFiles(e.currentTarget.files)}
        />
        <span className="mini-drop-title">{stagedName ?? "drop photo"}</span>
        <span className="mini-drop-hint">{stagedName ? "ready" : "or click"}</span>
      </div>
      <label className="prompt-field prompt-field-compact">
        <span className="prompt-label">prompt</span>
        <input
          type="text"
          className="prompt-input"
          value={prompt}
          onChange={(e) => onPrompt(e.currentTarget.value)}
          placeholder="fabric"
          spellCheck={false}
        />
      </label>
      <label className="prompt-field prompt-field-compact">
        <span className="prompt-label">metal</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          className="prompt-input"
          value={metalness}
          onChange={(e) => onMetalness(e.currentTarget.value)}
          placeholder="0 – 1"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="btn btn-primary insert-submit"
        disabled={!stagedName || busy}
        onClick={onSubmit}
      >
        {busy ? "extracting…" : "submit"}
      </button>
      {error ? <p className="error-line dock-error">{error}</p> : null}
    </section>
  );
});
