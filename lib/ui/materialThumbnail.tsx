export function MaterialThumbnail({
  src,
  alt = "",
}: {
  src: string;
  alt?: string;
}) {
  return (
    <span className="material-thumbnail">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
      />
    </span>
  );
}
