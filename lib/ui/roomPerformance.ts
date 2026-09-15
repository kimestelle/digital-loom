import { QUALITY_PRESETS, type Knobs } from "./knobs";

// Include landscape phones, not just the narrow layout breakpoint.
export const ROOM_MOBILE_PERFORMANCE_MEDIA =
  "(max-width: 820px), (hover: none) and (pointer: coarse)";

/** Preview-only budget. Never write these derived values to a material or prefs. */
export function roomPerformance(knobs: Knobs, mobile: boolean): Knobs {
  if (!mobile) return knobs;
  return {
    ...knobs,
    quality: "lo",
    meshRes: "lo",
    iterations: Math.min(knobs.iterations, 3),
    selfCollide: knobs.selfCollide === "full" ? "half" : knobs.selfCollide,
    anisotropy: 2,
    pomMinSteps: Math.min(knobs.pomMinSteps, QUALITY_PRESETS.lo.pomMinSteps),
    pomMaxSteps: Math.min(knobs.pomMaxSteps, QUALITY_PRESETS.lo.pomMaxSteps),
    autoQuality: false,
  };
}
