"use client";

// ─── modeButton.tsx ───────────────────────────────────────────────────────────
// The header's stage-mode toggle, drawn as a single bright pixel trailing
// through the orb. In cloth mode the pixel is a weft thread, serpentining
// over and under unseen warps; in object mode it orbits, wrapping an unseen
// form. Hovering previews the morph partway toward the other mode before you
// commit — clicking completes it. Rendered on a small 2D canvas quantized to
// a chunky pixel grid so it reads as kin to the PixelPlay companion pixels.

import { useCallback, useEffect, useRef } from "react";

export type ModeButtonProps = {
  mode?: "cloth" | "object";
  onMode?: (m: "cloth" | "object") => void;
};

const SIZE = 40; // css px — matches .mode-orb
const CELL = 5;  // css px per cell — same resolution as the PixelPlay pixels
const GRID = SIZE / CELL;
const TRAIL = 26; // trail length in samples (~0.4s at 60fps)

// Thread colors: jjok-indigo weft for cloth, plain white for object (the UI
// accent — the old warm gold left with the rest of the subtle yellow).
const CLOTH_RGB = [122, 158, 199] as const;
const OBJECT_RGB = [238, 236, 231] as const;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Pt {
  x: number;
  y: number;
  depth: number; // 0 far side · 1 front — modulates trail alpha
}

// Cloth: a weft pixel serpentining over/under warps as it sweeps side to side.
// The undulation is keyed to horizontal travel (not time) so it reads as
// interlacing rather than bobbing; a slow secondary sine drifts the row.
function clothPath(t: number): Pt {
  const sweep = Math.sin(t * 1.1);
  return {
    x: 0.5 + 0.33 * sweep,
    y: 0.5 + 0.16 * Math.sin(sweep * Math.PI * 2.5) + 0.05 * Math.sin(t * 0.43),
    depth: 1,
  };
}

// Object: an orbit wrapping an unseen form. The tilt breathes slowly and
// depth follows the near/far side of the loop so the trail dims "behind".
function objectPath(t: number): Pt {
  const th = t * 1.5;
  const tilt = 0.42 + 0.14 * Math.sin(t * 0.31);
  return {
    x: 0.5 + 0.32 * Math.cos(th),
    y: 0.5 + 0.32 * tilt * Math.sin(th),
    depth: 0.55 + 0.45 * Math.sin(th),
  };
}

function sample(t: number, m: number): Pt {
  const c = clothPath(t);
  const o = objectPath(t);
  return {
    x: lerp(c.x, o.x, m),
    y: lerp(c.y, o.y, m),
    depth: lerp(c.depth, o.depth, m),
  };
}

interface AnimState {
  morph: number;   // 0 cloth · 1 object (eased)
  hover: number;   // eased 0..1
  hoverOn: boolean;
  t: number;
  trail: Pt[];
  raf: number;
  last: number;
}

function draw(cv: HTMLCanvasElement, s: AnimState) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const px = cv.width;
  const cell = px / GRID;
  const m = smooth(clamp01(s.morph));
  ctx.clearRect(0, 0, px, px);

  const cellRect = (x: number, y: number, scale = 1) => {
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(x * GRID)));
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor(y * GRID)));
    const inset = (cell * (1 - 0.86 * scale)) / 2;
    ctx.fillRect(gx * cell + inset, gy * cell + inset, cell - inset * 2, cell - inset * 2);
  };

  // Ghost scaffolds cross-fading with the morph: warp threads for cloth,
  // a dotted wrap-ring for object. These are what the pixel weaves through
  // and orbits around — they make the two destinations legible mid-morph.
  const warpA = (1 - m) * 0.22;
  if (warpA > 0.02) {
    ctx.fillStyle = `rgba(${CLOTH_RGB[0]}, ${CLOTH_RGB[1]}, ${CLOTH_RGB[2]}, ${warpA})`;
    for (let i = 1; i <= 3; i++) {
      const gx = (i * GRID) / 4 / GRID + 0.001;
      for (let gy = 1; gy < GRID; gy += 2) {
        cellRect(gx, (gy + 0.5) / GRID, 0.5);
      }
    }
  }
  const ringA = m * 0.22;
  if (ringA > 0.02) {
    ctx.fillStyle = `rgba(${OBJECT_RGB[0]}, ${OBJECT_RGB[1]}, ${OBJECT_RGB[2]}, ${ringA})`;
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2;
      cellRect(0.5 + 0.32 * Math.cos(th), 0.5 + 0.32 * 0.42 * Math.sin(th), 0.5);
    }
  }

  // Trail — oldest to newest, alpha ramping up, dimmed on the far side.
  const r = Math.round(lerp(CLOTH_RGB[0], OBJECT_RGB[0], m));
  const g = Math.round(lerp(CLOTH_RGB[1], OBJECT_RGB[1], m));
  const b = Math.round(lerp(CLOTH_RGB[2], OBJECT_RGB[2], m));
  const n = s.trail.length;
  for (let i = 0; i < n; i++) {
    const p = s.trail[i];
    const f = (i + 1) / n;
    const a = f * f * (0.2 + 0.8 * p.depth);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    cellRect(p.x, p.y, 0.75 + 0.25 * f);
  }

  // Head pixel — lifted toward white so it reads as the live thread-end.
  const head = s.trail[n - 1];
  if (head) {
    const hr = Math.round(lerp(r, 255, 0.55));
    const hg = Math.round(lerp(g, 255, 0.55));
    const hb = Math.round(lerp(b, 255, 0.55));
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.55 + 0.45 * head.depth})`;
    cellRect(head.x, head.y, 1);
  }
}

// Reduced motion: no animation loop — build the trail by sampling the path
// backwards from a fixed instant and draw a single still that updates only
// on mode change / hover.
function drawStatic(cv: HTMLCanvasElement, mode: "cloth" | "object", hover: boolean) {
  const base = mode === "object" ? 1 : 0;
  const morph = base + (hover ? 1 : 0) * (base === 0 ? 0.45 : -0.45);
  const m = smooth(clamp01(morph));
  const t0 = 5.2; // an instant where both paths pose nicely
  const trail: Pt[] = [];
  for (let i = 0; i < TRAIL; i++) {
    trail.push(sample(t0 - (TRAIL - 1 - i) * 0.033, m));
  }
  draw(cv, { morph, hover: hover ? 1 : 0, hoverOn: hover, t: t0, trail, raf: 0, last: 0 });
}

export default function ModeButton({ mode = "cloth", onMode }: ModeButtonProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const st = useRef<AnimState>({
    morph: mode === "object" ? 1 : 0,
    hover: 0,
    hoverOn: false,
    t: 0,
    trail: [],
    raf: 0,
    last: 0,
  });
  const modeRef = useRef(mode);
  const reducedRef = useRef(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = Math.round(SIZE * dpr);
    const s = st.current;

    reducedRef.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedRef.current) {
      drawStatic(cv, modeRef.current, s.hoverOn);
      return;
    }

    const frame = (now: number) => {
      s.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, s.last ? (now - s.last) / 1000 : 0.016);
      s.last = now;

      // Hover previews the transition: the morph target leans 45% toward the
      // other mode while the pointer rests on the orb; clicking completes it.
      const k = 1 - Math.exp(-dt * 7);
      s.hover += ((s.hoverOn ? 1 : 0) - s.hover) * k;
      const base = modeRef.current === "object" ? 1 : 0;
      const target = base + s.hover * (base === 0 ? 0.45 : -0.45);
      s.morph += (target - s.morph) * (1 - Math.exp(-dt * 5));

      // The thread also quickens under attention.
      s.t += dt * (1 + s.hover * 0.9);
      s.trail.push(sample(s.t, smooth(clamp01(s.morph))));
      if (s.trail.length > TRAIL) s.trail.shift();
      draw(cv, s);
    };
    s.raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(s.raf);
  }, []);

  // Reduced-motion stills refresh on mode change.
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv && reducedRef.current) drawStatic(cv, mode, st.current.hoverOn);
  }, [mode]);

  const setHover = useCallback((on: boolean) => {
    st.current.hoverOn = on;
    const cv = canvasRef.current;
    if (cv && reducedRef.current) drawStatic(cv, modeRef.current, on);
  }, []);

  return (
    <button
      type="button"
      className={`mode-orb absolute left-1/2 -translate-x-1/2 ${mode === "cloth" ? "rounded-md" : "rounded-full"}`}
      data-mode={mode}
      aria-label={
        mode === "cloth"
          ? "cloth stage — switch to object"
          : "object stage — switch to cloth"
      }
      title={mode === "cloth" ? "cloth · tap for object" : "object · tap for cloth"}
      onClick={() => onMode?.(mode === "cloth" ? "object" : "cloth")}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <canvas ref={canvasRef} className="mode-orb-canvas" aria-hidden="true" />
    </button>
  );
}
