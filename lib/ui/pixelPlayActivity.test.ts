import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPixelPlay, PIXEL_PLAY_STATIC_MEDIA } from "./pixelPlay";
import { PixelPlayActivity } from "./pixelPlayActivity";

class ActivityElement {
  attributes = new Map<string, string>();
  classes = new Set<string>();
  parentElement: ActivityElement | null = null;
  clientWidth = 160;
  clientHeight = 32;
  style = { setProperty: vi.fn() };
  querySelector = vi.fn(() => null);
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  getBoundingClientRect = vi.fn(() => {
    throw new Error("activity must not read layout during animation");
  });

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }

  contains(element: ActivityElement): boolean {
    for (let current: ActivityElement | null = element; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector: string): ActivityElement | null {
    const matches = selector === "[data-dye]" ? this.attributes.has("data-dye")
      : this.attributes.has("inert") || this.attributes.has("hidden")
        || (this.attributes.has("data-cabinet-face") && this.getAttribute("data-active") === "false")
        || (this.classes.has("room-light-modal") && this.getAttribute("data-open") === "false");
    return matches ? this : this.parentElement?.closest(selector) ?? null;
  }
}

const asHost = (element: ActivityElement) => element as unknown as HTMLElement;
let intersections: FakeIntersectionObserver[];
let mutations: FakeMutationObserver[];
let cleanups: (() => void)[];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let mediaListeners: Set<() => void>;
let resizes: FakeResizeObserver[];

class FakeIntersectionObserver {
  observed = new Set<Element>();
  disconnect = vi.fn(() => this.observed.clear());
  observe = vi.fn((host: Element) => this.observed.add(host));
  unobserve = vi.fn((host: Element) => this.observed.delete(host));
  constructor(private callback: IntersectionObserverCallback) { intersections.push(this); }
  emit(host: ActivityElement, visible: boolean, width = 160, height = 32) {
    this.callback([{
      target: asHost(host), isIntersecting: visible, intersectionRect: { width, height },
    }] as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

class FakeMutationObserver {
  options?: MutationObserverInit;
  disconnect = vi.fn();
  observe = vi.fn((_target: Node, options: MutationObserverInit) => { this.options = options; });
  constructor(private callback: MutationCallback) { mutations.push(this); }
  emit(target: ActivityElement) {
    this.callback([{ target: asHost(target) }] as unknown as MutationRecord[], this as unknown as MutationObserver);
  }
}

class FakeResizeObserver {
  constructor(readonly callback: () => void) { resizes.push(this); }
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  intersections = [];
  mutations = [];
  cleanups = [];
  frames = new Map();
  nextFrame = 1;
  resizes = [];
  mediaListeners = new Set();
  media = {
    matches: false,
    addEventListener: vi.fn((_event: string, listener: () => void) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => mediaListeners.delete(listener)),
  };
  vi.stubGlobal("document", { documentElement: new ActivityElement() });
  vi.stubGlobal("window", { devicePixelRatio: 2, matchMedia: vi.fn(() => media) });
  vi.stubGlobal("HTMLElement", ActivityElement);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});

function animate(timestamp: number) {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) frame(timestamp);
}

function attach(host: ActivityElement) {
  const context = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
  const canvas = { parentElement: host, width: 0, height: 0, getContext: vi.fn(() => context) };
  const cleanup = attachPixelPlay(canvas as unknown as HTMLCanvasElement, 5, "ink");
  if (cleanup) cleanups.push(cleanup);
  return { context, canvas };
}

describe("PixelPlay activity", () => {
  it("ignores decorative aria-hidden wrappers, and follows scroll clipping without polling layout", () => {
    const activity = new PixelPlayActivity();
    const host = new ActivityElement();
    host.attributes.set("aria-hidden", "true");
    const listener = vi.fn();
    cleanups.push(activity.observe(asHost(host), listener));
    expect(listener.mock.calls).toEqual([[false]]);

    intersections[0].emit(host, true);
    intersections[0].emit(host, true);
    intersections[0].emit(host, false);
    intersections[0].emit(host, true);
    expect(listener.mock.calls).toEqual([[false], [true], [false], [true]]);
    expect(host.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("keeps intersecting cabinet backfaces paused and resumes when the face becomes active", () => {
    const activity = new PixelPlayActivity();
    const face = new ActivityElement();
    face.attributes.set("data-cabinet-face", "material");
    face.attributes.set("data-active", "false");
    face.attributes.set("inert", "");
    const host = new ActivityElement();
    host.parentElement = face;
    const listener = vi.fn();
    cleanups.push(activity.observe(asHost(host), listener));
    intersections[0].emit(host, true);
    expect(listener.mock.calls).toEqual([[false]]);

    face.attributes.set("data-active", "true");
    mutations[0].emit(face);
    expect(listener.mock.calls).toEqual([[false]]);
    face.attributes.delete("inert");
    mutations[0].emit(face);
    expect(listener.mock.calls).toEqual([[false], [true]]);
  });

  it("pauses a closed environment rail even while its fixed-height contents intersect", () => {
    const activity = new PixelPlayActivity();
    const rail = new ActivityElement();
    rail.classes.add("room-light-modal");
    rail.attributes.set("data-open", "false");
    const host = new ActivityElement();
    host.parentElement = rail;
    const listener = vi.fn();
    cleanups.push(activity.observe(asHost(host), listener));
    intersections[0].emit(host, true);
    expect(listener.mock.calls).toEqual([[false]]);
    rail.attributes.set("data-open", "true");
    mutations[0].emit(rail);
    host.attributes.set("hidden", "");
    mutations[0].emit(host);
    expect(listener.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("rejects zero-area edge contact and shares/disconnects its observers", () => {
    const activity = new PixelPlayActivity();
    const first = new ActivityElement();
    const second = new ActivityElement();
    const firstListener = vi.fn();
    const stopFirst = activity.observe(asHost(first), firstListener);
    const stopSecond = activity.observe(asHost(second), vi.fn());
    expect(intersections).toHaveLength(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].options?.attributeFilter).not.toContain("style");
    intersections[0].emit(first, true, 0);
    expect(firstListener.mock.calls).toEqual([[false]]);
    stopFirst();
    expect(intersections[0].disconnect).not.toHaveBeenCalled();
    stopSecond();
    expect(intersections[0].disconnect).toHaveBeenCalledOnce();
    expect(mutations[0].disconnect).toHaveBeenCalledOnce();
    cleanups.push(activity.observe(asHost(first), firstListener));
    expect(intersections).toHaveLength(2);
    intersections[0].emit(first, true);
    expect(firstListener.mock.calls).toEqual([[false], [false]]);
    intersections[1].emit(first, true);
    expect(firstListener.mock.calls).toEqual([[false], [false], [true]]);
  });

  it("retains explicit inactive gating when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const activity = new PixelPlayActivity();
    const host = new ActivityElement();
    host.attributes.set("inert", "");
    const listener = vi.fn();
    cleanups.push(activity.observe(asHost(host), listener));
    host.attributes.delete("inert");
    mutations[0].emit(host);
    expect(listener.mock.calls).toEqual([[false], [true]]);
  });
});

describe("PixelPlay animation suspension", () => {
  it("draws a visible static selection on mobile without scheduling animation frames", () => {
    media.matches = true;
    const host = new ActivityElement();
    const { context } = attach(host);
    intersections[0].emit(host, true);
    expect(window.matchMedia).toHaveBeenCalledWith(PIXEL_PLAY_STATIC_MEDIA);
    expect(context.fillRect).toHaveBeenCalledOnce();
    expect(context.fillStyle).toContain("0.95");
    expect(frames.size).toBe(0);
    animate(64);
    animate(10_000);
    expect(context.clearRect).toHaveBeenCalledOnce();

    const selection = new ActivityElement();
    Object.assign(selection, { offsetLeft: 100, offsetTop: 0, offsetWidth: 40, offsetHeight: 32, offsetParent: host });
    host.querySelector.mockReturnValue(selection as never);
    mutations.find(observer => observer.options?.attributeFilter?.includes("data-pressed"))!.emit(host);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.fillRect.mock.calls[1][0]).toBeGreaterThan(context.fillRect.mock.calls[0][0]);
    resizes[0].callback();
    expect(context.fillRect).toHaveBeenCalledTimes(3);
    expect(frames.size).toBe(0);
  });

  it("does no pointer layout reads on mobile and keeps hidden selection changes asleep", () => {
    media.matches = true;
    const host = new ActivityElement();
    const { context } = attach(host);
    intersections[0].emit(host, true);
    for (const [, listener] of host.addEventListener.mock.calls) listener({ clientX: 10, clientY: 10 });
    expect(host.getBoundingClientRect).not.toHaveBeenCalled();
    expect(context.clearRect).toHaveBeenCalledOnce();
    intersections[0].emit(host, false);
    mutations.find(observer => observer.options?.attributeFilter?.includes("data-pressed"))!.emit(host);
    expect(context.clearRect).toHaveBeenCalledOnce();
    intersections[0].emit(host, true);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it("shares one media listener, switches modes live, and tears down the last subscriber", () => {
    const firstHost = new ActivityElement();
    const secondHost = new ActivityElement();
    const first = attach(firstHost);
    attach(secondHost);
    intersections[0].emit(firstHost, true);
    intersections[0].emit(secondHost, true);
    expect(mediaListeners.size).toBe(1);
    expect(media.addEventListener).toHaveBeenCalledOnce();
    expect(frames.size).toBe(1);
    animate(64);

    media.matches = true;
    for (const listener of mediaListeners) listener();
    expect(frames.size).toBe(0);
    const staticDraws = first.context.clearRect.mock.calls.length;
    animate(5_000);
    expect(first.context.clearRect).toHaveBeenCalledTimes(staticDraws);

    media.matches = false;
    for (const listener of mediaListeners) listener();
    expect(frames.size).toBe(1);
    animate(5_032);
    expect(first.context.clearRect.mock.calls.length).toBeGreaterThan(staticDraws);
    cleanups.shift()!();
    expect(mediaListeners.size).toBe(1);
    cleanups.shift()!();
    expect(mediaListeners.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("retains the last bitmap, stops the last ticker, and resumes without remounting the canvas", () => {
    const host = new ActivityElement();
    const { context, canvas } = attach(host);
    expect(frames.size).toBe(0);
    intersections[0].emit(host, true);
    animate(64);
    animate(96);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    const bitmapSize = [canvas.width, canvas.height];

    intersections[0].emit(host, false);
    expect(frames.size).toBe(0);
    animate(5_000);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    intersections[0].emit(host, true);
    animate(5_032);
    expect(context.clearRect).toHaveBeenCalledTimes(3);
    expect([canvas.width, canvas.height]).toEqual(bitmapSize);
    expect(canvas.getContext).toHaveBeenCalledOnce();
    expect(host.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("keeps a visible sibling running while an inactive cabinet face stops drawing", () => {
    const face = new ActivityElement();
    face.attributes.set("data-cabinet-face", "material");
    const hiddenHost = new ActivityElement();
    hiddenHost.parentElement = face;
    const visibleHost = new ActivityElement();
    const first = attach(hiddenHost);
    const second = attach(visibleHost);
    intersections[0].emit(hiddenHost, true);
    intersections[0].emit(visibleHost, true);
    animate(64);
    face.attributes.set("data-active", "false");
    mutations.find(observer => observer.options?.attributeFilter?.includes("inert"))!.emit(face);
    animate(96);
    expect(first.context.clearRect).toHaveBeenCalledTimes(1);
    expect(second.context.clearRect).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(1);
  });
});
