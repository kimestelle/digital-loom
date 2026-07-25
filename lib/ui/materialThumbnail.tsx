"use client";

import { useEffect, useRef } from "react";

export function MaterialThumbnail({
  id,
  src,
  alt = "",
  away,
  onRegister,
  onHoverIn,
  onHoverOut,
}: {
  id: string;
  src: string;
  alt?: string;
  away: boolean;
  onRegister: (id: string, image: HTMLImageElement | null) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: (id: string) => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    onRegister(id, ref.current);
    return () => onRegister(id, null);
  }, [id, onRegister, src]);

  return (
    <span className="material-thumbnail" data-away={away}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
        onPointerEnter={() => onHoverIn(id)}
        onPointerLeave={() => onHoverOut(id)}
      />
      <span className="material-thumbnail-ghost" aria-hidden="true" />
    </span>
  );
}
