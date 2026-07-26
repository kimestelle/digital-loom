"use client";

// ─── insertPanel.tsx ──────────────────────────────────────────────────────────
// The "insert" section of the workshop panel: photo drop/click target, prompt
// and metalness fields, and the submit button that kicks off an extraction.
// Purely presentational — staging, validation, and the pipeline run stay in
// the page. Styles live in app/styles/workshop.css (.mini-drop / .prompt-*).

import { memo, useEffect, useRef, useState } from "react";
import { SectionLabel } from "@/lib/ui/panelPrimitives";

const FAL_KEY_STORAGE = "loom.falKey";

export interface InsertPanelProps {
  /** Name of the staged photo, or null when nothing is staged yet. */
  stagedName: string | null;
  onFiles: (files: FileList | null) => void;
  prompt: string;
  onPrompt: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error?: string | null;
}

export const InsertPanel = memo(function InsertPanel({
  stagedName,
  onFiles,
  prompt,
  onPrompt,
  onSubmit,
  busy,
  error,
}: InsertPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // The user's own fal credential. Lives in localStorage only — it rides
  // each /api/patina request as a header (never rendered anywhere else) and
  // takes precedence over the server's key. Cleared field = server key.
  const [falKey, setFalKey] = useState("");
  useEffect(() => {
    setFalKey(localStorage.getItem(FAL_KEY_STORAGE) ?? "");
  }, []);
  const saveFalKey = (v: string) => {
    setFalKey(v);
    if (v.trim()) localStorage.setItem(FAL_KEY_STORAGE, v.trim());
    else localStorage.removeItem(FAL_KEY_STORAGE);
  };

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
        <span className="prompt-label">fal.ai api key</span>
        <input
          type="password"
          className="prompt-input"
          value={falKey}
          onChange={(e) => saveFalKey(e.currentTarget.value)}
          placeholder="optional — for gen model"
          autoComplete="off"
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
