"use client";

// ─── landing/page.tsx ─────────────────────────────────────────────────────────
// The marketing page for digital loom.
//
// It lives inside the app rather than in a separate marketing repo for one
// reason: the hero is not a video of the product, it's the product. <FabricViewer>
// is the same embeddable component documented on /viewer, running the same CPU
// XPBD solver and the same TSL shaders the studio uses. A recording of cloth is
// a claim; cloth you can push with your cursor is evidence.
//
// Everything stated here is checked against the codebase — the solver is XPBD on
// the CPU (not GPU), maps are albedo/normal/roughness/metalness/height, extraction
// is fal.ai Patina, and the only gated feature is a fresh extraction from a new
// photo. No invented benchmarks, no invented users.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  MAP_ORDER,
  type MapName,
  type MaterialPackage,
} from "@/lib/core/materialPackage";
import "../styles/landing.css";

// The viewer pulls in three/webgpu and the whole solver — it must never touch
// the server render, and it shouldn't sit in the initial bundle either.
const FabricViewer = dynamic(() => import("@/lib/ui/fabricViewer"), {
  ssr: false,
  loading: () => <div className="lp-stage-fallback">hanging the cloth…</div>,
});

/* ── content ────────────────────────────────────────────────────────────────
   Copy is lifted from the product's own language where it exists: the nav
   tagline ("fabric material instrument"), the README one-liner, and the
   workshop's plain-language map hints. The voice is all-lowercase for labels,
   sentence case for prose — same as the studio. */

const SEQ_BASE = "/api/samples/sage-linen";

type SeqMap = { name: MapName | "source"; file: string; label: string };

const SEQ: SeqMap[] = [
  { name: "albedo", file: "albedo.png", label: "albedo" },
  { name: "normal", file: "normal.png", label: "normal" },
  { name: "roughness", file: "roughness.png", label: "roughness" },
  { name: "height", file: "height.png", label: "height" },
  { name: "metalness", file: "metalness.png", label: "metalness" },
];

const MAP_DEFS: { name: string; body: string }[] = [
  {
    name: "albedo",
    body:
      "Pure colour with the lighting taken out — the photograph's own highlights and shadows removed, so the shader can relight it from any angle.",
  },
  {
    name: "normal",
    body: "Which way each thread faces. This is what makes a flat tile catch light like a weave.",
  },
  {
    name: "roughness",
    body: "Matte against shiny, per pixel. The difference between dry linen and a silk that throws a sheen.",
  },
  {
    name: "height",
    body:
      "Raised threads against valleys. Driven through real parallax occlusion mapping, so the weave holds its depth at a grazing angle instead of flattening out.",
  },
  {
    name: "metalness",
    body: "Where the surface is metal. Mostly empty for cloth, and the reason sequins and foils survive the trip.",
  },
];

const SPECIMENS: { dir: string; name: string; prompt: string; src: string }[] = [
  {
    dir: "sage-linen",
    name: "sage linen",
    prompt: "sage green linen",
    src: "source.jpg",
  },
  {
    dir: "teal-tweed",
    name: "teal tweed",
    prompt: "teal tweed upholstery weave",
    src: "source.png",
  },
  {
    dir: "teapot-print",
    name: "teapot print",
    prompt: "silk printed with teacups and teapots",
    src: "source.png",
  },
];

const FABRICS: {
  ko: string;
  roman: string;
  en: string;
  gsm: number;
  weave: string;
}[] = [
  { ko: "명주", roman: "myeongju", en: "silk", gsm: 60, weave: "plain" },
  { ko: "모시", roman: "mosi", en: "ramie", gsm: 80, weave: "plain" },
  { ko: "무명", roman: "mumyeong", en: "cotton", gsm: 150, weave: "plain" },
  { ko: "저지", roman: "jeoji", en: "cotton jersey", gsm: 180, weave: "knit" },
  { ko: "삼베", roman: "sambe", en: "hemp", gsm: 200, weave: "plain" },
  { ko: "데님", roman: "denim", en: "denim twill", gsm: 400, weave: "twill" },
];

const CONSTRAINTS: { name: string; note: string; dye: string }[] = [
  { name: "warp", note: "lengthwise grain", dye: "var(--dye-indigo)" },
  { name: "weft", note: "crosswise", dye: "var(--dye-madder)" },
  { name: "shear", note: "the 45° bias", dye: "var(--dye-gardenia)" },
  { name: "bend", note: "resistance to folding", dye: "var(--dye-mugwort)" },
];

// Phase captions for the scroll sequence, keyed to progress bands.
const PHASES: { title: string; sub: string }[] = [
  {
    title: "You start with a photograph.",
    sub: "One image. A scrap of linen on a table, shot on a phone.",
  },
  {
    title: "Patina factors it into maps.",
    sub: "The photo is separated into the channels a renderer actually needs — colour, direction, sheen, depth, metal.",
  },
  {
    title: "Each map answers one question.",
    sub: "Together they describe a surface completely enough to relight it from any angle, at any scale, under any lamp.",
  },
  {
    title: "Then it becomes cloth.",
    sub: "The maps hang on a simulated weave with its own weight, drape and grain. Not a picture of fabric — fabric.",
  },
];

/* ── easing helpers ─────────────────────────────────────────────────────── */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Normalise v from [a,b] into [0,1], clamped. */
const span = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
/** Smoothstep — the sequence's only easing, so every card shares one hand. */
const ease = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/* ── page ───────────────────────────────────────────────────────────────── */

export default function Landing() {
  const [pkg, setPkg] = useState<MaterialPackage | null>(null);
  const [phase, setPhase] = useState(0);
  const [stuck, setStuck] = useState(false);
  const [drawn, setDrawn] = useState(false);

  const stickyRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const sourceRef = useRef<HTMLElement | null>(null);
  const cueRef = useRef<HTMLDivElement | null>(null);
  const phaseRef = useRef(0);

  /* Load the bundled pregen silk so the hero has a real material on it with no
     network dependency on the extraction cache. If it's missing, FabricViewer
     falls back to the base fabric's own textures — the cloth still hangs. */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/pregen/silk-sample/manifest.json");
        if (!r.ok) return;
        const m = (await r.json()) as {
          maps: { name: string; file: string }[];
          hash?: string;
        };
        const p: MaterialPackage = {
          id: m.hash ?? "pregen",
          maps: {},
          params: {},
          meta: {
            fabricName: "silk-sample",
            createdAt: new Date().toISOString(),
          },
        };
        for (const mp of m.maps) {
          if (!(MAP_ORDER as readonly string[]).includes(mp.name)) continue;
          p.maps[mp.name as MapName] = {
            name: mp.name as MapName,
            url: `/pregen/silk-sample/${mp.file}`,
            provenance: "patina",
          };
        }
        if (alive) setPkg(p);
      } catch {
        /* pregen absent — the viewer's own fallback covers this */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* Headline underline draws itself once, a beat after paint. */
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 90);
    return () => clearTimeout(t);
  }, []);

  /* ── the scroll sequence ───────────────────────────────────────────────────
     Progress is derived from the sticky container's own position, so it stays
     correct regardless of viewport height, and written straight to CSS custom
     properties inside a rAF. No React state per frame: a re-render at 60fps
     while a cloth simulation is running is how a landing page starts to stutter.
     Only the phase caption — which changes four times in total — goes through
     state. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    let raf = 0;
    let queued = false;

    const paint = () => {
      queued = false;
      const el = stickyRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      const p = travel > 0 ? clamp01(-rect.top / travel) : 0;

      const stageW = stageRef.current?.clientWidth ?? 900;
      // Five cards across, with breathing room at the edges.
      const step = Math.min(stageW / 5.35, 250);

      // The source photo holds, then dissolves as the maps take over.
      const src = sourceRef.current;
      if (src) {
        const out = ease(span(p, 0.1, 0.3));
        src.style.setProperty("--o", String(1 - out));
        src.style.setProperty("--s", String(mix(1.08, 0.88, out)));
        src.style.setProperty("--cap", String(1 - ease(span(p, 0.06, 0.18))));
      }

      for (let i = 0; i < SEQ.length; i++) {
        const card = cardRefs.current[i];
        if (!card) continue;

        // Stagger the fan-out so the row assembles rather than snapping.
        const t0 = 0.18 + i * 0.028;
        const outT = ease(span(p, t0, t0 + 0.2));
        // Converge: everything returns to centre, albedo last and largest.
        const isHero = i === 0;
        const inT = ease(span(p, isHero ? 0.76 : 0.7 + i * 0.012, 0.93));

        const spreadX = (i - 2) * step;
        // A shallow arc so the row reads as a hand of cards, not a toolbar.
        const arcY = Math.abs(i - 2) * 9;

        const x = mix(0, spreadX, outT) * (1 - inT);
        const y = mix(0, arcY, outT) * (1 - inT);
        const s = mix(0.82, 1, outT) * mix(1, isHero ? 1.42 : 0.9, inT);
        const o = outT * (isHero ? 1 : 1 - inT);

        card.style.setProperty("--x", `${x}px`);
        card.style.setProperty("--y", `${y}px`);
        card.style.setProperty("--s", String(s));
        card.style.setProperty("--o", String(o));
        card.style.setProperty(
          "--cap",
          String(ease(span(p, t0 + 0.08, t0 + 0.22)) * (1 - ease(span(p, 0.72, 0.82)))),
        );
      }

      if (cueRef.current) {
        cueRef.current.style.opacity = String(1 - ease(span(p, 0.02, 0.14)));
      }

      const next = p < 0.16 ? 0 : p < 0.42 ? 1 : p < 0.68 ? 2 : 3;
      if (next !== phaseRef.current) {
        phaseRef.current = next;
        setPhase(next);
      }
    };

    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  /* Section entrances + the nav's hairline. One observer for the whole page. */
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.in = "true";
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    document.querySelectorAll(".lp-reveal").forEach((n) => io.observe(n));

    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  /* Specimen scrub: the cursor's x position is the wipe between the photograph
     you shot and the material that came out of it. */
  const onScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const pct = clamp01((e.clientX - r.left) / r.width) * 100;
    el.style.setProperty("--wipe", `${pct}%`);
  }, []);

  const enterScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.dataset.active = "true";
  }, []);

  const leaveScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.dataset.active = "false";
    el.style.setProperty("--wipe", "62%");
  }, []);

  const markCells = useMemo(
    () => [0, 1, 0, 2, 3, 4, 0, 5, 0] as const,
    [],
  );

  return (
    <main className="lp">
      {/* ── nav ─────────────────────────────────────────────────────────── */}
      <nav className="lp-nav" data-stuck={stuck}>
        <div className="lp-nav-in">
          {/* prefetch is off on every studio link: the studio route pulls
              three/webgpu and the solver, and a marketing page has no business
              downloading that before someone asks for it. */}
          <Link className="lp-brand" href="/" prefetch={false}>
            <span className="lp-mark" aria-hidden>
              {markCells.map((c, i) => (
                <i key={i} data-on={c || undefined} />
              ))}
            </span>
            digital loom
          </Link>
          <span className="lp-nav-spacer" />
          <div className="lp-nav-links">
            <a className="lp-nav-link" href="#pipeline">pipeline</a>
            <a className="lp-nav-link" href="#weave">weave</a>
            <a className="lp-nav-link" href="#export">export</a>
            <a className="lp-nav-link" href="#embed">embed</a>
          </div>
          <Link className="lp-btn" href="/" prefetch={false}>
            open the studio <span className="lp-arrow" aria-hidden>→</span>
          </Link>
        </div>
      </nav>

      {/* ── hero ────────────────────────────────────────────────────────── */}
      <header className="lp-hero">
        <div className="lp-wrap">
          <div className="lp-hero-grid">
            <p className="lp-eyebrow">fabric material instrument</p>
            <h1 className="lp-h1">
              A photograph of cloth,
              <br />
              and then{" "}
              <span
                className="lp-mark-word"
                style={{ "--draw": drawn ? 1 : 0 } as CSSProperties}
              >
                the cloth
              </span>
              .
            </h1>
            <p className="lp-lede">
              Digital loom turns a fabric photograph into a tunable material. It
              extracts tileable PBR maps, hangs them on an interactive cloth
              simulation, and exports a portable bundle that drops straight into
              Blender, Unity, or Unreal.
            </p>
            <div className="lp-hero-actions">
              <Link className="lp-btn" href="/" prefetch={false}>
                open the studio <span className="lp-arrow" aria-hidden>→</span>
              </Link>
              <a className="lp-btn lp-btn-ghost" href="#export">
                see what it exports
              </a>
            </div>
          </div>
        </div>

        {/* The set piece. Not a render, not a loop — the solver, running. */}
        <div className="lp-stage">
          <div className="lp-stage-frame">
            <FabricViewer pkg={pkg} fabricId="myeongju" knobs={{ openness: 0.7 }} />
            <div className="lp-stage-cap">
              <span className="lp-live-dot" aria-hidden />
              live simulation · push it with your cursor
            </div>
          </div>
        </div>
      </header>

      {/* ── pipeline set piece ──────────────────────────────────────────── */}
      <section id="pipeline" className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head lp-reveal">
            <span className="lp-num">01 / pipeline</span>
            <h2 className="lp-h2">One photo in. A whole material out.</h2>
          </div>
        </div>

        <div className="lp-sticky" ref={stickyRef}>
          <div className="lp-sticky-vp">
            <div className="lp-seq-head lp-wrap">
              <h3 className="lp-seq-title">{PHASES[phase].title}</h3>
              <p className="lp-seq-sub">{PHASES[phase].sub}</p>
            </div>

            <div className="lp-seq-stage" ref={stageRef}>
              <figure
                className="lp-card"
                ref={(n) => {
                  sourceRef.current = n;
                }}
                style={{ "--s": 1.08, zIndex: 6 } as CSSProperties}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${SEQ_BASE}/source.jpg`} alt="A photograph of sage linen" />
                <figcaption>the photograph</figcaption>
              </figure>

              {SEQ.map((m, i) => (
                <figure
                  className="lp-card"
                  key={m.name}
                  ref={(n) => {
                    cardRefs.current[i] = n;
                  }}
                  style={{ "--o": 0, zIndex: i === 0 ? 5 : 4 - i } as CSSProperties}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${SEQ_BASE}/${m.file}`} alt={`${m.label} map`} />
                  <figcaption>{m.label}</figcaption>
                </figure>
              ))}
            </div>

            {/* Reduced-motion twin: same five maps, no choreography. */}
            <div className="lp-seq-static lp-wrap">
              {SEQ.map((m) => (
                <figure className="lp-card" key={`s-${m.name}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${SEQ_BASE}/${m.file}`} alt={`${m.label} map`} />
                  <figcaption>{m.label}</figcaption>
                </figure>
              ))}
            </div>

            <div className="lp-scroll-cue" ref={cueRef}>
              scroll
            </div>
          </div>
        </div>

        <div className="lp-wrap">
          <dl className="lp-defs lp-reveal">
            {MAP_DEFS.map((d) => (
              <div className="lp-def" key={d.name}>
                <dt>{d.name}</dt>
                <dd>{d.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── specimens ───────────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head lp-reveal">
            <span className="lp-num">02 / specimens</span>
            <h2 className="lp-h2">Shot on a table. Relit anywhere.</h2>
            <p className="lp-body">
              Three extractions that ship with the app. Drag across each one to
              wipe between the original photograph and the albedo that came out
              of it — lighting removed, tiled, and ready to be lit again.
            </p>
          </div>

          <div className="lp-specimens lp-reveal">
            {SPECIMENS.map((s) => (
              <figure className="lp-spec" key={s.dir}>
                <div
                  className="lp-spec-pair"
                  style={{ "--wipe": "62%" } as CSSProperties}
                  onPointerMove={onScrub}
                  onPointerEnter={enterScrub}
                  onPointerLeave={leaveScrub}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/samples/${s.dir}/${s.src}`}
                    alt={`Source photograph of ${s.name}`}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="lp-spec-after"
                    src={`/api/samples/${s.dir}/albedo.png`}
                    alt={`Extracted albedo for ${s.name}`}
                  />
                  <span className="lp-spec-seam" aria-hidden />
                  <span className="lp-spec-tag">photo → albedo</span>
                </div>
                <figcaption className="lp-spec-meta">
                  <span className="lp-spec-name">{s.name}</span>
                  <span className="lp-spec-prompt">“{s.prompt}”</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ── weave / physics ─────────────────────────────────────────────── */}
      <section id="weave" className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head lp-reveal">
            <span className="lp-num">03 / weave</span>
            <h2 className="lp-h2">Drape isn’t animated. It’s solved.</h2>
          </div>

          <div className="lp-split">
            <div className="lp-reveal">
              <p className="lp-body">
                The cloth is a grid of point masses held together by distance
                constraints, relaxed six times a step under XPBD. There are no
                rest-position springs and no keyframes: a soft body is pulled
                back toward a shape it remembers, but cloth has no rest shape at
                all. It has neighbours, gravity, and a grain. Drape is what falls
                out of that.
              </p>
              <p className="lp-body" style={{ marginTop: 16 }}>
                Constraints are tagged by direction, which is why a twill hangs
                differently from a knit — and why the bias, that 45° diagonal
                every tailor knows, behaves like the bias.
              </p>

              <div className="lp-constraints">
                {CONSTRAINTS.map((c) => (
                  <div className="lp-constraint" key={c.name}>
                    <span
                      className="lp-swatch-line"
                      style={{ background: c.dye }}
                      aria-hidden
                    />
                    <span>
                      <b>{c.name}</b> — {c.note}
                    </span>
                  </div>
                ))}
              </div>

              <p className="lp-body" style={{ marginTop: 22 }}>
                Those parameters aren’t dialed in by hand. Each fabric is
                described the way a mill would describe it — grams per square
                metre, cover factor, thickness, fibre modulus, twist — and the
                solver settings are derived from that. Jersey and denim ship with
                empty override blocks on purpose: proof the mapping holds without
                anyone nudging it.
              </p>
            </div>

            <div className="lp-reveal">
              <WeaveFigure />
              <div className="lp-fabrics" style={{ marginTop: 26 }}>
                {FABRICS.map((f) => (
                  <div className="lp-fabric" key={f.roman}>
                    <span className="lp-fabric-ko">{f.ko}</span>
                    <span>
                      <span className="lp-fabric-en">{f.en}</span>{" "}
                      <span className="lp-fabric-roman">{f.roman}</span>
                    </span>
                    <span className="lp-fabric-gsm">{f.gsm} gsm</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── export ──────────────────────────────────────────────────────── */}
      <section id="export" className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head lp-reveal">
            <span className="lp-num">04 / export</span>
            <h2 className="lp-h2">It leaves as a folder, not a screenshot.</h2>
            <p className="lp-body">
              Every material exports as a zip with the map suffixes Blender’s Node
              Wrangler, Unity and Unreal already key off, a packed ORM, a
              self-contained glb specimen, and a json that records its own
              provenance. Packed in the browser — the maps are already there and
              the numbers already live in state.
            </p>
          </div>

          <div className="lp-split">
            <div className="lp-reveal">
              <pre className="lp-tree">
{`sage-linen/
├─ `}<b>sage-linen_BaseColor.png</b>{`
├─ `}<b>sage-linen_Normal.png</b>{`
├─ `}<b>sage-linen_Roughness.png</b>{`
├─ `}<b>sage-linen_Metallic.png</b>{`
├─ `}<b>sage-linen_Height.png</b>{`
├─ `}<b>sage-linen_ORM.png</b>{`      `}<span>occlusion · roughness · metallic</span>{`
├─ `}<b>sage-linen.glb</b>{`          `}<span>sheen + transmission specimen</span>{`
├─ `}<b>material.json</b>{`           `}<span>schema loom.material/1</span>{`
└─ `}<b>README.md</b>{`               `}<span>per-engine import steps</span>
              </pre>
              <div className="lp-engines">
                <span className="lp-chip">Blender</span>
                <span className="lp-chip">Unity</span>
                <span className="lp-chip">Unreal</span>
                <span className="lp-chip">three.js</span>
                <span className="lp-chip">glTF</span>
              </div>
            </div>

            <div className="lp-reveal">
              <pre className="lp-code">
{`{
  `}<span className="a">&quot;schema&quot;</span>{`: `}<span className="s">&quot;loom.material/1&quot;</span>{`,
  `}<span className="a">&quot;cloth&quot;</span>{`: {
    `}<span className="a">&quot;weaveType&quot;</span>{`: `}<span className="s">&quot;plain&quot;</span>{`,
    `}<span className="a">&quot;fiberType&quot;</span>{`: `}<span className="s">&quot;staple&quot;</span>{`,
    `}<span className="a">&quot;warp&quot;</span>{`: 0.86, `}<span className="a">&quot;weft&quot;</span>{`: 0.84,
    `}<span className="a">&quot;shear&quot;</span>{`: 0.21, `}<span className="a">&quot;bend&quot;</span>{`: 0.07
  },
  `}<span className="a">&quot;provenance&quot;</span>{`: {
    `}<span className="a">&quot;extractor&quot;</span>{`: `}<span className="s">&quot;fal-ai/patina/material/extract&quot;</span>{`
  }
}`}
              </pre>
              <p className="lp-body" style={{ marginTop: 18 }}>
                The whole library exports too — one dated archive that reimports
                cleanly, maps re-attaching to their presets by content hash. It’s
                the durable copy, and it’s yours.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── embed ───────────────────────────────────────────────────────── */}
      <section id="embed" className="lp-section">
        <div className="lp-wrap">
          <div className="lp-section-head lp-reveal">
            <span className="lp-num">05 / embed</span>
            <h2 className="lp-h2">The viewer is a component.</h2>
            <p className="lp-body">
              The cloth at the top of this page is the same one-line embed. It
              owns a ResizeObserver and paints to its container, so it fills
              whatever box you give it and reflows with the window — no size
              math on your side. Embeds default to mid quality; a viewer in
              someone else’s page shouldn’t grab the heaviest settings uninvited.
            </p>
          </div>

          <div className="lp-reveal">
            <pre className="lp-code">
{`import FabricViewer from `}<span className="s">&quot;@/lib/ui/fabricViewer&quot;</span>{`;

<`}<span className="t">div</span>{` `}<span className="a">style</span>{`={{ display: `}<span className="s">&quot;flex&quot;</span>{`, height: 400 }}>
  <`}<span className="t">FabricViewer</span>{` `}<span className="a">pkg</span>{`={pkg} `}<span className="a">fabricId</span>{`=`}<span className="s">&quot;myeongju&quot;</span>{` `}<span className="a">knobs</span>{`={{ openness: 0.7 }} />
</`}<span className="t">div</span>{`>`}
            </pre>
          </div>
        </div>
      </section>

      {/* ── close ───────────────────────────────────────────────────────── */}
      <section className="lp-close">
        <div className="lp-wrap" style={{ display: "grid", gap: 24, justifyItems: "center" }}>
          <h2 className="lp-h2 lp-reveal">Bring a photograph of something woven.</h2>
          <p className="lp-lede lp-reveal" style={{ textAlign: "center" }}>
            The studio opens with a silk already hanging, four sample materials in
            the drawer, and every tuning knob live. You only need a fal key when
            you want to extract something new — and you can paste your own.
          </p>
          <div className="lp-reveal">
            <Link className="lp-btn" href="/" prefetch={false}>
              open the studio <span className="lp-arrow" aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-wrap">
        <div className="lp-foot">
          <span>digital loom</span>
          <span>fabric material instrument</span>
          <span className="lp-foot-spacer" />
          <span>
            PBR maps extracted via{" "}
            <a href="https://fal.ai" target="_blank" rel="noreferrer noopener">
              Patina
            </a>{" "}
            · packaged by loom
          </span>
        </div>
      </footer>
    </main>
  );
}

/* ── weave figure ───────────────────────────────────────────────────────────
   The four constraint families on one 4×4 patch of the grid, in the dye colours
   the list uses. Drawn rather than described because "shear is the 45° bias" is
   one line of text and one glance of picture, and the picture is faster. */

function WeaveFigure() {
  const cell = 46;
  const pad = 26;
  const n = 4;
  const at = (i: number) => pad + i * cell;
  const size = pad * 2 + (n - 1) * cell;

  const nodes: { x: number; y: number }[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) nodes.push({ x: at(c), y: at(r) });
  }

  return (
    <svg
      className="lp-weave-fig"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="A four-by-four patch of the cloth grid showing warp, weft, shear and bend constraints"
    >
      {/* weft — crosswise */}
      {Array.from({ length: n }, (_, r) => (
        <line
          key={`h${r}`}
          x1={at(0)} y1={at(r)} x2={at(n - 1)} y2={at(r)}
          stroke="var(--dye-madder)" strokeWidth={1.5} strokeLinecap="round"
        />
      ))}
      {/* warp — lengthwise grain */}
      {Array.from({ length: n }, (_, c) => (
        <line
          key={`v${c}`}
          x1={at(c)} y1={at(0)} x2={at(c)} y2={at(n - 1)}
          stroke="var(--dye-indigo)" strokeWidth={1.5} strokeLinecap="round"
        />
      ))}
      {/* shear — the 45° bias, drawn on one cell so it reads as a diagonal */}
      <line
        x1={at(1)} y1={at(1)} x2={at(2)} y2={at(2)}
        stroke="var(--dye-gardenia)" strokeWidth={1.8} strokeLinecap="round"
      />
      <line
        x1={at(2)} y1={at(1)} x2={at(1)} y2={at(2)}
        stroke="var(--dye-gardenia)" strokeWidth={1.8} strokeLinecap="round"
      />
      {/* bend — two cells apart, so it resists folding rather than stretching */}
      <path
        d={`M ${at(0)} ${at(3)} Q ${at(1)} ${at(3) + 16} ${at(2)} ${at(3)}`}
        fill="none" stroke="var(--dye-mugwort)" strokeWidth={1.8}
        strokeLinecap="round" strokeDasharray="4 4"
      />
      {nodes.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="var(--ink)" opacity={0.72} />
      ))}
    </svg>
  );
}
