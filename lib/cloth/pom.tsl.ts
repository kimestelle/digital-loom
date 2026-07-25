// ─── pom.tsl.ts ───────────────────────────────────────────────────────────────
// Parallax Occlusion Mapping helpers as TSL functions, composed into the cloth
// node material. Keeping ALL POM code here (constants, tangent frame, ray
// march, self-shadow) so the material just imports these functions and stays
// legible.
//
// Compilation target: TSL — three compiles these to WGSL on the WebGPU
// backend and to GLSL on the WebGL 2 fallback, so no backend-specific source
// lives here. `.level(0)` sampling matters inside the march loops: implicit
// derivatives there would come from divergent loop iterations, which is
// undefined in both ESSL3 and WGSL and shows up as sparkle/shimmer at grazing
// angles.
//
// Contract with the caller:
//   1. Call pomCotangentFrame in uniform control flow (before any
//      value-dependent branch) — it uses screen derivatives.
//   2. Compute pomUv once via pomTrace, use it for EVERY texture sample.
//
// Height convention: the input map encodes 1.0 = raised thread, 0.0 = valley
// (Patina's convention). POM marches INTO the surface, so internally it works
// on depth = 1.0 - height. Get this backwards and the weave embosses toward
// the camera instead of recessing.

import type { Node, TextureNode } from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  int,
  inverseSqrt,
  length,
  mat3,
  max,
  mix,
  select,
  vec2,
  vec3,
} from "three/tsl";

// Hard loop bound — the runtime pomMaxSteps uniform can go up to this ceiling
// without a shader rebuild. The debug enum matches the u_pomDebug int uniform
// in the material.
export const POM_MAX_STEPS_LIMIT = 64;
export const POM_DEBUG_OFF = 0;
export const POM_DEBUG_OFFSET = 1;
export const POM_DEBUG_STEPS = 2;

// Screen-space-derivative tangent frame. Cloth-sim's positions change every
// frame, so precomputed per-vertex tangents would need re-uploading each step.
// dFdx/dFdy on world position + UV give us T,B,N cheaply and correctly enough
// for a mostly-continuous surface. Columns are tangent→world; the caller gets
// tangent-space vectors via transpose(TBN) (near-orthonormal, so transpose
// stands in for inverse).
export const pomCotangentFrame = Fn(
  ([N, p, uvIn]: [Node<"vec3">, Node<"vec3">, Node<"vec2">]) => {
    const dp1 = dFdx(p);
    const dp2 = dFdy(p);
    const duv1 = dFdx(uvIn);
    const duv2 = dFdy(uvIn);
    const dp2perp = cross(dp2, N);
    const dp1perp = cross(N, dp1);
    const T = dp2perp.mul(duv1.x).add(dp1perp.mul(duv2.x));
    const B = dp2perp.mul(duv1.y).add(dp1perp.mul(duv2.y));
    const invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
    return mat3(T.mul(invmax), B.mul(invmax), N);
  },
);

// Linear raymarch into the surface with one secant refinement at the contact
// point. Adaptive step count: grazing angles (viewTS.z near 0) use maxSteps,
// normal incidence (viewTS.z near 1) uses minSteps.
//
// Returns vec3(pomUv, stepsTaken) — the GLSL version's `out float stepsTaken`
// packed into .z, since a TSL function returns exactly one node.
//
// TODO: if vertex displacement lands later, POM should sample a high-pass
// version of the height map so the two aren't stacking the same low-frequency
// signal. For now this consumes the full height map.
export const pomTrace = Fn(
  ([hMap, uvIn, viewTS, scale, minSteps, maxSteps]: [
    TextureNode,
    Node<"vec2">,
    Node<"vec3">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
  ]) => {
    const grazing = viewTS.z.abs().oneMinus();
    const steps = mix(minSteps, maxSteps, clamp(grazing, 0.0, 1.0)).toVar();
    const layerDepth = float(1.0).div(steps).toVar();

    // Total UV displacement across the full depth. Guard the divide so we
    // don't explode when viewTS.z hits zero exactly at silhouette pixels, then
    // clamp the excursion (offset limiting): past ~6× scale (view ~80°
    // off-normal) the march would cross several threads and smear the weave
    // sideways — trading a little parallax accuracy at extreme angles for no
    // warping.
    const P = viewTS.xy.div(max(viewTS.z.abs(), 1e-3)).mul(scale).toVar();
    const pLen = length(P).toVar();
    const pMax = scale.mul(6.0).toVar();
    If(pLen.greaterThan(pMax), () => {
      P.mulAssign(pMax.div(pLen));
    });
    const deltaUv = P.div(steps).toVar();

    const curUv = vec2(uvIn).toVar();
    const curDepth = float(0.0).toVar();
    // Depth = 1.0 - height. Raised thread (h=1) sits at the top (depth=0);
    // valleys (h=0) sit at depth=1. Lod 0 everywhere in the march — implicit
    // derivatives are undefined across divergent iterations (see header).
    const curSample = hMap.sample(curUv).level(float(0)).r.oneMinus().toVar();
    const stepsTaken = float(0.0).toVar();

    Loop(
      { start: int(0), end: int(POM_MAX_STEPS_LIMIT), type: "int", condition: "<" },
      ({ i }) => {
        If(
          float(i).greaterThanEqual(steps).or(curDepth.greaterThanEqual(curSample)),
          () => {
            Break();
          },
        );
        curUv.subAssign(deltaUv);
        curSample.assign(hMap.sample(curUv).level(float(0)).r.oneMinus());
        curDepth.addAssign(layerDepth);
        stepsTaken.addAssign(1.0);
      },
    );

    // Secant refinement between the last-crossed and last-uncrossed samples.
    const prevUv = curUv.add(deltaUv);
    const prevSample = hMap.sample(prevUv).level(float(0)).r.oneMinus();
    const afterDepth = curSample.sub(curDepth);
    const beforeDepth = prevSample.sub(curDepth.sub(layerDepth));
    const denom = afterDepth.sub(beforeDepth);
    const weight = select(
      denom.abs().greaterThan(1e-5),
      afterDepth.div(denom),
      float(0.0),
    );
    return vec3(mix(curUv, prevUv, clamp(weight, 0.0, 1.0)), stepsTaken);
  },
);

// Soft self-shadow: from the POM contact point, march back up toward the
// light through the same height field and accumulate how deeply the ray is
// buried under the surface along the way. Returns a light multiplier in
// [0,1] — 1 = fully lit, 0 = fully occluded. Partial penetrations weighted
// by proximity to the contact point give a cheap penumbra: nearby threads
// cast hard shadows, distant ones soft.
//
// lightTS must point TOWARD the light in the same tangent frame as the view
// ray. lightTS.z <= 0 means the light is under this face's horizon — direct
// light is gone, and the caller's N·L term is already ~0 there, so returning
// 1.0 (no *self*-shadow) avoids a hard line at the terminator. That early-out
// and the already-on-top one are folded into the single guard If (a TSL
// function has no early return).
export const pomSelfShadow = Fn(
  ([hMap, uvIn, lightTS, scale, minSteps, maxSteps]: [
    TextureNode,
    Node<"vec2">,
    Node<"vec3">,
    Node<"float">,
    Node<"float">,
    Node<"float">,
  ]) => {
    const result = float(1.0).toVar();
    // Contact depth. Already on top of the relief → nothing can occlude.
    const d0 = hMap.sample(uvIn).level(float(0)).r.oneMinus().toVar();
    If(lightTS.z.greaterThan(0.02).and(d0.greaterThan(0.01)), () => {
      // Fewer steps than the view march — shadows are low-frequency by nature.
      const grazing = lightTS.z.oneMinus();
      const steps = max(
        4.0,
        mix(minSteps, maxSteps, clamp(grazing, 0.0, 1.0)).mul(0.5),
      ).toVar();
      const layerDepth = d0.div(steps).toVar();

      // Same offset-limited construction as the view ray.
      const P = lightTS.xy.div(max(lightTS.z, 1e-3)).mul(scale).mul(d0).toVar();
      const pLen = length(P).toVar();
      const pMax = scale.mul(6.0).toVar();
      If(pLen.greaterThan(pMax), () => {
        P.mulAssign(pMax.div(pLen));
      });
      const deltaUv = P.div(steps).toVar();

      const curUv = vec2(uvIn).toVar();
      const rayDepth = float(d0).toVar();
      const occlusion = float(0.0).toVar();
      Loop(
        { start: int(0), end: int(POM_MAX_STEPS_LIMIT), type: "int", condition: "<" },
        ({ i }) => {
          If(
            float(i).greaterThanEqual(steps).or(rayDepth.lessThanEqual(0.0)),
            () => {
              Break();
            },
          );
          curUv.addAssign(deltaUv);
          rayDepth.subAssign(layerDepth);
          const surfDepth = hMap.sample(curUv).level(float(0)).r.oneMinus();
          // Surface above the ray → penetration. Weight by remaining travel so
          // occluders near the contact point shadow harder than distant ones.
          const pen = rayDepth.sub(surfDepth).mul(float(i).div(steps).oneMinus());
          occlusion.assign(max(occlusion, pen));
        },
      );
      result.assign(clamp(occlusion.mul(6.0), 0.0, 1.0).oneMinus());
    });
    return result;
  },
);
