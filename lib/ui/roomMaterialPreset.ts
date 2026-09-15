import type { MaterialPreset } from "../presets/types";
import type { FabricKnobs } from "./knobs";

const RED_SILK_HASH = "71871d958aa681541baf9159cbf98bc4";

/** An explicit openness edit updates alpha coverage, not the density mix or
 * strength of fiber backlighting. Returning to the original open area must
 * not silently reset either independently authored material value. */
export function roomOpennessCoverageFields(
  openness: number,
): Pick<FabricKnobs, "alphaFromDensity"> {
  const raw = Math.min(1, Math.max(0, openness));
  const effective = Math.pow(raw, 3);
  return {
    alphaFromDensity: 0.1 * effective,
  };
}

/** Adapt only the committed silk specimen's old coverage settings to the
 * room. Fiber backlighting is independent from seeing the backdrop through
 * the cloth, so retain its transmission/density and remove only alpha loss.
 *
 * Apply after the library merge, not in the renderer: drafts, comparisons,
 * copies and exports must all use the same actual material values. Do not
 * write the adapted baseline into the shared vault or server seed; the
 * original route still owns their historical rendering behavior. */
export function roomMaterialPreset(preset: MaterialPreset): MaterialPreset {
  const k = preset.knobs;
  if (
    preset.builtIn !== true ||
    preset.version !== 1 ||
    preset.slug !== RED_SILK_HASH ||
    preset.pkgHash !== RED_SILK_HASH ||
    k.openness !== 0 ||
    k.translucency !== 0.48 ||
    k.densityAmount !== 0.76 ||
    k.alphaFromDensity !== 0.048 ||
    k.alphaBoost !== 0 ||
    k.alphaBoostSource !== 1 ||
    k.txHeight !== 1 ||
    k.txAlbedo !== 1 ||
    k.txRoughness !== 0.94 ||
    k.transmissionContrast !== 0.3
  ) {
    return preset;
  }
  return { ...preset, knobs: { ...k, alphaFromDensity: 0 } };
}
