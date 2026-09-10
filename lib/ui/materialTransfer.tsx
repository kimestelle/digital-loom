"use client";

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { easeMotion } from "@/lib/ui/motion";

const FADE_OUT_MS = 150;
const FADE_IN_MS = 210;
const READY_TIMEOUT_MS = 1200;

export interface MaterialSwapOptions {
  /** Albedo URL whose load gates the fade-in. When omitted, ClothScene
   * compares its loaded albedo with the newly resolved fabric instead. */
  expectedAlbedoURL?: string;
  /** Active material id after the commit. `undefined` leaves the current id
   * alone, while `null` explicitly clears it. */
  ownerAfter?: string | null;
}

interface SwapIntent {
  commit: () => void;
  ownerAfter?: string | null;
  expectedAlbedoURL?: string;
  selectionId?: string;
}

export interface MaterialSwapController {
  /** Whole-specimen opacity. The renderer reads this ref directly so fades do
   * not cause React renders at animation-frame frequency. */
  opacityRef: MutableRefObject<number>;
  /** Generation currently waiting for the renderer's declared-map ack. */
  transitionKey: number;
  expectedAlbedoURL: string;
  /** Select a swatch through the same serialized path as other material
   * changes. Native button activation remains owned by the swatch grid. */
  select: (id: string) => void;
  /** Fade out, commit at zero, wait for declared maps, then fade in. One
   * intent may run and one may wait; a newer waiting intent replaces it. */
  swap: (commit: () => void, options?: MaterialSwapOptions) => void;
  /** Called by the renderer only after every declared map is ready. */
  materialReady: (key: number) => void;
}

function reducedMotionDuration(duration: number): number {
  if (typeof window === "undefined") return duration;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? Math.min(80, duration)
    : duration;
}

/**
 * Coordinates material commits without painting a preview of them.
 *
 * The previous implementation registered every thumbnail, moved its pixels
 * through a full-viewport canvas on hover, and coupled that flight to the
 * mesh reveal. This hook deliberately has no thumbnail, pointer, geometry,
 * portal, or canvas knowledge. Hover is therefore local CSS only.
 */
export function useMaterialSwap({
  activeId,
  commit,
}: {
  activeId: string | null;
  commit: (id: string) => void;
}): MaterialSwapController {
  const opacityRef = useRef(1);
  const [transitionKey, setTransitionKey] = useState(0);
  const [expectedAlbedoURL, setExpectedAlbedoURL] = useState("");
  const activeIdRef = useRef<string | null>(activeId);
  const commitRef = useRef(commit);
  const runningRef = useRef(false);
  const currentRef = useRef<SwapIntent | null>(null);
  const pendingRef = useRef<SwapIntent | null>(null);
  const transitionKeyRef = useRef(0);
  const readyRef = useRef(new Map<number, () => void>());
  const rafRef = useRef<number | null>(null);
  const animationResolveRef = useRef<(() => void) | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  const animateOpacity = useCallback(
    (to: number, duration: number): Promise<void> =>
      new Promise((resolve) => {
        const from = opacityRef.current;
        if (from === to || typeof window === "undefined") {
          opacityRef.current = to;
          resolve();
          return;
        }

        const resolvedDuration = reducedMotionDuration(duration);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          animationResolveRef.current = null;
          resolve();
        };
        animationResolveRef.current = finish;
        let start = 0;
        const step = (now: number) => {
          if (!mountedRef.current) {
            finish();
            return;
          }
          if (!start) start = now;
          const raw = Math.min(1, (now - start) / resolvedDuration);
          opacityRef.current = from + (to - from) * easeMotion(raw);
          if (raw < 1) {
            rafRef.current = window.requestAnimationFrame(step);
          } else {
            rafRef.current = null;
            opacityRef.current = to;
            finish();
          }
        };
        rafRef.current = window.requestAnimationFrame(step);
      }),
    [],
  );

  const waitForMaterial = useCallback(
    (key: number): Promise<void> =>
      new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          readyRef.current.delete(key);
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          resolve();
        };
        readyRef.current.set(key, finish);
        timeoutRef.current = window.setTimeout(finish, READY_TIMEOUT_MS);
      }),
    [],
  );

  const materialReady = useCallback((key: number) => {
    readyRef.current.get(key)?.();
  }, []);

  const runIntent = useCallback(
    async (intent: SwapIntent) => {
      await animateOpacity(0, FADE_OUT_MS);
      if (!mountedRef.current) return;

      const key = ++transitionKeyRef.current;
      setExpectedAlbedoURL(intent.expectedAlbedoURL ?? "");
      setTransitionKey(key);
      const ready = waitForMaterial(key);
      try {
        intent.commit();
      } catch (error) {
        readyRef.current.get(key)?.();
        throw error;
      }
      await ready;

      if (!mountedRef.current) return;
      if (intent.ownerAfter !== undefined) {
        activeIdRef.current = intent.ownerAfter;
      }
      // If a later choice arrived while the maps loaded, stay hidden and let
      // the next serialized commit land. Intermediate choices never flash.
      if (pendingRef.current) return;
      await animateOpacity(1, FADE_IN_MS);
    },
    [animateOpacity, waitForMaterial],
  );

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (mountedRef.current && pendingRef.current) {
      const intent = pendingRef.current;
      pendingRef.current = null;
      currentRef.current = intent;
      try {
        await runIntent(intent);
      } catch (error) {
        opacityRef.current = 1;
        console.error("Material swap failed", error);
      } finally {
        currentRef.current = null;
      }
    }
    runningRef.current = false;
  }, [runIntent]);

  const swap = useCallback(
    (nextCommit: () => void, options?: MaterialSwapOptions) => {
      // There is one waiting slot. Replacing it makes rapid input settle on
      // the latest request without overlapping renderer commits.
      pendingRef.current = { commit: nextCommit, ...options };
      void pump();
    },
    [pump],
  );

  const select = useCallback(
    (id: string) => {
      if (pendingRef.current?.selectionId === id) return;
      if (currentRef.current?.selectionId === id) {
        // The in-flight transition already lands on the latest requested
        // material. Discard an older waiting selection, if there is one.
        pendingRef.current = null;
        return;
      }
      if (id === activeIdRef.current && !runningRef.current) return;
      pendingRef.current = {
        commit: () => commitRef.current(id),
        ownerAfter: id,
        selectionId: id,
      };
      void pump();
    },
    [pump],
  );

  // Hydration, deletion, and any external selection still establish a
  // coherent baseline when no authored transition is in flight.
  useEffect(() => {
    if (runningRef.current || activeId === activeIdRef.current) return;
    activeIdRef.current = activeId;
    opacityRef.current = 1;
  }, [activeId]);

  useEffect(() => {
    mountedRef.current = true;
    const readyCallbacks = readyRef.current;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      animationResolveRef.current?.();
      animationResolveRef.current = null;
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      for (const finish of readyCallbacks.values()) finish();
      readyCallbacks.clear();
    };
  }, []);

  return {
    opacityRef,
    transitionKey,
    expectedAlbedoURL,
    select,
    swap,
    materialReady,
  };
}
