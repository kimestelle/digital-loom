#!/usr/bin/env python3
"""Bake source surface textures into Digital Loom's measured room planes."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOM_SIZE = (1280, 832)
SUPERSAMPLE = 3

# These points mirror lib/ui/roomFrame.tsx's 1280 x 832 SVG architecture.
BACK_WALL = ((0.5, 0.5), (920.5, 0.5), (920.5, 554.5), (0.5, 662.5))
SIDE_WALL = ((920.5, 0.5), (1279.5, 0.5), (1279.5, 717.865), (920.5, 554.5))
FLOOR_MASK = (
    (920.5, 554.5),
    (0.5, 662.5),
    (0.5, 831.5),
    (1279.5, 831.5),
    (1279.5, 717.865),
)

# Projective map from normalized floor coordinates to the SVG plane. Pixels
# outside its base quadrilateral still inverse-map cleanly; wrapping those UVs
# is what fills the viewport-clipped five-sided floor without faking a second
# vanishing point at the room corner.
FLOOR_HOMOGRAPHY = np.asarray(
    (
        (1099.447653, 80.802732, 0.5),
        (0.097473, -0.136062, 662.5),
        (0.194946, -0.272124, 1.0),
    ),
    dtype=np.float64,
)


def perspective_coefficients(
    destination: tuple[tuple[float, float], ...],
    source_size: tuple[int, int],
) -> tuple[float, ...]:
    """Return Pillow's output-to-input perspective coefficients."""

    source_width, source_height = source_size
    source = (
        (0.0, 0.0),
        (float(source_width - 1), 0.0),
        (float(source_width - 1), float(source_height - 1)),
        (0.0, float(source_height - 1)),
    )
    rows: list[list[float]] = []
    values: list[float] = []
    for (x, y), (u, v) in zip(destination, source, strict=True):
        rows.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        rows.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.extend((u, v))
    return tuple(np.linalg.solve(np.asarray(rows), np.asarray(values)).tolist())


def polygon_mask(
    points: tuple[tuple[float, float], ...],
    size: tuple[int, int],
    scale: int,
) -> Image.Image:
    mask = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([(x * scale, y * scale) for x, y in points], fill=255)
    return mask


def warp_to_quad(
    source: Image.Image,
    quad: tuple[tuple[float, float], ...],
    size: tuple[int, int] = ROOM_SIZE,
    scale: int = SUPERSAMPLE,
) -> Image.Image:
    scaled_quad = tuple((x * scale, y * scale) for x, y in quad)
    coefficients = perspective_coefficients(scaled_quad, source.size)
    warped = source.convert("RGBA").transform(
        (size[0] * scale, size[1] * scale),
        Image.Transform.PERSPECTIVE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0, 0),
    )
    alpha = polygon_mask(quad, size, scale)
    if warped.getchannel("A").getextrema() != (255, 255):
        alpha_array = np.asarray(alpha, dtype=np.uint16)
        source_alpha = np.asarray(warped.getchannel("A"), dtype=np.uint16)
        alpha = Image.fromarray(((alpha_array * source_alpha) // 255).astype(np.uint8))
    warped.putalpha(alpha)
    return warped.resize(size, Image.Resampling.LANCZOS)


def make_seamless(source: Image.Image, seam: int = 16) -> Image.Image:
    """Crossfade opposing edges without flattening the source's straight alpha."""

    pixels = np.asarray(source.convert("RGBA"), dtype=np.float32).copy()
    seam_x = min(seam, max(1, source.width // 4))
    seam_y = min(seam, max(1, source.height // 4))
    for distance in range(seam_x):
        weight = 1.0 - distance / seam_x
        opposite = pixels[:, -(distance + 1)].copy()
        average = (pixels[:, distance] + opposite) * 0.5
        pixels[:, distance] = pixels[:, distance] * (1.0 - weight) + average * weight
        pixels[:, -(distance + 1)] = opposite * (1.0 - weight) + average * weight
    for distance in range(seam_y):
        weight = 1.0 - distance / seam_y
        opposite = pixels[-(distance + 1), :].copy()
        average = (pixels[distance, :] + opposite) * 0.5
        pixels[distance, :] = pixels[distance, :] * (1.0 - weight) + average * weight
        pixels[-(distance + 1), :] = opposite * (1.0 - weight) + average * weight
    return Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8), "RGBA")


def repeat_crop(source: Image.Image, start: int, width: int) -> Image.Image:
    pixels = np.asarray(source.convert("RGBA"))
    columns = (np.arange(start, start + width) % source.width).astype(np.intp)
    return Image.fromarray(pixels[:, columns], "RGBA")


def bilinear_repeat(
    source: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
) -> np.ndarray:
    """Sample a repeating straight-alpha image through premultiplied bilinear."""

    height, width, _ = source.shape
    x = np.mod(x, width)
    y = np.mod(y, height)
    x0 = np.floor(x).astype(np.intp)
    y0 = np.floor(y).astype(np.intp)
    x1 = (x0 + 1) % width
    y1 = (y0 + 1) % height
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]

    source_float = source.astype(np.float32) / 255.0
    alpha = source_float[..., 3:4]
    premultiplied = np.concatenate((source_float[..., :3] * alpha, alpha), axis=2)
    top = premultiplied[y0, x0] * (1.0 - fx) + premultiplied[y0, x1] * fx
    bottom = premultiplied[y1, x0] * (1.0 - fx) + premultiplied[y1, x1] * fx
    sampled = top * (1.0 - fy) + bottom * fy
    sampled_alpha = sampled[..., 3:4]
    sampled_rgb = np.divide(
        sampled[..., :3],
        sampled_alpha,
        out=np.zeros_like(sampled[..., :3]),
        where=sampled_alpha > 1e-6,
    )
    return np.concatenate((sampled_rgb, sampled_alpha), axis=2)


def bake_walls(source_path: Path, output_path: Path) -> None:
    source = make_seamless(Image.open(source_path))
    back_width = round(source.width * 1.15)
    side_width = round(source.width * 0.42)
    back_source = repeat_crop(source, 0, back_width)
    side_source = repeat_crop(source, back_width, side_width)
    back = warp_to_quad(back_source, BACK_WALL)
    side = warp_to_quad(side_source, SIDE_WALL)
    output = Image.alpha_composite(side, back)
    output.save(output_path, format="PNG", optimize=True)


def bake_floor(source_path: Path, output_path: Path) -> None:
    source = np.asarray(make_seamless(Image.open(source_path)))
    width = ROOM_SIZE[0] * SUPERSAMPLE
    height = ROOM_SIZE[1] * SUPERSAMPLE
    inverse = np.linalg.inv(FLOOR_HOMOGRAPHY)
    mask = np.asarray(polygon_mask(FLOOR_MASK, ROOM_SIZE, SUPERSAMPLE))
    output = np.zeros((height, width, 4), dtype=np.uint8)
    x = (np.arange(width, dtype=np.float64) + 0.5) / SUPERSAMPLE

    for row_start in range(0, height, 192):
        row_end = min(height, row_start + 192)
        y = (np.arange(row_start, row_end, dtype=np.float64) + 0.5) / SUPERSAMPLE
        xx, yy = np.meshgrid(x, y)
        denominator = inverse[2, 0] * xx + inverse[2, 1] * yy + inverse[2, 2]
        # The projective horizon crosses pixels outside FLOOR_MASK. Keep those
        # unused samples finite so the bake is warning-free and deterministic.
        safe_denominator = np.where(
            np.abs(denominator) < 1e-8,
            np.where(denominator < 0, -1e-8, 1e-8),
            denominator,
        )
        s = (
            inverse[0, 0] * xx + inverse[0, 1] * yy + inverse[0, 2]
        ) / safe_denominator
        t = (
            inverse[1, 0] * xx + inverse[1, 1] * yy + inverse[1, 2]
        ) / safe_denominator
        sampled = bilinear_repeat(
            source,
            s * 2.0 * source.shape[1],
            t * source.shape[0],
        )
        chunk_mask = mask[row_start:row_end, :, None].astype(np.float32) / 255.0
        sampled[..., 3:4] *= chunk_mask
        output[row_start:row_end] = np.clip(sampled * 255.0, 0, 255).astype(np.uint8)

    baked = Image.fromarray(output, "RGBA").resize(ROOM_SIZE, Image.Resampling.LANCZOS)
    baked.save(output_path, format="PNG", optimize=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wood", type=Path, required=True)
    parser.add_argument("--wall", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    bake_floor(args.wood, args.output_dir / "room-floor-perspective.png")
    bake_walls(args.wall, args.output_dir / "room-walls-perspective.png")


if __name__ == "__main__":
    main()
