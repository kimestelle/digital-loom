import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePixelPlayLocalBox } from "./pixelPlay";

class FakeElement {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
  clientWidth: number;
  clientHeight: number;
  offsetParent: FakeElement | null;

  constructor({
    left = 0,
    top = 0,
    width,
    height,
    parent = null,
  }: {
    left?: number;
    top?: number;
    width: number;
    height: number;
    parent?: FakeElement | null;
  }) {
    this.offsetLeft = left;
    this.offsetTop = top;
    this.offsetWidth = width;
    this.offsetHeight = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this.offsetParent = parent;
  }

  getBoundingClientRect(): never {
    throw new Error("projected geometry must not be read for local anchors");
  }
}

const asElement = (element: FakeElement): HTMLElement =>
  element as unknown as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe("PixelPlay local geometry", () => {
  it("uses the host client box instead of its projected cabinet rectangle", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    const host = new FakeElement({ width: 353, height: 29 });

    expect(resolvePixelPlayLocalBox(asElement(host), asElement(host))).toEqual({
      left: 0,
      top: 0,
      width: 353,
      height: 29,
    });
  });

  it("accumulates offsets for a selected descendant nested inside the host", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    const host = new FakeElement({ width: 360, height: 36 });
    const group = new FakeElement({
      left: 36,
      top: 4,
      width: 300,
      height: 28,
      parent: host,
    });
    const selected = new FakeElement({
      left: 84,
      top: 2,
      width: 96,
      height: 24,
      parent: group,
    });

    expect(
      resolvePixelPlayLocalBox(asElement(host), asElement(selected)),
    ).toEqual({
      left: 120,
      top: 6,
      width: 96,
      height: 24,
    });
  });

  it("rejects an offset chain that does not belong to the PixelPlay host", () => {
    vi.stubGlobal("HTMLElement", FakeElement);
    const host = new FakeElement({ width: 360, height: 36 });
    const otherHost = new FakeElement({ width: 360, height: 36 });
    const selected = new FakeElement({
      left: 12,
      top: 3,
      width: 100,
      height: 30,
      parent: otherHost,
    });

    expect(
      resolvePixelPlayLocalBox(asElement(host), asElement(selected)),
    ).toBeNull();
  });
});
