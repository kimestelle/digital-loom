"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type ReactNode,
} from "react";

export type MaterialCabinetFace = "material" | "archive";

export interface MaterialCabinetProps {
  face: MaterialCabinetFace;
  onFlip: (nextFace: MaterialCabinetFace) => void;
  materialFace: ReactNode;
  archiveFace: ReactNode;
  /** Outer material-face scroller, exposed for view-change scroll resets. */
  materialFaceRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * One cabinet with two permanently mounted faces. The track flips in the
 * desktop room and becomes a side-by-side sliding rail in the mobile sheet.
 * The edge tab stays outside the track, so its DOM identity and focus do
 * not change during either transition.
 */
export function MaterialCabinet({
  face,
  onFlip,
  materialFace,
  archiveFace,
  materialFaceRef,
  className,
}: MaterialCabinetProps) {
  const flipRef = useRef<HTMLButtonElement | null>(null);
  const materialRef = useRef<HTMLElement | null>(null);
  const archiveRef = useRef<HTMLElement | null>(null);
  const nextFace: MaterialCabinetFace =
    face === "material" ? "archive" : "material";

  useEffect(() => {
    const inactive = face === "material" ? archiveRef.current : materialRef.current;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && inactive?.contains(focused)) {
      flipRef.current?.focus();
    }
  }, [face]);

  const flip = useCallback(() => {
    onFlip(face === "material" ? "archive" : "material");
  }, [face, onFlip]);

  const setMaterialFaceRef = useCallback(
    (node: HTMLElement | null) => {
      materialRef.current = node;
      if (materialFaceRef) materialFaceRef.current = node;
    },
    [materialFaceRef],
  );

  const classes = ["material-cabinet", className].filter(Boolean).join(" ");

  return (
    <section className={classes} data-face={face} aria-label="material cabinet">
      <div className="material-cabinet__track" data-face={face}>
        <section
          ref={setMaterialFaceRef}
          className="material-cabinet__face material-cabinet__face--material"
          data-cabinet-face="material"
          data-active={face === "material"}
          aria-hidden={face !== "material"}
          inert={face !== "material" ? true : undefined}
        >
          {materialFace}
        </section>

        <section
          ref={archiveRef}
          className="material-cabinet__face material-cabinet__face--archive"
          data-cabinet-face="archive"
          data-active={face === "archive"}
          aria-hidden={face !== "archive"}
          inert={face !== "archive" ? true : undefined}
        >
          {archiveFace}
        </section>
      </div>

      <button
        ref={flipRef}
        type="button"
        className="material-cabinet__flip"
        aria-label={
          nextFace === "archive"
            ? "show swatch archive"
            : "show material dossier"
        }
        title={nextFace === "archive" ? "swatch archive" : "material dossier"}
        onClick={flip}
      >
        <svg
          className="material-cabinet__flip-icon"
          data-destination="material"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {/* Feather sliders; copyright Cole Bemis, MIT (public/icons/FEATHER-LICENSE.txt). */}
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        <svg
          className="material-cabinet__flip-icon"
          data-destination="archive"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {/* Feather grid; see the shared license above. */}
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      </button>
    </section>
  );
}
