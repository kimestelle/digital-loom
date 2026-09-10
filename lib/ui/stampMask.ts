// ─── stampMask.ts ─────────────────────────────────────────────────────────────
// Single source of truth for the frayed-stamp silhouette: a turbulence-
// displaced rect (the fray) bitten by straight rows of machine-punched
// perforation holes. The swatch archive consumes it as a CSS mask via the
// --stamp-mask custom property.

const HOLE_STOPS = [5, 17, 30, 43, 57, 70, 83, 95];

const holes = [
  ...HOLE_STOPS.map((x) => `<circle cx='${x}' cy='5' r='3'/>`),
  ...HOLE_STOPS.map((x) => `<circle cx='${x}' cy='95' r='3'/>`),
  ...HOLE_STOPS.slice(1, -1).map((y) => `<circle cx='5' cy='${y}' r='3'/>`),
  ...HOLE_STOPS.slice(1, -1).map((y) => `<circle cx='95' cy='${y}' r='3'/>`),
].join("");

const STAMP_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' ` +
  `width='256' height='256' preserveAspectRatio='none'>` +
  `<defs>` +
  `<filter id='f' x='-15%' y='-15%' width='130%' height='130%'>` +
  `<feTurbulence type='fractalNoise' baseFrequency='0.14' numOctaves='2' seed='11'/>` +
  `<feDisplacementMap in='SourceGraphic' scale='7'/>` +
  `</filter>` +
  `<mask id='m'><rect width='100' height='100' fill='white'/>` +
  `<g fill='black'>${holes}</g></mask>` +
  `</defs>` +
  `<g mask='url(#m)'>` +
  `<rect x='5' y='5' width='90' height='90' fill='white' filter='url(#f)'/>` +
  `</g></svg>`;

export const STAMP_MASK_URI = `data:image/svg+xml,${encodeURIComponent(STAMP_SVG)}`;
