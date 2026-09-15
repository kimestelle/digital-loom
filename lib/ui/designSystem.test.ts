import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EASE_MOTION } from "./motion";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const tokens = read("app/styles/room-tokens.css");
const room = read("app/styles/room.css");
const layout = read("app/styles/layout.css");
const controls = read("app/styles/room-controls.css");
const definitions = new Map(
  [...tokens.matchAll(/(--room-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
);

describe("room design-system contract", () => {
  it("resolves every semantic token without missing references or cycles", () => {
    const resolveToken = (name: string, visited: string[] = []): void => {
      expect(visited, `Token cycle at ${name}`).not.toContain(name);
      expect(definitions.has(name), `Missing ${name}`).toBe(true);
      for (const [, dependency] of definitions.get(name)!.matchAll(/var\((--room-[\w-]+)/g)) {
        resolveToken(dependency, [...visited, name]);
      }
    };
    for (const name of definitions.keys()) resolveToken(name);
  });

  it("keeps the CSS and JavaScript motion curves identical", () => {
    const css = read("app/styles/tokens.css");
    const curve = css.match(/--ease-motion:\s*cubic-bezier\(([^)]+)\)/)![1];
    expect(curve.split(",").map(Number)).toEqual(EASE_MOTION);
    expect(layout).toContain("width var(--room-duration-reveal) var(--ease-motion)");
    expect(room).toContain("grid-template-rows var(--room-duration-reveal) var(--ease-motion)");
  });

  it("shares the 44px mounted controls and keeps the environment rail flush", () => {
    expect(definitions.get("--room-control-size")).toBe("44px");
    expect(layout).toContain("--room-logo-hit-size: var(--room-control-size)");
    expect(layout).toContain("--room-controls-start: calc(var(--room-controls-top) + var(--room-logo-hit-size));");
    const flip = room.match(/\.material-cabinet__flip \{([^}]+)\}/)![1];
    expect(flip).toContain("height: var(--room-control-size)");
    expect(flip).toContain("width: var(--room-control-size)");
  });

  it("preserves explicit material/light range variants in both browser engines", () => {
    expect(definitions.get("--room-range-track-material")).toBe("2px");
    expect(definitions.get("--room-range-thumb-material")).toBe("8px");
    expect(definitions.get("--room-range-track-light")).toBe("1px");
    expect(definitions.get("--room-range-thumb-light")).toBe("9px");
    for (const pseudo of ["-webkit-slider-thumb", "-moz-range-thumb"]) {
      expect(controls).toContain(`::${pseudo}`);
    }
    expect(room).not.toMatch(/::-(webkit-slider-thumb|moz-range-thumb)/);
    expect(controls).toContain("var(--room-range-thumb-size)");
  });

  it("defines the light adapter once and retains accessible surface alternatives", () => {
    expect(room).not.toMatch(/--(?:bg|bg-elev|fg|accent):/);
    expect(tokens).toContain(".material-cabinet__face,\n.room-light-modal");
    expect(room).toContain("@media (max-width: 820px)");
    expect(room).toContain("@media (prefers-reduced-motion: reduce)");
    expect(room).toContain("@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)");
    expect(room.match(/background: var\(--room-ui-solid\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("loads the room system in dependency order without changing the original route", () => {
    const manifest = read("app/globals.css");
    const imports = [...manifest.matchAll(/@import "([^\"]+)";/g)].map((match) => match[1]);
    expect(imports.indexOf("./styles/room-tokens.css")).toBeGreaterThan(imports.indexOf("./styles/authoring-tokens.css"));
    expect(imports.indexOf("./styles/room-controls.css")).toBeGreaterThan(imports.indexOf("./styles/room.css"));
    expect(read("app/(original)/globals.css")).not.toContain("room-");
    expect(read("app/(original)/layout.tsx")).toContain('import "./globals.css"');
    expect(read("app/(room)/layout.tsx")).toContain('import "../globals.css"');
  });
});
