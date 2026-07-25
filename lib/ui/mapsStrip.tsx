"use client";

// ─── mapsStrip.tsx ────────────────────────────────────────────────────────────
// The "maps" section of the workshop panel: the extracted PBR maps as a strip
// of hover-to-enlarge chips, plus the export button. Purely presentational —
// the page owns the package and the export pipeline. Styles live in
// app/styles/workshop.css (.preview-strip / .preview-chip*).

import { memo } from "react";
import PreviewBox from "@/lib/ui/previewBox";
import { SectionLabel } from "@/lib/ui/panelPrimitives";

export type ExportState = "idle" | "working" | "error";

export interface MapsStripProps {
  /** Name + resolvable URL per extracted map, in display order. */
  entries: { name: string; url: string }[];
  exportState: ExportState;
  /** False while no package is loaded — disables export. */
  canExport: boolean;
  onExport: () => void;
}

export const MapsStrip = memo(function MapsStrip({
  entries,
  exportState,
  canExport,
  onExport,
}: MapsStripProps) {
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
            {entries.map((m) => (
              <li key={m.name} className="preview-chip">
                <div className="preview-chip-thumb">
                  <PreviewBox src={m.url} alt={m.name} size="small" />
                </div>
                <span className="preview-chip-label">{m.name}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost export-btn"
            disabled={!canExport || exportState === "working"}
            onClick={onExport}
            title="download PBR maps + ORM + .glb + material.json + README as a zip"
          >
            {exportState === "working"
              ? "packaging…"
              : exportState === "error"
                ? "export failed — retry"
                : "export material ⤓"}
          </button>
          <p className="export-note">
            zips these maps (PBR-named) with a .glb specimen + material.json —
            drops straight into Blender, Unity, or Unreal
          </p>
        </>
      )}
    </section>
  );
});
