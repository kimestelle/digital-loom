"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
} from "react";
import * as THREE from "three/webgpu";
import {
  ClothSolver,
  DEFAULT_CONFIG,
  FixedStepAccumulator,
  type ClothConfig,
} from "@/lib/cloth/ClothSolver";
import {
  clampPointerTravel,
  CLOTH_INTERACTION_RADIUS,
  CLOTH_PLUCK_RADIUS,
  CLOTH_POINTER_PROFILES,
  normalizeClothPointerKind,
  resolveMouseForce,
  updateContactVelocity,
  type ClothPointerKind,
} from "@/lib/cloth/pointerInteraction";
import type { ResolvedFabric } from "@/lib/cloth/fabrics";
import type { MapName, MaterialPackage } from "@/lib/core/materialPackage";
import {
  createClothMaterial,
  createSkyMaterial,
  createLensFlareMaterial,
  createWireMaterial,
} from "@/lib/ui/clothSceneNodes";
import {
  CLOTH_LAUNCH_MAP_WAIT_MS,
  CLOTH_LAUNCH_HIDDEN_SETTLE_TICKS,
  CLOTH_LAUNCH_SETTLE_ITERATIONS,
  CLOTH_LAUNCH_SETTLE_STEPS,
  CLOTH_LAUNCH_TOTAL_MS,
  seedClothLaunchDrape,
} from "@/lib/ui/clothLaunchShimmer";
import { easeMotion } from "@/lib/ui/motion";

// Development escape hatch: flip to true to run the scene on the WebGL 2
// backend even where WebGPU is available (the same fallback path browsers
// without WebGPU take automatically). Useful for eyeballing backend parity.
const FORCE_WEBGL = false;

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
  /** Optional roughness map URL (from the Patina pipeline). It shapes the
   *  surface sheen and metallic highlight, and can also drive threadbare wear. */
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
  /** Rainbow refraction amount (0 = off). Drives the cloth's transmission
   *  dispersion + grating sheen, the sky's circumsolar ring, and the
   *  object's physical iridescence — one knob, four spectral effects. */
  iridescence?: number;
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
  /** Multiplier on the safe mouse hover + travel profile. Touch and pen keep
   *  their own direct-contact profiles. */
  mouseForce?: number;

  /** Shared, imperatively animated reveal value for material transfers. The
   *  render loop reads it directly so a pixel dissolve never re-renders the
   *  React tree at 60 fps. */
  materialRevealRef?: MutableRefObject<number>;
  /** Selection generation whose albedo readiness should be acknowledged. */
  materialTransitionKey?: number;
  materialExpectedAlbedoURL?: string;
  onMaterialReady?: (key: number) => void;

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
  /** GPU render-pass duration when timestamp queries are supported. */
  gpuMs?: number;
  /** Triangles drawn last frame (renderer.info). */
  tris: number;
  /** Draw calls last frame (renderer.info). */
  calls: number;
}

/** Named, repeatable material tests exposed to the studio controls. */
export type ClothProbe = "still" | "gust" | "pull" | "reset";

export interface ClothSceneHandle {
  /** Reset to the canonical drape, then optionally replay a fixed force. */
  runProbe: (probe: ClothProbe) => void;
}

// The cloth and sky node materials live in clothSceneNodes.ts — this file
// stays focused on scene setup, physics wiring, and rendering.

const ClothScene = forwardRef<ClothSceneHandle, Props>(function ClothScene(
  props,
  ref,
) {
  const {
    fabric,
    // No size defaults: when omitted the mount div is 100% × 100% and the
    // scene fills its container (a ResizeObserver drives the actual canvas
    // size). The studio passes measured pixels; the embed passes nothing.
    width,
    height,
    // Every knob prop is read live from propsRef in the tick loop — only the
    // mount-time values are destructured here.
    pixelScale = 1,
    objectModelUrl = "/model/whale.glb",
  } = props;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const probeRunnerRef = useRef<((probe: ClothProbe) => void) | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      runProbe: (probe) => probeRunnerRef.current?.(probe),
    }),
    [],
  );

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
    // WebGPU where the browser supports it; the renderer transparently falls
    // back to a WebGL 2 backend elsewhere (TSL materials compile for both).
    const renderer = new THREE.WebGPURenderer({
      // MSAA on top of ≥1.5× supersampling is redundant — the supersample
      // already anti-aliases, and the combined backing-store bandwidth is
      // what kills older GPUs. Only request MSAA at lower pixel scales,
      // where edges would otherwise stair-step. (Construction-time only;
      // runtime quality flips keep whichever choice the mount made.)
      antialias: pixelScale < 1.5,
      alpha: false,
      powerPreference: "high-performance",
      forceWebGL: FORCE_WEBGL,
      // Gives the in-product meter an actual GPU duration instead of asking
      // FPS to stand in for both CPU and fragment cost. Unsupported backends
      // simply leave gpuMs absent.
      trackTimestamp: true,
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
    // and reads as light scattering through moist air. (Dialed down from
    // 0.00035 — with the veiling glare now adding its own near-sun haze the
    // original density read as an overcast murk.)
    const fogColor = new THREE.Color(0xbecfe0);
    scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.00019);

    // Camera framing — cloth spans roughly 423 units in solver units and we
    // want it to occupy about 60% of the frame vertically (matches the
    // original cloth-sim look). At FOV 30, tan(15°) ≈ 0.268, so a distance
    // of ~1300 puts the visible view height near ~695 units → cloth at
    // ~60% vertical.
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 8000);
    // Starting framing: a low, oblique angle nearly along the clothesline's
    // own length — the line reads as a long diagonal across the frame
    // instead of a level bar, and the cloth looms large and a little
    // twisted, more editorial than a dead-on catalog shot. Target stays the
    // origin (OrbitControls' own default target), so this only shapes the
    // opening frame — the orbit pivot for later interaction is unaffected,
    // and there's no target mismatch for controls.update() to snap away on
    // the first drag.
    camera.position.set(0, -720, -1200);
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
        // Touch remap: two fingers get the mouse-drag effect (orbit, plus
        // pinch-to-zoom standing in for the scroll wheel); one finger gets
        // NO camera gesture at all, so it falls straight through to the
        // pointermove listener below as the mouse-hover equivalent (that
        // listener isn't gated on button state — it already treats any
        // pointer motion over the canvas, mouse or touch, as "hovering").
        // `null` is OrbitControls' documented way to disable a touch-count
        // mapping (there's no TOUCH.NONE constant).
        c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
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
    // ResizeObserver fires repeatedly — often dozens of times a second —
    // while a window is being live-dragged. renderer.setSize() tears down
    // and reconfigures the WebGPU swap chain on every call, so calling it
    // unthrottled during a drag hammers that reconfiguration continuously,
    // which is what reads as on-screen flicker. Coalesce to at most one
    // actual resize per animation frame; a pending one is cancelled on
    // unmount so it can't fire after the renderer's been disposed.
    let resizeRaf = 0;
    const scheduleResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        resize();
      });
    };
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(container);

    // ── Sky ─────────────────────────────────────────────────────────────
    const skyGeom = new THREE.SphereGeometry(3500, 32, 24);
    const { material: skyMat, u: skyU } = createSkyMaterial();
    // The bundle owns its own Color instances (no aliasing with fogColor) —
    // seed the fog tint once; updateSun keeps it in sync every frame.
    skyU.u_fogColor.value.copy(fogColor);
    const skyMesh = new THREE.Mesh(skyGeom, skyMat);
    scene.add(skyMesh);

    // ── Lens flare overlay ──────────────────────────────────────────────
    // Additive fullscreen quad drawn after everything (the material's
    // vertexNode bypasses the camera). The tick projects the sun to NDC,
    // fades the flare at the frame edges, and hides the quad outright when
    // it would be invisible so the overlay costs nothing most of the time.
    const { material: flareMat, u: flareU } = createLensFlareMaterial();
    const flareGeom = new THREE.PlaneGeometry(2, 2);
    const flareQuad = new THREE.Mesh(flareGeom, flareMat);
    flareQuad.frustumCulled = false;
    flareQuad.renderOrder = 999;
    flareQuad.visible = false;
    scene.add(flareQuad);
    const flareSunVec = new THREE.Vector3();
    const flareDirVec = new THREE.Vector3();
    const flareCamDir = new THREE.Vector3();
    // Smoothed cloth-occlusion factor for the flare (1 = unobstructed).
    let flareOcclusion = 1;

    // ── Lighting ────────────────────────────────────────────────────────
    // Hemisphere sky-bounce plus the moving sun as a directional.
    const hemi = new THREE.HemisphereLight(0xb5d0e6, 0x8b7146, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
    scene.add(sun);
    const sunTarget = new THREE.Object3D();
    scene.add(sunTarget);
    sun.target = sunTarget;

    // ── Pointer interaction (3D) ────────────────────────────────────────
    // Raycast the pointer against the plane the cloth hangs in (Z=0 in
    // world space), then feed the resulting world XY back into solver
    // coords (solver Y+ is down, world Y+ is up). Solver's applyCursor
    // operates in XY so we don't need per-triangle intersection — the
    // Z-plane projection is accurate enough for hover interaction.
    // Mouse travel is consumed once, while hover pressure remains active on
    // every simulation tick. Touch and pen travel is filtered into a continuous
    // contact field; their stronger profiles live in pointerInteraction.ts so
    // feel can be tuned without touching rendering.
    const pointer = {
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      velocityX: 0,
      velocityY: 0,
      active: false,
      pending: false,
      pendingPluck: false,
      pressed: false,
      pointerId: null as number | null,
      kind: "mouse" as ClothPointerKind,
    };
    const directPointerIds = new Set<number>();
    const mousePress = {
      pointerId: null as number | null,
      startX: 0,
      startY: 0,
      moved: false,
    };
    let suppressDirectGesture = false;
    const clearDirectPointer = () => {
      pointer.active = false;
      pointer.pending = false;
      pointer.pendingPluck = false;
      pointer.pressed = false;
      pointer.pointerId = null;
      pointer.dx = 0;
      pointer.dy = 0;
      pointer.velocityX = 0;
      pointer.velocityY = 0;
    };
    const raycaster = new THREE.Raycaster();
    const cursorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const cursorPoint = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const updatePointerPosition = (
      e: PointerEvent,
      accumulateTravel: boolean,
    ): boolean => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.ray.intersectPlane(cursorPlane, cursorPoint);
      if (hit) {
        const nextX = cursorPoint.x;
        const nextY = -cursorPoint.y; // world Y+ up → solver Y+ down
        if (pointer.active && accumulateTravel) {
          // Accumulate events between fixed ticks; the solver consumes the
          // total path once rather than multiplying work by pointer-event rate.
          pointer.dx += nextX - pointer.x;
          pointer.dy += nextY - pointer.y;
        }
        pointer.x = nextX;
        pointer.y = nextY;
        pointer.active = true;
        pointer.pending ||= accumulateTravel;
        pointer.kind = normalizeClothPointerKind(e.pointerType);
        return true;
      }
      return false;
    };
    const onPointerMove = (e: PointerEvent) => {
      const kind = normalizeClothPointerKind(e.pointerType);
      if (kind === "mouse" && mousePress.pointerId === e.pointerId) {
        mousePress.moved ||=
          Math.hypot(e.clientX - mousePress.startX, e.clientY - mousePress.startY) > 6;
      }
      if (
        kind !== "mouse" &&
        (suppressDirectGesture ||
          !pointer.pressed ||
          pointer.pointerId !== e.pointerId)
      ) {
        return;
      }
      // While a finger/stylus owns the material interaction, ignore secondary
      // pointers. OrbitControls can still consume a two-finger gesture.
      if (pointer.pointerId !== null && e.pointerId !== pointer.pointerId) return;
      updatePointerPosition(e, true);
    };
    const onPointerDown = (e: PointerEvent) => {
      const kind = normalizeClothPointerKind(e.pointerType);
      // Mouse remains a hover instrument so its primary drag can orbit the
      // camera. Touch and pen are direct material contacts.
      if (kind === "mouse") {
        mousePress.pointerId = e.pointerId;
        mousePress.startX = e.clientX;
        mousePress.startY = e.clientY;
        mousePress.moved = false;
        return;
      }
      directPointerIds.add(e.pointerId);
      if (directPointerIds.size > 1) {
        // Two fingers belong exclusively to OrbitControls. Without this gate,
        // the primary finger also fed the newly amplified cloth force while the
        // camera orbited, leaving an accidental crease after navigation.
        suppressDirectGesture = true;
        clearDirectPointer();
        return;
      }
      if (suppressDirectGesture || !e.isPrimary) return;
      pointer.active = false; // do not connect this contact to a stale hover
      pointer.dx = 0;
      pointer.dy = 0;
      pointer.pending = false;
      pointer.pendingPluck = false;
      pointer.velocityX = 0;
      pointer.velocityY = 0;
      if (!updatePointerPosition(e, false)) return;
      pointer.kind = kind;
      pointer.pointerId = e.pointerId;
      pointer.pressed = true;
      pointer.pendingPluck = true;
    };
    const finishDirectPointer = (e: PointerEvent, cancelled: boolean) => {
      directPointerIds.delete(e.pointerId);
      if (suppressDirectGesture) {
        clearDirectPointer();
        if (directPointerIds.size === 0) suppressDirectGesture = false;
        return;
      }
      if (e.pointerId !== pointer.pointerId) return;
      pointer.active = false;
      pointer.pending = false;
      // Keep a completed tap's one-shot pluck queued for the next fixed tick.
      // A cancelled OS gesture should not affect the material.
      if (cancelled) pointer.pendingPluck = false;
      pointer.pressed = false;
      pointer.pointerId = null;
      pointer.dx = 0;
      pointer.dy = 0;
      pointer.velocityX = 0;
      pointer.velocityY = 0;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (mousePress.pointerId === e.pointerId) {
        if (!mousePress.moved && updatePointerPosition(e, false)) {
          pointer.kind = "mouse";
          pointer.pendingPluck = true;
        }
        mousePress.pointerId = null;
        return;
      }
      finishDirectPointer(e, false);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (mousePress.pointerId === e.pointerId) mousePress.pointerId = null;
      finishDirectPointer(e, true);
    };
    const onLostPointerCapture = (e: PointerEvent) => {
      if (e.pointerId === pointer.pointerId) finishDirectPointer(e, true);
    };
    const onWindowBlur = () => {
      mousePress.pointerId = null;
      directPointerIds.clear();
      suppressDirectGesture = false;
      clearDirectPointer();
    };
    const onPointerLeave = () => {
      // Direct pointers receive pointerup/pointercancel through implicit touch
      // capture. A mouse leaving the canvas should stop compounding at once.
      if (pointer.pressed) return;
      mousePress.pointerId = null;
      pointer.active = false;
      pointer.pending = false;
      pointer.pendingPluck = false;
      pointer.dx = 0;
      pointer.dy = 0;
      pointer.velocityX = 0;
      pointer.velocityY = 0;
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerCancel);
    renderer.domElement.addEventListener(
      "lostpointercapture",
      onLostPointerCapture,
    );
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("blur", onWindowBlur);
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
    // TSL node material with all knob uniforms; the tick loop pushes the
    // prop-derived values (openness formulas included) before the first
    // render, so the bundle's defaults only matter for the few constants the
    // loop never touches.
    const {
      material: clothMat,
      u: clothU,
      tex: clothTex,
      blanks: clothBlanks,
      launchShimmer,
    } = createClothMaterial();
    clothU.u_fogColor.value.copy(fogColor);
    const launchReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    clothU.u_launchProgress.value = launchReducedMotion ? 1 : 0;
    container.dataset.clothLaunch = launchReducedMotion ? "ready" : "waiting";
    let launchWaitStartedAt = Infinity;
    let launchStartedAt: number | null = null;
    let launchComplete = launchReducedMotion;
    // ── Cloth unit factory ──────────────────────────────────────────────
    // A "unit" is a complete, independent cloth: its own solver, geometry,
    // wire-debug draws, and pins, all under one group. Normally one is live;
    // during a resolution/pin change two coexist briefly while the old slides
    // off and the new slides in. `ropeAt` / `clothGroup` are referenced lazily
    // (defined below) — the factory is only *called* after they exist.
    const WIRE_V_MAX = 8; // wire-view velocity→white clip (units/fixed tick)
    const FULL_SETTLE_STEPS = 110; // off-screen pre-drape for later unit swaps
    const WIND_RAMP = 90; // fixed ticks to fade breeze in on a fresh unit
    const GUST_PROBE_TICKS = 72;
    const PULL_PROBE_TICKS = 54;
    const GUST_PROBE_STRENGTH = 0.24;
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
      syncView: () => void;
      setVisible: (wf: boolean) => void;
      settle: (mode?: "full" | "launch" | "probe") => void;
      resetToBaseline: () => void;
      dispose: () => void;
    }

    interface ActiveProbe {
      kind: "gust" | "pull";
      tick: number;
    }
    let activeProbe: ActiveProbe | null = null;

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
      const applyPinLayout = () => {
        if (pinModeVal === "pegs") {
          // Pin fractions relative to width so the drape looks the same at
          // every resolution.
          solver.setPinned(Math.round(cols * 0.08), true);
          solver.setPinned(Math.round(cols * 0.88), true);
        } else {
          solver.pinTopEdge();
        }
      };
      applyPinLayout();

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
          const requestedIterations = propsRef.current.iterations ?? 6;
          // A newly born, nearly flat sheet cannot meaningfully self-collide.
          // Keep that expensive pass off until the shimmer lands, while full
          // constraint iterations quietly finish the drape behind the reveal.
          solver.setIterations(requestedIterations);
          solver.selfCollisionEvery = launchComplete
            ? SC_EVERY[propsRef.current.selfCollide ?? "full"]
            : 0;
          // Wind fades in over WIND_RAMP fixed ticks so a just-born unit isn't
          // kicked before it has finished settling.
          const windScale = Math.min(1, (time - unit.birth) / WIND_RAMP);
          snapPins();
          if (activeProbe?.kind === "gust") {
            // A fixed phase and a sine envelope make every audition identical;
            // this replaces ambient wind for the duration rather than stacking
            // another force/render loop on top of it.
            const phase = (activeProbe.tick + 1) / GUST_PROBE_TICKS;
            const envelope = Math.sin(Math.PI * phase);
            solver.applyWind(
              40 + activeProbe.tick,
              GUST_PROBE_STRENGTH * envelope,
            );
          } else if (activeProbe?.kind === "pull") {
            // Pull the same lower-center particle toward the same target with
            // a smooth engage/release envelope. This is deliberately one
            // point: the material's constraints decide how the rest follows.
            const row = Math.round((rows - 1) * 0.68);
            const col = Math.round((cols - 1) * 0.52);
            const particle = row * cols + col;
            const span = (cols - 1) * spacing;
            const phase = (activeProbe.tick + 1) / PULL_PROBE_TICKS;
            const envelope = Math.sin(Math.PI * phase);
            const restX = cfg.originX + col * spacing;
            const restY = cfg.originY + row * spacing;
            const ix = particle * 3;
            const response = fabricRef.current.windResponse;
            const spring = 0.038 * envelope * response;
            solver.addAcceleration(
              particle,
              (restX + span * 0.28 - solver.pos[ix]) * spring,
              (restY - span * 0.08 - solver.pos[ix + 1]) * spring,
              (-span * 0.25 - solver.pos[ix + 2]) * spring,
            );
          } else {
            solver.applyWind(
              time,
              (propsRef.current.breeze ?? 0.06) * windScale,
            );
          }
          if (allowCursor && (pointer.active || pointer.pendingPluck)) {
            const localX = pointer.x - group.position.x;
            const profile = CLOTH_POINTER_PROFILES[pointer.kind];
            const mouseForce =
              pointer.kind === "mouse"
                ? resolveMouseForce(propsRef.current.mouseForce)
                : 1;
            if (pointer.pendingPluck && profile.pluckStrength > 0) {
              solver.applyPluck(
                localX,
                pointer.y,
                CLOTH_PLUCK_RADIUS,
                profile.pluckStrength * mouseForce,
              );
              pointer.pendingPluck = false;
            }
            if (
              pointer.active &&
              pointer.kind === "mouse" &&
              pointer.pending
            ) {
              // Directional travel is an event impulse; event-rate deltas are
              // accumulated, capped, and consumed once by the next fixed tick.
              const travel = clampPointerTravel(pointer.dx, pointer.dy);
              solver.applyDrag(
                localX,
                pointer.y,
                travel.dx,
                travel.dy,
                CLOTH_INTERACTION_RADIUS,
                profile.dragStrength * mouseForce,
              );
              pointer.dx = 0;
              pointer.dy = 0;
              pointer.pending = false;
            }
            // Mouse remains the existing hover instrument. Its pressure keeps
            // accumulating per fixed tick, while travel is a discrete sample.
            if (pointer.active && pointer.kind === "mouse") {
              solver.applyCursor(
                localX,
                pointer.y,
                CLOTH_INTERACTION_RADIUS,
                profile.pressureStrength * mouseForce,
              );
            }
            if (pointer.active && pointer.kind !== "mouse") {
              // Touch/pen transport spans sparse browser events: update the
              // filter once per simulation tick, then merge transport and
              // steady pressure into one particle traversal.
              const velocity = updateContactVelocity(
                pointer.velocityX,
                pointer.velocityY,
                pointer.dx,
                pointer.dy,
                pointer.pending,
              );
              pointer.velocityX = velocity.vx;
              pointer.velocityY = velocity.vy;
              pointer.dx = 0;
              pointer.dy = 0;
              pointer.pending = false;
              solver.applyContactField(
                localX,
                pointer.y,
                CLOTH_INTERACTION_RADIUS,
                velocity.vx,
                velocity.vy,
                profile.pressureStrength,
                profile.dragStrength,
              );
            }
          }
          syncPorosity();
          solver.step(1);
        },
        syncView: () => {
          syncGeometry();
          if (propsRef.current.wireframe === true) syncWireColors();
          syncPins();
        },
        setVisible: (wf) => {
          clothMesh.visible = !wf;
          wireEdges.visible = wf;
          wirePoints.visible = wf;
        },
        settle: (mode = "full") => {
          // Pre-drape off-screen: gravity + constraints only, bleeding the
          // implicit Verlet velocity to zero every 8th step so the flat grid
          // reaches rest WITHOUT the frame-one recoil that reads as the cloth
          // "slamming" against the line. Launch uses a much smaller pass with
          // self-collision disabled; probes use the same analytic seed with a
          // single warmup step so their input handler stays responsive. The
          // live solver finishes the drape; later resolution swaps retain the
          // full invisible settle.
          solver.setFabric(fabricRef.current);
          const requestedIterations = propsRef.current.iterations ?? 6;
          const requestedCollision =
            SC_EVERY[propsRef.current.selfCollide ?? "full"];
          const seeded = mode === "launch" || mode === "probe";
          solver.setIterations(
            seeded
              ? Math.min(requestedIterations, CLOTH_LAUNCH_SETTLE_ITERATIONS)
              : requestedIterations,
          );
          solver.selfCollisionEvery = seeded ? 0 : requestedCollision;
          syncPorosity();
          if (seeded) {
            snapPins();
            seedClothLaunchDrape(solver, spacing);
          }
          const steps =
            mode === "probe"
              ? 1
              : mode === "launch"
                ? CLOTH_LAUNCH_SETTLE_STEPS
                : FULL_SETTLE_STEPS;
          for (let s = 0; s < steps; s++) {
            snapPins();
            solver.step(1);
            if ((s & 7) === 7) solver.prev.set(solver.pos);
          }
          solver.prev.set(solver.pos);
          solver.setIterations(requestedIterations);
          solver.selfCollisionEvery = requestedCollision;
          syncGeometry();
          syncPins();
        },
        resetToBaseline: () => {
          solver.setFabric(fabricRef.current);
          unit.lastFabric = fabricRef.current;
          solver.reset();
          applyPinLayout();
          // Probe buttons run in an input handler. The analytic seed plus one
          // collision-free warmup step is a deterministic baseline without
          // blocking high mesh for the launch/full-settle durations.
          unit.settle("probe");
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
    // Lazy read: the backend's capabilities only exist after renderer.init()
    // resolves, and every caller (texture loads, syncAnisotropy) runs
    // post-init. WebGPU caps at 16; the `|| 16` guards a zero from an
    // uninitialized backend.
    const currentAniso = () =>
      Math.min(propsRef.current.anisotropy ?? 8, renderer.getMaxAnisotropy() || 16);
    const configureTex = (t: THREE.Texture, isColor: boolean) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = currentAniso();
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      if (isColor) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    // One entry per texture slot: which texture node it feeds, whether it's a
    // color (sRGB) map, an optional has-flag uniform for maps that may be
    // absent, plus load bookkeeping (current texture + last URL). The node's
    // `.value` is never null — an empty slot binds the shared black
    // placeholder, which the slot code must never dispose.
    interface TexSlot {
      node: (typeof clothTex)["albedo"];
      blank: THREE.Texture;
      hasFlag?: { value: number };
      isColor: boolean;
      /** POM repeatedly samples density inside a divergent ray march. Capping
       * anisotropy there avoids multiplying every step by 8 taps; the final
       * albedo and normal reads retain the user-selected sharpness. */
      anisotropyCap?: number;
      current: THREE.Texture | null;
      currentUrl: string;
      lastUrl: string;
    }
    const texSlots: Record<
      "albedo" | "density" | "metalness" | "normal" | "roughness",
      TexSlot
    > = {
      albedo: { node: clothTex.albedo, blank: clothBlanks.albedo, isColor: true, current: null, currentUrl: "", lastUrl: "" },
      density: {
        node: clothTex.density,
        blank: clothBlanks.density,
        isColor: false,
        anisotropyCap: 2,
        current: null,
        currentUrl: "",
        lastUrl: "",
      },
      metalness: {
        node: clothTex.metalness,
        blank: clothBlanks.metalness,
        hasFlag: clothU.u_hasMetalnessTex,
        isColor: false,
        current: null,
        currentUrl: "",
        lastUrl: "",
      },
      normal: {
        node: clothTex.normal,
        blank: clothBlanks.normal,
        hasFlag: clothU.u_hasNormalTex,
        isColor: false,
        current: null,
        currentUrl: "",
        lastUrl: "",
      },
      roughness: {
        node: clothTex.roughness,
        blank: clothBlanks.roughness,
        hasFlag: clothU.u_hasRoughnessTex,
        isColor: false,
        current: null,
        currentUrl: "",
        lastUrl: "",
      },
    };
    const clearSlot = (slot: TexSlot) => {
      slot.current?.dispose();
      slot.current = null;
      slot.currentUrl = "";
      slot.node.value = slot.blank;
      if (slot.hasFlag) slot.hasFlag.value = 0;
    };
    const setSlotUrl = (slot: TexSlot, url: string) => {
      if (url === slot.lastUrl) return;
      slot.lastUrl = url;
      // A slot belongs to exactly one material. Clear the previous texture as
      // soon as ownership changes so a failed request cannot leave pixels from
      // the prior swatch bound to the new one.
      clearSlot(slot);
      if (!url) {
        return;
      }
      texLoader.load(
        url,
        (tex) => {
          // Bail if unmounted or the slot was re-targeted while loading.
          if (disposed || slot.lastUrl !== url) {
            tex.dispose();
            return;
          }
          configureTex(tex, slot.isColor);
          tex.anisotropy = Math.min(
            tex.anisotropy,
            slot.anisotropyCap ?? tex.anisotropy,
          );
          tex.needsUpdate = true;
          slot.current = tex;
          slot.currentUrl = url;
          slot.node.value = tex;
          if (slot.hasFlag) slot.hasFlag.value = 1;
        },
        undefined,
        () => {
          if (disposed || slot.lastUrl !== url) return;
          clearSlot(slot);
        },
      );
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
    // (First syncTextures() runs post-init — texture configuration reads the
    // backend's anisotropy cap.)
    let lastReadyKey = -1;

    // Anisotropy is a live perf lever — push the current value onto every
    // loaded cloth + object texture whenever it changes.
    let lastAniso = -1;
    const syncAnisotropy = () => {
      const a = currentAniso();
      if (a === lastAniso) return;
      lastAniso = a;
      for (const slot of Object.values(texSlots)) {
        if (slot.current) {
          slot.current.anisotropy = Math.min(a, slot.anisotropyCap ?? a);
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
    const ropeBaseline = new Float32Array(ropePos);
    const resetRope = () => {
      ropePos.set(ropeBaseline);
      ropePrev.set(ropeBaseline);
    };

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
    // Radial segments around the tube's circumference. A thin, dark strand
    // seen mostly against the bright sky is the worst case for under-
    // tessellation: too few facets doesn't just jag the silhouette, each
    // flat facet catches the sun's specular highlight at a slightly
    // different angle, so a low count reads as a travelling glint/band
    // shimmering along the rope as it sways — easy to mistake for aliasing,
    // but no amount of MSAA/supersampling fixes it (that's for sampling
    // rate, not missing geometry). 16 reads as round at any camera
    // distance; cost is trivial since the tube is a single thin strip that
    // only rebuilds when it's actually moved (see ROPE_REBUILD_EPS below).
    const WIRE_RADIAL_SEGMENTS = 16;
    // Fixes the *other* half of rope aliasing: a soft analytic silhouette
    // fade instead of a hard rasterized edge (see createWireMaterial) — the
    // 16-segment tessellation above stops the facets from glinting, this
    // stops the sub-pixel-wide silhouette itself from shimmering.
    const wireMat = createWireMaterial();
    let wireTube = new THREE.TubeGeometry(
      ropeCurve,
      100,
      wireRadius,
      WIRE_RADIAL_SEGMENTS,
      false,
    );
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
      const next = new THREE.TubeGeometry(
        ropeCurve,
        100,
        wireRadius,
        WIRE_RADIAL_SEGMENTS,
        false,
      );
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
    // Starting angle: with the camera now looking back along the
    // clothesline (see camera.position above), this phase puts the sun
    // almost directly on the far side of the cloth from the camera, so the
    // very first frame shows it backlit/glowing rather than front-lit.
    let sunPhase = 0.9;
    // Scratch objects — all reused each frame to avoid per-tick GC churn.
    const SUN_COOL = new THREE.Color(1.0, 0.95, 0.86);
    const SUN_WARM = new THREE.Color(1.0, 0.7, 0.42);
    const SKY_TOP_DAY = new THREE.Color(0x2c5990);
    // Darkened from the original 0x4a6d95 / 0xe8dcb8 — those two are what the
    // midday sky (high sun altitude) actually blends toward, and the old
    // bottom tone in particular was light cream, near-white — exactly what
    // washes out the chromeless tuning panel's white text (see
    // side-panel-right in panels.css). Sun color/intensity and the shader's
    // halo/glow/disk terms are untouched: the light itself should still read
    // as bright, only the flat backdrop it sits against is dimmer now.
    const SKY_TOP_HORIZON = new THREE.Color(0x3a5878);
    const SKY_BOTTOM_HORIZON = new THREE.Color(0xd88a4a);
    const SKY_BOTTOM_DAY = new THREE.Color(0xa39572);
    const sunDir = new THREE.Vector3();
    const sunTint = new THREE.Color();
    const skyTopScratch = new THREE.Color();
    const skyBottomScratch = new THREE.Color();
    const fogScratch = new THREE.Color();
    const sceneFog = scene.fog as THREE.FogExp2;
    const updateSun = (dtSeconds: number) => {
      // Preserve the authored 60 Hz orbit speed while keeping it wall-clock
      // correct on throttled, high-refresh, and temporarily slow displays.
      sunPhase += 0.00025 * (2 * Math.PI) * dtSeconds * 60;
      const alt = Math.sin(sunPhase * 0.5 + 0.4) * 0.7;
      sun.position.set(
        Math.cos(sunPhase) * sunRadius,
        (0.3 + alt * 0.7) * sunRadius,
        Math.sin(sunPhase) * sunRadius,
      );
      // Same direction fed to cloth and sky. Cloth wants light-travel
      // direction (sun → ground), so pass the negation.
      sunDir.copy(sun.position).normalize();
      clothU.u_lightDir.value.set(-sunDir.x, -sunDir.y, -sunDir.z);
      skyU.u_sunDir.value.copy(sunDir);
      skyU.u_sunAlt.value = THREE.MathUtils.clamp(
        sunDir.y + 0.3,
        0,
        1,
      );

      // Sun colour: warm at the horizon, cool overhead.
      const alt01 = THREE.MathUtils.clamp(sunDir.y + 0.2, 0, 1);
      sunTint.copy(SUN_WARM).lerp(SUN_COOL, alt01);
      sun.color.copy(sunTint);
      sun.intensity = 0.45 + alt01 * 1.25;
      clothU.u_lightColor.value.copy(sunTint).multiplyScalar(1.15);
      skyU.u_sunColor.value.copy(sunTint);

      // Sky gradient shifts too — dawn/dusk warmth vs midday blue.
      skyTopScratch.copy(SKY_TOP_DAY).lerp(SKY_TOP_HORIZON, alt01);
      skyBottomScratch.copy(SKY_BOTTOM_HORIZON).lerp(SKY_BOTTOM_DAY, alt01);
      skyU.u_top.value.copy(skyTopScratch);
      skyU.u_bottom.value.copy(skyBottomScratch);
      // Fog colour lerps with the horizon so distance-haze always reads
      // as lit by the current time of day.
      fogScratch.copy(skyBottomScratch).lerp(skyTopScratch, 0.35);
      fogColor.copy(fogScratch);
      sceneFog.color.copy(fogScratch);
      clothU.u_fogColor.value.copy(fogScratch);
      skyU.u_fogColor.value.copy(fogScratch);
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
      initial.settle("launch");
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
      // Iridescence is a compile-time shader variant — enable it at a floor
      // value from construction so toggling the knob never recompiles the
      // object's program mid-session; the tick drives the live amount.
      iridescence: 0.001,
      iridescenceIOR: 1.3,
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

    // blend: 0 = pure cloth, 1 = pure object. Eased by the interface's shared
    // motion curve for the whisk/surface; its per-frame delta is the
    // "bezier-mediated speed" that drives the object's spin-in. Timing is
    // WALL-CLOCK (ms), not per-frame, so the ~1s duration holds whatever the
    // frame rate — a slow GPU no longer stretches the transition to a crawl.
    const TRANSITION_MS = 1100; // cloth↔object duration
    const OBJECT_SPIN = Math.PI * 2 * 1.25; // 1¼ turns as it surfaces
    let blend = props.mode === "object" ? 1 : 0;
    let easedPrev = easeMotion(blend);
    let objectSpin = 0;

    // ── Loop ────────────────────────────────────────────────────────────
    // Physics targets normalized 60 Hz ticks but pays at most one per rendered
    // frame. When a device cannot hold 60 fps, temporal fidelity yields instead
    // of multiplying solver cost and preventing the renderer from recovering.
    // Render-facing geometry is synchronized once after that fixed tick.
    const simClock = new FixedStepAccumulator({
      stepSeconds: 1 / 60,
      maxSubSteps: 1,
      maxFrameSeconds: 0.1,
    });
    let simulationTick = 0;

    const resetProbeBaseline = () => {
      // Resolution changes can temporarily leave two units in the scene.
      // A test always addresses the visible incoming unit and retires the
      // frozen outgoing one before establishing its baseline.
      if (slideT < 1) finalizeSlide();
      activeProbe = null;
      simulationTick = 0;
      simClock.reset();
      resetRope();
      clearDirectPointer();
      directPointerIds.clear();
      suppressDirectGesture = false;
      const current = units[units.length - 1];
      current.birth = 0;
      current.resetToBaseline();
      current.syncView();
      rebuildWireTube();
    };

    probeRunnerRef.current = (probe) => {
      resetProbeBaseline();
      if (probe === "gust" || probe === "pull") {
        activeProbe = { kind: probe, tick: 0 };
      }
      // "still" captures the canonical drape before ambient air resumes.
      // "reset" is intentionally the same state operation, exposed
      // separately so the UI can distinguish a test pose from recovery.
    };
    // Rendering faster than 60 Hz only repeats this expensive fragment pass;
    // the simulation and interaction model are authored for 60 Hz. A small
    // budget accumulator produces 60 renders/sec on 90/120/144 Hz displays
    // without degrading the 2× backing store or slowing wall-clock motion.
    const RENDER_INTERVAL_MS = 1000 / 60;
    // rAF timestamps on nominal 60 Hz panels often arrive around 15.8–16.4ms.
    // A small tolerance prevents the limiter from mistakenly halving those
    // displays while 90/120/144 Hz callbacks still fall well below the gate.
    const RENDER_TOLERANCE_MS = 1.5;
    let lastAnimationNow = performance.now();
    let renderBudgetMs = RENDER_INTERVAL_MS;
    let lastPixelRatio = pixelScale;
    let lastNow = performance.now();
    // Stats accumulators — averaged and emitted ~2 Hz via onStats.
    let statFrames = 0;
    let statDtMs = 0;
    let statSimMs = 0;
    let gpuMs = 0;
    let gpuTimingPending = false;
    // Boot animation is renderer-owned: no React state or second canvas is
    // touched at 60fps. It waits briefly for declared maps, then writes one
    // scalar uniform until the material's steady-state branch takes over.
    // (Fabric hot-swap is per unit now — each unit re-runs setFabric only
    // when the fabric object identity actually changes; see stepSim.)

    const tick = (animationNow = performance.now()) => {
      const animationDt = Math.min(
        100,
        Math.max(0, animationNow - lastAnimationNow),
      );
      lastAnimationNow = animationNow;
      renderBudgetMs = Math.min(
        RENDER_INTERVAL_MS * 2,
        renderBudgetMs + animationDt,
      );
      if (renderBudgetMs + RENDER_TOLERANCE_MS < RENDER_INTERVAL_MS) return;
      renderBudgetMs = Math.max(0, renderBudgetMs - RENDER_INTERVAL_MS);

      const p = propsRef.current;
      // Wall-clock delta, clamped so a background-tab stall doesn't teleport
      // the transition or spike the FPS meter.
      const now = animationNow;
      const dtMs = Math.min(100, now - lastNow);

      lastNow = now;

      syncAnisotropy();

      // Sun / sky / fog advance every frame — both stages share that
      // atmosphere, so this runs regardless of the transition state.
      updateSun(dtMs / 1000);

      // Advance the cloth↔object blend toward the target mode, ease it, and
      // derive the two visibility gates.
      const target = p.mode === "object" ? 1 : 0;
      const blendStep = dtMs / TRANSITION_MS;
      if (blend < target) blend = Math.min(target, blend + blendStep);
      else if (blend > target) blend = Math.max(target, blend - blendStep);
      const eased = easeMotion(blend);
      const clothVisible = eased < 0.999;
      const objectVisible = eased > 0.001;

      // Whisk the cloth up and out as it fades to transparent.
      clothGroup.visible = clothVisible;
      clothU.u_fade.value = 1 - eased;
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
        const incoming = makeClothUnit(
          mc,
          mr,
          pm,
          -SLIDE_DIST,
          simulationTick,
        );
        // A saved mesh preference can arrive just after mount. Treat that as
        // startup work rather than paying the full swap warm-up under the
        // launch reveal; deliberate later mesh changes retain the full settle.
        incoming.settle(launchComplete ? "full" : "launch");
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
        const se = easeMotion(slideT);
        for (const un of units) {
          un.group.position.x = un.fromX + (un.toX - un.fromX) * se;
        }
        if (slideT >= 1) finalizeSlide();
      }

      // Skip the whole solver when the cloth is gone — no point simulating an
      // invisible sheet (this is the "don't re-render everything" win).
      const simStart = performance.now();
      // Do not carry an unconsumed touch impulse or filtered velocity through
      // object mode and fire it later when the cloth returns.
      if (!clothVisible) {
        pointer.pendingPluck = false;
        if (pointer.kind !== "mouse") {
          pointer.velocityX = 0;
          pointer.velocityY = 0;
        }
      }
      if (clothVisible) {
        const currentUnit = units[units.length - 1];
        const simSteps = simClock.advance(dtMs / 1000, () => {
          simulationTick++;
          // Rope physics runs first — its positions drive both cloth pinning
          // and the visible wire geometry in this fixed simulation tick.
          const ropeStrength = activeProbe
            ? activeProbe.kind === "gust"
              ? GUST_PROBE_STRENGTH *
                Math.sin(
                  Math.PI *
                    ((activeProbe.tick + 1) / GUST_PROBE_TICKS),
                )
              : 0
            : p.breeze ?? 0.06;
          stepRope(
            activeProbe ? 40 + activeProbe.tick : simulationTick,
            ropeStrength,
          );
          // Only the CURRENT unit simulates. During a slide the departing
          // sheet(s) ride off as frozen drapes — nobody inspects their physics
          // at slide speed, and this keeps a res-switch from double-billing the
          // solver (self-collision especially).
          currentUnit.stepSim(simulationTick, true);
          if (activeProbe) {
            activeProbe.tick++;
            const duration =
              activeProbe.kind === "gust"
                ? GUST_PROBE_TICKS
                : PULL_PROBE_TICKS;
            if (activeProbe.tick >= duration) activeProbe = null;
          }
        });
        if (simSteps > 0) currentUnit.syncView();
        // rebuildWireTube syncs curve points itself, and only when the rope
        // has actually drifted since the last built tube.
        rebuildWireTube();
        // Cloth material textures are shared across units — sync once.
        syncTextures();
        const readyKey = propsRef.current.materialTransitionKey ?? 0;
        const expectedAlbedo = propsRef.current.materialExpectedAlbedoURL;
        const loadedAlbedo = texSlots.albedo.currentUrl;
        // Normalize BOTH sides: callers hand over swatch `currentSrc` values
        // (absolute) as well as cache-relative map URLs (/api/cache/…), and
        // the loader stores whatever string it fetched with.
        const toAbs = (u: string) =>
          u ? new URL(u, window.location.href).href : "";
        const expectedReady = expectedAlbedo
          ? toAbs(loadedAlbedo) === toAbs(expectedAlbedo)
          : loadedAlbedo === fabricRef.current.albedoURL;
        const allDeclaredMapsReady = [
          [texSlots.albedo, fabricRef.current.albedoURL],
          [texSlots.density, fabricRef.current.textureURL],
          [texSlots.normal, propsRef.current.normalMapURL ?? ""],
          [texSlots.roughness, propsRef.current.roughnessMapURL ?? ""],
          [texSlots.metalness, propsRef.current.metalnessMapURL ?? ""],
        ].every(([slot, url]) =>
          typeof url === "string" && url
            ? toAbs((slot as TexSlot).currentUrl) === toAbs(url)
            : true,
        );
        if (
          !launchReducedMotion &&
          !launchComplete &&
          launchStartedAt === null &&
          simulationTick >= CLOTH_LAUNCH_HIDDEN_SETTLE_TICKS &&
          (allDeclaredMapsReady ||
            now - launchWaitStartedAt >= CLOTH_LAUNCH_MAP_WAIT_MS)
        ) {
          launchStartedAt = now;
          container.dataset.clothLaunch = "shimmering";
        }
        if (launchStartedAt !== null) {
          const launchProgress = Math.min(
            1,
            (now - launchStartedAt) / CLOTH_LAUNCH_TOTAL_MS,
          );
          clothU.u_launchProgress.value = launchProgress;
          if (launchProgress >= 1) {
            launchStartedAt = null;
            launchComplete = true;
            container.dataset.clothLaunch = "ready";
          }
        }
        if (
          readyKey !== lastReadyKey &&
          expectedReady &&
          allDeclaredMapsReady
        ) {
          lastReadyKey = readyKey;
          propsRef.current.onMaterialReady?.(readyKey);
        }
      } else {
        // Invisible time should not become catch-up debt. The cloth resumes
        // from its last stable state when object mode gives it back.
        simClock.reset();
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
        // Floor keeps the iridescence shader variant alive (see constructor).
        objectMat.iridescence = Math.max(0.001, p.iridescence ?? 0);
        syncObjectTextures();
      }
      easedPrev = eased;

      // Push knob uniforms — cheap, and lets sliders take effect immediately.
      const u = clothU;
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
      u.u_materialReveal.value = p.materialRevealRef?.current ?? 1;
      u.u_iridescence.value = p.iridescence ?? 0;
      u.u_sheen.value = fabricRef.current.sheen;

      // Skybox mode is just a shader uniform on the sky mesh — lighting is
      // driven by the DirectionalLight/HemisphereLight/cloth uniforms and
      // stays exactly the same across modes.
      skyU.u_skyMode.value = p.skyMode ?? 0;
      skyU.u_halo.value = p.iridescence ?? 0;

      // setPixelRatio unconditionally re-runs setSize, which reassigns
      // canvas.width — per the HTML spec that clears/reallocates the drawing
      // buffer even at the same value. Only touch it when quality changes.
      const nextRatio = p.pixelScale ?? 1;
      if (nextRatio !== lastPixelRatio) {
        lastPixelRatio = nextRatio;
        renderer.setPixelRatio(nextRatio);
      }
      // Lens flare: project the sun, fade near the frame edges, and skip
      // the overlay entirely when the sun is off-frame, behind the camera,
      // or the backdrop is the flat black stage (no visible sun to flare).
      {
        flareCamDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
        flareDirVec.copy(sun.position).sub(camera.position);
        const facing = flareDirVec.dot(flareCamDir) > 0;
        let amt = 0;
        if (facing && (p.skyMode ?? 0) !== 1) {
          flareSunVec.copy(sun.position).project(camera);
          const edge = (v: number) =>
            Math.max(0, Math.min(1, (1.25 - Math.abs(v)) / 0.35));
          amt =
            edge(flareSunVec.x) *
            edge(flareSunVec.y) *
            (p.iridescence ?? 0) *
            0.8;

          // Occlusion flicker — flare source strength depends on what the
          // camera→sun ray passes through. Intersect it with the cloth's
          // hang plane (z = 0) and scan the live unit's particles for
          // silhouette coverage at that point: dense cloth chokes the flare,
          // sheer weave lets it bloom, and the flutter modulates coverage
          // frame to frame, which is what makes the flare shimmer.
          if (amt > 0 && clothVisible) {
            const cz = camera.position.z;
            const sz = sun.position.z;
            let target = 1;
            if ((cz > 0) !== (sz > 0)) {
              const t0 = cz / (cz - sz);
              const ix = camera.position.x + (sun.position.x - camera.position.x) * t0;
              const iy = camera.position.y + (sun.position.y - camera.position.y) * t0;
              const unit = units[units.length - 1];
              const px = ix - unit.group.position.x;
              const py = -iy; // world Y+ up → solver Y+ down
              const pos = unit.solver.pos;
              let minD2 = Infinity;
              for (let i = 0; i < unit.solver.count; i++) {
                const dx = pos[i * 3] - px;
                const dy = pos[i * 3 + 1] - py;
                const d2 = dx * dx + dy * dy;
                if (d2 < minD2) minD2 = d2;
              }
              // Inside the silhouette when the nearest particle is within
              // ~1.5 grid spacings; soft edge over one more spacing.
              const spacing = unit.cfg.spacing;
              const dMin = Math.sqrt(minD2);
              const cover = Math.max(
                0,
                Math.min(1, (spacing * 2.5 - dMin) / spacing),
              );
              // How much light survives the covered path: dense weave chokes
              // the flare to ~12%, organza passes most of it.
              const o = p.openness ?? 0.55;
              const pass = 0.12 + 0.68 * o;
              target = 1 - cover * (1 - pass);
            }
            // EMA so coverage changes breathe instead of popping; the
            // residual lag also reads as the eye readjusting.
            flareOcclusion += (target - flareOcclusion) * 0.12;
            amt *= flareOcclusion;
          }
          flareU.u_sun.value.set(flareSunVec.x, flareSunVec.y);
          flareU.u_aspect.value = camera.aspect;
        }
        flareU.u_amt.value = amt;
        flareQuad.visible = amt > 0.003;
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
        const timingBackend = renderer.backend as typeof renderer.backend & {
          trackTimestamp?: boolean;
        };
        if (timingBackend.trackTimestamp && !gpuTimingPending) {
          gpuTimingPending = true;
          void renderer
            .resolveTimestampsAsync("render")
            .then((duration) => {
              if (typeof duration === "number" && Number.isFinite(duration)) {
                // Timestamp results arrive at a lower cadence than FPS. Smooth
                // them so one folded/grazing frame does not make the meter
                // oscillate between unrelated samples.
                gpuMs = gpuMs > 0 ? gpuMs * 0.8 + duration * 0.2 : duration;
              }
            })
            .finally(() => {
              gpuTimingPending = false;
            });
        }
        propsRef.current.onStats?.({
          fps: statDtMs > 0 ? 1000 / (statDtMs / statFrames) : 0,
          simMs: statSimMs / statFrames,
          ...(gpuMs > 0 ? { gpuMs } : {}),
          tris: renderer.info.render.triangles,
          calls: renderer.info.render.drawCalls,
        });
        statFrames = 0;
        statDtMs = 0;
        statSimMs = 0;
      }
    };
    // WebGPURenderer.render() throws until the backend has initialized, so
    // the loop (and the first texture loads, which read backend capabilities)
    // starts from init(). Everything above — scene graph, solver, listeners —
    // stayed synchronous.
    renderer
      .init()
      .then(() => {
        if (disposed) {
          // Unmounted while the async init was in flight; the cleanup below
          // already ran, so release the now-initialized backend here.
          renderer.dispose();
          return;
        }
        resize();
        syncTextures();
        launchWaitStartedAt = performance.now();
        // WebGPU initialization can take several rendered-frame intervals.
        // Do not reinterpret that startup latency as physics catch-up: the
        // first cloth is already pre-settled and its geometry is ready.
        lastNow = performance.now();
        lastAnimationNow = lastNow;
        renderBudgetMs = RENDER_INTERVAL_MS;
        simClock.reset();
        // Three owns the rAF lifecycle so renderer.info and WebGPU timestamp
        // frame IDs advance in the same loop as the render they describe.
        void renderer.setAnimationLoop(tick);
      })
      .catch((err) => {
        console.error("ClothScene: renderer init failed", err);
      });

    return () => {
      disposed = true;
      probeRunnerRef.current = null;
      if (renderer.getAnimationLoop() !== null) {
        void renderer.setAnimationLoop(null);
      }
      cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      controls?.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerCancel);
      renderer.domElement.removeEventListener(
        "lostpointercapture",
        onLostPointerCapture,
      );
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onWindowBlur);
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      for (const un of units) un.dispose(); // per-unit geometries
      clothMat.dispose();
      wireEdgeMat.dispose();
      wirePointMat.dispose();
      skyGeom.dispose();
      skyMat.dispose();
      flareGeom.dispose();
      flareMat.dispose();
      wireTube.dispose();
      wireMat.dispose();
      pinBodyGeom.dispose();
      pinBodyMat.dispose();
      for (const slot of Object.values(texSlots)) slot.current?.dispose();
      for (const b of Object.values(clothBlanks)) b.dispose();
      launchShimmer.dispose();
      objectGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
      objectMat.dispose();
      for (const t of objTextures) t.dispose();
      // If init() is still pending, its .then() disposes the renderer once
      // the backend exists (see above).
      if (renderer.initialized) renderer.dispose();
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
});

export default ClothScene;
