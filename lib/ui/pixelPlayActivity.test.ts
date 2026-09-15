import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPixelPlay } from "./pixelPlay";
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
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  intersections = [];
  mutations = [];
  cleanups = [];
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("document", { documentElement: new ActivityElement() });
  vi.stubGlobal("window", { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) });
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
