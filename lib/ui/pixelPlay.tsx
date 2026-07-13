"use client";

// ─── pixelPlay.tsx ────────────────────────────────────────────────────────────
// A drop-in companion pixel for the gray buttons and pickers — kin to the
// header's mode orb. One dye-colored pixel lives on each host surface:
//
//   · idle, it orbits the selected option (any child with data-active or
//     data-pressed; the whole host if nothing is selected),
//   · on hover it chases the pointer, trailing a few fading cells,
//   · every few seconds — and whenever the selection changes — it bursts
//     into a cross of four pixels with an empty center, then re-forms.
//
// Each pixel holds ONE color at rest (seeded from its section's data-dye) and
// mirrors it onto the host's --cat, so category-tinted text (the tuning tab
// labels) reads the exact same color. Only a hover enter/exit pop re-dyes it
// to a random other vat, cross-fading pixel and text together.
//
// Deliberately cheap: a plain 2D canvas per host, all instances driven by one
// shared 30fps rAF ticker, a dozen fillRects per frame, no WebGL. Positions
// quantize to the pixel grid so it reads as chunky as the mode orb's thread.
//
// Usage: drop <PixelPlay /> as the first child of any pixel-play host
// (position: relative + isolation: isolate — see app/styles/pixelplay.css).
// The default "under" layer paints above the host's own gray background but
// below its label; layer="over" floats it above children, for container
// hosts like the weave picker whose tiles carry their own backgrounds.

import { useEffect, useRef } from "react";

export interface PixelPlayProps {
  /** CSS px per pixel-cell. */
  pixel?: number;
  /** "under": behind the host's content. "over": above it (container hosts). */
  layer?: "under" | "over";
  className?: string;
}

// Natural-dye pixels — exact RGB of the --dye-* tokens in tokens.css. A pixel
// keeps one color at rest (seeded from its section's data-dye); only a hover
// enter/exit pop re-dips it into a different random vat. Order matches
// DYE_NAMES so the seed can map a data-dye attribute to its index.
const DYES: ReadonlyArray<readonly [number, number, number]> = [
  [104, 152, 210], // indigo
  [206, 110, 88],  // madder
  [224, 182, 96],  // gardenia
  [198, 142, 94],  // persimmon
  [152, 172, 116], // mugwort
];
const DYE_NAMES = ["indigo", "madder", "gardenia", "persimmon", "mugwort"] as const;

const TRAIL = 10;
const BURST_S = 0.55; // seconds
const FRAME_MS = 32; // ~30fps

interface Anchor {
  cx: number; // center + half-extents, unit coords of the host
  cy: number;
  rx: number;
  ry: number;
}

interface Sub {
  ctx: CanvasRenderingContext2D;
  host: HTMLElement;
  pixel: number;
  dpr: number;
  w: number; // device px
  h: number;
  t: number;
  phase: number;
  pos: { x: number; y: number };
  mouse: { x: number; y: number };
  hover: boolean;
  trail: { x: number; y: number }[];
  burst: { t0: number; x: number; y: number; respawn: boolean } | null;
  /** When the pixel last (re)spawned — its head fades in from this instant. */
  born: number;
  nextBurst: number;
  /** Live color, eased toward colorTarget; mirrored to the host's --cat so
   *  category-tinted controls (the tuning tab text) track the pixel exactly. */
  color: [number, number, number];
  colorTarget: [number, number, number];
  targetIdx: number;
  /** True while the color is mid-fade — gates the per-frame --cat write. */
  colorDirty: boolean;
  anchor: Anchor;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function computeAnchor(s: Sub) {
  const hr = s.host.getBoundingClientRect();
  if (hr.width < 1 || hr.height < 1) return;
  const sel = s.host.querySelector('[data-active="true"], [data-pressed="true"]');
  // data-pressed lives on the host button itself, not a descendant.
  const el =
    sel ??
    (s.host.getAttribute("data-pressed") === "true" ? s.host : null);
  if (el) {
    const r = el.getBoundingClientRect();
    s.anchor = {
      cx: (r.left + r.width / 2 - hr.left) / hr.width,
      cy: (r.top + r.height / 2 - hr.top) / hr.height,
      rx: r.width / 2 / hr.width,
      ry: r.height / 2 / hr.height,
    };
  } else {
    s.anchor = { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 };
  }
}

function render(s: Sub) {
  const { ctx, w: W, h: H } = s;
  ctx.clearRect(0, 0, W, H);
  const cell = s.pixel * s.dpr;
  const r = Math.round(s.color[0]);
  const g = Math.round(s.color[1]);
  const b = Math.round(s.color[2]);

  // Snap a unit-coord point to the pixel grid and stamp a cell. Off-surface
  // points are skipped, not clamped — burst shards fly off the edge and vanish.
  const put = (ux: number, uy: number, alpha: number, scale = 1) => {
    const gx = Math.floor((ux * W) / cell);
    const gy = Math.floor((uy * H) / cell);
    if (gx < 0 || gy < 0 || gx > Math.floor(W / cell) - 1 || gy > Math.floor(H / cell) - 1) return;
    const inset = (cell * (1 - 0.9 * scale)) / 2;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.fillRect(gx * cell + inset, gy * cell + inset, cell - inset * 2, cell - inset * 2);
  };

  const n = s.trail.length;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    put(s.trail[i].x, s.trail[i].y, f * f * 0.35, 0.75 + 0.25 * f);
  }

  // The star: four pixels stepping outward cell by cell, center left empty;
  // the pixel re-forms there as the shards fade. A respawn burst keeps the
  // center empty for its whole run — the pixel is between lives.
  let headAlpha = 0.95;
  if (s.burst) {
    const u = (s.t - s.burst.t0) / BURST_S;
    if (u >= 1) {
      if (s.burst.respawn) {
        // Shards gone — respawn fresh at the anchor.
        s.pos.x = s.anchor.cx;
        s.pos.y = s.anchor.cy;
        s.born = s.t;
      }
      s.burst = null;
    } else {
      const o = 1 + 2.6 * (1 - (1 - u) * (1 - u)); // cells, ease-out
      const ba = Math.pow(1 - u, 1.4);
      const { x: bx, y: by } = s.burst;
      const ox = (o * cell) / W;
      const oy = (o * cell) / H;
      put(bx + ox, by, ba);
      put(bx - ox, by, ba);
      put(bx, by + oy, ba);
      put(bx, by - oy, ba);
      headAlpha = s.burst.respawn ? 0 : u < 0.5 ? 0 : (u - 0.5) * 2 * 0.95;
    }
  }
  // Freshly (re)spawned pixels fade in over ~0.3s.
  headAlpha *= Math.min(1, (s.t - s.born) / 0.3);
  if (headAlpha > 0.02) put(s.pos.x, s.pos.y, headAlpha);
}

class PixelEngine {
  private subs = new Set<Sub>();
  private raf = 0;
  private lastRender = 0;
  private reduced =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  add(sub: Sub) {
    this.subs.add(sub);
    if (!this.raf) {
      this.lastRender = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  remove(sub: Sub) {
    this.subs.delete(sub);
    if (this.subs.size === 0 && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  burstAt(s: Sub, x: number, y: number, respawn = false, recolor = false) {
    // Debounce so a click + the resulting selection change pop one star.
    // Respawn (exit) and recolor (enter/exit) pops always land.
    if (!respawn && !recolor && s.burst && s.t - s.burst.t0 < 0.3) return;
    s.burst = { t0: s.t, x, y, respawn };
    // Idle and selection-change bursts keep the color; only enter/exit re-dye.
    if (recolor) this.recolor(s);
    s.nextBurst = s.t + 3 + Math.random() * 4;
  }

  /** Retarget the pixel to a random dye other than its current one; the tick
   *  loop eases toward it, so the pixel and its --cat-tinted text cross-fade. */
  private recolor(s: Sub) {
    let idx = Math.floor(Math.random() * (DYES.length - 1));
    if (idx >= s.targetIdx) idx++; // uniform over the four other vats
    s.targetIdx = idx;
    s.colorTarget = [...DYES[idx]] as [number, number, number];
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    // No document.hidden gate — the browser already throttles rAF for hidden
    // tabs, and occluded-but-captured windows report hidden while still visible.
    if (now - this.lastRender < FRAME_MS) return;
    const dt = Math.min(0.1, this.lastRender ? (now - this.lastRender) / 1000 : 0.032);
    this.lastRender = now;
    const k = 1 - Math.exp(-dt * 7);

    const ck = 1 - Math.exp(-dt * 6); // color fade rate (~0.5s)

    for (const s of this.subs) {
      if (s.w < 2 || s.h < 2) continue; // collapsed/hidden host
      s.t += dt;

      // Ease the live color toward its target and mirror it onto the host's
      // --cat while it's still moving, so category text tracks the pixel
      // without a style write every idle frame.
      let moving = false;
      for (let i = 0; i < 3; i++) {
        const d = s.colorTarget[i] - s.color[i];
        if (Math.abs(d) > 0.4) {
          s.color[i] += d * ck;
          moving = true;
        } else {
          s.color[i] = s.colorTarget[i];
        }
      }
      if (moving) s.colorDirty = true;
      if (s.colorDirty) {
        const cr = Math.round(s.color[0]);
        const cg = Math.round(s.color[1]);
        const cb = Math.round(s.color[2]);
        s.host.style.setProperty("--cat", `rgb(${cr}, ${cg}, ${cb})`);
        if (!moving) s.colorDirty = false; // final write done; go quiet
      }

      const cellX = (s.pixel * s.dpr) / s.w;
      const cellY = (s.pixel * s.dpr) / s.h;
      const a = s.anchor;

      if (this.reduced?.matches) {
        // Reduced motion: the pixel simply marks the selection (or pointer).
        s.pos.x = s.hover ? s.mouse.x : a.cx;
        s.pos.y = s.hover ? s.mouse.y : a.cy;
        s.trail.length = 0;
        s.burst = null;
      } else if (s.burst?.respawn) {
        // Between lives: frozen where it popped while the shards fly.
        s.trail.length = 0;
      } else {
        let tx: number;
        let ty: number;
        if (s.hover) {
          tx = s.mouse.x;
          ty = s.mouse.y;
        } else {
          // Idle: loop around the selected option, slightly outside its
          // bounds, with incommensurate x/y rates so the path never repeats.
          const th = s.t * 0.8 + s.phase;
          tx = a.cx + (a.rx * 0.8 + cellX) * Math.cos(th);
          ty = a.cy + (a.ry * 0.8 + cellY) * Math.sin(th * 1.37 + s.phase);
        }
        tx = clamp(tx, cellX * 0.5, 1 - cellX * 0.5);
        ty = clamp(ty, cellY * 0.5, 1 - cellY * 0.5);
        s.pos.x += (tx - s.pos.x) * k;
        s.pos.y += (ty - s.pos.y) * k;
        s.trail.push({ x: s.pos.x, y: s.pos.y });
        if (s.trail.length > TRAIL) s.trail.shift();
        if (s.t >= s.nextBurst) this.burstAt(s, s.pos.x, s.pos.y);
      }
      render(s);
    }
  };
}

let engine: PixelEngine | null = null;
let seedCounter = 0;

/** Wire a target canvas into the shared ticker. Returns a detach fn. */
function attach(el: HTMLCanvasElement, pixel: number): (() => void) | undefined {
  const ctx = el.getContext("2d");
  const host = el.parentElement;
  if (!ctx || !host) return undefined;
  engine ??= new PixelEngine();
  const eng = engine;

  // Seed the resting color from the nearest section's data-dye so the pixel
  // and its text start on the category color; -1 → indigo.
  const dyeName = host.closest("[data-dye]")?.getAttribute("data-dye") ?? "";
  const seedIdx = Math.max(0, (DYE_NAMES as readonly string[]).indexOf(dyeName));
  const seed = [...DYES[seedIdx]] as [number, number, number];
  host.style.setProperty("--cat", `rgb(${seed[0]}, ${seed[1]}, ${seed[2]})`);

  const sub: Sub = {
    ctx,
    host,
    pixel,
    dpr: Math.min(2, window.devicePixelRatio || 1),
    w: 0,
    h: 0,
    t: 0,
    // Golden-ratio stride de-phases sibling orbits.
    phase: ((seedCounter++ * 0.618034) % 1) * Math.PI * 2,
    pos: { x: 0.5, y: 0.5 },
    mouse: { x: 0.5, y: 0.5 },
    hover: false,
    trail: [],
    burst: null,
    born: 0,
    nextBurst: 1.5 + Math.random() * 4,
    color: [...seed] as [number, number, number],
    colorTarget: seed,
    targetIdx: seedIdx,
    colorDirty: false,
    anchor: { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 },
  };

  const measure = () => {
    sub.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = host.getBoundingClientRect();
    const w = Math.round(r.width * sub.dpr);
    const h = Math.round(r.height * sub.dpr);
    if (w !== sub.w || h !== sub.h) {
      sub.w = w;
      sub.h = h;
      if (w > 0 && h > 0) {
        el.width = w;
        el.height = h;
      }
    }
    computeAnchor(sub);
  };
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(host);

  // Selection changes re-anchor the orbit and pop a star at the new choice.
  const mo = new MutationObserver(() => {
    computeAnchor(sub);
    eng.burstAt(sub, sub.anchor.cx, sub.anchor.cy);
  });
  mo.observe(host, {
    attributes: true,
    subtree: true,
    attributeFilter: ["data-active", "data-pressed"],
  });

  const toUnit = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      sub.mouse.x = clamp((e.clientX - r.left) / r.width, 0, 1);
      sub.mouse.y = clamp((e.clientY - r.top) / r.height, 0, 1);
    }
  };
  const onEnter = (e: PointerEvent) => {
    sub.hover = true;
    toUnit(e);
    // Pop where it idled and re-dye — both pixel and text fade to a new color.
    eng.burstAt(sub, sub.pos.x, sub.pos.y, false, true);
  };
  const onMove = (e: PointerEvent) => {
    sub.hover = true;
    toUnit(e);
  };
  const onLeave = () => {
    sub.hover = false;
    // The pixel dies right where it stands the instant feedback cuts off,
    // re-dyes, then respawns at its anchor in the new color.
    eng.burstAt(sub, sub.pos.x, sub.pos.y, true, true);
  };
  const onDown = (e: PointerEvent) => {
    toUnit(e);
    eng.burstAt(sub, sub.mouse.x, sub.mouse.y);
  };
  host.addEventListener("pointerenter", onEnter);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("pointerdown", onDown);

  eng.add(sub);
  return () => {
    ro.disconnect();
    mo.disconnect();
    host.removeEventListener("pointerenter", onEnter);
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerleave", onLeave);
    host.removeEventListener("pointerdown", onDown);
    eng.remove(sub);
  };
}

// ── component ────────────────────────────────────────────────────────────────

export function PixelPlay({ pixel = 5, layer = "under", className }: PixelPlayProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attach(el, pixel);
  }, [pixel]);

  const cls = [
    "pixel-play",
    layer === "over" ? "pixel-play-over" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return <canvas ref={ref} className={cls} aria-hidden="true" />;
}
