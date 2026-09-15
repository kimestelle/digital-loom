import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRoomSurfaceCache } from "./roomSurfaceCache";
import { ROOM_SURFACE_INVALIDATE_EVENT, roomSurfaceSnapshot } from "./roomSurfaceSnapshot";

vi.mock("./roomSurfaceSnapshot", async importOriginal => ({
  ...await importOriginal<typeof import("./roomSurfaceSnapshot")>(),
  roomSurfaceSnapshot: vi.fn(),
  embedRoomSurfaceTextures: vi.fn(async () => {}),
}));

function fixture(mobileInitially = true) {
  let width = 390, height = 675.2, paint = "morning";
  let onResize: ResizeObserverCallback = () => {};
  const draw = vi.fn();
  const decode = vi.fn((): Promise<void> => Promise.resolve());
  const revoke = vi.fn();
  const disconnect = vi.fn();
  const media = Object.assign(new EventTarget(), { matches: mobileInitially });
  const source = { getBoundingClientRect: () => ({ width, height }) };
  const root = Object.assign(new EventTarget(), {
    dataset: {} as Record<string, string>, querySelector: () => source,
  });
  const canvas = {
    width: 1, height: 1, dataset: {} as Record<string, string>, style: {} as Record<string, string>,
    closest: () => root, getContext: () => ({ drawImage: draw }),
  };
  vi.mocked(roomSurfaceSnapshot).mockImplementation(() => ({ paint, width, height }) as unknown as SVGSVGElement);
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("devicePixelRatio", 3);
  vi.stubGlobal("requestAnimationFrame", () => { throw new Error("static cache must not create a frame loop"); });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("XMLSerializer", class { serializeToString(value: unknown) { return JSON.stringify(value); } });
  vi.stubGlobal("Image", class { src = ""; decode = decode; });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:room-surface"), revokeObjectURL: revoke });
  return {
    canvas, root, draw, decode, revoke, disconnect,
    attach: () => attachRoomSurfaceCache(canvas as unknown as HTMLCanvasElement)!,
    resize(w: number, h: number) { width = w; height = h; onResize([], {} as ResizeObserver); },
    author(value: string) { paint = value; root.dispatchEvent(new Event(ROOM_SURFACE_INVALIDATE_EVENT)); },
    setMobile(value: boolean) { media.matches = value; media.dispatchEvent(new Event("change")); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("room substrate cache lifecycle", () => {
  it("draws once after decode, with no tick work or repeated identical paint bakes", async () => {
    const f = fixture(); const cleanup = f.attach();
    expect(f.root.dataset.roomSurfaceCached).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(f.root.dataset.roomSurfaceCached).toBe("true");
    expect(f.canvas.width).toBe(585);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    f.author("morning");
    await vi.advanceTimersByTimeAsync(120);
    expect(f.draw).toHaveBeenCalledTimes(1);
    cleanup();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does no image work on desktop and responds to mobile policy changes", async () => {
    const f = fixture(false); const cleanup = f.attach();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.decode).not.toHaveBeenCalled();
    f.setMobile(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(f.draw).toHaveBeenCalledTimes(1);
    f.setMobile(false);
    expect(f.root.dataset.roomSurfaceCached).toBeUndefined();
    expect(f.canvas.width).toBe(1);
    cleanup();
  });

  it("reveals the correctly-sized SVG during resize until the new bitmap is ready", async () => {
    const f = fixture(); const cleanup = f.attach();
    await vi.advanceTimersByTimeAsync(120);
    f.resize(844, 420);
    expect(f.root.dataset.roomSurfaceCached).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.root.dataset.roomSurfaceCached).toBe("true");
    expect(f.canvas.style.width).toBe("844px");
    expect(f.draw).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("revokes a pending image on teardown and ignores its late decode", async () => {
    const f = fixture(); let complete!: () => void;
    f.decode.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const cleanup = f.attach();
    await vi.advanceTimersByTimeAsync(120);
    cleanup();
    expect(f.revoke).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalledTimes(1);
    expect(f.root.dataset.roomSurfaceCached).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces a newer palette during decode without publishing the stale image", async () => {
    const f = fixture(); let complete!: () => void;
    f.decode.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const cleanup = f.attach();
    await vi.advanceTimersByTimeAsync(120);
    f.author("evening");
    await vi.advanceTimersByTimeAsync(120);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.draw).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(f.revoke).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("keeps the SVG on failed decode and can retry the same paint", async () => {
    const f = fixture(); f.decode.mockRejectedValueOnce(new Error("decode failed"));
    const cleanup = f.attach();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.root.dataset.roomSurfaceCached).toBeUndefined();
    expect(f.draw).not.toHaveBeenCalled();
    f.author("morning");
    await vi.advanceTimersByTimeAsync(120);
    expect(f.draw).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
