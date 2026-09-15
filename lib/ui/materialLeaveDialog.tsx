"use client";

import { useEffect, useRef } from "react";

/** Native modal focus, Escape and focus restoration. */
export function MaterialLeaveDialog({ action, busy, error, onCancel, onDiscard, onSave }: {
  action: string | null;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (action && !dialog.open) dialog.showModal();
    if (!action && dialog.open) dialog.close();
  }, [action]);
  const next = action === "switch swatches" ? "switch" : "continue";
  return <dialog ref={ref} className="material-leave-dialog" aria-label="save changes before leaving"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2>Save your changes?</h2>
    <p>Save a new swatch before you {action}. The original stays unchanged.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="material-leave-dialog__actions">
      <button type="button" disabled={busy} onClick={onCancel}>cancel</button>
      <button type="button" disabled={busy} onClick={onDiscard}>discard &amp; {next}</button>
      <button type="button" disabled={busy} onClick={onSave}>{busy ? "saving…" : `save & ${next}`}</button>
    </div>
  </dialog>;
}
