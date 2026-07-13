"use client";

// ─── fabricViewer.tsx ─────────────────────────────────────────────────────────
// A drop-in, self-sizing fabric renderer. Give it a material package (the maps)
// and it hangs the cloth — draping, breathing, backlit — filling whatever box
// you put it in. No width/height math on the caller's side: the underlying
// ClothScene owns a ResizeObserver and paints to its container, so
//
//     <div style={{ display: "flex", height: 400 }}>
//       <FabricViewer pkg={pkg} />
//     </div>
//
// just works, and the fabric reflows with the box. Knobs are optional overrides
// merged over sensible defaults; everything else (rope, sun, sky, physics) is
// handled internally.

import { useMemo } from "react";
import ClothScene from "@/lib/ui/clothScene";
import {
  FABRICS,
  resolveFabric,
  type FabricId,
  type ResolvedFabric,
} from "@/lib/cloth/fabrics";
import type { MaterialPackage } from "@/lib/core/materialPackage";
import {
  type Knobs,
  DEFAULT_KNOBS,
  MESH_PRESETS,
  QUALITY_PRESETS,
} from "@/lib/ui/knobs";

/** Resolve a base fabric profile + material-package maps + knob overrides into
 *  the ResolvedFabric the solver/scene consume. Shared with the main app so
 *  the embed and the studio render identically. */
export function fabricFromPkg(
  pkg: MaterialPackage | null,
  knobs: Knobs,
  baseId: FabricId,
): ResolvedFabric {
  const base = FABRICS[baseId];
  const resolved = resolveFabric(base, knobs.tileScale);
  const albedoUrl = pkg?.maps.albedo?.url ?? resolved.albedoURL;
  const heightUrl =
    pkg?.maps.height?.url ?? pkg?.maps.roughness?.url ?? resolved.textureURL;
  return {
    ...resolved,
    albedoURL: albedoUrl,
    textureURL: heightUrl,
    sheen: knobs.sheen,
    particleMass: resolved.particleMass * Math.max(0.05, knobs.weight),
    warpStiffness: knobs.warpStiffness,
    weftStiffness: knobs.weftStiffness,
    shearStiffness: knobs.shearStiffness,
    bendStiffness: knobs.bendStiffness,
  };
}

export interface FabricViewerProps {
  /** The material to wear — maps from an extraction. Null falls back to the
   *  base fabric's bundled textures. */
  pkg?: MaterialPackage | null;
  /** Base physical profile (drape/motion character). Default: silk. */
  fabricId?: FabricId;
  /** Partial knob overrides merged over defaults (openness, sheen, tileScale,
   *  weave stiffness, POM, edge, breeze, quality, meshRes, …). */
  knobs?: Partial<Knobs>;
  /** "cloth" hangs it on the line; "object" drapes it over the bundled model. */
  mode?: "cloth" | "object";
  /** Metalness amount 0..1 (gates the metalness map). */
  metalness?: number;
  /** Model surfaced in object mode. */
  objectModelUrl?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** Embeddable fabric viewer that fills its container. */
export default function FabricViewer({
  pkg = null,
  fabricId = "myeongju",
  knobs: knobOverrides,
  mode = "cloth",
  metalness = 0,
  objectModelUrl,
  className,
  style,
}: FabricViewerProps) {
  // Embeds default to `mid` quality/mesh — a viewer in someone else's page
  // shouldn't grab the heaviest settings uninvited (the studio can opt into hi).
  const knobs = useMemo<Knobs>(
    () => ({ ...DEFAULT_KNOBS, quality: "mid", ...knobOverrides }),
    [knobOverrides],
  );
  const fabric = useMemo(
    () => fabricFromPkg(pkg, knobs, fabricId),
    [pkg, knobs, fabricId],
  );
  const opennessCurved = Math.pow(knobs.openness, 3);

  return (
    <div
      className={className}
      style={{ width: "100%", height: "100%", minHeight: 0, ...style }}
    >
      <ClothScene
        fabric={fabric}
        mode={mode}
        pkg={pkg}
        objectModelUrl={objectModelUrl}
        objectTileScale={knobs.tileScale * 5}
        metalness={metalness}
        metalnessMapURL={pkg?.maps.metalness?.url}
        normalMapURL={pkg?.maps.normal?.url}
        roughnessMapURL={pkg?.maps.roughness?.url}
        porosityMapURL={pkg?.maps.transmission?.url}
        openness={opennessCurved}
        alphaBoost={knobs.alphaBoost}
        alphaBoostSource={knobs.alphaBoostSource}
        normalAmount={knobs.normalAmount}
        pomShadow={knobs.pomShadow}
        stretch={knobs.stretch}
        stretchDebug={knobs.stretchDebug}
        albedoAmount={knobs.albedoAmount}
        pomScale={knobs.pomScale}
        pomMinSteps={knobs.pomMinSteps}
        pomMaxSteps={knobs.pomMaxSteps}
        edgeInset={knobs.edgeInset}
        edgeFray={knobs.edgeFray}
        edgeSharpness={knobs.edgeSharpness}
        edgeDetail={knobs.edgeDetail}
        tileScale={knobs.tileScale}
        txHeight={knobs.txHeight}
        txAlbedo={knobs.txAlbedo}
        txRoughness={knobs.txRoughness}
        transmissionContrast={knobs.transmissionContrast}
        pixelScale={QUALITY_PRESETS[knobs.quality].pixelScale}
        meshCols={MESH_PRESETS[knobs.meshRes].cols}
        meshRows={MESH_PRESETS[knobs.meshRes].rows}
        breeze={knobs.breeze}
        skyMode={knobs.skyMode === "sky" ? 0 : 1}
        iterations={knobs.iterations}
        selfCollide={knobs.selfCollide}
        anisotropy={knobs.anisotropy}
      />
    </div>
  );
}
