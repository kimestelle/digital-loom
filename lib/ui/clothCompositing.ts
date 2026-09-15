/** Coverage, not fiber backlighting, determines whether a sheet needs alpha
 * blending. Be exact: even a small authored opening or unfinished fade must
 * retain the transparent, two-sided path. Frayed edges use discard in either
 * path and do not require blending. */
export function clothNeedsBlending(
  alphaFromDensity: number,
  alphaBoost: number,
  fade: number,
  materialReveal: number,
  launchProgress: number,
): boolean {
  return !(alphaFromDensity === 0 && alphaBoost === 0 && fade === 1 &&
    materialReveal === 1 && launchProgress === 1);
}
