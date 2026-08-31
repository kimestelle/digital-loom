"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { MapName } from "@/lib/core/materialPackage";
import { Slider } from "@/lib/ui/panelPrimitives";
import {
  buildMapFilter,
  DEFAULT_MAP_IMAGE_SETTINGS,
  editNormalImageData,
  isColorMap,
  isNormalMap,
  type MapImageSettings,
} from "@/lib/ui/mapImageEdits";

interface MapEditorModalProps {
  entry: { name: MapName; url: string };
  onClose: () => void;
  onCreateVariation: (name: MapName, file: File) => Promise<void>;
}

interface VariationRecipe {
  label: string;
  patch: Partial<MapImageSettings>;
}

const COLOR_RECIPES: VariationRecipe[] = [
  { label: "faded", patch: { brightness: 0.08, contrast: -0.12, saturation: 0.72 } },
  { label: "denser", patch: { contrast: 0.28, saturation: 1.18 } },
  { label: "shifted", patch: { hue: 28, saturation: 1.08 } },
];

const SCALAR_RECIPES: VariationRecipe[] = [
  { label: "softer", patch: { brightness: 0.06, contrast: -0.2, blur: 0.8 } },
  { label: "harder", patch: { contrast: 0.35 } },
  { label: "invert", patch: { invert: true } },
];

const NORMAL_RECIPES: VariationRecipe[] = [
  { label: "soft relief", patch: { normalStrength: 0.5 } },
  { label: "deep relief", patch: { normalStrength: 1.55 } },
  { label: "flip y", patch: { flipNormalY: true } },
];

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the edited map"))),
      "image/png",
    );
  });
}

export function MapEditorModal({
  entry,
  onClose,
  onCreateVariation,
}: MapEditorModalProps) {
  const beforeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const afterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [settings, setSettings] = useState<MapImageSettings>(
    DEFAULT_MAP_IMAGE_SETTINGS,
  );
  const [sourceUrl, setSourceUrl] = useState(entry.url);
  const [sourceName, setSourceName] = useState(`${entry.name} source`);
  const [dimensions, setDimensions] = useState<string>("loading map…");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRecipe, setActiveRecipe] = useState<string | null>(null);

  const normal = isNormalMap(entry.name);
  const color = isColorMap(entry.name);
  const recipes = normal
    ? NORMAL_RECIPES
    : color
      ? COLOR_RECIPES
      : SCALAR_RECIPES;

  const drawEdited = useCallback(() => {
    const image = sourceImageRef.current;
    const canvas = afterCanvasRef.current;
    if (!image || !canvas || !ready) return;
    const context = canvas.getContext("2d", { willReadFrequently: normal });
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.filter = normal ? "none" : buildMapFilter(settings);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.filter = "none";
    if (normal) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      editNormalImageData(
        pixels,
        settings.normalStrength,
        settings.flipNormalY,
      );
      context.putImageData(pixels, 0, 0);
    }
  }, [normal, ready, settings]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [onClose]);

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const maxDimension = 2048;
      const scale = Math.min(
        1,
        maxDimension / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      for (const canvas of [beforeCanvasRef.current, afterCanvasRef.current]) {
        if (!canvas) continue;
        canvas.width = width;
        canvas.height = height;
      }
      const before = beforeCanvasRef.current?.getContext("2d");
      before?.drawImage(image, 0, 0, width, height);
      sourceImageRef.current = image;
      setDimensions(
        scale < 1
          ? `${image.naturalWidth} × ${image.naturalHeight} · working at ${width} × ${height}`
          : `${width} × ${height}`,
      );
      setReady(true);
    };
    image.onerror = () => {
      setError("This map could not be opened for pixel editing");
      setDimensions("map unavailable");
    };
    image.src = sourceUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [sourceUrl]);

  useEffect(() => {
    const frame = requestAnimationFrame(drawEdited);
    return () => cancelAnimationFrame(frame);
  }, [drawEdited]);

  const update = useCallback((patch: Partial<MapImageSettings>) => {
    setActiveRecipe(null);
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const applyRecipe = (recipe: VariationRecipe) => {
    setActiveRecipe(recipe.label);
    setSettings({ ...DEFAULT_MAP_IMAGE_SETTINGS, ...recipe.patch });
  };

  const replaceSource = (file: File) => {
    if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
      setError("Use a PNG, JPEG, or WebP image");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setError("Map files must be 32 MB or smaller");
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const nextUrl = URL.createObjectURL(file);
    objectUrlRef.current = nextUrl;
    setReady(false);
    setSourceUrl(nextUrl);
    setSourceName(file.name);
    setActiveRecipe(null);
    setSettings(DEFAULT_MAP_IMAGE_SETTINGS);
    setError(null);
  };

  const saveVariation = async () => {
    const canvas = afterCanvasRef.current;
    if (!canvas || !ready) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await canvasBlob(canvas);
      const file = new File(
        [blob],
        `${entry.name}-variation-${Date.now()}.png`,
        { type: "image/png" },
      );
      await onCreateVariation(entry.name, file);
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const titleId = `map-editor-${entry.name}-title`;
  const modal = (
    <div
      className="map-studio-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="map-studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="map-studio-header">
          <div>
            <p className="map-studio-kicker">pixel editor</p>
            <h2 id={titleId}>{entry.name} map</h2>
          </div>
          <div className="map-studio-source">
            <span>{sourceName}</span>
            <span>{dimensions}</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="map-studio-close"
            aria-label={`close ${entry.name} map editor`}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="map-studio-workspace">
          <div className="map-studio-images">
            <figure className="map-studio-figure">
              <figcaption>source</figcaption>
              <div className="map-studio-canvas-frame">
                <canvas ref={beforeCanvasRef} aria-label="source map preview" />
              </div>
            </figure>
            <figure className="map-studio-figure" data-output>
              <figcaption>variation</figcaption>
              <div className="map-studio-canvas-frame">
                <canvas ref={afterCanvasRef} aria-label="edited map preview" />
              </div>
            </figure>
          </div>

          <aside className="map-studio-controls" aria-label="map adjustments">
            <div className="map-studio-control-section">
              <span className="map-studio-control-label">variations</span>
              <div className="map-studio-recipes">
                {recipes.map((recipe) => (
                  <button
                    key={recipe.label}
                    type="button"
                    data-active={activeRecipe === recipe.label}
                    aria-pressed={activeRecipe === recipe.label}
                    onClick={() => applyRecipe(recipe)}
                  >
                    {recipe.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="map-studio-control-section map-studio-sliders">
              {normal ? (
                <>
                  <Slider
                    label="relief strength"
                    hint="rescales the x/y vectors, then renormalizes every pixel"
                    value={settings.normalStrength}
                    min={0}
                    max={2}
                    step={0.01}
                    onChange={(normalStrength) => update({ normalStrength })}
                  />
                  <button
                    type="button"
                    className="map-studio-toggle"
                    data-active={settings.flipNormalY}
                    aria-pressed={settings.flipNormalY}
                    onClick={() => update({ flipNormalY: !settings.flipNormalY })}
                  >
                    flip green / y
                  </button>
                </>
              ) : (
                <>
                  <Slider
                    label="brightness"
                    value={settings.brightness}
                    min={-0.8}
                    max={0.8}
                    step={0.01}
                    onChange={(brightness) => update({ brightness })}
                  />
                  <Slider
                    label="contrast"
                    value={settings.contrast}
                    min={-0.8}
                    max={1}
                    step={0.01}
                    onChange={(contrast) => update({ contrast })}
                  />
                  {color ? (
                    <>
                      <Slider
                        label="saturation"
                        value={settings.saturation}
                        min={0}
                        max={2}
                        step={0.01}
                        onChange={(saturation) => update({ saturation })}
                      />
                      <Slider
                        label="hue"
                        value={settings.hue}
                        min={-180}
                        max={180}
                        step={1}
                        onChange={(hue) => update({ hue })}
                      />
                    </>
                  ) : null}
                  <Slider
                    label="blur"
                    value={settings.blur}
                    min={0}
                    max={8}
                    step={0.1}
                    onChange={(blur) => update({ blur })}
                  />
                  <button
                    type="button"
                    className="map-studio-toggle"
                    data-active={settings.invert}
                    aria-pressed={settings.invert}
                    onClick={() => update({ invert: !settings.invert })}
                  >
                    invert pixels
                  </button>
                </>
              )}
            </div>

            <div className="map-studio-control-section map-studio-source-action">
              <label className="btn btn-ghost">
                use another image
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) replaceSource(file);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setActiveRecipe(null);
                  setSettings(DEFAULT_MAP_IMAGE_SETTINGS);
                }}
              >
                reset edits
              </button>
            </div>
          </aside>
        </div>

        <footer className="map-studio-footer">
          <p>
            saves baked pixels in a new material swatch · source stays intact
          </p>
          {error ? <p className="map-studio-error" role="alert">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary map-studio-save"
            disabled={!ready || saving}
            onClick={() => void saveVariation()}
          >
            {saving ? "building variation…" : "save as variation"}
          </button>
        </footer>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
