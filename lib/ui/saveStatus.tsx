"use client";

import { memo } from "react";

export type SaveStatusKind = "dirty" | "saving" | "saved" | "error";

export interface SaveStatusProps {
  status: SaveStatusKind;
  message?: string | null;
  onRetry: () => void;
}

export const SaveStatus = memo(function SaveStatus({
  status,
  message,
  onRetry,
}: SaveStatusProps) {
  const label =
    status === "dirty"
      ? "unsaved changes"
      : status === "saving"
        ? "saving locally…"
        : status === "saved"
          ? "saved on this device"
          : message || "local save failed";
  return (
    <div
      className="save-status"
      data-status={status}
      role="status"
      aria-live={status === "error" ? "assertive" : "polite"}
      title={message ?? undefined}
    >
      <span className="save-status-dot" aria-hidden="true" />
      <span className="save-status-label">{label}</span>
      {status === "error" ? (
        <button type="button" className="save-status-retry" onClick={onRetry}>
          retry
        </button>
      ) : null}
    </div>
  );
});
