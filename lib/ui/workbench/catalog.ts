export const COMPONENTS = [
  { id: "sunlight", label: "Morning sunlight", source: "lib/ui/roomSunlightProjection.ts", note: "Compare the computed glass-light bake with the previous treatment in the real room architecture. No cloth renderer or saved settings.", groups: ["ui"] },
  { id: "logo", label: "Logo + wordmark", source: "lib/ui/navBar.tsx", note: "Click the mark to expand; Escape closes the environment rail.", groups: ["control", "type", "duration", "delay", "ui"] },
  { id: "cabinet", label: "Panel + flip tab", source: "lib/ui/materialCabinet.tsx", note: "Flip between the real archive and dossier. Narrow widths use the sliding sheet.", groups: ["glass", "grain", "panel", "tab", "control", "duration", "ui"] },
  { id: "changes", label: "Material changes shelf", source: "lib/ui/materialEditShelf.tsx", note: "Adjust sheen to reveal the bottom shelf. Real undo, comparison and cabinet movement; swatch saves stay in this preview.", groups: ["ui", "control", "type", "space", "panel", "duration"] },
  { id: "environment", label: "Environment controls", source: "lib/ui/roomLightModal.tsx", note: "Real light controls and disclosures; local values only, without a renderer.", groups: ["ui", "glass", "grain", "rail", "range", "type", "control", "duration", "stagger"] },
  { id: "sliders", label: "Sliders + measurements", source: "lib/ui/panelPrimitives.tsx", note: "Continuous and integer sliders, with keyboard control and hints.", groups: ["range", "ui", "type", "space"] },
  { id: "pads", label: "Behavior / surface fields", source: "lib/ui/instrumentPad.tsx", note: "Drag the pixel; the value commits on release. Arrow keys work too.", groups: ["ui", "control", "space"] },
  { id: "weaves", label: "Weave diagrams + selectors", source: "lib/ui/weaveDiagram.tsx · lib/ui/pixelPlay.tsx", note: "Real weave diagrams and living pixels in the existing selector styles.", groups: ["ui", "control", "type", "space"] },
  { id: "swatches", label: "Swatches + library", source: "lib/ui/materialSwatches.tsx", note: "Select, duplicate, rename, reorder and delete in a disposable in-memory library.", groups: ["ui", "type", "space", "panel"] },
  { id: "maps", label: "Maps + image editor", source: "lib/ui/mapsStrip.tsx · lib/ui/mapEditorModal.tsx", note: "Open the real pixel editor. Variations exist only in this preview; no material is saved.", groups: ["ui", "type", "control", "space"] },
  { id: "insert", label: "Photo input + prompt", source: "lib/ui/insertPanel.tsx", note: "Stage a file and test form states. Extraction is simulated; no API calls or stored credentials.", groups: ["ui", "type", "control", "space"] },
  { id: "status", label: "Save states", source: "lib/ui/saveStatus.tsx", note: "Inspect dirty, saving, saved and failed states. Retry is simulated.", groups: ["ui", "type", "space"] },
  { id: "primitives", label: "Buttons, hints + disclosure", source: "lib/ui/panelPrimitives.tsx · app/styles/buttons.css", note: "Native buttons, disabled state, pressed state, section labels and keyboard-focusable hints.", groups: ["ui", "control", "type", "space"] },
  { id: "lens", label: "Lens border", source: "app/styles/room.css · .cloth-scene__loupe-ring", note: "The real CSS lens border only. Cloth rendering and optical magnification stay in the main room at /.", groups: ["duration"] },
] as const;

export type ComponentId = typeof COMPONENTS[number]["id"];
export type TokenDefaults = Record<string, string>;
export type TokenPatch = Record<string, string>;
export type Drafts = Partial<Record<ComponentId, TokenPatch>>;
export const DRAFT_KEY = "loom.component-workbench.v1";
export const isComponentId = (id: unknown): id is ComponentId => COMPONENTS.some(c => c.id === id);
export const safeTokenValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[;{}@<>]/.test(value);

export function sanitizeDrafts(input: unknown, defaults: TokenDefaults): Drafts {
  if (!input || typeof input !== "object") return {};
  const result: Drafts = {};
  for (const [id, patch] of Object.entries(input)) {
    if (!isComponentId(id) || !patch || typeof patch !== "object") continue;
    result[id] = Object.fromEntries(Object.entries(patch).flatMap(([key, value]) =>
      Object.hasOwn(defaults, key) && safeTokenValue(value) ? [[key, value]] : []));
  }
  return result;
}

export function exportTokens(id: ComponentId, patch: TokenPatch): string {
  return `/* ${id} specimen draft. Review shared effects before applying to room-tokens.css. */\n:root {\n${Object.entries(patch).filter(([name, value]) => /^--room-[\w-]+$/.test(name) && safeTokenValue(value)).map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}\n`;
}
