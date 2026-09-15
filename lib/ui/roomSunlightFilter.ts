/** Display optics shared by the live fallback and offline rasterizer. The
 * transport PNGs remain untouched: this is display exposure, not ray energy. */
export const ROOM_SUNLIGHT_DISPLAY_SETTINGS = {
  bloom: 1,
  softness: 1,
  edgeBlurPx: 4,
  workingPaddingPx: 128,
  outputCrop: "source-bounds",
} as const;

/** IDs are internal, never user HTML. Keep the bake and adjustable study on
 * exactly the same filter graph, including the original filter bounds. */
export function roomSunlightFilterMarkup(id: string, bloom = 1): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) throw new Error("Invalid sunlight filter ID");
  const strength = Number.isFinite(bloom) ? Math.min(1, Math.max(0, bloom)) : 1;
  return `<filter id="${id}" x="-10%" y="-22%" width="120%" height="144%" color-interpolation-filters="sRGB">
    <feComponentTransfer in="SourceGraphic" result="direct"><feFuncA type="linear" slope="2.85" intercept="0" /></feComponentTransfer>
    <feComponentTransfer in="direct" result="highlights"><feFuncA type="linear" slope="2" intercept="-1" /></feComponentTransfer>
    <feFlood flood-color="#fff1cf" result="scatter-color" />
    <feComposite in="scatter-color" in2="highlights" operator="in" result="scatter" />
    <feGaussianBlur in="scatter" stdDeviation="6" result="near-scatter" />
    <feComponentTransfer in="near-scatter" result="near-bloom"><feFuncA type="linear" slope="${strength * 1.1}" /></feComponentTransfer>
    <feGaussianBlur in="scatter" stdDeviation="32" result="wide-scatter" />
    <feComponentTransfer in="wide-scatter" result="wide-bloom"><feFuncA type="linear" slope="${strength * 1.25}" /></feComponentTransfer>
    <feMerge><feMergeNode in="wide-bloom" /><feMergeNode in="near-bloom" /><feMergeNode in="direct" /></feMerge>
  </filter>`;
}
