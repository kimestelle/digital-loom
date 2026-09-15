"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ClothStats } from "./clothScene";
import type { Knobs } from "./knobs";

interface AutoQualityState {
  lowSince: number;
  highSince: number;
  lastStep: number;
}

/** Rendering-only hysteresis; quality stays put until a sustained threshold. */
export function advanceAutoQuality(
  state: AutoQualityState,
  fps: number,
  quality: Knobs["quality"],
  now: number,
): Knobs["quality"] | undefined {
  const order = ["lo", "mid", "hi"] as const;
  const idx = order.indexOf(quality);
  const canStep = now - state.lastStep > 10_000;
  if (fps < 45) {
    state.highSince = 0;
    if (!state.lowSince) state.lowSince = now;
    else if (now - state.lowSince > 3_000 && canStep && idx > 0) {
      state.lastStep = now;
      state.lowSince = 0;
      return order[idx - 1];
    }
  } else if (fps > 58) {
    state.lowSince = 0;
    if (!state.highSince) state.highSince = now;
    else if (now - state.highSince > 10_000 && canStep && idx < 2) {
      state.lastStep = now;
      state.highSince = 0;
      return order[idx + 1];
    }
  } else {
    state.lowSince = 0;
    state.highSince = 0;
  }
}

export interface PerformanceMetersHandle {
  update: (stats: ClothStats) => void;
}

interface PerformanceMetersProps {
  autoQuality: boolean;
  quality: Knobs["quality"];
  onQualityChange: (quality: Knobs["quality"]) => void;
}

/** Own the 2 Hz samples here so measuring the scene never rerenders the room. */
export const PerformanceMeters = forwardRef<PerformanceMetersHandle, PerformanceMetersProps>(
  function PerformanceMeters({ autoQuality, quality, onQualityChange }, ref) {
    const [stats, setStats] = useState<ClothStats | null>(null);
    const autoQualityRef = useRef<AutoQualityState>({ lowSince: 0, highSince: 0, lastStep: 0 });

    useImperativeHandle(ref, () => ({ update: setStats }), []);

    useEffect(() => {
      if (!autoQuality || !stats) return;
      const next = advanceAutoQuality(autoQualityRef.current, stats.fps, quality, Date.now());
      if (next) onQualityChange(next);
    }, [stats, autoQuality, quality, onQualityChange]);

    return (
      <div className="perf-meters" role="status" aria-live="off">
        <span className="perf-meter">
          <span className="perf-meter-val" data-warn={!!stats && stats.fps < 40}>
            {stats ? Math.round(stats.fps) : "—"}
          </span>
          <span className="perf-meter-unit">fps</span>
        </span>
        <span className="perf-meter">
          <span className="perf-meter-val">
            {stats ? stats.simMs.toFixed(1) : "—"}
          </span>
          <span className="perf-meter-unit">sim ms</span>
        </span>
        <span className="perf-meter">
          <span className="perf-meter-val">
            {stats?.gpuMs ? stats.gpuMs.toFixed(1) : "—"}
          </span>
          <span className="perf-meter-unit">gpu ms</span>
        </span>
        <span className="perf-meter">
          <span className="perf-meter-val">
            {stats ? `${Math.round(stats.tris / 1000)}k` : "—"}
          </span>
          <span className="perf-meter-unit">tris</span>
        </span>
        <span className="perf-meter">
          <span className="perf-meter-val">
            {stats ? stats.calls : "—"}
          </span>
          <span className="perf-meter-unit">calls</span>
        </span>
      </div>
    );
  },
);
