"use client";

// ─── materialSwatches.tsx ─────────────────────────────────────────────────────
// The material swatch grids — the visual language for "a material you can put
// on the loom". Two variants share one look (styles in app/styles/library.css):
//
//   <SampleGrid>   read-only, built-in bundles. Click to wear; drag a swatch
//                  body out to clone it into the library.
//   <LibraryGrid>  the user's materials. Grip (⠿) drags reorder, body drags
//                  clone, hover arms a two-stage delete; the grid itself is
//                  the drop target for clone drags from either grid.
//
// Drag state must be shared between the grids (a drag starts on a sample and
// ends on the library), so the page owns it via useSwatchDrag() and threads it
// into both. Components are memoized: knob drags re-render the page ~60/s and
// the grids' props are stable, so they skip reconciliation entirely.

import { memo, useCallback, useMemo, useState } from "react";
import { MaterialThumbnail } from "@/lib/ui/materialThumbnail";
import { SectionLabel } from "@/lib/ui/panelPrimitives";

/** What a swatch needs to render. Callers usually have a richer item type —
 *  anything structurally satisfying this works (callbacks get the id back). */
export interface SwatchItem {
  /** Stable identity; also what select/clone/reorder/delete callbacks report. */
  id: string;
  label: string;
  /** Albedo (or any representative) image URL; blank checkerboard when absent. */
  thumb?: string;
  /** Hover tooltip; falls back to label. */
  title?: string;
  /** Show the delete affordance (LibraryGrid only). */
  deletable?: boolean;
}

interface DragGesture {
  id: string;
  mode: "reorder" | "clone";
}

/** Shared drag state between grids: what's in flight and which gesture. */
export interface SwatchDrag {
  current: DragGesture | null;
  cloning: boolean;
  begin: (id: string, mode: DragGesture["mode"]) => void;
  end: () => void;
}

/** Owns the cross-grid drag state. Call once in the page, pass to both grids. */
export function useSwatchDrag(): SwatchDrag {
  const [current, setCurrent] = useState<DragGesture | null>(null);
  const begin = useCallback((id: string, mode: DragGesture["mode"]) => {
    setCurrent({ id, mode });
  }, []);
  const end = useCallback(() => setCurrent(null), []);

  return useMemo(
    () => ({ current, cloning: current?.mode === "clone", begin, end }),
    [current, begin, end],
  );
}

// ── Shared face: thumb + caption, drag-to-clone source ──────────────────────

function SwatchFace({
  item,
  active,
  away,
  drag,
  onSelect,
  onRegister,
  onHoverIn,
  onHoverOut,
  onRename,
}: {
  item: SwatchItem;
  active: boolean;
  away: boolean;
  drag: SwatchDrag;
  onSelect: (id: string) => void;
  onRegister: (id: string, image: HTMLImageElement | null) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: (id: string) => void;
  onRename?: (id: string, name: string) => void;
}) {
  // Double-click opens an inline rename field over the label ribbon.
  const [editing, setEditing] = useState(false);
  const commit = (value: string) => {
    setEditing(false);
    const name = value.trim();
    if (name && name !== item.label) onRename?.(item.id, name);
  };
  return (
    <>
      <button
        type="button"
        className="swatch-face"
        data-active={active}
        draggable={!editing}
        onDragStart={(e) => {
          drag.begin(item.id, "clone");
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setData("text/plain", item.id);
        }}
        onDragEnd={drag.end}
        onClick={() => {
          if (!editing) onSelect(item.id);
        }}
        onDoubleClick={() => {
          if (onRename) setEditing(true);
        }}
        title={
          item.title ??
          (onRename ? `${item.label} — double-click to rename` : item.label)
        }
      >
        {item.thumb ? (
          <MaterialThumbnail
            id={item.id}
            src={item.thumb}
            alt=""
            away={away}
            onRegister={onRegister}
            onHoverIn={onHoverIn}
            onHoverOut={onHoverOut}
          />
        ) : (
          <span className="swatch-blank" />
        )}
      </button>
      {/* Caption sits BELOW the face (maps-strip style), so it never fights
          the artwork or the stamp fray; renaming swaps it for an input in
          the same spot. */}
      {editing ? (
        <input
          className="swatch-rename"
          defaultValue={item.label}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label={`rename ${item.label}`}
        />
      ) : (
        <span className="swatch-label">{item.label}</span>
      )}
    </>
  );
}

// ── SampleGrid ───────────────────────────────────────────────────────────────

export interface SampleGridProps {
  items: SwatchItem[];
  activeId: string | null;
  awayId: string | null;
  meshOwnerId: string | null;
  drag: SwatchDrag;
  onSelect: (id: string) => void;
  onRegister: (id: string, image: HTMLImageElement | null) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: (id: string) => void;
  onRename?: (id: string, name: string) => void;
}

export const SampleGrid = memo(function SampleGrid({
  items,
  activeId,
  awayId,
  meshOwnerId,
  drag,
  onSelect,
  onRegister,
  onHoverIn,
  onHoverOut,
  onRename,
}: SampleGridProps) {
  if (items.length === 0) return null;
  return (
    <section className="panel-section" data-dye="gardenia">
      <SectionLabel>
        samples
        <span className="cache-count">{items.length}</span>
      </SectionLabel>
      <ul className="swatch-grid" role="list">
        {items.map((item) => (
          <li key={item.id} className="swatch">
            <SwatchFace
              item={{ ...item, title: `${item.label} — drag into library to clone` }}
              active={activeId === item.id}
              away={awayId === item.id || meshOwnerId === item.id}
              drag={drag}
              onSelect={onSelect}
              onRegister={onRegister}
              onHoverIn={onHoverIn}
              onHoverOut={onHoverOut}
              onRename={onRename}
            />
          </li>
        ))}
      </ul>
    </section>
  );
});

// ── LibraryGrid ──────────────────────────────────────────────────────────────

export interface LibraryGridProps {
  items: SwatchItem[];
  activeId: string | null;
  awayId: string | null;
  meshOwnerId: string | null;
  drag: SwatchDrag;
  onSelect: (id: string) => void;
  onRegister: (id: string, image: HTMLImageElement | null) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: (id: string) => void;
  /** A body-drag (from either grid) was dropped here — make a copy. */
  onClone: (id: string) => void;
  /** A grip-drag landed on another swatch — move dragId before beforeId. */
  onReorder: (dragId: string, beforeId: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  emptyHint?: string;
}

export const LibraryGrid = memo(function LibraryGrid({
  items,
  activeId,
  awayId,
  meshOwnerId,
  drag,
  onSelect,
  onRegister,
  onHoverIn,
  onHoverOut,
  onClone,
  onReorder,
  onDelete,
  onRename,
  emptyHint = "drag a sample here to start a material",
}: LibraryGridProps) {
  // Two-stage delete (arm → confirm) and the reorder drop marker are purely
  // presentational — they live here, not in the page.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  return (
    <section className="panel-section" data-dye="mugwort">
      <SectionLabel>
        library
        <span className="cache-count">{items.length}</span>
      </SectionLabel>
      {items.length === 0 ? <p className="dock-empty">{emptyHint}</p> : null}
      <ul
        className="swatch-grid"
        role="list"
        data-cloning={drag.cloning}
        onDragOver={(e) => {
          if (drag.current?.mode === "clone") e.preventDefault();
        }}
        onDrop={(e) => {
          const d = drag.current;
          if (d?.mode === "clone") {
            e.preventDefault();
            onClone(d.id);
          }
          drag.end();
        }}
      >
        {items.map((item) => {
          const armed = armedId === item.id;
          return (
            <li
              key={item.id}
              className="swatch"
              data-drop={dropTargetId === item.id}
              onDragOver={(e) => {
                if (drag.current?.mode === "reorder") {
                  e.preventDefault();
                  setDropTargetId(item.id);
                }
              }}
              onDragLeave={() =>
                setDropTargetId((cur) => (cur === item.id ? null : cur))
              }
              onDrop={(e) => {
                const d = drag.current;
                if (d?.mode === "reorder") {
                  e.preventDefault();
                  e.stopPropagation(); // don't fall through to the grid's clone drop
                  onReorder(d.id, item.id);
                }
                setDropTargetId(null);
              }}
            >
              <span
                className="swatch-grip"
                role="button"
                aria-label={`reorder ${item.label}`}
                draggable
                onDragStart={(e) => {
                  drag.begin(item.id, "reorder");
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={() => {
                  drag.end();
                  setDropTargetId(null);
                }}
              >
                ⠿
              </span>
              <SwatchFace
                item={item}
                active={activeId === item.id}
                away={awayId === item.id || meshOwnerId === item.id}
                drag={drag}
                onSelect={onSelect}
                onRegister={onRegister}
                onHoverIn={onHoverIn}
                onHoverOut={onHoverOut}
                onRename={onRename}
              />
              {item.deletable ? (
                <button
                  type="button"
                  className="swatch-del"
                  data-armed={armed}
                  aria-label={armed ? "confirm delete" : `delete ${item.label}`}
                  onMouseLeave={() => setArmedId(null)}
                  onClick={() => {
                    if (armed) {
                      setArmedId(null);
                      onDelete(item.id);
                    } else {
                      setArmedId(item.id);
                    }
                  }}
                >
                  {armed ? "✓" : "×"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
});
