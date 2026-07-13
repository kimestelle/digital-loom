// ─── pom.glsl.ts ──────────────────────────────────────────────────────────────
// Parallax Occlusion Mapping helpers, as GLSL source strings meant to be
// concatenated into a fragment shader. Keeping ALL POM code here (defines,
// tangent frame, ray march, self-shadow) so the material shader just imports
// these two strings and stays legible.
//
// Compilation target: Three compiles every non-raw ShaderMaterial as
// `#version 300 es` (see WebGLProgram's GLSL 3.0 conversion), so ESSL3
// builtins — textureLod, dFdx/dFdy, inverse() — are available directly.
// textureLod matters inside the march loops: texture2D there would pick mip
// levels from implicit derivatives, which are undefined across divergent
// loop iterations and show up as sparkle/shimmer at grazing angles.
//
// Contract with the caller:
//   1. Insert POM_DEFINES near the top (constants + debug enum).
//   2. Insert POM_HELPERS after uniform declarations.
//   3. In main(): compute pomUv once, use it for EVERY texture sample.
//
// Height convention: the input map encodes 1.0 = raised thread, 0.0 = valley
// (Patina's convention). POM marches INTO the surface, so internally it works
// on depth = 1.0 - height. Get this backwards and the weave embosses toward
// the camera instead of recessing.

export const POM_MAX_STEPS_LIMIT = 64;

// Compile-time defines. POM_MAX_STEPS_LIMIT is the hard loop bound — the
// runtime pomMaxSteps uniform can go up to this ceiling without a recompile.
// The debug enum matches the u_pomDebug int uniform in the material shader.
export const POM_DEFINES = /* glsl */ `
#define POM_MAX_STEPS_LIMIT ${POM_MAX_STEPS_LIMIT}
#define POM_DEBUG_OFF    0
#define POM_DEBUG_OFFSET 1
#define POM_DEBUG_STEPS  2
`;

export const POM_HELPERS = /* glsl */ `
// Screen-space-derivative tangent frame. Cloth-sim's positions change every
// frame, so precomputed per-vertex tangents would need re-uploading each step.
// dFdx/dFdy on world position + UV give us T,B,N cheaply and correctly enough
// for a mostly-continuous surface. Requires GL_OES_standard_derivatives.
mat3 pomCotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
  return mat3(T * invmax, B * invmax, N);
}

// View direction in tangent space. TBN is (near-)orthonormal so we transpose
// via three dot products — GLSL 1.00 has no transpose()/inverse().
vec3 pomViewDirTS(mat3 TBN, vec3 V) {
  return normalize(vec3(dot(V, TBN[0]), dot(V, TBN[1]), dot(V, TBN[2])));
}

// Linear raymarch into the surface with one secant refinement at the contact
// point. Adaptive step count: grazing angles (viewTS.z near 0) use maxSteps,
// normal incidence (viewTS.z near 1) uses minSteps.
//
// TODO: if vertex displacement lands later, POM should sample a high-pass
// version of the height map so the two aren't stacking the same low-frequency
// signal. For now this consumes the full height map.
vec2 pomTrace(
  sampler2D hMap, vec2 uv, vec3 viewTS,
  float scale, float minSteps, float maxSteps,
  out float stepsTaken
) {
  float grazing = 1.0 - abs(viewTS.z);
  float steps = mix(minSteps, maxSteps, clamp(grazing, 0.0, 1.0));
  float layerDepth = 1.0 / steps;

  // Total UV displacement across the full depth. Guard the divide so we don't
  // explode when viewTS.z hits zero exactly at silhouette pixels, then clamp
  // the excursion (offset limiting): past ~6× scale (view ~80° off-normal)
  // the march would cross several threads and smear the weave sideways —
  // trading a little parallax accuracy at extreme angles for no warping.
  vec2 P = (viewTS.xy / max(abs(viewTS.z), 1e-3)) * scale;
  float pLen = length(P);
  float pMax = scale * 6.0;
  if (pLen > pMax) P *= pMax / pLen;
  vec2 deltaUv = P / steps;

  vec2 curUv = uv;
  float curDepth = 0.0;
  // Depth = 1.0 - height. Raised thread (h=1) sits at the top (depth=0);
  // valleys (h=0) sit at depth=1. Lod 0 everywhere in the march — implicit
  // derivatives are undefined across divergent iterations (see header).
  float curSample = 1.0 - textureLod(hMap, curUv, 0.0).r;
  stepsTaken = 0.0;

  for (int i = 0; i < POM_MAX_STEPS_LIMIT; i++) {
    if (float(i) >= steps || curDepth >= curSample) break;
    curUv -= deltaUv;
    curSample = 1.0 - textureLod(hMap, curUv, 0.0).r;
    curDepth += layerDepth;
    stepsTaken += 1.0;
  }

  // Secant refinement between the last-crossed and last-uncrossed samples.
  vec2 prevUv = curUv + deltaUv;
  float prevSample = 1.0 - textureLod(hMap, prevUv, 0.0).r;
  float afterDepth = curSample - curDepth;
  float beforeDepth = prevSample - (curDepth - layerDepth);
  float denom = afterDepth - beforeDepth;
  float weight = (abs(denom) > 1e-5) ? (afterDepth / denom) : 0.0;
  return mix(curUv, prevUv, clamp(weight, 0.0, 1.0));
}

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
// 1.0 (no *self*-shadow) avoids a hard line at the terminator.
float pomSelfShadow(
  sampler2D hMap, vec2 uv, vec3 lightTS,
  float scale, float minSteps, float maxSteps
) {
  if (lightTS.z <= 0.02) return 1.0;

  // Contact depth. Already on top of the relief → nothing can occlude.
  float d0 = 1.0 - textureLod(hMap, uv, 0.0).r;
  if (d0 <= 0.01) return 1.0;

  // Fewer steps than the view march — shadows are low-frequency by nature.
  float grazing = 1.0 - lightTS.z;
  float steps = max(4.0, mix(minSteps, maxSteps, clamp(grazing, 0.0, 1.0)) * 0.5);
  float layerDepth = d0 / steps;

  // Same offset-limited construction as the view ray.
  vec2 P = (lightTS.xy / max(lightTS.z, 1e-3)) * scale * d0;
  float pLen = length(P);
  float pMax = scale * 6.0;
  if (pLen > pMax) P *= pMax / pLen;
  vec2 deltaUv = P / steps;

  vec2 curUv = uv;
  float rayDepth = d0;
  float occlusion = 0.0;
  for (int i = 0; i < POM_MAX_STEPS_LIMIT; i++) {
    if (float(i) >= steps || rayDepth <= 0.0) break;
    curUv += deltaUv;
    rayDepth -= layerDepth;
    float surfDepth = 1.0 - textureLod(hMap, curUv, 0.0).r;
    // Surface above the ray → penetration. Weight by remaining travel so
    // occluders near the contact point shadow harder than distant ones.
    float pen = (rayDepth - surfDepth) * (1.0 - float(i) / steps);
    occlusion = max(occlusion, pen);
  }
  return 1.0 - clamp(occlusion * 6.0, 0.0, 1.0);
}
`;
