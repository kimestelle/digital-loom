"use client";

// ─── weaveDiagram.tsx ─────────────────────────────────────────────────────────
// Tiny SVG interlacing diagrams for the weave picker. Each drawing is a
// truthful cartoon of the fabric's actual weaveType (FabricCore.weaveType):
//   plain — over-under checkerboard; thread count + yarn width vary per
//           fabric so fine silk, open ramie, and coarse hemp read distinctly
//   twill — the diagonal wale (denim)
//   knit  — columns of interlocking stockinette loops (jersey)
// Drawn in currentColor so the tiles theme with the panel.

import type { WeaveType } from "@/lib/cloth/fabricCore";

export interface WeaveDiagramProps {
  type: WeaveType;
  /** Threads per side for woven types. More = finer cloth. */
  threads?: number;
  /** Yarn width as a fraction of the cell (0..1). Fatter = coarser yarn. */
  yarn?: number;
}

const SIZE = 48;

function PlainWeave({ threads = 5, yarn = 0.55 }: Required<Omit<WeaveDiagramProps, "type">>) {
  const cell = SIZE / threads;
  const w = cell * yarn;
  const off = (cell - w) / 2;
  const warps: React.ReactNode[] = [];
  const wefts: React.ReactNode[] = [];
  const overs: React.ReactNode[] = [];
  for (let i = 0; i < threads; i++) {
    warps.push(
      <rect key={`w${i}`} x={i * cell + off} y={0} width={w} height={SIZE} opacity={0.4} />,
    );
    wefts.push(
      <rect key={`f${i}`} x={0} y={i * cell + off} width={SIZE} height={w} opacity={0.7} />,
    );
  }
  // Re-draw warp segments on the cells where warp passes over weft — this is
  // what makes it read as interlacing rather than a grid.
  for (let i = 0; i < threads; i++) {
    for (let j = 0; j < threads; j++) {
      if ((i + j) % 2 !== 0) continue;
      overs.push(
        <rect
          key={`o${i}-${j}`}
          x={i * cell + off}
          y={j * cell + off - 1}
          width={w}
          height={w + 2}
          opacity={0.95}
        />,
      );
    }
  }
  return (
    <>
      {warps}
      {wefts}
      {overs}
    </>
  );
}

function TwillWeave() {
  // Parallel diagonal wales — the denim signature. Two opacities alternate so
  // the ridges read as raised warp over dipped weft.
  const lines: React.ReactNode[] = [];
  const spacing = 8;
  for (let k = -7; k <= 7; k++) {
    lines.push(
      <line
        key={k}
        x1={k * spacing}
        y1={SIZE + 4}
        x2={k * spacing + SIZE + 8}
        y2={-4}
        strokeWidth={4}
        opacity={k % 2 === 0 ? 0.9 : 0.4}
      />,
    );
  }
  return <g stroke="currentColor" strokeLinecap="round">{lines}</g>;
}

function KnitWeave() {
  // Stockinette: columns of interlocking V loops. Each V dips into the row
  // below, which is what makes knit read as loops rather than zigzag.
  const loops: React.ReactNode[] = [];
  const cols = 4;
  const rows = 4;
  const cw = SIZE / cols;
  const rh = SIZE / rows;
  for (let j = 0; j < rows + 1; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cw;
      const y = j * rh - rh * 0.35;
      loops.push(
        <path
          key={`${i}-${j}`}
          d={`M ${x + cw * 0.12} ${y}
              C ${x + cw * 0.32} ${y + rh * 0.55}, ${x + cw * 0.42} ${y + rh * 0.9}, ${x + cw * 0.5} ${y + rh * 0.9}
              C ${x + cw * 0.58} ${y + rh * 0.9}, ${x + cw * 0.68} ${y + rh * 0.55}, ${x + cw * 0.88} ${y}`}
          fill="none"
          strokeWidth={2.6}
          opacity={j % 2 === 0 ? 0.85 : 0.55}
        />,
      );
    }
  }
  return <g stroke="currentColor" strokeLinecap="round">{loops}</g>;
}

export function WeaveDiagram({ type, threads = 5, yarn = 0.55 }: WeaveDiagramProps) {
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      aria-hidden="true"
      fill="currentColor"
      className="weave-diagram"
    >
      {type === "twill" ? (
        <TwillWeave />
      ) : type === "knit" ? (
        <KnitWeave />
      ) : (
        // satin shares the plain renderer for now — no satin preset exists.
        <PlainWeave threads={threads} yarn={yarn} />
      )}
    </svg>
  );
}
