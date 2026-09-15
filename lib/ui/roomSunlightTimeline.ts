/** Only adjacent optical samples participate in a daylight interval. */
export interface RoomSunlightInterval {
  lowerIndex: number;
  upperIndex: number;
  lowerWeight: number;
  upperWeight: number;
}

/**
 * Select a bounded pair without extrapolating or wrapping the dawn/dusk frame.
 * The caller projects both samples into the current light direction before
 * blending, so their window edges stay registered while the optics change.
 * These weights do not include solar intensity; the room light owns that.
 */
export function resolveRoomSunlightInterval(
  frames: readonly { pathPosition: number }[],
  position: number,
): RoomSunlightInterval | null {
  if (!frames.length || !Number.isFinite(position)) return null;
  for (let index = 0; index < frames.length; index++) {
    const value = frames[index].pathPosition;
    if (!Number.isFinite(value) || value < 0 || value > 1
      || (index > 0 && value <= frames[index - 1].pathPosition)) return null;
  }

  const exact = (index: number): RoomSunlightInterval => ({
    lowerIndex: index,
    upperIndex: index,
    lowerWeight: 1,
    upperWeight: 0,
  });
  if (position <= frames[0].pathPosition) return exact(0);
  for (let upperIndex = 1; upperIndex < frames.length; upperIndex++) {
    const upperPosition = frames[upperIndex].pathPosition;
    if (position === upperPosition) return exact(upperIndex);
    if (position < upperPosition) {
      const lowerIndex = upperIndex - 1;
      const lowerPosition = frames[lowerIndex].pathPosition;
      const upperWeight = (position - lowerPosition) / (upperPosition - lowerPosition);
      return { lowerIndex, upperIndex, lowerWeight: 1 - upperWeight, upperWeight };
    }
  }
  return exact(frames.length - 1);
}
