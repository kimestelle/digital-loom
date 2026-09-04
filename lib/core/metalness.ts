/** Resolve the authored scalar that gates a metalness map in every renderer
 * and export path. An empty legacy/UI value means "use the map as authored";
 * an explicit numeric zero remains zero so imported materials round-trip. */
export function resolveMetalnessAmount(
  input: string | number,
  hasMap: boolean,
): number {
  if (typeof input === "string" && input.trim() === "") {
    return hasMap ? 1 : 0;
  }
  const parsed = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}
