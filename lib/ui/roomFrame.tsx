import { forwardRef, type CSSProperties, type ReactNode } from "react";

export interface RoomFrameProps {
  /** The single persistent Three canvas and its specimen interaction layer. */
  stage: ReactNode;
  /** The material dossier / swatch archive cabinet. */
  cabinet?: ReactNode;
  /** Portals, transient status, or other non-architectural UI. */
  overlay?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Exposed for deterministic light checks; the controller may also set CSS vars. */
  lightPosition?: number;
}

function lightPositionAttribute(value: number | undefined): string {
  if (!Number.isFinite(value)) return "0.500";
  return Math.min(1, Math.max(0, value as number)).toFixed(3);
}

/**
 * Perspective room architecture around the real specimen renderer.
 *
 * The room is still ordinary DOM/SVG rather than a second 3D scene. Its
 * measured planes and window follow the 1280 x 832 Figma composition, so the
 * persistent Three canvas only has to render the specimen itself.
 */
export const RoomFrame = forwardRef<HTMLElement, RoomFrameProps>(function RoomFrame({
  stage,
  cabinet,
  overlay,
  className,
  style,
  lightPosition,
}, ref) {
  const classes = ["room-frame", className].filter(Boolean).join(" ");

  return (
    <main
      ref={ref}
      className={classes}
      style={style}
      data-room-environment="room"
      data-has-cabinet={Boolean(cabinet)}
      data-light-position={lightPositionAttribute(lightPosition)}
    >
      <div className="room-frame__architecture" aria-hidden="true">
        <svg
          className="room-frame__planes"
          viewBox="0 0 1280 832"
          preserveAspectRatio="none"
          focusable="false"
        >
          <defs>
            <linearGradient id="room-back-wall" x1="0" y1="0" x2="0.86" y2="1">
              <stop className="room-frame__stop room-frame__stop--wall-light" offset="0" />
              <stop className="room-frame__stop room-frame__stop--wall-mid" offset="0.58" />
              <stop className="room-frame__stop room-frame__stop--wall-shade" offset="1" />
            </linearGradient>
            <linearGradient id="room-side-wall" x1="0" y1="0" x2="1" y2="0.85">
              <stop className="room-frame__stop room-frame__stop--side-light" offset="0" />
              <stop className="room-frame__stop room-frame__stop--side-mid" offset="0.54" />
              <stop className="room-frame__stop room-frame__stop--side-shade" offset="1" />
            </linearGradient>
            <linearGradient id="room-floor-plane" x1="0.38" y1="0" x2="0.56" y2="1">
              <stop className="room-frame__stop room-frame__stop--floor-far" offset="0" />
              <stop className="room-frame__stop room-frame__stop--floor-mid" offset="0.42" />
              <stop className="room-frame__stop room-frame__stop--floor-near" offset="1" />
            </linearGradient>
          </defs>

          <path
            className="room-frame__plane room-frame__plane--back"
            d="M0.5 0.5H920.5V554.5L0.5 662.5Z"
          />
          <path
            className="room-frame__plane room-frame__plane--side"
            d="M920.5 0.5H1279.5V717.865L920.5 554.5Z"
          />
          <path
            className="room-frame__plane room-frame__plane--floor"
            d="M920.5 554.5L0.5 662.5V831.5H1279.5V717.865L920.5 554.5Z"
          />
          <image
            className="room-frame__surface-texture room-frame__surface-texture--walls"
            data-room-texture="walls"
            href="/2d-textures/room-walls-perspective.png"
            x="0"
            y="0"
            width="1280"
            height="832"
            preserveAspectRatio="none"
          />
          <image
            className="room-frame__surface-texture room-frame__surface-texture--floor"
            data-room-texture="floor"
            href="/2d-textures/room-floor-perspective.png"
            x="0"
            y="0"
            width="1280"
            height="832"
            preserveAspectRatio="none"
          />
          <path
            className="room-frame__perspective-seams"
            d="M920.5 554.5V0.5M920.5 554.5L0.5 662.5V0.5H920.5M920.5 554.5L1279.5 717.865V0.5H920.5"
          />
        </svg>

        <div
          className="room-frame__window-anchor"
          data-room-window-anchor="wall-corner"
        >
          <div
            className="room-frame__window"
            data-room-window-mask="aperture"
          />

          <div className="room-frame__angled-light" />
        </div>
        <div className="room-frame__ground-light">
          <div className="room-frame__floor-projection">
            <div className="room-frame__dapple">
              <div className="room-frame__dapple-mask room-frame__dapple-mask--soft" />
            </div>
            <div className="room-frame__transmitted-light" />
          </div>
        </div>
        <div className="room-frame__foreground-line" />
      </div>

      <svg
        className="room-frame__guides"
        viewBox="0 0 1280 832"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M851 0V832M1245 0V832M814 39H1279M814 714H1279" />
      </svg>

      <section
        className="room-frame__stage"
        data-room-slot="stage"
        aria-label="fabric specimen"
      >
        {stage}
      </section>

      {cabinet ? (
        <aside
          className="room-frame__cabinet"
          data-room-slot="cabinet"
          aria-label="material controls"
        >
          {cabinet}
        </aside>
      ) : null}

      {overlay ? (
        <div className="room-frame__overlay" data-room-slot="overlay">
          {overlay}
        </div>
      ) : null}
    </main>
  );
});
