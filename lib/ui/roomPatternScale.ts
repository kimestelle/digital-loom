/** A phone's smaller specimen needs a larger visible repeat. This is a view
 * adjustment only: authored repeats, undo history, saves and exports stay in
 * material space. Match the room's responsive CSS breakpoint. */
export const ROOM_NARROW_MEDIA = "(max-width: 820px)";
export const ROOM_NARROW_PATTERN_MAGNIFICATION = 1.5;

export function roomPreviewTileScale(authoredRepeats: number, narrow: boolean): number {
  return authoredRepeats / (narrow ? ROOM_NARROW_PATTERN_MAGNIFICATION : 1);
}
