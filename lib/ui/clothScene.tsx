"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ClothSolver, DEFAULT_CONFIG, type ClothConfig } from "@/lib/cloth/ClothSolver";
import type { ResolvedFabric } from "@/lib/cloth/fabrics";
import type { MapName, MaterialPackage } from "@/lib/core/materialPackage";
import {
  CLOTH_VERTEX_SHADER,
  CLOTH_FRAGMENT_SHADER,
  SKY_VERTEX_SHADER,
  SKY_FRAGMENT_SHADER,
} from "@/lib/ui/clothSceneShaders";

// Cubic-bezier easing (CSS-style control points), Newton-solved. Returns
// eased y for a linear x in [0,1]. Used to shape the cloth→object transition
// so its *speed* ramps in and out rather than moving at a constant rate.
function makeCubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 5; i++) {
      const err = sampleX(t) - x;
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(Math.min(1, Math.max(0, t)));
  };
}

// Object maps that map onto MeshPhysicalMaterial slots. Shared with the
// object-material sync below.
const OBJECT_TEX_KEYS: MapName[] = [
  "albedo",
  "normal",
  "roughness",
  "metalness",
  "height",
  "ao",
];

interface Props {
  fabric: ResolvedFabric;
  width?: number;
  height?: number;
  wireframe?: boolean;
  pinMode?: "line" | "pegs";
  /** Single transparency scalar. Drives u_translucency, u_densityAmount, and
   *  u_alphaFromDensity via the step-3 formulas in the tick loop unless the
   *  matching deprecated prop below is explicitly set. */
  openness?: number;
  /** @deprecated derive from openness. If set, beats the openness-derived value
   *  for one release. */
  translucency?: number;
  /** @deprecated derive from openness. */
  densityAmount?: number;
  /** @deprecated derive from openness. */
  alphaFromDensity?: number;
  /** Threadbare boost: extra alpha loss on top of the openness-derived
   *  sheerness, weighted per-texel by `alphaBoostSource`. */
  alphaBoost?: number;
  /** Which map weights the threadbare boost: 0 = height, 1 = albedo,
   *  2 = roughness, 3 = metalness. Dark regions of the chosen map go sheer;
   *  sources without a loaded map fall back to height. */
  alphaBoostSource?: 0 | 1 | 2 | 3;
  /** Optional roughness map URL (from the Patina pipeline). Only consumed by
   *  the threadbare boost when alphaBoostSource = 2. */
  roughnessMapURL?: string;
  /** Optional transmission map URL. When set, each cloth particle's porosity
   *  is sampled from this image at its UV; higher luminance → more porous →
   *  less wind pickup on that particle. When absent, porosity falls back to
   *  the fabric's inherent openness scalar. */
  porosityMapURL?: string;
  albedoAmount?: number;
  /** Metallic amount (0 = dielectric fabric, 1 = full metalness). Gates the
   *  metalness map; at 0 the material stays fully non-metallic. */
  metalness?: number;
  /** Optional metalness map URL (from the Patina pipeline). When set the
   *  shader samples it per-fragment; when absent, `metalness` acts as a flat
   *  metalness across the whole sheet. */
  metalnessMapURL?: string;
  /** Optional normal map URL (from the Patina pipeline). Sampled at the
   *  parallaxed UV to perturb the shading normal so the weave catches light. */
  normalMapURL?: string;
  /** Normal-map strength (0 = smooth vertex normal, 1 = full map). */
  normalAmount?: number;
  /** POM self-shadow strength (0 = off, 1 = threads fully occlude the sun). */
  pomShadow?: number;
  /** Stretch response amount (0 = off): taut regions go sheer, flatten their
   *  relief, and specularise. Drives + gates the per-particle strain compute. */
  stretch?: number;
  /** Heatmap the strain field instead of shading (debug). */
  stretchDebug?: boolean;
  pomScale?: number;
  pomMinSteps?: number;
  pomMaxSteps?: number;
  pomDebug?: 0 | 1 | 2;
  edgeInset?: number;
  edgeFray?: number;
  edgeSharpness?: number;
  edgeDetail?: number;
  tileScale?: number;
  txHeight?: number;
  txAlbedo?: number;
  txRoughness?: number;
  transmissionContrast?: number;
  pixelScale?: number;
  breeze?: number;
  meshCols?: number;
  meshRows?: number;
  /** 0 = full sky, 1 = flat dark-gray backdrop. Lighting unchanged. */
  skyMode?: 0 | 1;

  /** "cloth" hangs the fabric; "object" whisks the cloth away and surfaces a
   *  3D object wearing the same material, in the SAME scene (shared sky, sun,
   *  fog, camera) — no teardown, just an eased cross-transition. */
  mode?: "cloth" | "object";
  /** Material package whose maps dress the object in object mode. */
  pkg?: MaterialPackage | null;
  /** glTF model surfaced in object mode. */
  objectModelUrl?: string;
  /** Texture repeat for the object's maps. Defaults higher than the cloth (a
   *  3D object reads better with more tiling). */
  objectTileScale?: number;

  // ── Performance ───────────────────────────────────────────────────────────
  /** Solver relaxation iterations per step (perf ↔ crispness). */
  iterations?: number;
  /** Self-collision cadence. */
  selfCollide?: "full" | "half" | "off";
  /** Texture anisotropy (applied live to loaded maps). */
  anisotropy?: number;
  /** Telemetry sink, fired ~2 Hz with live render/sim stats. */
  onStats?: (s: ClothStats) => void;
}

export interface ClothStats {
  fps: number;
  /** CPU ms spent in the solver step, EMA-smoothed. */
  simMs: number;
  /** Triangles drawn last frame (renderer.info). */
  tris: number;
  /** Draw calls last frame (renderer.info). */
  calls: number;
}

// Shader sources for the cloth, sky, and sun live in clothSceneShaders.ts —
// this file stays focused on scene setup, physics wiring, and rendering.

export default function ClothScene(props: Props) {
  const {
    fabric,
    // No size defaults: when omitted the mount div is 100% × 100% and the
    // scene fills its container (a ResizeObserver drives the actual canvas
    // size). The studio passes measured pixels; the embed passes nothing.
    width,
    height,
    openness = 0.55,
    albedoAmount = 1.0,
    metalness = 0,
    normalAmount = 1.0,
    pomShadow = 0.55,
    stretch = 0,
    alphaBoost = 0,
    alphaBoostSource = 0,
    pomScale = 0.015,
    pomMinSteps = 8,
    pomMaxSteps = 32,
    pomDebug = 0,
    edgeInset = 0.008,
    edgeFray = 0.12,
    edgeSharpness = 0.15,
    edgeDetail = 1,
    tileScale = 1,
    txHeight = 1,
    txAlbedo = 0,
    txRoughness = 0,
    transmissionContrast = 0.3,
    pixelScale = 1,
    objectModelUrl = "/model/whale.glb",
  } = props;

  const mountRef = useRef<HTMLDivElement | null>(null);

  // Every prop lives in a ref so the render-loop and uniforms can read the
  // latest value without needing to re-init the whole scene each change.
  const propsRef = useRef(props);
  const fabricRef = useRef(fabric);

  useEffect(() => {
    propsRef.current = props;
    fabricRef.current = fabric;
  }, [props, fabric]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;

    // ── Renderer / scene / camera ───────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      // MSAA on top of ≥1.5× supersampling is redundant — the supersample
      // already anti-aliases, and the combined backing-store bandwidth is
      // what kills older GPUs. Only request MSAA at lower pixel scales,
      // where edges would otherwise stair-step. (Construction-time only;
      // runtime quality flips keep whichever choice the mount made.)
      antialias: pixelScale < 1.5,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(pixelScale);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8bfd0);

    // Exponential fog — the "little volumetric" ask. Distance-based haze
    // knits the cloth into the sky, gives the sun its atmospheric weight,
    // and reads as light scattering through moist air.
    const fogColor = new THREE.Color(0xbecfe0);
    scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.00035);

    // Camera framing — cloth spans roughly 423 units in solver units and we
    // want it to occupy about 60% of the frame vertically (matches the
    // original cloth-sim look). At FOV 30, tan(15°) ≈ 0.268, so a distance
    // of ~1300 puts the visible view height near ~695 units → cloth at
    // ~60% vertical.
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 8000);
    camera.position.set(0, 0, 1300);
    camera.lookAt(0, 0, 0);

    // Orbit controls — dynamic import so the example addon doesn't drag
    // into the initial bundle chunk. Camera can rotate around the fabric
    // and zoom in/out within the configured distance limits. Damping
    // makes the motion feel Apple-y (interruptible, spring-easy).
    let controls: {
      enabled: boolean;
      update: () => void;
      dispose: () => void;
    } | null = null;
    import("three/examples/jsm/controls/OrbitControls.js")
      .then((mod) => {
        if (disposed) return;
        const c = new mod.OrbitControls(camera, renderer.domElement);
        c.enableDamping = true;
        c.dampingFactor = 0.08;
        c.enablePan = false;
        c.minDistance = 500;   // don't dive inside the fabric
        c.maxDistance = 2400;  // don't drift out past the sky
        c.minPolarAngle = Math.PI * 0.1;  // keep the horizon roughly in view
        c.maxPolarAngle = Math.PI * 0.9;
        c.rotateSpeed = 0.65;
        c.zoomSpeed = 0.9;
        controls = c;
      })
      .catch(() => {
        // Orbit controls are enhancement, not required. Silently continue
        // with a static camera if the dynamic import fails.
      });

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ── Sky ─────────────────────────────────────────────────────────────
    const skyGeom = new THREE.SphereGeometry(3500, 32, 24);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        u_top: { value: new THREE.Color(0x2f5c94) },
        u_bottom: { value: new THREE.Color(0xe6d3b0) },
        u_sunDir: { value: new THREE.Vector3(0, 0.5, 1).normalize() },
        u_sunColor: { value: new THREE.Color(1.0, 0.86, 0.65) },
        u_sunAlt: { value: 0.5 },
        u_fogColor: { value: fogColor },
        u_skyMode: { value: 0 },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
    });
    const skyMesh = new THREE.Mesh(skyGeom, skyMat);
    scene.add(skyMesh);

    // ── Lighting ────────────────────────────────────────────────────────
    // Hemisphere sky-bounce plus the moving sun as a directional.
    const hemi = new THREE.HemisphereLight(0xb5d0e6, 0x8b7146, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
    scene.add(sun);
    const sunTarget = new THREE.Object3D();
    scene.add(sunTarget);
    sun.target = sunTarget;

    // ── Mouse interaction (3D) ──────────────────────────────────────────
    // Raycast the pointer against the plane the cloth hangs in (Z=0 in
    // world space), then feed the resulting world XY back into solver
    // coords (solver Y+ is down, world Y+ is up). Solver's applyCursor
    // operates in XY so we don't need per-triangle intersection — the
    // Z-plane projection is accurate enough for hover interaction.
    const mouse = { x: 0, y: 0, active: false };
    const raycaster = new THREE.Raycaster();
    const cursorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const cursorPoint = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.ray.intersectPlane(cursorPlane, cursorPoint);
      if (hit) {
        mouse.x = cursorPoint.x;
        mouse.y = -cursorPoint.y; // world Y+ up → solver Y+ down
        mouse.active = true;
      }
    };
    const onPointerLeave = () => {
      mouse.active = false;
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.style.touchAction = "none";

    // ── Cloth rig (shared bits) ──────────────────────────────────────────
    // Changing mesh/frag res or pin mode no longer tears the scene down.
    // Instead a fresh cloth *unit* is built at the new resolution, pre-settled
    // OFF-SCREEN to the left, and slid in along the clothesline while the old
    // unit slides off to the right (see the slide logic in the tick). The
    // renderer, camera, textures, sun, and object all persist across the swap.
    // SHEET_SIZE is held constant so resolution means discretization, not
    // physical size — which also keeps the rope height fixed.
    const SHEET_SIZE = 423;

    // Debug + peg materials/geometry — one set, shared by every unit.
    const wireEdgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      fog: false,
    });
    const wirePointMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: 3,
      sizeAttenuation: false,
      transparent: true,
      fog: false,
    });
    const pinBodyGeom = new THREE.BoxGeometry(2.6, 5.5, 1.6);
    const pinBodyMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      roughness: 0.5,
      metalness: 0.25,
      transparent: true,
    });

    // Cloth material — shared across every unit (uniforms are global). The
    // ported shader with all knob uniforms.
    const clothMat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      // Three's TypeScript defs require every field here in newer versions;
      // WebGL2 has derivatives in core, and Three enables them by default,
      // so we don't strictly need to opt in — leaving this out is fine.
      uniforms: {
        u_lightDir: { value: new THREE.Vector3(0, 0, 1) },
        u_lightColor: { value: new THREE.Color(1.4, 1.2, 0.95) },
        u_ambientColor: { value: new THREE.Color(0.32, 0.42, 0.55) },
        u_baseColor: { value: new THREE.Color(1, 1, 1) },
        // Initial values derived from `openness` via the step-3 formulas;
        // the tick loop refreshes them each frame with the same math.
        u_translucency: { value: openness },
        u_sheen: { value: 0.9 },
        u_albedoTex: { value: null as THREE.Texture | null },
        u_albedoAmount: { value: albedoAmount },
        u_densityTex: { value: null as THREE.Texture | null },
        u_densityAmount: { value: 1 - 0.5 * openness },
        u_alphaFromDensity: { value: 0.1 * openness },
        u_metalnessTex: { value: null as THREE.Texture | null },
        u_metalness: { value: metalness },
        u_hasMetalnessTex: { value: 0 },
        u_normalTex: { value: null as THREE.Texture | null },
        u_normalAmount: { value: normalAmount },
        u_hasNormalTex: { value: 0 },
        u_pomShadow: { value: pomShadow },
        u_stretch: { value: stretch },
        u_stretchDetail: { value: 0.5 },
        u_stretchDebug: { value: 0 },
        u_alphaBoost: { value: alphaBoost },
        u_alphaBoostSource: { value: alphaBoostSource },
        u_roughnessTex: { value: null as THREE.Texture | null },
        u_hasRoughnessTex: { value: 0 },
        u_pomScale: { value: pomScale },
        u_pomMinSteps: { value: pomMinSteps },
        u_pomMaxSteps: { value: pomMaxSteps },
        u_pomDebug: { value: pomDebug },
        u_edgeInset: { value: edgeInset },
        u_edgeFray: { value: edgeFray },
        u_edgeSharpness: { value: edgeSharpness },
        u_edgeDetail: { value: edgeDetail },
        u_tileScale: { value: tileScale },
        u_txHeight: { value: txHeight },
        u_txAlbedo: { value: txAlbedo },
        u_txRoughness: { value: txRoughness },
        u_transmissionContrast: { value: transmissionContrast },
        u_fade: { value: 1 },
        u_fogColor: { value: fogColor },
        u_fogDensity: { value: 0.00035 },
      },
      vertexShader: CLOTH_VERTEX_SHADER,
      fragmentShader: CLOTH_FRAGMENT_SHADER,
    });
    // ── Cloth unit factory ──────────────────────────────────────────────
    // A "unit" is a complete, independent cloth: its own solver, geometry,
    // wire-debug draws, and pins, all under one group. Normally one is live;
    // during a resolution/pin change two coexist briefly while the old slides
    // off and the new slides in. `ropeAt` / `clothGroup` are referenced lazily
    // (defined below) — the factory is only *called* after they exist.
    const WIRE_V_MAX = 8; // wire-view velocity→white clip (solver units/frame)
    const SETTLE_STEPS = 110; // off-screen pre-drape steps at a unit's birth
    const WIND_RAMP = 90; // frames to fade breeze in on a fresh unit
    const SNAP_VEC = new THREE.Vector3();
    // Self-collision cadence knob → step divisor (0 disables).
    const SC_EVERY: Record<"full" | "half" | "off", number> = {
      full: 1,
      half: 2,
      off: 0,
    };

    interface ClothUnit {
      cols: number;
      rows: number;
      solver: ClothSolver;
      cfg: ClothConfig;
      group: THREE.Group;
      birth: number;
      fromX: number;
      toX: number;
      lastFabric: ResolvedFabric;
      snapPins: () => void;
      stepSim: (time: number, allowCursor: boolean) => void;
      setVisible: (wf: boolean) => void;
      settle: () => void;
      dispose: () => void;
    }

    const makeClothUnit = (
      cols: number,
      rows: number,
      pinModeVal: "line" | "pegs",
      startX: number,
      birth: number,
    ): ClothUnit => {
      const spacing = SHEET_SIZE / (cols - 1);
      const cfg: ClothConfig = { ...DEFAULT_CONFIG, cols, rows, spacing };
      cfg.originX = -SHEET_SIZE / 2;
      cfg.originY = -((rows - 1) * spacing) / 2;
      const solver = new ClothSolver(cfg, fabricRef.current);
      if (pinModeVal === "pegs") {
        // Pin fractions relative to width so the drape looks the same at
        // every resolution.
        solver.setPinned(Math.round(cols * 0.08), true);
        solver.setPinned(Math.round(cols * 0.88), true);
      } else {
        solver.pinTopEdge();
      }

      const indices = solver.buildIndices();
      const uvs = solver.buildUVs();
      const normals = new Float32Array(solver.count * 3);

      const geom = new THREE.BufferGeometry();
      const posArr = new Float32Array(solver.count * 3);
      const norArr = new Float32Array(solver.count * 3);
      const strainArr = new Float32Array(solver.count * 2); // (u,v) strain
      const posAttr = new THREE.BufferAttribute(posArr, 3);
      const norAttr = new THREE.BufferAttribute(norArr, 3);
      const strainAttr = new THREE.BufferAttribute(strainArr, 2);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      norAttr.setUsage(THREE.DynamicDrawUsage);
      strainAttr.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("position", posAttr);
      geom.setAttribute("normal", norAttr);
      geom.setAttribute("strain", strainAttr);
      geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
      geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
      const clothMesh = new THREE.Mesh(geom, clothMat);

      // Wire debug: edges over the constraint topology + points, sharing this
      // unit's live position buffer; velocity-colored.
      const wireColorArr = new Float32Array(solver.count * 3);
      const wireColorAttr = new THREE.BufferAttribute(wireColorArr, 3);
      wireColorAttr.setUsage(THREE.DynamicDrawUsage);
      const edgePairs: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (c + 1 < cols) edgePairs.push(i, i + 1);
          if (r + 1 < rows) edgePairs.push(i, i + cols);
        }
      }
      const wireEdgeGeom = new THREE.BufferGeometry();
      wireEdgeGeom.setAttribute("position", posAttr);
      wireEdgeGeom.setAttribute("color", wireColorAttr);
      wireEdgeGeom.setIndex(
        new THREE.BufferAttribute(new Uint32Array(edgePairs), 1),
      );
      const wireEdges = new THREE.LineSegments(wireEdgeGeom, wireEdgeMat);
      const wirePointGeom = new THREE.BufferGeometry();
      wirePointGeom.setAttribute("position", posAttr);
      wirePointGeom.setAttribute("color", wireColorAttr);
      const wirePoints = new THREE.Points(wirePointGeom, wirePointMat);
      wireEdges.visible = false;
      wirePoints.visible = false;

      const pinIndices: number[] = [];
      for (let c = 0; c < cols; c++) if (solver.pinned[c]) pinIndices.push(c);
      const pins = pinIndices.map(() => new THREE.Mesh(pinBodyGeom, pinBodyMat));

      const group = new THREE.Group();
      group.add(clothMesh, wireEdges, wirePoints, ...pins);
      group.position.x = startX;

      const fabricH = (rows - 1) * spacing;
      const pinVec = new THREE.Vector3();

      let strainActive = false;
      const syncGeometry = () => {
        solver.computeNormals(indices, normals);
        for (let i = 0; i < solver.count; i++) {
          const i3 = i * 3;
          posArr[i3] = solver.pos[i3];
          posArr[i3 + 1] = -solver.pos[i3 + 1]; // flip so Y+ is up
          posArr[i3 + 2] = solver.pos[i3 + 2];
          norArr[i3] = normals[i3];
          norArr[i3 + 1] = -normals[i3 + 1];
          norArr[i3 + 2] = normals[i3 + 2];
        }
        posAttr.needsUpdate = true;
        norAttr.needsUpdate = true;
        // Per-vertex strain (Tier B) — only when the stretch effect/debug is
        // on. When it turns off, zero the buffer once so no stale strain
        // lingers on the shader varying.
        const p = propsRef.current;
        const wantStrain = (p.stretch ?? 0) > 0 || p.stretchDebug === true;
        if (wantStrain) {
          solver.computeStrain(strainArr);
          strainAttr.needsUpdate = true;
          strainActive = true;
        } else if (strainActive) {
          strainArr.fill(0);
          strainAttr.needsUpdate = true;
          strainActive = false;
        }
      };

      const syncWireColors = () => {
        for (let i = 0; i < solver.count; i++) {
          const i3 = i * 3;
          const vx = solver.pos[i3] - solver.prev[i3];
          const vy = solver.pos[i3 + 1] - solver.prev[i3 + 1];
          const vz = solver.pos[i3 + 2] - solver.prev[i3 + 2];
          const t = Math.min(1, Math.sqrt(vx * vx + vy * vy + vz * vz) / WIRE_V_MAX);
          let cr: number, cg: number, cb: number;
          if (t < 0.5) {
            const k = t * 2;
            cr = 0.22 + (0.92 - 0.22) * k;
            cg = 0.32 + (0.72 - 0.32) * k;
            cb = 0.52 + (0.35 - 0.52) * k;
          } else {
            const k = (t - 0.5) * 2;
            cr = 0.92 + (1.0 - 0.92) * k;
            cg = 0.72 + (0.97 - 0.72) * k;
            cb = 0.35 + (0.9 - 0.35) * k;
          }
          wireColorArr[i3] = cr;
          wireColorArr[i3 + 1] = cg;
          wireColorArr[i3 + 2] = cb;
        }
        wireColorAttr.needsUpdate = true;
      };

      // Snap pinned particles to the rope at their *sliding* world-x. The rope
      // lives in clothGroup-local coords; the unit group adds the slide
      // offset, so sample at (localX + slideX) and store the local x back
      // (rope is ~horizontal, so local x stays put and only y tracks the wire).
      const snapPins = () => {
        const inset = propsRef.current.edgeInset ?? 0.008;
        const frayAmp = (propsRef.current.edgeFray ?? 0.12) * 0.08;
        const clothLift = fabricH * (inset + frayAmp) + 4;
        for (let c = 0; c < cols; c++) {
          if (!solver.pinned[c]) continue;
          const worldX = cfg.originX + c * spacing + group.position.x;
          ropeAt(worldX, SNAP_VEC);
          const ci = c * 3;
          solver.pos[ci] = SNAP_VEC.x - group.position.x;
          solver.pos[ci + 1] = -(SNAP_VEC.y + clothLift);
          solver.pos[ci + 2] = SNAP_VEC.z;
          solver.prev[ci] = solver.pos[ci];
          solver.prev[ci + 1] = solver.pos[ci + 1];
          solver.prev[ci + 2] = solver.pos[ci + 2];
        }
      };

      const syncPins = () => {
        for (let i = 0; i < pinIndices.length; i++) {
          const src = pinIndices[i] * 3;
          ropeAt(solver.pos[src] + group.position.x, pinVec);
          pins[i].position.set(solver.pos[src], pinVec.y - 1.5, pinVec.z + 1.2);
        }
      };

      // Per-unit porosity (transmission map → per-particle wind attenuation).
      let lastPorosityUrl = "";
      let lastPorosityOpenness = fabricRef.current.openness;
      const loadPorosityMap = (url: string) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (disposed || lastPorosityUrl !== url) return;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h) return;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(img, 0, 0);
          let data: Uint8ClampedArray;
          try {
            data = ctx.getImageData(0, 0, w, h).data;
          } catch {
            return; // cross-origin taint — keep the scalar fill
          }
          const pr = new Float32Array(solver.count);
          for (let i = 0; i < solver.count; i++) {
            const u = uvs[i * 2];
            const v = 1 - uvs[i * 2 + 1];
            const px = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
            const py = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
            const idx = (py * w + px) * 4;
            pr[i] =
              (0.2126 * data[idx] +
                0.7152 * data[idx + 1] +
                0.0722 * data[idx + 2]) /
              255;
          }
          solver.setPorosity(pr);
        };
        img.src = url;
      };
      const syncPorosity = () => {
        const url = propsRef.current.porosityMapURL ?? "";
        if (url !== lastPorosityUrl) {
          lastPorosityUrl = url;
          if (url) loadPorosityMap(url);
          else {
            solver.fillPorosity(fabricRef.current.openness);
            lastPorosityOpenness = fabricRef.current.openness;
          }
          return;
        }
        if (!url) {
          const o = fabricRef.current.openness;
          if (o !== lastPorosityOpenness) {
            lastPorosityOpenness = o;
            solver.fillPorosity(o);
          }
        }
      };

      const unit: ClothUnit = {
        cols,
        rows,
        solver,
        cfg,
        group,
        birth,
        fromX: startX,
        toX: startX,
        lastFabric: fabricRef.current,
        snapPins,
        stepSim: (time, allowCursor) => {
          if (fabricRef.current !== unit.lastFabric) {
            unit.lastFabric = fabricRef.current;
            solver.setFabric(fabricRef.current);
          }
          // Live perf dials: iteration count + self-collision cadence.
          solver.setIterations(propsRef.current.iterations ?? 6);
          solver.selfCollisionEvery =
            SC_EVERY[propsRef.current.selfCollide ?? "full"];
          // Wind fades in over WIND_RAMP frames so a just-born unit isn't
          // kicked before it has finished settling.
          const windScale = Math.min(1, (time - unit.birth) / WIND_RAMP);
          snapPins();
          solver.applyWind(time, (propsRef.current.breeze ?? 0.06) * windScale);
          if (allowCursor && mouse.active) {
            solver.applyCursor(mouse.x - group.position.x, mouse.y, 140, 1.2);
          }
          solver.step(1);
          syncGeometry();
          if (propsRef.current.wireframe === true) syncWireColors();
          syncPins();
          syncPorosity();
        },
        setVisible: (wf) => {
          clothMesh.visible = !wf;
          wireEdges.visible = wf;
          wirePoints.visible = wf;
        },
        settle: () => {
          // Pre-drape off-screen: gravity + constraints only, bleeding the
          // implicit Verlet velocity to zero every 8th step so the flat grid
          // reaches rest WITHOUT the frame-one recoil that reads as the cloth
          // "slamming" against the line. No wind. Leaves the unit calm and
          // already draped before it's ever seen.
          solver.setFabric(fabricRef.current);
          solver.setIterations(propsRef.current.iterations ?? 6);
          solver.selfCollisionEvery =
            SC_EVERY[propsRef.current.selfCollide ?? "full"];
          syncPorosity();
          for (let s = 0; s < SETTLE_STEPS; s++) {
            snapPins();
            solver.step(1);
            if ((s & 7) === 7) solver.prev.set(solver.pos);
          }
          solver.prev.set(solver.pos);
          syncGeometry();
          syncPins();
        },
        dispose: () => {
          clothGroup.remove(group);
          geom.dispose();
          wireEdgeGeom.dispose();
          wirePointGeom.dispose();
        },
      };
      return unit;
    };

    let units: ClothUnit[] = [];

    // ── Texture loading ─────────────────────────────────────────────────
    // Anisotropic + trilinear texture setup so tiled maps don't moiré.
    const texLoader = new THREE.TextureLoader();
    const anisoMax = renderer.capabilities.getMaxAnisotropy();
    const currentAniso = () =>
      Math.min(propsRef.current.anisotropy ?? 8, anisoMax);
    const configureTex = (t: THREE.Texture, isColor: boolean) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = currentAniso();
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      if (isColor) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    // One entry per texture slot: which uniform it feeds, whether it's a
    // color (sRGB) map, an optional has-flag uniform for maps that may be
    // absent, plus load bookkeeping (current texture + last URL).
    interface TexSlot {
      uniform: string;
      hasFlag?: string;
      isColor: boolean;
      current: THREE.Texture | null;
      lastUrl: string;
    }
    const texSlots: Record<
      "albedo" | "density" | "metalness" | "normal" | "roughness",
      TexSlot
    > = {
      albedo: { uniform: "u_albedoTex", isColor: true, current: null, lastUrl: "" },
      density: { uniform: "u_densityTex", isColor: false, current: null, lastUrl: "" },
      metalness: {
        uniform: "u_metalnessTex",
        hasFlag: "u_hasMetalnessTex",
        isColor: false,
        current: null,
        lastUrl: "",
      },
      normal: {
        uniform: "u_normalTex",
        hasFlag: "u_hasNormalTex",
        isColor: false,
        current: null,
        lastUrl: "",
      },
      roughness: {
        uniform: "u_roughnessTex",
        hasFlag: "u_hasRoughnessTex",
        isColor: false,
        current: null,
        lastUrl: "",
      },
    };
    const setSlotUrl = (slot: TexSlot, url: string) => {
      if (url === slot.lastUrl) return;
      slot.lastUrl = url;
      if (!url) {
        // Cleared — drop the texture and flag so the shader falls back.
        slot.current?.dispose();
        slot.current = null;
        clothMat.uniforms[slot.uniform].value = null;
        if (slot.hasFlag) clothMat.uniforms[slot.hasFlag].value = 0;
        return;
      }
      texLoader.load(url, (tex) => {
        // Bail if unmounted or the slot was re-targeted while loading.
        if (disposed || slot.lastUrl !== url) {
          tex.dispose();
          return;
        }
        configureTex(tex, slot.isColor);
        slot.current?.dispose();
        slot.current = tex;
        clothMat.uniforms[slot.uniform].value = tex;
        if (slot.hasFlag) clothMat.uniforms[slot.hasFlag].value = 1;
      });
    };
    const syncTextures = () => {
      const fab = fabricRef.current;
      setSlotUrl(texSlots.albedo, fab.albedoURL);
      setSlotUrl(texSlots.density, fab.textureURL);
      // Metalness / normal maps stream via props (they live on the material
      // package, not the resolved fabric). Clearing a URL drops the shader
      // back to its no-map fallback.
      setSlotUrl(texSlots.metalness, propsRef.current.metalnessMapURL ?? "");
      setSlotUrl(texSlots.normal, propsRef.current.normalMapURL ?? "");
      setSlotUrl(texSlots.roughness, propsRef.current.roughnessMapURL ?? "");
    };
    syncTextures();

    // Anisotropy is a live perf lever — push the current value onto every
    // loaded cloth + object texture whenever it changes.
    let lastAniso = -1;
    const syncAnisotropy = () => {
      const a = currentAniso();
      if (a === lastAniso) return;
      lastAniso = a;
      for (const slot of Object.values(texSlots)) {
        if (slot.current) {
          slot.current.anisotropy = a;
          slot.current.needsUpdate = true;
        }
      }
      for (const t of objTextures) {
        t.anisotropy = a;
        t.needsUpdate = true;
      }
    };
    // (Porosity is now sampled per cloth unit — see makeClothUnit.)

    // ── Verlet clothesline ──────────────────────────────────────────────
    // Independent particle system pinned at exactly two points: a distant
    // left anchor and a right anchor pulled in close to the fabric's
    // right edge (asymmetric drape — the rope hangs like a real
    // clothesline strung between two posts at different distances).
    // Weak wind, high damping, near-inextensible constraints so the rope
    // reads as taut twine that barely notices the breeze.
    // Constant, decoupled from any unit's cfg so the line stays put across
    // resolution swaps (SHEET_SIZE fixes the sheet height).
    const topWorldY = SHEET_SIZE / 2; // = -cfg.originY, held constant
    const ropeN = 40;
    // Symmetric endpoints: rope stretches evenly across the viewport at
    // one height. The asymmetric drape lives in the fabric (only two
    // cloth-columns are pinned to the rope), not in the wire itself.
    const ropeStartX = -2400;
    const ropeEndX = 2400;
    const ropeLeftY = topWorldY + 155;
    const ropeRightY = topWorldY + 155;
    const straightDist = ropeEndX - ropeStartX;
    // Very slight slack — the rope shows a hair of sag under gravity,
    // otherwise reads as taut and horizontal.
    const ropeSegLen = (straightDist / (ropeN - 1)) * 1.0003;
    const ropePos = new Float32Array(ropeN * 3);
    const ropePrev = new Float32Array(ropeN * 3);
    const ropePinned = new Uint8Array(ropeN);
    for (let i = 0; i < ropeN; i++) {
      const t = i / (ropeN - 1);
      const x = ropeStartX + t * (ropeEndX - ropeStartX);
      const y = ropeLeftY + t * (ropeRightY - ropeLeftY);
      ropePos[i * 3] = x;
      ropePos[i * 3 + 1] = y;
      ropePos[i * 3 + 2] = 0;
      ropePrev[i * 3] = x;
      ropePrev[i * 3 + 1] = y;
      ropePrev[i * 3 + 2] = 0;
    }
    ropePinned[0] = 1;
    ropePinned[ropeN - 1] = 1;

    const stepRope = (t: number, breezeStrength: number) => {
      const g = 0.08;
      const damp = 0.97;
      const gustEnv = Math.max(
        0.2,
        0.6 + Math.sin(t * 0.015) * 0.45 + Math.sin(t * 0.021 + 2.1) * 0.4,
      );
      const dirZ = -1.0;
      const dirX = Math.sin(t * 0.008) * 0.4;
      for (let i = 0; i < ropeN; i++) {
        if (ropePinned[i]) continue;
        // Barely any wind coupling — clothesline is heavy taut twine.
        const turbZ = Math.sin(t * 0.06 + i * 0.35) * 0.08;
        const turbX = Math.cos(t * 0.045 + i * 0.29) * 0.04;
        const wf = breezeStrength * 0.35 * gustEnv;
        const ax = (dirX + turbX) * wf;
        const ay = -g;
        const az = (dirZ + turbZ) * wf;
        const ix = i * 3;
        const nx = ropePos[ix] + (ropePos[ix] - ropePrev[ix]) * damp + ax;
        const ny = ropePos[ix + 1] + (ropePos[ix + 1] - ropePrev[ix + 1]) * damp + ay;
        const nz = ropePos[ix + 2] + (ropePos[ix + 2] - ropePrev[ix + 2]) * damp + az;
        ropePrev[ix] = ropePos[ix];
        ropePrev[ix + 1] = ropePos[ix + 1];
        ropePrev[ix + 2] = ropePos[ix + 2];
        ropePos[ix] = nx;
        ropePos[ix + 1] = ny;
        ropePos[ix + 2] = nz;
      }
      // Many constraint iterations so the rope reads as near-inextensible.
      const iterations = 10;
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < ropeN - 1; i++) {
          const ia = i * 3;
          const ib = (i + 1) * 3;
          const dx = ropePos[ib] - ropePos[ia];
          const dy = ropePos[ib + 1] - ropePos[ia + 1];
          const dz = ropePos[ib + 2] - ropePos[ia + 2];
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < 1e-6) continue;
          const wA = ropePinned[i] ? 0 : 1;
          const wB = ropePinned[i + 1] ? 0 : 1;
          const sum = wA + wB;
          if (sum === 0) continue;
          const k = (dist - ropeSegLen) / dist;
          const shareA = (k * wA) / sum;
          const shareB = (k * wB) / sum;
          ropePos[ia] += dx * shareA;
          ropePos[ia + 1] += dy * shareA;
          ropePos[ia + 2] += dz * shareA;
          ropePos[ib] -= dx * shareB;
          ropePos[ib + 1] -= dy * shareB;
          ropePos[ib + 2] -= dz * shareB;
        }
      }
    };

    // Rope mesh — narrow dark tube through the Verlet particles.
    const ropePoints = Array.from({ length: ropeN }, () => new THREE.Vector3());
    const syncRopePoints = () => {
      for (let i = 0; i < ropeN; i++) {
        ropePoints[i].set(ropePos[i * 3], ropePos[i * 3 + 1], ropePos[i * 3 + 2]);
      }
    };
    syncRopePoints();
    const ropeCurve = new THREE.CatmullRomCurve3(
      ropePoints,
      false,
      "catmullrom",
      0.5,
    );
    const wireRadius = 0.9;
    const wireMat = new THREE.MeshStandardMaterial({
      color: 0x141414,
      roughness: 0.75,
      metalness: 0.15,
    });
    let wireTube = new THREE.TubeGeometry(ropeCurve, 100, wireRadius, 5, false);
    const wireMesh = new THREE.Mesh(wireTube, wireMat);
    scene.add(wireMesh);
    // Tube regeneration is the priciest per-frame allocation in the loop:
    // Frenet frames + ~600 fresh vertices + GPU upload + the old geometry's
    // GC. But the rope is taut and heavily damped — most frames it moves
    // sub-pixel. Snapshot the particle positions at each rebuild and skip
    // regeneration until something drifts past REBUILD_EPS world units
    // (~0.5px at the closest zoom).
    const ropeSnapshot = new Float32Array(ropePos);
    const ROPE_REBUILD_EPS = 0.15;
    const rebuildWireTube = () => {
      let moved = false;
      for (let i = 0; i < ropeN * 3; i++) {
        if (Math.abs(ropePos[i] - ropeSnapshot[i]) > ROPE_REBUILD_EPS) {
          moved = true;
          break;
        }
      }
      if (!moved) return;
      ropeSnapshot.set(ropePos);
      syncRopePoints();
      const next = new THREE.TubeGeometry(ropeCurve, 100, wireRadius, 5, false);
      wireTube.dispose();
      wireTube = next;
      wireMesh.geometry = next;
    };

    // Interpolate the rope's world position at a given cloth-particle X.
    // Used both for pinning cloth's top row and for placing clothespins.
    const ropeSpan = ropeEndX - ropeStartX;
    const ropeAt = (worldX: number, out: THREE.Vector3) => {
      const t = (worldX - ropeStartX) / ropeSpan;
      const rf = Math.max(0, Math.min(ropeN - 1, t * (ropeN - 1)));
      const i0 = Math.floor(rf);
      const i1 = Math.min(ropeN - 1, i0 + 1);
      const alpha = rf - i0;
      const a0 = i0 * 3;
      const a1 = i1 * 3;
      out.set(
        ropePos[a0] + (ropePos[a1] - ropePos[a0]) * alpha,
        ropePos[a0 + 1] + (ropePos[a1 + 1] - ropePos[a0 + 1]) * alpha,
        ropePos[a0 + 2] + (ropePos[a1 + 2] - ropePos[a0 + 2]) * alpha,
      );
      return out;
    };

    // (Clothespins, geometry sync, and pin placement now live inside each
    // cloth unit — see makeClothUnit above. `ropeAt` is defined above and is
    // what those per-unit closures snap to.)

    // ── Sun animation ───────────────────────────────────────────────────
    // Slow full orbit (~50s at 60fps) around the Y axis; the vertical
    // component keeps it above the horizon most of the time and dips
    // beneath so the cloth cycles between back and front lit.
    const sunRadius = 1600;
    let sunPhase = 0.35; // starting angle
    // Scratch objects — all reused each frame to avoid per-tick GC churn.
    const SUN_COOL = new THREE.Color(1.0, 0.95, 0.86);
    const SUN_WARM = new THREE.Color(1.0, 0.7, 0.42);
    const SKY_TOP_DAY = new THREE.Color(0x2c5990);
    const SKY_TOP_HORIZON = new THREE.Color(0x4a6d95);
    const SKY_BOTTOM_HORIZON = new THREE.Color(0xd88a4a);
    const SKY_BOTTOM_DAY = new THREE.Color(0xe8dcb8);
    const sunDir = new THREE.Vector3();
    const sunTint = new THREE.Color();
    const skyTopScratch = new THREE.Color();
    const skyBottomScratch = new THREE.Color();
    const fogScratch = new THREE.Color();
    const sceneFog = scene.fog as THREE.FogExp2;
    const updateSun = () => {
      sunPhase += 0.00025 * (2 * Math.PI);
      const alt = Math.sin(sunPhase * 0.5 + 0.4) * 0.7;
      sun.position.set(
        Math.cos(sunPhase) * sunRadius,
        (0.3 + alt * 0.7) * sunRadius,
        Math.sin(sunPhase) * sunRadius,
      );
      // Same direction fed to cloth and sky. Cloth wants light-travel
      // direction (sun → ground), so pass the negation.
      sunDir.copy(sun.position).normalize();
      clothMat.uniforms.u_lightDir.value.set(-sunDir.x, -sunDir.y, -sunDir.z);
      skyMat.uniforms.u_sunDir.value.copy(sunDir);
      skyMat.uniforms.u_sunAlt.value = THREE.MathUtils.clamp(
        sunDir.y + 0.3,
        0,
        1,
      );

      // Sun colour: warm at the horizon, cool overhead.
      const alt01 = THREE.MathUtils.clamp(sunDir.y + 0.2, 0, 1);
      sunTint.copy(SUN_WARM).lerp(SUN_COOL, alt01);
      sun.color.copy(sunTint);
      sun.intensity = 0.5 + alt01 * 1.6;
      clothMat.uniforms.u_lightColor.value.copy(sunTint).multiplyScalar(1.35);
      skyMat.uniforms.u_sunColor.value.copy(sunTint);

      // Sky gradient shifts too — dawn/dusk warmth vs midday blue.
      skyTopScratch.copy(SKY_TOP_DAY).lerp(SKY_TOP_HORIZON, alt01);
      skyBottomScratch.copy(SKY_BOTTOM_HORIZON).lerp(SKY_BOTTOM_DAY, alt01);
      skyMat.uniforms.u_top.value.copy(skyTopScratch);
      skyMat.uniforms.u_bottom.value.copy(skyBottomScratch);
      // Fog colour lerps with the horizon so distance-haze always reads
      // as lit by the current time of day.
      fogScratch.copy(skyBottomScratch).lerp(skyTopScratch, 0.35);
      fogColor.copy(fogScratch);
      sceneFog.color.copy(fogScratch);
      clothMat.uniforms.u_fogColor.value.copy(fogScratch);
    };

    // ── Cloth ↔ object transition ───────────────────────────────────────
    // Everything cloth-y (rope + the live cloth unit(s)) goes under one group
    // so the whisk-away is a single transform + fade. Cloth units are added to
    // this group as they're built.
    const clothGroup = new THREE.Group();
    clothGroup.add(wireMesh);
    scene.add(clothGroup);
    // Rope + pins are opaque standard materials; let them fade with the cloth.
    wireMat.transparent = true;
    pinBodyMat.transparent = true;

    // The initial cloth unit. `ropeAt` and `clothGroup` now exist, so the
    // factory can settle (which snaps to the rope). Pre-settled so it appears
    // already draped, not slamming into the line.
    {
      const p0 = propsRef.current;
      const initial = makeClothUnit(
        p0.meshCols ?? 48,
        p0.meshRows ?? 48,
        p0.pinMode ?? "pegs",
        0,
        0,
      );
      initial.settle();
      clothGroup.add(initial.group);
      units.push(initial);
    }

    // Slide state for resolution/pin swaps. A change spawns a fresh unit at
    // −SLIDE_DIST (off the left, already settled) and pushes every current
    // unit to the right; `slideT` eases them across, then the departed units
    // are disposed.
    const SLIDE_DIST = 1150;
    const SLIDE_MS = 900; // wall-clock slide duration
    let slideT = 1; // 1 = settled, no slide in progress
    let lastMeshCols = propsRef.current.meshCols ?? 48;
    let lastMeshRows = propsRef.current.meshRows ?? 48;
    let lastPinMode = propsRef.current.pinMode ?? "pegs";
    const finalizeSlide = () => {
      // Keep the newest unit (the incoming one), snap it home, drop the rest.
      const keep = units[units.length - 1];
      keep.group.position.x = 0;
      keep.fromX = 0;
      keep.toX = 0;
      for (const u of units) if (u !== keep) u.dispose();
      units = [keep];
      slideT = 1;
    };

    // Object lives in the same scene, at the same origin, scaled to roughly
    // the cloth's on-screen size and lit by the same moving sun + fog.
    const objectGroup = new THREE.Group();
    objectGroup.visible = false;
    scene.add(objectGroup);
    const objectMat = new THREE.MeshPhysicalMaterial({
      color: 0xbfc4c8,
      roughness: 0.9,
      metalness: 0.0,
      // The cloth shader has no dielectric GGX lobe at all — only a soft
      // grazing sheen. A default MeshPhysicalMaterial gets a full specular
      // hotspot from the directional sun and reads as tacky plastic next to
      // it. specularIntensity collapses that lobe for DIELECTRICS only —
      // metals' F0 comes from albedo, so sequins/metalness maps stay shiny.
      specularIntensity: 0.25,
      sheen: 0.9,
      sheenColor: new THREE.Color(0xf3dcb1),
      // Glossier velvet sits at ~0.4; fabric wants a broad, matte sheen.
      sheenRoughness: 0.8,
      thickness: 0.35,
      ior: 1.4,
      side: THREE.DoubleSide,
      transparent: true,
    });
    let objectReady = false;
    let objectFitScale = 1;
    import("three/examples/jsm/loaders/GLTFLoader.js")
      .then((mod) => {
        if (disposed) return;
        new mod.GLTFLoader().load(objectModelUrl, (gltf) => {
          if (disposed) return;
          const root = gltf.scene;
          // Fit to ~520 solver units on its largest axis so it occupies a
          // similar slice of frame to the hanging cloth.
          const box = new THREE.Box3().setFromObject(root);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          objectFitScale = 520 / maxDim;
          root.scale.setScalar(objectFitScale);
          box.setFromObject(root);
          const center = new THREE.Vector3();
          box.getCenter(center);
          root.position.sub(center);
          root.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = objectMat;
          });
          objectGroup.add(root);
          objectReady = true;
        });
      })
      .catch(() => {
        // Object is an enhancement; cloth mode is unaffected if it fails.
      });

    // Object texture set — mirrors ObjectViewer's slot mapping. Reloaded when
    // the material package changes; repeat driven by objectTileScale.
    const objTextures: THREE.Texture[] = [];
    let lastObjPkgId = "__unset__";
    let lastObjTile = -1;
    const applyObjectRepeat = () => {
      // Floor is tiny (not 0.25) so any deliberate object tiling — coarse or
      // fine — is honoured rather than silently clamped. Default 5 = the
      // object weave reads 5× finer than the cloth (objectTileScale = tile×5).
      const rep = Math.max(0.02, propsRef.current.objectTileScale ?? 5);
      if (rep === lastObjTile) return;
      lastObjTile = rep;
      for (const t of objTextures) t.repeat.set(rep, rep);
    };
    const syncObjectTextures = () => {
      const pkg = propsRef.current.pkg ?? null;
      const id = pkg?.id ?? "";
      if (id === lastObjPkgId) {
        applyObjectRepeat();
        return;
      }
      lastObjPkgId = id;
      for (const t of objTextures) t.dispose();
      objTextures.length = 0;
      lastObjTile = -1;
      const applied: Partial<Record<MapName, THREE.Texture>> = {};
      let pending = 0;
      const finalize = () => {
        if (disposed) return;
        objectMat.map = applied.albedo ?? null;
        objectMat.normalMap = applied.normal ?? null;
        objectMat.roughnessMap = applied.roughness ?? null;
        objectMat.metalnessMap = applied.metalness ?? null;
        objectMat.aoMap = applied.ao ?? null;
        objectMat.bumpMap = applied.height ?? null;
        objectMat.thicknessMap = applied.height ?? null;
        objectMat.sheenRoughnessMap = applied.roughness ?? null;
        if (objectMat.bumpMap) objectMat.bumpScale = 0.04;
        objectMat.color = applied.albedo
          ? new THREE.Color(0xffffff)
          : new THREE.Color(0xbfc4c8);
        objectMat.roughness = applied.roughness ? 1 : 0.9;
        objectMat.needsUpdate = true;
        applyObjectRepeat();
      };
      const entries = OBJECT_TEX_KEYS.map((n) => [n, pkg?.maps[n]] as const).filter(
        ([, e]) => Boolean(e),
      );
      if (entries.length === 0) {
        finalize();
        return;
      }
      pending = entries.length;
      for (const [name, entry] of entries) {
        texLoader.load(
          entry!.url,
          (tex) => {
            if (disposed) {
              tex.dispose();
              return;
            }
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = currentAniso();
            if (name === "albedo") tex.colorSpace = THREE.SRGBColorSpace;
            applied[name] = tex;
            objTextures.push(tex);
            if (--pending === 0) finalize();
          },
          undefined,
          () => {
            // One bad map shouldn't strand the material half-loaded.
            if (--pending === 0) finalize();
          },
        );
      }
    };

    // blend: 0 = pure cloth, 1 = pure object. Eased by the bezier for the
    // whisk/surface; its per-frame delta is the "bezier-mediated speed" that
    // drives the object's spin-in. Timing is WALL-CLOCK (ms), not per-frame,
    // so the ~1s duration holds whatever the frame rate — a slow GPU no
    // longer stretches the transition to a crawl.
    const easeTransition = makeCubicBezier(0.65, 0.0, 0.35, 1.0);
    const TRANSITION_MS = 1100; // cloth↔object duration
    const OBJECT_SPIN = Math.PI * 2 * 1.25; // 1¼ turns as it surfaces
    let blend = props.mode === "object" ? 1 : 0;
    let easedPrev = easeTransition(blend);
    let objectSpin = 0;

    // ── Loop ────────────────────────────────────────────────────────────
    let time = 0;
    let raf = 0;
    let lastPixelRatio = pixelScale;
    let lastNow = performance.now();
    // Stats accumulators — averaged and emitted ~2 Hz via onStats.
    let statFrames = 0;
    let statDtMs = 0;
    let statSimMs = 0;
    // (Fabric hot-swap is per unit now — each unit re-runs setFabric only
    // when the fabric object identity actually changes; see stepSim.)

    const tick = () => {
      time++;
      const p = propsRef.current;
      // Wall-clock delta, clamped so a background-tab stall doesn't teleport
      // the transition or spike the FPS meter.
      const now = performance.now();
      const dtMs = Math.min(100, now - lastNow);
      lastNow = now;

      syncAnisotropy();

      // Sun / sky / fog advance every frame — both stages share that
      // atmosphere, so this runs regardless of the transition state.
      updateSun();

      // Advance the cloth↔object blend toward the target mode, ease it, and
      // derive the two visibility gates.
      const target = p.mode === "object" ? 1 : 0;
      const blendStep = dtMs / TRANSITION_MS;
      if (blend < target) blend = Math.min(target, blend + blendStep);
      else if (blend > target) blend = Math.max(target, blend - blendStep);
      const eased = easeTransition(blend);
      const clothVisible = eased < 0.999;
      const objectVisible = eased > 0.001;

      // Whisk the cloth up and out as it fades to transparent.
      clothGroup.visible = clothVisible;
      clothMat.uniforms.u_fade.value = 1 - eased;
      wireMat.opacity = 1 - eased;
      pinBodyMat.opacity = 1 - eased;
      wireEdgeMat.opacity = (1 - eased) * 0.65;
      wirePointMat.opacity = 1 - eased;
      clothGroup.position.y = eased * 950;

      // Wire debug view: swap the shaded sheet for the raw structure on every
      // live unit — vertices + constraint edges, velocity-colored.
      const wf = p.wireframe === true;
      for (const un of units) un.setVisible(wf);

      // Resolution / pin-mode change → slide the old cloth off to the right
      // and a fresh one in from the left. Read live from props (deps []
      // capture stale mount-time values). The incoming unit is built AND
      // settled off-screen, so its drop-and-drape is never seen — it arrives
      // already hanging. This is the "slide instead of rebuild" swap.
      const mc = p.meshCols ?? 48;
      const mr = p.meshRows ?? 48;
      const pm = p.pinMode ?? "pegs";
      if (mc !== lastMeshCols || mr !== lastMeshRows || pm !== lastPinMode) {
        if (slideT < 1) finalizeSlide(); // collapse any in-flight slide first
        lastMeshCols = mc;
        lastMeshRows = mr;
        lastPinMode = pm;
        const incoming = makeClothUnit(mc, mr, pm, -SLIDE_DIST, time);
        incoming.settle();
        clothGroup.add(incoming.group);
        for (const un of units) {
          un.fromX = un.group.position.x;
          un.toX = un.group.position.x + SLIDE_DIST;
        }
        incoming.fromX = -SLIDE_DIST;
        incoming.toX = 0;
        units.push(incoming);
        slideT = 0;
      }

      // Advance an in-progress slide (bezier-eased, reusing the transition
      // curve), then retire the units that have left frame. Wall-clock timed.
      if (slideT < 1) {
        slideT = Math.min(1, slideT + dtMs / SLIDE_MS);
        const se = easeTransition(slideT);
        for (const un of units) {
          un.group.position.x = un.fromX + (un.toX - un.fromX) * se;
        }
        if (slideT >= 1) finalizeSlide();
      }

      // Skip the whole solver when the cloth is gone — no point simulating an
      // invisible sheet (this is the "don't re-render everything" win).
      const simStart = performance.now();
      if (clothVisible) {
        // Rope physics runs first — its positions drive both cloth pinning
        // and the visible wire geometry this frame.
        stepRope(time, p.breeze ?? 0.06);
        // Only the CURRENT unit simulates. During a slide the departing
        // sheet(s) ride off as frozen drapes — nobody inspects their physics
        // at slide speed, and this keeps a res-switch from double-billing the
        // solver (self-collision especially).
        units[units.length - 1].stepSim(time, true);
        // rebuildWireTube syncs curve points itself, and only when the rope
        // has actually drifted since the last built tube.
        rebuildWireTube();
        // Cloth material textures are shared across units — sync once.
        syncTextures();
      }
      statSimMs += performance.now() - simStart;

      // Surface the object: rise from below, scale up, and spin. The spin
      // increment is the *eased delta*, so its speed ramps in and out with
      // the bezier — the "bezier-curve-mediated speed" of the surfacing.
      objectGroup.visible = objectVisible && objectReady;
      if (objectVisible) {
        objectSpin += (eased - easedPrev) * OBJECT_SPIN;
        objectGroup.rotation.y = objectSpin;
        objectGroup.position.y = (1 - eased) * -620;
        objectGroup.scale.setScalar(0.8 + 0.2 * eased);
        objectMat.opacity = eased;
        // Three's sheen BRDF is stronger than the cloth's ×0.5 grazing rim,
        // so scale it down to keep the two renderers' rim intensity matched.
        objectMat.sheen = fabricRef.current.sheen * 0.6;
        // Deliberately NO transmission on the object: MeshPhysicalMaterial
        // transmission > 0 makes Three render the entire scene an extra time
        // into a transmission framebuffer every frame — a huge cost on older
        // GPUs for an effect that barely reads on a solid object. (Writing
        // the property here without it in the constructor was also a no-op:
        // the shader compiles without the transmission define.)
        objectMat.metalness = Math.min(1, Math.max(0, p.metalness ?? 0));
        syncObjectTextures();
      }
      easedPrev = eased;

      // Push knob uniforms — cheap, and lets sliders take effect immediately.
      const u = clothMat.uniforms;
      // Collapse the transparency cluster: one openness scalar drives all
      // three shader uniforms via the step-3 formulas. Legacy props still
      // win if a caller explicitly sets them (one-release compat).
      const o = p.openness ?? 0.55;
      u.u_translucency.value = p.translucency ?? o;
      u.u_densityAmount.value = p.densityAmount ?? (1 - 0.5 * o);
      u.u_alphaFromDensity.value = p.alphaFromDensity ?? (0.1 * o);
      u.u_alphaBoost.value = p.alphaBoost ?? 0;
      u.u_alphaBoostSource.value = p.alphaBoostSource ?? 0;
      u.u_albedoAmount.value = p.albedoAmount ?? 1;
      u.u_metalness.value = p.metalness ?? 0;
      u.u_normalAmount.value = p.normalAmount ?? 1;
      u.u_pomShadow.value = p.pomShadow ?? 0.55;
      u.u_stretch.value = p.stretch ?? 0;
      u.u_stretchDebug.value = p.stretchDebug ? 1 : 0;
      u.u_pomScale.value = p.pomScale ?? 0.015;
      u.u_pomMinSteps.value = p.pomMinSteps ?? 8;
      u.u_pomMaxSteps.value = p.pomMaxSteps ?? 32;
      u.u_pomDebug.value = p.pomDebug ?? 0;
      u.u_edgeInset.value = p.edgeInset ?? 0.008;
      u.u_edgeFray.value = p.edgeFray ?? 0.12;
      u.u_edgeSharpness.value = p.edgeSharpness ?? 0.15;
      u.u_edgeDetail.value = p.edgeDetail ?? 1;
      u.u_tileScale.value = p.tileScale ?? 1;
      u.u_txHeight.value = p.txHeight ?? 1;
      u.u_txAlbedo.value = p.txAlbedo ?? 0;
      u.u_txRoughness.value = p.txRoughness ?? 0;
      u.u_transmissionContrast.value = p.transmissionContrast ?? 0.3;
      u.u_sheen.value = fabricRef.current.sheen;

      // Skybox mode is just a shader uniform on the sky mesh — lighting is
      // driven by the DirectionalLight/HemisphereLight/cloth uniforms and
      // stays exactly the same across modes.
      skyMat.uniforms.u_skyMode.value = p.skyMode ?? 0;

      // setPixelRatio unconditionally re-runs setSize, which reassigns
      // canvas.width — per the HTML spec that clears/reallocates the drawing
      // buffer even at the same value. Only touch it when quality changes.
      const nextRatio = p.pixelScale ?? 1;
      if (nextRatio !== lastPixelRatio) {
        lastPixelRatio = nextRatio;
        renderer.setPixelRatio(nextRatio);
      }
      // Advances damping so the rotate/zoom motion continues to ease
      // after the pointer is released.
      controls?.update();
      renderer.render(scene, camera);

      // Telemetry: average over ~30 frames (2 Hz) and hand back FPS, sim-ms,
      // and draw stats. renderer.info is populated by the render() above.
      statFrames++;
      statDtMs += dtMs;
      if (statFrames >= 30) {
        propsRef.current.onStats?.({
          fps: statDtMs > 0 ? 1000 / (statDtMs / statFrames) : 0,
          simMs: statSimMs / statFrames,
          tris: renderer.info.render.triangles,
          calls: renderer.info.render.calls,
        });
        statFrames = 0;
        statDtMs = 0;
        statSimMs = 0;
      }

      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls?.dispose();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      for (const un of units) un.dispose(); // per-unit geometries
      clothMat.dispose();
      wireEdgeMat.dispose();
      wirePointMat.dispose();
      skyGeom.dispose();
      skyMat.dispose();
      wireTube.dispose();
      wireMat.dispose();
      pinBodyGeom.dispose();
      pinBodyMat.dispose();
      for (const slot of Object.values(texSlots)) slot.current?.dispose();
      objectGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
      objectMat.dispose();
      for (const t of objTextures) t.dispose();
      renderer.dispose();
    };
    // Mount ONCE. meshCols/meshRows/pinMode changes are handled imperatively
    // by the slide swap in the tick — re-running this effect would tear down
    // the renderer, camera, textures, sun, and object every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        display: "block",
        width: width ? `${width}px` : "100%",
        height: height ? `${height}px` : "100%",
        touchAction: "none",
      }}
    />
  );
}
