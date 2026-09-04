"use client";

import { memo, useEffect, useState } from "react";
import PreviewBox from "@/lib/ui/previewBox";
import { SectionLabel } from "@/lib/ui/panelPrimitives";
import {
  MapEditorModal,
  type MapVariationSource,
} from "@/lib/ui/mapEditorModal";
import type { MapName } from "@/lib/core/materialPackage";

export type ExportState = "idle" | "working" | "partial" | "error";

export interface MapsStripProps {
  entries: { name: MapName; url: string }[];
  source: Omit<MapVariationSource, "mapUrl"> | null;
  /** Creates a new authored swatch; shared source bytes stay put. */
  onCreateVariation: (
    source: MapVariationSource,
    name: MapName,
    file: File,
    variationId: string,
  ) => Promise<void>;
  exportState: ExportState;
  canExport: boolean;
  onExport: () => void;
}

export const MapsStrip = memo(function MapsStrip({
  entries,
  source,
  onCreateVariation,
  exportState,
  canExport,
  onExport,
}: MapsStripProps) {
  const [editing, setEditing] = useState<{
    entry: { name: MapName; url: string };
    source: MapVariationSource;
  } | null>(null);

  useEffect(() => {
    if (
      editing &&
      (!source ||
        source.itemId !== editing.source.itemId ||
        source.pkgHash !== editing.source.pkgHash ||
        !entries.some(
          (entry) =>
            entry.name === editing.entry.name &&
            entry.url === editing.source.mapUrl,
        ))
    ) {
      setEditing(null);
    }
  }, [editing, entries, source]);

  return (
    <section className="panel-section" data-dye="indigo">
      <SectionLabel hint="your photo is factored by the Patina AI into PBR maps the shader relights from any angle: albedo = pure color with lighting removed · normal = which way each thread faces · roughness = matte vs shiny · height = raised threads vs valleys · metalness = where it's metal">
        maps
      </SectionLabel>
      {entries.length === 0 ? (
        <p className="dock-empty">no maps</p>
      ) : (
        <>
          <ul className="preview-strip" role="list">
            {entries.map((map) => (
              <li key={map.name} className="preview-chip">
                <button
                  type="button"
                  className="preview-chip-button"
                  data-active={editing?.entry.name === map.name}
                  aria-label={`edit ${map.name} map pixels`}
                  disabled={!source}
                  onClick={() => {
                    if (!source) return;
                    setEditing({
                      entry: map,
                      source: { ...source, mapUrl: map.url },
                    });
                  }}
                >
                  <span className="preview-chip-thumb">
                    <PreviewBox src={map.url} alt={map.name} size="small" />
                  </span>
                  <span className="preview-chip-label">{map.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost export-btn"
            disabled={!canExport || exportState === "working"}
            onClick={onExport}
            title="download the available PBR maps, derived artifacts, canonical material.json, and an exact README as a zip"
          >
            {exportState === "working"
              ? "packaging…"
              : exportState === "partial"
                ? "exported with omissions — retry"
                : exportState === "error"
                  ? "export failed — retry"
                  : "export material ⤓"}
          </button>
          <p className="export-note">
            zips the available maps with material.json; ORM/GLB are included
            when they can be built, and omissions are listed in the README
          </p>
        </>
      )}
      {editing ? (
        <MapEditorModal
          entry={editing.entry}
          source={editing.source}
          onClose={() => setEditing(null)}
          onCreateVariation={onCreateVariation}
        />
      ) : null}
    </section>
  );
});
