import type { MaterialPreset } from "../presets/types";
import { paramSig } from "./knobs";
import { readMaterialEditRecovery, type MaterialEditSource } from "./materialEditRecovery";
import { roomMaterialPreset } from "./roomMaterialPreset";

/** Preserve an existing edit session across the room's built-in silk coverage
 * correction. The unmodified vault seed proves the old source; ordinary stale
 * or replaced material recovery still follows the strict shared parser. */
export function readRoomMaterialEditRecovery(
  json: string | null,
  expectedSource: MaterialEditSource,
  vaultPreset?: MaterialPreset,
) {
  const current = readMaterialEditRecovery(json, expectedSource);
  if (current || !vaultPreset) return current;

  const adapted = roomMaterialPreset(vaultPreset);
  if (
    adapted === vaultPreset ||
    adapted.slug !== expectedSource.materialId ||
    adapted.pkgHash !== expectedSource.pkgHash ||
    paramSig(adapted.fabricId, adapted.metalness, adapted.knobs) !==
      paramSig(expectedSource.fabricId, expectedSource.metalness, expectedSource.knobs)
  ) return null;

  const previous = readMaterialEditRecovery(json, {
    ...expectedSource,
    knobs: vaultPreset.knobs,
  });
  if (!previous) return null;

  // Only the protected comparison source changes. The user's current values,
  // undo and redo snapshots remain exact, even if they include legacy alpha.
  return Object.freeze({
    ...previous,
    baseline: Object.freeze({ ...expectedSource.knobs }),
  });
}
