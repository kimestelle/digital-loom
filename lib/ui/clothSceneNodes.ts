// ─── clothSceneNodes.ts ───────────────────────────────────────────────────────
// TSL node materials for the cloth scene. Kept out of the component so the
// component reads as glue between physics, geometry, and lighting rather than
// several hundred lines of shading interspersed with wiring code.
//
// These replace the former GLSL ShaderMaterials: three's WebGPURenderer only
// accepts node materials, and TSL compiles to WGSL on the WebGPU backend and
// GLSL on the WebGL 2 fallback, so one source serves both.
//
// Parity notes vs. the old ShaderMaterials:
//   - fragmentNode output is NOT tone-mapped or color-space converted by the
//     renderer — exactly like a non-raw ShaderMaterial body without the
//     tonemapping/colorspace chunks, which is what these shaders were. The
//     math ports 1:1, no compensation.
//   - `fog: false` on both materials is mandatory: NodeMaterial defaults to
//     scene fog ON (ShaderMaterial defaults OFF), and the cloth applies its
//     own exponential fog via uniforms while the sky wants none.
//   - Every sampler slot is always bound: a shared 1×1 black DataTexture
//     stands in when no map is loaded, matching WebGL's sample-black-from-null
//     semantics (including the POM march over black before the density map
//     arrives).
//   - NO int-typed uniforms: runtime updates to `uniform(n, "int")` values
//     did not reach the WebGPU backend in three r185 (verified via the
//     sky-mode toggle — the shader kept reading the build-time value), so
//     every flag/enum uniform here is a float compared with greaterThan(0.5)
//     or exact small-integer equal(). Small ints are exact in f32.

import type { Node } from "three/webgpu";
import {
  AdditiveBlending,
  Color,
  DataTexture,
  DoubleSide,
  BackSide,
  LinearFilter,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  RepeatWrapping,
  Vector2,
  Vector3,
} from "three/webgpu";
import {
  Discard,
  Fn,
  If,
  attribute,
  cameraPosition,
  clamp,
  cos,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  materialOpacity,
  max,
  min,
  mix,
  normalLocal,
  normalWorld,
  modelWorldMatrix,
  positionGeometry,
  positionWorld,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  step,
  texture,
  transpose,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  POM_DEBUG_OFFSET,
  POM_DEBUG_STEPS,
  pomCotangentFrame,
  pomSelfShadow,
  pomTrace,
} from "@/lib/cloth/pom.tsl";

// 1×1 opaque black. Bound to a sampler slot that has no map so the shader
// samples black exactly like WebGL did with a null sampler uniform. One
// instance PER SLOT — the node builder deduplicates texture nodes by value,
// so slots sharing a single placeholder instance would collapse into one
// binding at build and then all read whichever map loads last. Slot-clear
// code re-binds the slot's own placeholder and must never dispose it.
export function makeBlackTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export type ClothMaterialBundle = ReturnType<typeof createClothMaterial>;
export type SkyMaterialBundle = ReturnType<typeof createSkyMaterial>;

// Shared spectral ramp — a cosine palette swept across the visible spectrum
// (t = 0 → red, ~0.33 → green, ~0.67 → blue). One palette serves the
// transmission fringe, the grating sheen, and the sky halo so every rainbow
// in the scene agrees tonally; three cos() and a couple of mads, no LUT.
const spectralRamp = (t: Node<"float">) =>
  cos(t.add(vec3(0.0, 0.33, 0.67)).mul(Math.PI * 2))
    .mul(0.5)
    .add(0.5);

// ── Cloth ─────────────────────────────────────────────────────────────────────
// The POM + edge-fray + transmission material. `u` keeps the old ShaderMaterial
// uniform names with `.value` semantics so the component's per-frame push block
// carries over verbatim; `tex` holds the swappable texture nodes (assign
// `.value`, never null — use the slot's entry in `blanks`).
export function createClothMaterial() {
  const blanks = {
    albedo: makeBlackTexture(),
    density: makeBlackTexture(),
    metalness: makeBlackTexture(),
    normal: makeBlackTexture(),
    roughness: makeBlackTexture(),
  };
  const tex = {
    albedo: texture(blanks.albedo),
    density: texture(blanks.density),
    metalness: texture(blanks.metalness),
    normal: texture(blanks.normal),
    roughness: texture(blanks.roughness),
  };

  // Initial values mirror the old constructor defaults. The knob uniforms are
  // re-pushed from props every tick (and the sun/fog ones every updateSun), so
  // only the constants — u_ambientColor, u_baseColor, u_stretchDetail,
  // u_fogDensity — actually rely on these numbers.
  const u = {
    u_lightDir: uniform(new Vector3(0, 0, 1)),
    u_lightColor: uniform(new Color(1.4, 1.2, 0.95)),
    u_ambientColor: uniform(new Color(0.32, 0.42, 0.55)),
    u_baseColor: uniform(new Color(1, 1, 1)),
    u_translucency: uniform(0.55),
    u_sheen: uniform(0.9),
    u_albedoAmount: uniform(1.0),
    u_densityAmount: uniform(0.725),
    u_alphaFromDensity: uniform(0.055),
    u_metalness: uniform(0.0),
    u_hasMetalnessTex: uniform(0),
    u_normalAmount: uniform(1.0),
    u_hasNormalTex: uniform(0),
    u_pomShadow: uniform(0.55),
    u_stretch: uniform(0.0),
    u_stretchDetail: uniform(0.5),
    u_stretchDebug: uniform(0),
    u_alphaBoost: uniform(0.0),
    u_alphaBoostSource: uniform(0),
    u_hasRoughnessTex: uniform(0),
    u_pomScale: uniform(0.015),
    u_pomMinSteps: uniform(8),
    u_pomMaxSteps: uniform(32),
    u_pomDebug: uniform(0),
    u_edgeInset: uniform(0.008),
    u_edgeFray: uniform(0.12),
    u_edgeSharpness: uniform(0.15),
    u_edgeDetail: uniform(1.0),
    u_tileScale: uniform(1.0),
    u_txHeight: uniform(1.0),
    u_txAlbedo: uniform(0.0),
    u_txRoughness: uniform(0.0),
    u_transmissionContrast: uniform(0.3),
    u_materialReveal: uniform(1.0),
    u_iridescence: uniform(0.0),
    u_fade: uniform(1.0),
    u_fogColor: uniform(new Color(0xbecfe0)),
    u_fogDensity: uniform(0.00019), // matches the scene's FogExp2 density
  };

  // Varyings — 1:1 with the old GLSL vertex shader (default vertex stage,
  // no displacement).
  //
  // Flip V: the solver builds UVs with row 0 (the pinned top edge) at v=0,
  // but image textures put their top row at v=1 (three's default flipY), so
  // sampling straight put every map on upside down. Flipping here fixes all
  // maps at once, and the tangent frame (derived from dFdx/dFdy of vUv in the
  // fragment) flips with it, so normal-map lighting stays consistent.
  const vUv = varying(vec2(uv().x, uv().y.oneMinus()), "vClothUv");
  // Per-vertex directional strain (u = crosswise, v = lengthwise); 0 = rest,
  // >0 = stretched. Solver-authored (ClothSolver.computeStrain), interpolated
  // across the triangle so the fragment gets a smooth field.
  const vStrain = varying(
    vec2(attribute("strain", "vec2") as Node<"vec2">),
    "vClothStrain",
  );
  // Raw world normal — mat3(modelMatrix) * normal, deliberately NOT three's
  // normalWorld: the built-in applies the double-sided faceDirection flip,
  // which the GLSL never did, and the back/front transmission split
  // (dot(Ns, L) vs dot(Ns, -L)) depends on the unflipped normal.
  const vNormalRaw = varying(
    modelWorldMatrix.mul(vec4(normalLocal, 0.0)).xyz,
    "vClothNormal",
  );

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.side = DoubleSide;
  material.fog = false;

  material.fragmentNode = Fn(() => {
    const N = vNormalRaw.normalize().toVar();
    const L = u.u_lightDir.normalize().toVar(); // direction the sun light travels
    const V = cameraPosition.sub(positionWorld).normalize().toVar();

    // ── Stretch response ──────────────────────────────────────────────────
    // How taut is the fabric *here*? Two signals, both cheap: Tier B is the
    // smooth per-vertex strain the solver measured; Tier A recovers per-pixel
    // stretch from screen derivatives (crisp at folds). An inextensible weave
    // only stretches a few percent, so we gain the result up to make it read.
    // Gated: at u_stretch == 0 (and no debug) this whole block is one compare.
    // (Derivatives stay in uniform control flow — the gate is uniform-valued.)
    const strainMag = float(0.0).toVar();
    const strainRaw = float(0.0).toVar();
    If(
      u.u_stretch.greaterThan(0.0).or(u.u_stretchDebug.greaterThan(0.5)),
      () => {
        const sB = max(vec2(0.0), vStrain);
        const dpx = dFdx(positionWorld);
        const dpy = dFdy(positionWorld);
        const dux = dFdx(vUv);
        const duy = dFdy(vUv);
        const det = dux.x.mul(duy.y).sub(dux.y.mul(duy.x)).toVar();
        const sA = vec2(0.0).toVar();
        If(det.abs().greaterThan(1e-8), () => {
          // world-units spanned per UV-unit; ÷ rest sheet size (423 world
          // units) so 1.0 = unstretched. Isometry preserves this under pure
          // bending, so it isolates real stretch from drape folds.
          const dPdu = dpx.mul(duy.y).sub(dpy.mul(dux.y)).div(det);
          const dPdv = dpx.negate().mul(duy.x).add(dpy.mul(dux.x)).div(det);
          sA.assign(
            max(vec2(0.0), vec2(length(dPdu), length(dPdv)).div(423.0).sub(1.0)),
          );
        });
        const s = sB.add(sA.mul(u.u_stretchDetail));
        strainRaw.assign(s.x.add(s.y).mul(0.5));
        strainMag.assign(clamp(strainRaw.mul(12.0), 0.0, 1.0).mul(u.u_stretch));
      },
    );

    // Taut fabric pulls its threads straight — the weave relief flattens.
    const pomScaleEff = u.u_pomScale.div(strainMag.mul(1.5).add(1.0));

    // POM in tiled UV space so the raymarch operates on the same signal every
    // downstream sample reads from. Tangent frame + trace run before the
    // debug/full-shading branch chain so all derivative work stays in uniform
    // control flow (a WGSL uniformity requirement).
    const tiledUv = vUv.mul(u.u_tileScale).toVar();
    const TBN = pomCotangentFrame(N, positionWorld, tiledUv).toVar();
    const TBNt = transpose(TBN).toVar(); // world→tangent, reused below
    const viewTS = TBNt.mul(V).normalize().toVar();
    const pomUv = vec2(tiledUv).toVar();
    const pomSteps = float(0.0).toVar();
    // Real branch, not select() — select evaluates both sides and would pay
    // for the march even at pomScale == 0.
    If(u.u_pomScale.greaterThan(0.0), () => {
      const r = pomTrace(
        tex.density,
        tiledUv,
        viewTS,
        pomScaleEff,
        u.u_pomMinSteps,
        u.u_pomMaxSteps,
      );
      pomUv.assign(r.xy);
      pomSteps.assign(r.z);
    });

    // The three GLSL early-return debug modes become one If/ElseIf chain
    // writing outColor; the Else carries the full shading path.
    const outColor = vec4(0.0).toVar();
    If(u.u_stretchDebug.greaterThan(0.5), () => {
      const t = clamp(strainRaw.mul(12.0), 0.0, 1.0); // slate→amber→white
      const dbg = select(
        t.lessThan(0.5),
        mix(vec3(0.15, 0.2, 0.35), vec3(0.95, 0.7, 0.2), t.mul(2.0)),
        mix(vec3(0.95, 0.7, 0.2), vec3(1.0, 1.0, 1.0), t.sub(0.5).mul(2.0)),
      );
      outColor.assign(vec4(dbg, 1.0));
    })
      .ElseIf(u.u_pomDebug.equal(POM_DEBUG_OFFSET), () => {
        const mag = length(pomUv.sub(tiledUv));
        const g = clamp(mag.div(max(u.u_pomScale, 1e-4)).mul(4.0), 0.0, 1.0);
        outColor.assign(vec4(g, g.mul(0.6).add(0.15), g.oneMinus(), 1.0));
      })
      .ElseIf(u.u_pomDebug.equal(POM_DEBUG_STEPS), () => {
        const s = clamp(pomSteps.div(max(u.u_pomMaxSteps, 1.0)), 0.0, 1.0);
        outColor.assign(vec4(s, s.mul(0.5), s.oneMinus(), 1.0));
      })
      .Else(() => {
        // Edge carve — apron + noise punchout.
        const d = min(
          min(vUv.x, vUv.x.oneMinus()),
          min(vUv.y, vUv.y.oneMinus()),
        ).toVar();
        const hemFactor = float(0.0).toVar();
        If(u.u_edgeInset.greaterThan(0.0), () => {
          const raw = tex.density.sample(tiledUv.mul(u.u_edgeDetail)).r.toVar();
          const contrast = mix(1.0, 3.5, u.u_edgeSharpness);
          const noise = clamp(raw.sub(0.5).mul(2.0).mul(contrast), -1.0, 1.0);
          const striation = raw.sub(0.5).abs().mul(2.0);
          const striationBoost = mix(0.4, 1.8, striation);
          const amp = u.u_edgeFray.mul(0.08).mul(striationBoost);
          const carve = max(0.0, u.u_edgeInset.add(amp.mul(noise))).toVar();
          Discard(d.lessThan(carve));
          const hemWidth = max(0.015, u.u_edgeInset.mul(0.6));
          hemFactor.assign(smoothstep(carve, carve.add(hemWidth), d).oneMinus());
        });

        const albedoSample = tex.albedo.sample(pomUv).rgb.toVar();
        const fabricColor = mix(
          u.u_baseColor.rgb,
          albedoSample,
          u.u_albedoAmount,
        ).toVar();

        // ── Micro-relief shading normal ─────────────────────────────────────
        // Perturb the smooth vertex normal with the Patina normal map so the
        // weave actually catches light. Sampled at pomUv — the same relief the
        // parallax march resolved — otherwise highlights slide off the threads
        // they belong to. TBN columns are tangent→world, reusing the POM frame.
        const Ns = vec3(N).toVar();
        If(
          u.u_hasNormalTex.greaterThan(0.5).and(u.u_normalAmount.greaterThan(0.0)),
          () => {
            const nTS = tex.normal.sample(pomUv).xyz.mul(2.0).sub(1.0).toVar();
            nTS.assign(vec3(nTS.xy.mul(u.u_normalAmount), nTS.z));
            Ns.assign(TBN.mul(nTS.normalize()).normalize());
          },
        );

        // ── POM self-shadow ─────────────────────────────────────────────────
        // March from the contact point toward the sun through the height
        // field; threads shadow each other. Only direct sun terms are
        // attenuated — ambient and back-transmission take different paths.
        const sunShade = float(1.0).toVar();
        If(
          u.u_pomScale.greaterThan(0.0).and(u.u_pomShadow.greaterThan(0.0)),
          () => {
            const lightTS = TBNt.mul(L.negate()).normalize();
            const shade = pomSelfShadow(
              tex.density,
              pomUv,
              lightTS,
              u.u_pomScale,
              u.u_pomMinSteps,
              u.u_pomMaxSteps,
            );
            sunShade.assign(mix(1.0, shade, u.u_pomShadow));
          },
        );

        const texel = tex.density.sample(pomUv).r;
        const albedoLum = dot(albedoSample, vec3(0.2126, 0.7152, 0.0722)).toVar();
        // Density is a weighted blend of up to three source maps (height,
        // albedo, roughness), each with its own independent weight. Zero-weight
        // maps drop out; the weighted mean normalises so relative slider
        // values set the mix. roughLum falls back to 0.5 (neutral) when no
        // roughness map is bound so a stray txRoughness weight can't punch the
        // density to an extreme.
        const roughLum = select(
          u.u_hasRoughnessTex.greaterThan(0.5),
          tex.roughness.sample(pomUv).r,
          float(0.5),
        );
        const txSum = u.u_txHeight.add(u.u_txAlbedo).add(u.u_txRoughness);
        const baseDensity = float(1.0).toVar();
        If(txSum.greaterThan(1e-4), () => {
          baseDensity.assign(
            u.u_txHeight
              .mul(texel)
              .add(u.u_txAlbedo.mul(albedoLum))
              .add(u.u_txRoughness.mul(roughLum))
              .div(txSum),
          );
        });
        // (All sources off → baseDensity stays 1.0: opaque fabric, no
        // map-driven transmission variation.)

        const txMul = u.u_transmissionContrast.mul(3.0).add(1.0);
        baseDensity.assign(clamp(baseDensity.sub(0.5).mul(txMul).add(0.5), 0.0, 1.0));

        const density = mix(1.0, baseDensity, u.u_densityAmount);
        // Stretched fabric spreads its threads — gaps open, cloth goes sheer.
        // Physically the same thing the alpha path already does, just
        // localised to where the sheet is under tension.
        const openness = clamp(
          density.oneMinus().add(strainMag.mul(0.5)),
          0.0,
          1.0,
        ).toVar();

        // Threadbare weight for the boost. Height keeps the original formula
        // (boost rides the same openness signal the base term uses); the other
        // sources read their own map at pomUv so worn patches follow the
        // captured material rather than the weave relief.
        const boostWeight = float(openness).toVar();
        If(u.u_alphaBoostSource.equal(1.0), () => {
          boostWeight.assign(albedoLum.oneMinus());
        })
          .ElseIf(
            u.u_alphaBoostSource.equal(2.0).and(u.u_hasRoughnessTex.greaterThan(0.5)),
            () => {
              boostWeight.assign(tex.roughness.sample(pomUv).r.oneMinus());
            },
          )
          .ElseIf(
            u.u_alphaBoostSource.equal(3.0).and(u.u_hasMetalnessTex.greaterThan(0.5)),
            () => {
              boostWeight.assign(tex.metalness.sample(pomUv).r.oneMinus());
            },
          );

        // Exponential sheerness. As openness × u_alphaFromDensity grows, alpha
        // drops much faster than linear (a light nudge of the slider produces
        // a noticeable transparency shift), and the fabric color desaturates
        // slightly toward the base so albedo differences fade with opacity —
        // real thin fabric loses saturation as it turns sheer because the
        // light transmitted through it dominates the surface's own hue.
        const lossLinear = openness
          .mul(u.u_alphaFromDensity)
          .add(boostWeight.mul(u.u_alphaBoost));
        const lossExp = pow(max(0.0, lossLinear.oneMinus()), 2.5).oneMinus().toVar();
        fabricColor.assign(mix(fabricColor, u.u_baseColor.rgb, lossExp.mul(0.35)));

        // Backlit transmission when the sun is on the far side of the fabric
        // (surface normal aligned with the light-travel direction). All direct
        // terms use the micro-relief normal Ns so the weave shapes the light.
        const back = max(0.0, dot(Ns, L));
        const front = max(0.0, dot(Ns, L.negate()));

        const transmitAmt = u.u_translucency
          .mul(openness.mul(0.65).add(0.35))
          .mul(mix(1.0, 1.8, hemFactor));
        const transmitted = u.u_lightColor.rgb
          .mul(fabricColor)
          .mul(back)
          .mul(transmitAmt)
          .toVar();

        // ── Rainbow dispersion of the transmitted glow ────────────────────
        // Refraction through the fibers is wavelength-dependent: evaluate the
        // same transmission lobe at slightly shifted cosines per channel (a
        // cosine shift ≈ an angular shift for small angles) and tint the
        // transmitted light by the normalized spectral ratio. Pure ALU on
        // values already in registers — no texture taps. The channels only
        // diverge at the lobe's falloff edge, so the core glow stays warm and
        // the rim fringes into a rainbow; sheer regions disperse more.
        If(u.u_iridescence.greaterThan(0.0), () => {
          const disp = u.u_iridescence
            .mul(0.1)
            .mul(openness.mul(0.65).add(0.35));
          const lobeR = pow(clamp(back.add(disp), 0.0, 1.0), 3.0);
          const lobeG = pow(back, 3.0);
          const lobeB = pow(clamp(back.sub(disp), 0.0, 1.0), 3.0);
          const s3 = vec3(lobeR, lobeG, lobeB);
          // Normalizing by the channel mean keeps the transmitted energy —
          // the tint redistributes it across the spectrum, never adds light.
          const tint = s3.div(max(s3.dot(vec3(1.0 / 3.0)), 1e-4));
          transmitted.mulAssign(
            mix(vec3(1.0), tint, clamp(u.u_iridescence.mul(0.8), 0.0, 1.0)),
          );
        });

        // Forward diffuse — Lambertian from the sun on the viewer's side,
        // attenuated where neighbouring threads occlude it.
        const frontDiffuse = u.u_lightColor.rgb
          .mul(fabricColor)
          .mul(front)
          .mul(0.9)
          .mul(sunShade);

        // Ambient sky bounce.
        const ambient = u.u_ambientColor.rgb.mul(fabricColor).mul(0.55);

        // Grazing sheen — grazing to view, boosted at cut hems. On the micro
        // normal, so individual threads sparkle instead of the whole sheet.
        // Taut threads lie flat and parallel — they catch a sharper specular.
        const graze = dot(Ns, V).abs().oneMinus();
        const sheen = pow(graze, 3.0)
          .mul(u.u_sheen)
          .mul(mix(1.0, 1.5, hemFactor))
          .mul(strainMag.mul(1.5).add(1.0));

        const color = frontDiffuse
          .add(transmitted.mul(0.65))
          .add(ambient)
          .add(u.u_lightColor.rgb.mul(sheen).mul(0.5).mul(sunShade))
          .toVar();

        color.mulAssign(mix(1.0, 0.72, hemFactor));

        // ── Grating iridescence ─────────────────────────────────────────────
        // Parallel threads are a diffraction grating: the classic grating
        // condition keys the spectral order to the projection of (V̂ − L̂)
        // onto the thread axes — both come free from the POM tangent frame.
        // Path difference → hue via the shared ramp. The band rides the
        // already-computed sheen lobe (so it lives at grazing angles like
        // real silk shimmer), taut threads (strain, folded into sheen)
        // sharpen it, and the POM self-shadow kills it where neighbouring
        // threads occlude the sun. Zero texture taps.
        If(u.u_iridescence.greaterThan(0.0), () => {
          const sumTS = TBNt.mul(V.sub(L));
          const t = fract(sumTS.x.mul(1.7).add(sumTS.y.mul(2.3)));
          const band = spectralRamp(t);
          // Deliberately a FAINT TRACE (~12% of the original strength): hue
          // stripes across the surface read as synthetic oil-slick when loud;
          // the anchored-to-the-sun lens flare carries the rainbow instead.
          const iri = sheen.mul(u.u_iridescence).mul(0.06);
          color.addAssign(u.u_lightColor.rgb.mul(band).mul(iri).mul(sunShade));
        });

        // ── Metalness ───────────────────────────────────────────────────────
        // Metals carry no diffuse albedo — their energy goes into a tight,
        // albedo-tinted specular highlight plus reflected ambient. Lerp the
        // dielectric shading toward that metallic model by the per-texel
        // metalness (map × amount). At u_metalness == 0 the fabric is
        // untouched, and both blocks cost one uniform compare.
        const metal = float(0.0).toVar();
        If(u.u_metalness.greaterThan(0.0), () => {
          const metalMap = select(
            u.u_hasMetalnessTex.greaterThan(0.5),
            tex.metalness.sample(pomUv).r,
            float(1.0),
          );
          metal.assign(clamp(metalMap.mul(u.u_metalness), 0.0, 1.0));
        });
        If(metal.greaterThan(0.0), () => {
          const Ldir = L.negate(); // toward the sun
          const H = Ldir.add(V).normalize();
          const ndl = max(dot(Ns, Ldir), 0.0);
          const spec = pow(max(dot(Ns, H), 0.0), 42.0);
          const metallic = u.u_lightColor.rgb
            .mul(fabricColor)
            .mul(spec.mul(3.5).add(ndl.mul(0.25)))
            .mul(sunShade)
            .add(u.u_ambientColor.rgb.mul(fabricColor).mul(0.55));
          color.assign(mix(color, metallic, metal));
        });

        // Exponential fog blend — same formula FogExp2 uses, fed by uniforms
        // so the cloth dissolves into the atmosphere with the rest of the
        // scene (scene fog itself is off for this material).
        const dist = length(cameraPosition.sub(positionWorld));
        const fogAmt = exp(
          u.u_fogDensity.mul(u.u_fogDensity).mul(dist).mul(dist).negate(),
        ).oneMinus();
        color.assign(mix(color, u.u_fogColor.rgb, clamp(fogAmt, 0.0, 1.0)));

        // Metal reads as opaque — lift alpha toward solid as metalness rises
        // so sheer fabric doesn't stay see-through where it's meant to be
        // foil.
        const alpha = clamp(lossExp.oneMinus(), 0.0, 1.0).toVar();
        alpha.assign(mix(alpha, max(alpha, 0.9), metal));

        // A deterministic UV-space pixel mask used while a material moves
        // between its swatch and this mesh. The canvas transfer layer uses the
        // same hash and 64×64 grid, so cells disappear there on the frame they
        // appear here.
        const revealCell = floor(vUv.mul(64.0));
        const revealNoise = fract(
          sin(dot(revealCell, vec2(127.1, 311.7))).mul(43758.5453123),
        );
        const pixelReveal = select(
          u.u_materialReveal.lessThanEqual(0.0),
          float(0.0),
          select(
            u.u_materialReveal.greaterThanEqual(1.0),
            float(1.0),
            step(revealNoise, u.u_materialReveal),
          ),
        );

        outColor.assign(
          vec4(color, alpha.mul(u.u_fade).mul(pixelReveal)),
        );
      });
    return outColor;
  })();

  return { material, u, tex, blanks };
}

// ── Sky ───────────────────────────────────────────────────────────────────────
// Inside-out sphere at the far frustum edge. Gradient sky + procedural sun
// disk + halo tracked to the current sun direction so both light source and
// atmosphere shift together. (The HDR sun disk overshoot writes straight to
// the framebuffer and clips, exactly as the old ShaderMaterial did.)
export function createSkyMaterial() {
  const u = {
    u_top: uniform(new Color(0x2f5c94)),
    u_bottom: uniform(new Color(0xe6d3b0)),
    u_sunDir: uniform(new Vector3(0, 0.5, 1).normalize()),
    u_sunColor: uniform(new Color(1.0, 0.86, 0.65)),
    u_sunAlt: uniform(0.5),
    // Scene fog color (same value the cloth + FogExp2 use). The horizon haze
    // band tints toward it so the sky and the distance fog read as one
    // atmosphere rather than two separate gradients.
    u_fogColor: uniform(new Color(0xbecfe0)),
    // 0 = full sky, 1 = flat dark-gray backdrop. Lighting on the scene is
    // driven by the DirectionalLight/HemisphereLight/cloth uniforms and is
    // NOT affected by this mode — only the visible background sphere is.
    // (Float, compared with >0.5 — see the int-uniform note in the header.)
    u_skyMode: uniform(0),
    // Circumsolar spectral ring strength (driven by the same iridescence
    // knob as the cloth, so the sun itself reads as refracting).
    u_halo: uniform(0),
  };

  const vDir = varying(positionGeometry, "vSkyDir");

  const material = new MeshBasicNodeMaterial();
  material.side = BackSide;
  material.depthWrite = false;
  material.fog = false;

  material.fragmentNode = Fn(() => {
    const outColor = vec4(0.0).toVar();
    If(u.u_skyMode.greaterThan(0.5), () => {
      // Slightly gray-ish black so the backdrop reads as an unlit surface
      // rather than pure void, and edge-fray anti-aliasing has something to
      // blend against.
      outColor.assign(vec4(0.14, 0.14, 0.15, 1.0));
    }).Else(() => {
      const dir = vDir.normalize().toVar();
      const h = clamp(dir.y.mul(0.5).add(0.5), 0.0, 1.0);
      const sky = mix(u.u_bottom.rgb, u.u_top.rgb, pow(h, 0.7)).toVar();
      const sunDot = max(0.0, dot(dir, u.u_sunDir.normalize())).toVar();

      // Azimuthal asymmetry — the sun's half of the dome sits brighter and
      // warmer, the anti-solar half darker and cooler. A purely vertical
      // gradient is symmetric, which is exactly the "flat painted sky" tell;
      // this term rotates with the orbiting sun so the whole dome turns with
      // it.
      const dirAz = vec2(dir.x, dir.z).add(1e-5).normalize();
      const sunAz = vec2(u.u_sunDir.x, u.u_sunDir.z).add(1e-5).normalize();
      const sunSide = dot(dirAz, sunAz).toVar(); // +1 toward sun, −1 away
      sky.mulAssign(sunSide.mul(0.1).add(1.0)); // lift the sun side
      sky.assign(
        mix(
          sky,
          sky.mul(vec3(0.92, 0.96, 1.06)), // cool the far side
          max(0.0, sunSide.negate()).mul(0.5),
        ),
      );

      // Horizon haze band — Rayleigh in-scatter through the long low-angle
      // air path piles a desaturated, brightened wedge on the horizon (both
      // sides). Tinting toward the scene fog color is what knits sky and
      // distance fog into a single atmosphere, so the cloth sits *in* the sky.
      const haze = exp(dir.y.abs().mul(5.0).negate());
      sky.assign(mix(sky, u.u_fogColor.rgb.mul(1.08), haze.mul(0.34)));

      // Warm horizon glow — tint the bottom of the sky toward the sun's color
      // as the sun sinks. Ties the whole scene together tonally. Sits on top
      // of the haze so the low sun still punches through it.
      const horizonSun = pow(sunDot, 3.0).mul(
        clamp(u.u_sunAlt, 0.0, 1.0).oneMinus(),
      );
      sky.assign(mix(sky, u.u_sunColor.rgb.mul(0.9), horizonSun.mul(0.4)));

      // Sun, three lobes wide→tight: atmospheric halo, inner glow, and a disk
      // pushed far past 1.0. (Note: fragmentNode output skips tone mapping —
      // as did the old ShaderMaterial — so the overshoot clips to white; kept
      // for parity.)
      const halo = pow(sunDot, 8.0).mul(0.38);
      const glow = pow(sunDot, 64.0).mul(1.0);
      const disk = pow(sunDot, 900.0).mul(28.0);
      sky.addAssign(u.u_sunColor.rgb.mul(halo.add(glow).add(disk)));

      // Circumsolar spectral ring (22°-halo-like). A gaussian in cosine
      // space — no acos — centered at cos(22°) ≈ 0.927, hue signed across
      // the ring (red sunward → blue outside). Real coronas are never a
      // clean printed circle: the ring is broken up by a sky-anchored
      // blotch field (it stays put while the ring sweeps through it as the
      // sun orbits, so the breakup drifts organically), fades against a
      // bright high sun, and is desaturated toward the sun's own color.
      If(u.u_halo.greaterThan(0.0), () => {
        const ringT = sunDot.sub(0.927).mul(34.0);
        const ring = exp(ringT.mul(ringT).negate());
        const hue = mix(
          spectralRamp(clamp(float(0.5).sub(ringT.mul(0.5)), 0.0, 1.0)),
          vec3(1.0),
          0.3,
        );
        const blotch = sin(dir.x.mul(41.0).add(dir.y.mul(27.0)))
          .mul(sin(dir.z.mul(37.0).sub(dir.y.mul(19.0))))
          .mul(0.5)
          .add(0.5)
          .mul(0.75)
          .add(0.25);
        const lowSun = clamp(u.u_sunAlt, 0.0, 1.0).mul(0.5).oneMinus();
        sky.addAssign(
          hue
            .mul(u.u_sunColor.rgb)
            .mul(ring)
            .mul(blotch)
            .mul(lowSun)
            .mul(u.u_halo)
            .mul(0.12),
        );
      });

      // Screen-space hash dither, ±0.75/255. The gradient spans few 8-bit
      // steps across a lot of pixels; without breaking it up it bands — the
      // single loudest "rendered sky" tell.
      const dither = fract(
        sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453),
      );
      sky.addAssign(dither.sub(0.5).mul(1.5 / 255.0));
      outColor.assign(vec4(sky, 1.0));
    });
    return outColor;
  })();

  return { material, u };
}

// ── Lens flare ────────────────────────────────────────────────────────────────
// Photographic flare drawn as an additive fullscreen overlay, last in the
// frame, and grounded in what lenses actually do:
//
//   - Ghosts are inter-element DOUBLE reflections. Coated glass reflects well
//     under 1% per surface, so a ghost carries ~1e-4 of the sun's light — a
//     faint translucent disk, never a solid circle. Their centers sit on the
//     line through the source and the optical axis (screen center).
//   - Their color is a subtle WHOLE-DISK tint from the anti-reflective
//     coating (coatings suppress green best → alternating faint magenta /
//     green / cyan casts between element pairs), not a rainbow rim.
//   - A larger ghost is a more-defocused aperture image: same energy over
//     more area → dimmer (strength scales ~1/r here).
//   - Most of visible "flare" is veiling glare: a broad low haze toward the
//     source that washes contrast.
//
// Everything is pure ALU keyed to the sun's NDC position — the component
// projects the sun each frame and hides the quad entirely when the flare
// would be invisible, so the overlay costs nothing while the sun is off-frame.
export type LensFlareBundle = ReturnType<typeof createLensFlareMaterial>;

export function createLensFlareMaterial() {
  const u = {
    /** Sun position in NDC (−1…1, y up). */
    u_sun: uniform(new Vector2(0, 0)),
    /** Viewport aspect (w/h) so orbs stay circular. */
    u_aspect: uniform(1.0),
    /** Overall strength; the component folds knob × on-screen fade into it. */
    u_amt: uniform(0.0),
  };

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  // The 2×2 plane's own coordinates ARE clip space — bypass the camera.
  material.vertexNode = vec4(positionGeometry.xy, 0.0, 1.0);
  const vNdc = varying(positionGeometry.xy, "vFlareNdc");

  // Ghosts: [axis position (fraction of sun vector; negative = across
  // center), radius, coating tint]. Three, not six — real flares show a
  // handful at most, and each additional orb reads as decoration. Peak
  // strengths land near 2–4% of framebuffer white via 0.028/r · body.
  const GHOSTS: Array<[number, number, [number, number, number]]> = [
    [0.42, 0.05, [1.0, 0.88, 0.97]], // faint magenta cast
    [-0.2, 0.085, [0.9, 1.0, 0.92]], // faint green cast
    [-0.55, 0.16, [0.9, 0.96, 1.0]], // faint cyan cast, large & dimmest
  ];

  material.fragmentNode = Fn(() => {
    // Aspect-corrected space so distances are isotropic.
    const p = vec2(vNdc.x.mul(u.u_aspect), vNdc.y).toVar();
    const s = vec2(u.u_sun.x.mul(u.u_aspect), u.u_sun.y).toVar();
    const col = vec3(0.0).toVar();

    // Veiling glare — the dominant real-world flare component: a broad,
    // very low warm haze centered on the source, washing contrast toward it.
    const dSun = length(p.sub(s));
    const veil = exp(dSun.mul(dSun).mul(-1.6)).mul(0.03);
    const core = exp(dSun.mul(dSun).mul(-60.0)).mul(0.06);
    col.addAssign(vec3(1.0, 0.94, 0.84).mul(veil.add(core)));

    // Ghosts. A defocused ghost is an image of the APERTURE, and an iris is
    // a blade polygon — so the shape is a soft hexagon (fixed orientation:
    // the iris doesn't rotate), its corners rounded toward circular by
    // defocus. Soft body + slightly brighter thin edge (spherical
    // aberration's donut), whole shape carrying the coating tint. The 1/r
    // factor is the energy-conservation term.
    const IRIS_ROT = 0.26; // radians; fixed blade orientation
    const cosR = Math.cos(IRIS_ROT);
    const sinR = Math.sin(IRIS_ROT);
    for (const [k, r, tint] of GHOSTS) {
      const c = s.mul(k);
      const o = p.sub(c);
      const q = vec2(
        o.x.mul(cosR).sub(o.y.mul(sinR)).abs(),
        o.x.mul(sinR).add(o.y.mul(cosR)).abs(),
      );
      // Pointy-top hex SDF (inradius r), blended 70/30 with the circular
      // metric so the corners read defocus-rounded, not die-cut.
      const hex = max(q.x.mul(0.866025).add(q.y.mul(0.5)), q.y);
      const t = mix(hex, length(o), 0.3).div(r);
      const body = smoothstep(1.0, 0.55, t);
      const edge = smoothstep(1.0, 0.86, t).mul(smoothstep(0.62, 0.92, t));
      const g = body.mul(0.55).add(edge.mul(0.45)).mul(0.028 / r).mul(0.1);
      col.addAssign(vec3(...tint).mul(g));
    }

    // Additive blend uses src alpha as a multiplier — bake the strength into
    // the color and keep alpha at 1 so u_amt scales the whole flare.
    return vec4(col.mul(u.u_amt), 1.0);
  })();

  return { material, u };
}

/** Clothesline rope/wire. A thin cylinder is the worst case for silhouette
 *  aliasing: at any real camera distance its screen footprint is only a few
 *  pixels wide, so its ENTIRE visible strip is silhouette edge — there's no
 *  interior fill for MSAA/supersampling to blend into, just a hard edge on
 *  both sides sweeping almost the full width. More samples raise the
 *  sampling rate, but a genuinely sub-pixel edge that shifts a fraction of a
 *  pixel every frame still shimmers no matter how high that rate goes.
 *  Instead of sampling harder, fade opacity analytically as the surface
 *  normal approaches edge-on to the camera (dot ≈ 0), so the rasterized cut
 *  is never hard in the first place — one dot product + smoothstep per
 *  fragment, negligible next to the geometry's own cost, independent of
 *  MSAA/pixelScale. */
export function createWireMaterial() {
  const material = new MeshStandardNodeMaterial();
  material.color = new Color(0x141414);
  material.roughness = 0.75;
  material.metalness = 0.15;
  material.transparent = true;
  material.side = DoubleSide;
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = dot(normalWorld, viewDir).abs();
  // opacityNode REPLACES the material's own `.opacity` uniform rather than
  // multiplying it (NodeMaterial only reads one or the other) — fold
  // materialOpacity back in so the runtime fade-in/out via `wireMat.opacity`
  // still works.
  material.opacityNode = smoothstep(0.0, 0.6, facing).mul(materialOpacity);
  return material;
}
