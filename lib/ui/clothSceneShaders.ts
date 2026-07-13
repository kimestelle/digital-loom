// ─── clothSceneShaders.ts ─────────────────────────────────────────────────────
// GLSL sources for the Three.js cloth scene. Kept out of the component so the
// component reads as glue between physics, geometry, and lighting rather than
// several hundred lines of shader interspersed with wiring code.
//
// Three.js prepends its own prelude (uniforms, precision, helper functions)
// before ShaderMaterial sources. Therefore:
//   - No `#extension GL_OES_standard_derivatives`. WebGL 2 has derivatives in
//     core; the extension line would be rejected by ESSL3 because Three's
//     prelude precedes it.
//   - No explicit `precision`. Three already injects `precision highp float;`
//     in the fragment prelude.

import { POM_DEFINES, POM_HELPERS } from "@/lib/cloth/pom.glsl";

// ── Cloth ─────────────────────────────────────────────────────────────────────
// Vertex shader hands world position and normal to the fragment via three
// varyings; the fragment shader is the POM + edge-fray + transmission path.
export const CLOTH_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  // Per-vertex directional strain (u = crosswise, v = lengthwise); 0 = rest,
  // >0 = stretched. Solver-authored (ClothSolver.computeStrain), interpolated
  // across the triangle so the fragment gets a smooth field.
  attribute vec2 strain;
  varying vec2 vStrain;

  void main() {
    // Flip V: the solver builds UVs with row 0 (the pinned top edge) at v=0,
    // but image textures put their top row at v=1 (Three's default flipY), so
    // sampling straight put every map on upside down. Flipping here fixes all
    // maps at once, and the tangent frame (derived from dFdx/dFdy(vUv) in the
    // fragment shader) flips with it, so normal-map lighting stays consistent.
    vUv = vec2(uv.x, 1.0 - uv.y);
    vStrain = strain;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const CLOTH_FRAGMENT_SHADER = /* glsl */ `
  ${POM_DEFINES}

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec2 vStrain; // solver strain (u, v); 0 = rest, >0 = stretched

  // Stretch response — makes taut regions of the fabric render differently
  // from slack ones. u_stretch is the master amount (0 = off, so the whole
  // block is skipped); u_stretchDetail weights the per-pixel derivative
  // (Tier A) on top of the smooth per-vertex strain (Tier B); u_stretchDebug
  // paints the strain field as a heatmap for tuning.
  uniform float u_stretch;
  uniform float u_stretchDetail;
  uniform int   u_stretchDebug;

  uniform vec3 u_lightDir;       // direction the sun light travels
  uniform vec3 u_lightColor;
  uniform vec3 u_ambientColor;
  uniform vec3 u_baseColor;

  uniform float u_translucency;
  uniform float u_sheen;

  uniform sampler2D u_albedoTex;
  uniform float u_albedoAmount;
  uniform sampler2D u_densityTex;
  uniform float u_densityAmount;
  uniform float u_alphaFromDensity;

  // Threadbare boost — extra alpha loss weighted by a selectable map, so the
  // user controls WHERE the fabric wears thin, not just how much. Source:
  // 0 = height (dark valleys sheer — the original behavior), 1 = albedo,
  // 2 = roughness, 3 = metalness. Dark regions of the chosen map go
  // threadbare; sources without a loaded map fall back to height.
  uniform float u_alphaBoost;
  uniform int   u_alphaBoostSource;
  uniform sampler2D u_roughnessTex;
  uniform int   u_hasRoughnessTex;

  // Metalness map from the Patina pipeline. u_metalness is the insert-panel
  // "metalness" amount (0 = fully dielectric fabric, 1 = the map at full
  // strength). u_hasMetalnessTex gates the sampler so an absent map falls back
  // to a flat metalness driven by the amount alone.
  uniform sampler2D u_metalnessTex;
  uniform float u_metalness;
  uniform int   u_hasMetalnessTex;

  // Patina normal map — micro-relief shading normal, sampled at the
  // parallaxed UV so lighting and parallax agree on where each thread is.
  // u_normalAmount scales the tangent-space XY (0 = smooth vertex normal,
  // 1 = full map strength).
  uniform sampler2D u_normalTex;
  uniform float u_normalAmount;
  uniform int   u_hasNormalTex;

  // POM self-shadow strength: how much threads occlude the sun for each
  // other. 0 disables the shadow march entirely.
  uniform float u_pomShadow;

  uniform float u_pomScale;
  uniform float u_pomMinSteps;
  uniform float u_pomMaxSteps;
  uniform int   u_pomDebug;

  uniform float u_edgeInset;
  uniform float u_edgeFray;
  uniform float u_edgeSharpness;
  uniform float u_edgeDetail;
  uniform float u_tileScale;

  uniform float u_txHeight;
  uniform float u_txAlbedo;
  uniform float u_txRoughness;
  uniform float u_transmissionContrast;

  // Global opacity multiplier — driven to 0 as the cloth whisks away during
  // the cloth→object transition. 1 in normal use.
  uniform float u_fade;

  // Fog integration — Three's fog uniforms are exposed here so the cloth
  // dissolves into the atmosphere at distance just like the rest of the
  // scene. Ambient sky bounce also feeds the shader.
  uniform vec3  u_fogColor;
  uniform float u_fogDensity;

  ${POM_HELPERS}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(u_lightDir);
    // View direction toward the camera. cameraPosition is a Three built-in
    // fragment uniform — previously this inverted the 4x4 view matrix per
    // fragment to recover the same vector, which was pure waste.
    vec3 camPos = cameraPosition;
    vec3 V = normalize(camPos - vWorldPos);

    // ── Stretch response ──────────────────────────────────────────────────
    // How taut is the fabric *here*? Two signals, both cheap: Tier B is the
    // smooth per-vertex strain the solver measured; Tier A recovers per-pixel
    // stretch from screen derivatives (crisp at folds). An inextensible weave
    // only stretches a few percent, so we gain the result up to make it read.
    // Gated: at u_stretch == 0 (and no debug) this whole block is one compare.
    float strainMag = 0.0;
    float strainRaw = 0.0;
    if (u_stretch > 0.0 || u_stretchDebug == 1) {
      vec2 sB = max(vec2(0.0), vStrain);
      vec3 dpx = dFdx(vWorldPos), dpy = dFdy(vWorldPos);
      vec2 dux = dFdx(vUv), duy = dFdy(vUv);
      float det = dux.x * duy.y - dux.y * duy.x;
      vec2 sA = vec2(0.0);
      if (abs(det) > 1e-8) {
        // world-units spanned per UV-unit; ÷ rest sheet size (423 world
        // units) so 1.0 = unstretched. Isometry preserves this under pure
        // bending, so it isolates real stretch from drape folds.
        vec3 dPdu = ( dpx * duy.y - dpy * dux.y) / det;
        vec3 dPdv = (-dpx * duy.x + dpy * dux.x) / det;
        sA = max(vec2(0.0), vec2(length(dPdu), length(dPdv)) / 423.0 - 1.0);
      }
      vec2 s = sB + sA * u_stretchDetail;
      strainRaw = (s.x + s.y) * 0.5;
      strainMag = clamp(strainRaw * 12.0, 0.0, 1.0) * u_stretch;
    }
    if (u_stretchDebug == 1) {
      float t = clamp(strainRaw * 12.0, 0.0, 1.0); // slate→amber→white
      vec3 dbg = (t < 0.5)
        ? mix(vec3(0.15, 0.20, 0.35), vec3(0.95, 0.70, 0.20), t * 2.0)
        : mix(vec3(0.95, 0.70, 0.20), vec3(1.0, 1.0, 1.0), (t - 0.5) * 2.0);
      gl_FragColor = vec4(dbg, 1.0);
      return;
    }
    // Taut fabric pulls its threads straight — the weave relief flattens.
    float pomScaleEff = u_pomScale / (1.0 + strainMag * 1.5);

    // POM in tiled UV space so the raymarch operates on the same signal
    // every downstream sample reads from.
    vec2 tiledUv = vUv * u_tileScale;
    mat3 TBN = pomCotangentFrame(N, vWorldPos, tiledUv);
    vec3 viewTS = pomViewDirTS(TBN, V);
    float pomSteps = 0.0;
    vec2 pomUv = (u_pomScale > 0.0)
      ? pomTrace(u_densityTex, tiledUv, viewTS,
                 pomScaleEff, u_pomMinSteps, u_pomMaxSteps, pomSteps)
      : tiledUv;

    if (u_pomDebug == POM_DEBUG_OFFSET) {
      float mag = length(pomUv - tiledUv);
      float g = clamp(mag / max(u_pomScale, 1e-4) * 4.0, 0.0, 1.0);
      gl_FragColor = vec4(g, 0.15 + 0.6 * g, 1.0 - g, 1.0);
      return;
    }
    if (u_pomDebug == POM_DEBUG_STEPS) {
      float s = clamp(pomSteps / max(u_pomMaxSteps, 1.0), 0.0, 1.0);
      gl_FragColor = vec4(s, s * 0.5, 1.0 - s, 1.0);
      return;
    }

    // Edge carve — apron + noise punchout.
    float d = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float hemFactor = 0.0;
    if (u_edgeInset > 0.0) {
      float raw = texture2D(u_densityTex, tiledUv * u_edgeDetail).r;
      float contrast = mix(1.0, 3.5, u_edgeSharpness);
      float noise = clamp((raw - 0.5) * 2.0 * contrast, -1.0, 1.0);
      float striation = abs(raw - 0.5) * 2.0;
      float striationBoost = mix(0.4, 1.8, striation);
      float amp = u_edgeFray * 0.08 * striationBoost;
      float carve = max(0.0, u_edgeInset + amp * noise);
      if (d < carve) discard;
      float hemWidth = max(0.015, u_edgeInset * 0.6);
      hemFactor = 1.0 - smoothstep(carve, carve + hemWidth, d);
    }

    vec3 albedoSample = texture2D(u_albedoTex, pomUv).rgb;
    vec3 fabricColor = mix(u_baseColor, albedoSample, u_albedoAmount);

    // ── Micro-relief shading normal ───────────────────────────────────────
    // Perturb the smooth vertex normal with the Patina normal map so the
    // weave actually catches light. Sampled at pomUv — the same relief the
    // parallax march resolved — otherwise highlights slide off the threads
    // they belong to. TBN columns are tangent→world, reusing the POM frame.
    vec3 Ns = N;
    if (u_hasNormalTex == 1 && u_normalAmount > 0.0) {
      vec3 nTS = texture2D(u_normalTex, pomUv).xyz * 2.0 - 1.0;
      nTS.xy *= u_normalAmount;
      Ns = normalize(TBN * normalize(nTS));
    }

    // ── POM self-shadow ───────────────────────────────────────────────────
    // March from the contact point toward the sun through the height field;
    // threads shadow each other. Only direct sun terms are attenuated —
    // ambient and back-transmission take different light paths.
    float sunShade = 1.0;
    if (u_pomScale > 0.0 && u_pomShadow > 0.0) {
      vec3 lightTS = normalize(
        vec3(dot(-L, TBN[0]), dot(-L, TBN[1]), dot(-L, TBN[2])));
      float shade = pomSelfShadow(
        u_densityTex, pomUv, lightTS,
        u_pomScale, u_pomMinSteps, u_pomMaxSteps);
      sunShade = mix(1.0, shade, u_pomShadow);
    }

    float texel = texture2D(u_densityTex, pomUv).r;
    float albedoLum = dot(albedoSample, vec3(0.2126, 0.7152, 0.0722));
    // Density is a weighted blend of up to three source maps (height, albedo,
    // roughness), each with its own independent weight. Zero-weight maps drop
    // out; the weighted mean normalises so relative slider values set the mix.
    // roughLum falls back to 0.5 (neutral) when no roughness map is bound so a
    // stray txRoughness weight can't punch the density to an extreme.
    float roughLum = u_hasRoughnessTex == 1
      ? texture2D(u_roughnessTex, pomUv).r
      : 0.5;
    float txSum = u_txHeight + u_txAlbedo + u_txRoughness;
    float baseDensity;
    if (txSum > 1e-4) {
      baseDensity = (u_txHeight * texel
                   + u_txAlbedo * albedoLum
                   + u_txRoughness * roughLum) / txSum;
    } else {
      // All sources off → opaque fabric, no map-driven transmission variation.
      baseDensity = 1.0;
    }

    float txMul = 1.0 + u_transmissionContrast * 3.0;
    baseDensity = clamp(0.5 + (baseDensity - 0.5) * txMul, 0.0, 1.0);

    float density = mix(1.0, baseDensity, u_densityAmount);
    float openness = 1.0 - density;
    // Stretched fabric spreads its threads — gaps open, cloth goes sheer.
    // Physically the same thing the alpha path already does, just localised
    // to where the sheet is under tension.
    openness = clamp(openness + strainMag * 0.5, 0.0, 1.0);

    // Threadbare weight for the boost. Height keeps the original formula
    // (boost rides the same openness signal the base term uses); the other
    // sources read their own map at pomUv so worn patches follow the
    // captured material rather than the weave relief.
    float boostWeight = openness;
    if (u_alphaBoostSource == 1) {
      boostWeight = 1.0 - albedoLum;
    } else if (u_alphaBoostSource == 2 && u_hasRoughnessTex == 1) {
      boostWeight = 1.0 - texture2D(u_roughnessTex, pomUv).r;
    } else if (u_alphaBoostSource == 3 && u_hasMetalnessTex == 1) {
      boostWeight = 1.0 - texture2D(u_metalnessTex, pomUv).r;
    }

    // Exponential sheerness. As openness × u_alphaFromDensity grows, alpha
    // drops much faster than linear (a light nudge of the slider produces a
    // noticeable transparency shift), and the fabric color desaturates
    // slightly toward the base so albedo differences fade with opacity —
    // real thin fabric loses saturation as it turns sheer because the
    // light transmitted through it dominates the surface's own hue.
    float lossLinear = openness * u_alphaFromDensity + boostWeight * u_alphaBoost;
    float lossExp = 1.0 - pow(max(0.0, 1.0 - lossLinear), 2.5);
    fabricColor = mix(fabricColor, u_baseColor, lossExp * 0.35);

    // Backlit transmission when the sun is on the far side of the fabric
    // (surface normal aligned with the light-travel direction). All direct
    // terms use the micro-relief normal Ns so the weave shapes the light.
    float back = max(0.0, dot(Ns, L));
    float front = max(0.0, dot(Ns, -L));

    float transmitAmt = u_translucency * (0.35 + 0.65 * openness);
    transmitAmt *= mix(1.0, 1.8, hemFactor);
    vec3 transmitted = u_lightColor * fabricColor * back * transmitAmt;

    // Forward diffuse — Lambertian from the sun on the viewer's side,
    // attenuated where neighbouring threads occlude it.
    vec3 frontDiffuse = u_lightColor * fabricColor * front * 0.9 * sunShade;

    // Ambient sky bounce.
    vec3 ambient = u_ambientColor * fabricColor * 0.55;

    // Grazing sheen — grazing to view, boosted at cut hems. On the micro
    // normal, so individual threads sparkle instead of the whole sheet.
    float graze = 1.0 - abs(dot(Ns, V));
    float sheen = pow(graze, 3.0) * u_sheen;
    sheen *= mix(1.0, 1.5, hemFactor);
    // Taut threads lie flat and parallel — they catch a sharper specular.
    sheen *= 1.0 + strainMag * 1.5;

    vec3 color =
      frontDiffuse +
      transmitted * 0.65 +
      ambient +
      u_lightColor * sheen * 0.5 * sunShade;

    color *= mix(1.0, 0.72, hemFactor);

    // ── Metalness ─────────────────────────────────────────────────────────
    // Metals carry no diffuse albedo — their energy goes into a tight,
    // albedo-tinted specular highlight plus reflected ambient. Lerp the
    // dielectric shading toward that metallic model by the per-texel
    // metalness (map × amount). At u_metalness == 0 the fabric is untouched.
    // Both the map sample and the shading only run when the metalness
    // amount is actually dialed in — at the default 0 this whole block
    // costs one uniform compare.
    float metal = 0.0;
    if (u_metalness > 0.0) {
      float metalMap = (u_hasMetalnessTex == 1)
        ? texture2D(u_metalnessTex, pomUv).r
        : 1.0;
      metal = clamp(metalMap * u_metalness, 0.0, 1.0);
    }
    if (metal > 0.0) {
      vec3 Ldir = -L;                 // toward the sun
      vec3 H = normalize(Ldir + V);
      float ndl = max(dot(Ns, Ldir), 0.0);
      float spec = pow(max(dot(Ns, H), 0.0), 42.0);
      vec3 metallic =
        u_lightColor * fabricColor * (spec * 3.5 + ndl * 0.25) * sunShade +
        u_ambientColor * fabricColor * 0.55;
      color = mix(color, metallic, metal);
    }

    // Exponential fog blend.
    float dist = length(camPos - vWorldPos);
    float fogAmt = 1.0 - exp(-u_fogDensity * u_fogDensity * dist * dist);
    color = mix(color, u_fogColor, clamp(fogAmt, 0.0, 1.0));

    // Metal reads as opaque — lift alpha toward solid as metalness rises so
    // sheer fabric doesn't stay see-through where it's meant to be foil.
    float alpha = clamp(1.0 - lossExp, 0.0, 1.0);
    alpha = mix(alpha, max(alpha, 0.9), metal);

    gl_FragColor = vec4(color, alpha * u_fade);
  }
`;

// ── Sky ───────────────────────────────────────────────────────────────────────
// Inside-out sphere at the far frustum edge. Gradient sky + procedural sun
// disk + halo tracked to the current sun direction so both light source and
// atmosphere shift together.
export const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Note: no explicit precision — Three injects highp in the fragment prelude,
// and mediump on some GPUs quantizes the gradient math itself into bands
// before the dither below can help.
export const SKY_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 u_top;
  uniform vec3 u_bottom;
  uniform vec3 u_sunDir;
  uniform vec3 u_sunColor;
  uniform float u_sunAlt;
  // Scene fog color (same value the cloth + FogExp2 use). The horizon haze
  // band tints toward it so the sky and the distance fog read as one
  // atmosphere rather than two separate gradients.
  uniform vec3 u_fogColor;
  // 0 = full sky, 1 = flat dark-gray backdrop. Lighting on the scene is
  // driven by the DirectionalLight/HemisphereLight/cloth uniforms and is
  // NOT affected by this mode — only the visible background sphere is.
  uniform int u_skyMode;
  void main() {
    if (u_skyMode == 1) {
      // Slightly gray-ish black so the backdrop reads as an unlit surface
      // rather than pure void, and edge-fray anti-aliasing has something
      // to blend against.
      gl_FragColor = vec4(0.14, 0.14, 0.15, 1.0);
      return;
    }
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = mix(u_bottom, u_top, pow(h, 0.7));
    float sunDot = max(0.0, dot(dir, normalize(u_sunDir)));

    // Azimuthal asymmetry — the sun's half of the dome sits brighter and
    // warmer, the anti-solar half darker and cooler. A purely vertical
    // gradient is symmetric, which is exactly the "flat painted sky" tell;
    // this term rotates with the orbiting sun so the whole dome turns with it.
    vec2 dirAz = normalize(vec2(dir.x, dir.z) + 1e-5);
    vec2 sunAz = normalize(vec2(u_sunDir.x, u_sunDir.z) + 1e-5);
    float sunSide = dot(dirAz, sunAz);              // +1 toward sun, −1 away
    sky *= 1.0 + sunSide * 0.10;                    // lift the sun side
    sky = mix(sky, sky * vec3(0.92, 0.96, 1.06),    // cool the far side
              max(0.0, -sunSide) * 0.5);

    // Horizon haze band — Rayleigh in-scatter through the long low-angle air
    // path piles a desaturated, brightened wedge on the horizon (both sides).
    // Tinting toward the scene fog color is what knits sky and distance fog
    // into a single atmosphere, so the cloth sits *in* the sky.
    float haze = exp(-abs(dir.y) * 5.0);
    sky = mix(sky, u_fogColor * 1.08, haze * 0.5);

    // Warm horizon glow — tint the bottom of the sky toward the sun's color
    // as the sun sinks. Ties the whole scene together tonally. Sits on top of
    // the haze so the low sun still punches through it.
    float horizonSun = pow(sunDot, 3.0) * (1.0 - clamp(u_sunAlt, 0.0, 1.0));
    sky = mix(sky, u_sunColor * 0.9, horizonSun * 0.4);
    // Sun, three lobes wide→tight: atmospheric halo, inner glow, and an HDR
    // disk pushed far past 1.0 — the ACES tone curve rolls the overshoot off
    // into a photographic bloom shoulder instead of clipping to a hard
    // sticker-edged circle. (Deliberately relies on renderer.toneMapping =
    // ACESFilmicToneMapping; with tonemapping off this would clip.)
    float halo = pow(sunDot, 8.0) * 0.55;
    float glow = pow(sunDot, 64.0) * 1.5;
    float disk = pow(sunDot, 900.0) * 40.0;
    sky += u_sunColor * (halo + glow + disk);
    // Screen-space hash dither, ±0.75/255. The gradient spans few 8-bit
    // steps across a lot of pixels; without breaking it up it bands — the
    // single loudest "rendered sky" tell.
    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    sky += (dither - 0.5) * (1.5 / 255.0);
    gl_FragColor = vec4(sky, 1.0);
  }
`;
