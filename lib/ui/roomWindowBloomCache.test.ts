import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRoomWindowBloomCache, planRoomWindowBloom, rasterizeRoomWindowBloom, ROOM_WINDOW_BLOOM, roomWindowBloomSvg } from "./roomWindowBloomCache";

const path = "M0,0L900,0L900,300L0,420Z";
const screen = { left: -620, top: 0, width: 900, height: 420 };
const phone = { left: 0, top: 0, width: 390, height: 844 };
const makePlan = () => planRoomWindowBloom("0 0 900 420", path, screen, phone, 3)!;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("window bloom raster bounds", () => {
  it("retains the source aperture and optical radii but clips offscreen mobile pixels", () => {
    const plan = makePlan();
    expect(plan.path).toBe(path);
    expect(plan.x).toBe(620 - 54);
    expect(plan.width).toBeLessThan(phone.width + 108);
    expect(plan.width).toBeLessThan(900 * 0.6);
    expect(plan.pixelWidth).toBe(Math.ceil(plan.width * 2));
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(ROOM_WINDOW_BLOOM.maxPixels);
    const svg = roomWindowBloomSvg(plan);
    expect(svg).toContain(`d="${path}"`);
    expect(svg).toContain('stdDeviation="18"');
    expect(svg).toContain('stdDeviation="3"');
    expect(svg).toContain('slope="0.3"');
    expect(svg).toContain('slope="0.55"');
    expect(svg).toContain('color-interpolation-filters="sRGB"');
    expect(svg).toContain(`viewBox="${plan.x} ${plan.y} ${plan.width} ${plan.height}"`);
  });

  it("caps large screens and keys geometry, visible crop, and raster density", () => {
    const large = { left: 0, top: 0, width: 8_000, height: 4_000 };
    const plan = planRoomWindowBloom("0 0 900 420", path, large, large, 4)!;
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(ROOM_WINDOW_BLOOM.maxPixels);
    expect(makePlan().key).toBe(makePlan().key);
    expect(makePlan().key).not.toBe(planRoomWindowBloom("0 0 900 420", path, screen, phone, 1)!.key);
    expect(makePlan().key).not.toBe(planRoomWindowBloom("0 0 900 420", path, screen, { ...phone, width: 300 }, 3)!.key);
    expect(makePlan().key).not.toBe(planRoomWindowBloom("0 0 900 420", path.replace("300", "320"), screen, phone, 3)!.key);
  });

  it("skips unmeasured, invalid, or entirely offscreen geometry", () => {
    expect(planRoomWindowBloom("", path, screen, phone, 2)).toBeNull();
    expect(planRoomWindowBloom("0 0 Infinity 420", path, screen, phone, 2)).toBeNull();
    expect(planRoomWindowBloom("0 0 900 420", path, { ...screen, width: NaN }, phone, 2)).toBeNull();
    expect(planRoomWindowBloom("0 0 900 420", "", screen, phone, 2)).toBeNull();
    expect(planRoomWindowBloom("0 0 900 420", path, { ...screen, left: -2_000 }, phone, 2)).toBeNull();
  });
});

class ElementStub {
  attributes = new Map<string, string>();
  style = { display: "" };
  dataset: Record<string, string> = {};
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}

function mountCache() {
  vi.useFakeTimers();
  const svg = new ElementStub();
  const aperture = new ElementStub();
  const fallback = new ElementStub();
  const image = new ElementStub();
  svg.setAttribute("viewBox", "0 0 900 420");
  aperture.setAttribute("d", path);
  let notify = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, addEventListener, removeEventListener });
  vi.stubGlobal("MutationObserver", class {
    observe = observe;
    disconnect = disconnect;
    constructor(callback: () => void) { notify = callback; }
  });
  Object.assign(svg, {
    querySelector: (selector: string) => selector.includes("aperture") ? aperture : selector.includes("source") ? fallback : image,
    getBoundingClientRect: () => screen,
    closest: () => ({ getBoundingClientRect: () => phone }),
  });
  const jobs: { ready: (url: string) => void; failed: () => void; dispose: ReturnType<typeof vi.fn> }[] = [];
  const rasterize = vi.fn((_plan, ready, failed) => {
    const dispose = vi.fn();
    jobs.push({ ready, failed, dispose });
    return dispose;
  });
  const cleanup = attachRoomWindowBloomCache(svg as unknown as SVGSVGElement, rasterize);
  return { svg, aperture, fallback, image, notify: () => notify(), observe, disconnect, jobs, rasterize, cleanup, removeEventListener };
}

describe("window bloom cache lifecycle", () => {
  it("keeps the live fallback until the PNG is decoded, then has no active filter", () => {
    const cache = mountCache();
    expect(cache.svg.dataset.windowBloom).toBe("pending");
    expect(cache.image.style.display).toBe("none");
    expect(cache.fallback.style.display).toBe("");
    vi.advanceTimersByTime(120);
    cache.jobs[0].ready("blob:cached");
    expect(cache.svg.dataset.windowBloom).toBe("cached");
    expect(cache.fallback.style.display).toBe("none");
    expect(cache.image.style.display).toBe("");
    expect(cache.image.getAttribute("href")).toBe("blob:cached");
    expect(cache.image.getAttribute("filter")).toBeNull();
    expect(cache.image.getAttribute("x")).toBe(String(makePlan().x));
    expect(cache.observe.mock.calls.map(call => call[1].attributeFilter)).toEqual([["viewBox"], ["d"]]);
    cache.notify();
    vi.advanceTimersByTime(10_000);
    expect(cache.rasterize).toHaveBeenCalledOnce();
    cache.cleanup();
  });

  it("coalesces resize geometry and rejects stale bake completion after resize/unmount", () => {
    const cache = mountCache();
    vi.advanceTimersByTime(120);
    cache.aperture.setAttribute("d", path.replace("300", "320"));
    cache.notify();
    expect(cache.jobs[0].dispose).toHaveBeenCalledOnce();
    cache.jobs[0].ready("blob:stale");
    expect(cache.image.getAttribute("href")).toBeNull();
    cache.aperture.setAttribute("d", path.replace("300", "330"));
    cache.notify();
    vi.advanceTimersByTime(120);
    expect(cache.rasterize).toHaveBeenCalledTimes(2);
    cache.jobs[1].failed();
    expect(cache.svg.dataset.windowBloom).toBe("fallback");
    expect(cache.fallback.style.display).toBe("");
    cache.cleanup();
    cache.jobs[1].ready("blob:late");
    cache.notify();
    vi.runAllTimers();
    expect(cache.image.getAttribute("href")).toBeNull();
    expect(cache.jobs[1].dispose).toHaveBeenCalledOnce();
    expect(cache.disconnect).toHaveBeenCalledOnce();
    expect(cache.removeEventListener).toHaveBeenCalledOnce();
    expect(cache.rasterize).toHaveBeenCalledTimes(2);
  });

  it("retains the live fallback if bitmap allocation throws", () => {
    const cache = mountCache();
    cache.rasterize.mockImplementation(() => { throw new Error("bitmap allocation failed"); });
    vi.advanceTimersByTime(120);
    expect(cache.svg.dataset.windowBloom).toBe("fallback");
    expect(cache.fallback.style.display).toBe("");
    expect(cache.image.style.display).toBe("none");
    cache.cleanup();
  });
});

describe("window raster resource ownership", () => {
  function setupRaster() {
    const images: { onload: (() => void) | null; onerror: (() => void) | null; src: string }[] = [];
    vi.stubGlobal("Image", class {
      onload = null;
      onerror = null;
      src = "";
      constructor() { images.push(this); }
    });
    const revoke = vi.fn();
    let nextUrl = 0;
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => `blob:${++nextUrl}`), revokeObjectURL: revoke });
    const encode: ((blob: Blob | null) => void)[] = [];
    const draw = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toBlob: (callback: (blob: Blob | null) => void) => encode.push(callback) };
    vi.stubGlobal("document", { createElement: () => canvas });
    const ready = vi.fn();
    const failed = vi.fn();
    const cleanup = rasterizeRoomWindowBloom(makePlan(), ready, failed);
    return { images, revoke, encode, draw, canvas, ready, failed, cleanup };
  }

  it("releases SVG decode and canvas after baking, and owns the PNG until teardown", () => {
    const raster = setupRaster();
    raster.images[0].onload!();
    expect(raster.draw).toHaveBeenCalledOnce();
    expect(raster.revoke).toHaveBeenCalledWith("blob:1");
    expect(raster.images[0].src).toBe("");
    raster.encode[0](new Blob(["png"]));
    expect(raster.canvas.width).toBe(0);
    expect(raster.ready).not.toHaveBeenCalled();
    raster.images[1].onload!();
    expect(raster.ready).toHaveBeenCalledWith("blob:2");
    expect(raster.images[1].src).toBe("");
    raster.cleanup();
    expect(raster.revoke.mock.calls).toEqual([["blob:1"], ["blob:2"]]);
  });

  it("discards a pending encode after unmount and falls back when raster decode fails", () => {
    const cancelled = setupRaster();
    cancelled.images[0].onload!();
    cancelled.cleanup();
    cancelled.encode[0](new Blob(["png"]));
    expect(cancelled.ready).not.toHaveBeenCalled();
    expect(cancelled.revoke.mock.calls).toEqual([["blob:1"]]);
    const broken = setupRaster();
    broken.images[0].onload!();
    broken.encode[0](new Blob(["png"]));
    broken.images[1].onerror!();
    expect(broken.failed).toHaveBeenCalledOnce();
    expect(broken.revoke.mock.calls).toEqual([["blob:1"], ["blob:2"]]);
    broken.cleanup();
  });
});
