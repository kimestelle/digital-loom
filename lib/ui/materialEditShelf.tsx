"use client";

export interface MaterialEditShelfProps {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  comparingOriginal: boolean;
  saving: boolean;
  disabled?: boolean;
  savedName?: string | null;
  /** Keep saved content mounted while the shelf slides away during a flip. */
  dismissing?: boolean;
  recoveryWarning?: string | null;
  onCompare: (original: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onSave: () => void;
  onViewArchive: () => void;
}

/** A bottom row of the cabinet, outside its scrolling material content. */
export function MaterialEditShelf({
  dirty,
  canUndo,
  canRedo,
  comparingOriginal,
  saving,
  disabled = false,
  savedName,
  dismissing = false,
  recoveryWarning,
  onCompare,
  onUndo,
  onRedo,
  onReset,
  onSave,
  onViewArchive,
}: MaterialEditShelfProps) {
  const open = !dismissing && (dirty || canUndo || canRedo || saving || Boolean(savedName) || Boolean(recoveryWarning));
  const saved = !dirty && Boolean(savedName);
  const status = saving
    ? "saving new swatch…"
    : dirty
      ? "unsaved changes · original unchanged"
      : saved
        ? "saved to swatch archive"
        : "original unchanged";

  return (
    <section
      className="material-edit-shelf"
      data-open={open}
      data-saved={saved}
      aria-label="material changes"
      aria-hidden={!open}
      inert={!open || disabled ? true : undefined}
    >
      <div className="material-edit-shelf__reveal">
        <div className="material-edit-shelf__body">
          <div className="material-edit-shelf__status-row">
            <p className="material-edit-shelf__status" role="status" title={saved ? savedName ?? undefined : undefined}>
              {status}
            </p>
            {saved ? (
              <button
                type="button"
                className="material-edit-shelf__archive"
                onClick={onViewArchive}
              >
                view swatch
              </button>
            ) : null}
          </div>

          {!saved ? (
            <>
              <div className="material-edit-shelf__compare" role="group" aria-label="compare appearance">
                <span>compare appearance</span>
                <div className="material-edit-shelf__choices">
                  <button
                    type="button"
                    aria-pressed={comparingOriginal}
                    disabled={!dirty || saving}
                    onClick={() => onCompare(true)}
                  >
                    original
                  </button>
                  <button
                    type="button"
                    aria-pressed={!comparingOriginal}
                    disabled={!dirty || saving}
                    onClick={() => onCompare(false)}
                  >
                    edited
                  </button>
                </div>
              </div>
              <div className="material-edit-shelf__actions">
                <button type="button" disabled={!canUndo || saving} onClick={onUndo}>undo</button>
                <button type="button" disabled={!canRedo || saving} onClick={onRedo}>redo</button>
                <button type="button" disabled={!dirty || saving} onClick={onReset}>reset changes</button>
                <button
                  type="button"
                  className="material-edit-shelf__save"
                  disabled={!dirty || saving}
                  onClick={onSave}
                >
                  {saving ? "saving…" : "save as new swatch"}
                </button>
              </div>
            </>
          ) : null}

          {recoveryWarning ? (
            <p className="material-edit-shelf__warning" role="alert">{recoveryWarning}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
