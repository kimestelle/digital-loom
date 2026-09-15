#!/usr/bin/env python3
"""Deterministic forward spectral transport for one authored room-light keyframe.

Run with any Python with NumPy, including Blender's bundled Python:
  /Applications/Blender.app/Contents/Resources/5.1/python/bin/python3.13 \
      scripts/bake-room-sunlight.py

This is direct optical transport through two gently uneven glass surfaces.
It is not a Cycles render, a full room simulation, or an image-generation step.
Only NumPy and the Python standard library are required. The PNG encoder is
included so this can run without installing Pillow into Blender's Python.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import time
import zlib

import numpy as np


SEED = 902104
WIDTH, HEIGHT = 1024, 512
WINDOW_WIDTH, SILL, TOP = 3.2, 1.0, 2.65
CROSSBAR = TOP - 0.46 * (TOP - SILL)
PANE_COUNT = 5
PANE_WIDTH = WINDOW_WIDTH / PANE_COUNT
GLASS_THICKNESS = 0.006
FRAME_DEPTH = 0.018
DIRECTION = np.asarray((0.59770104299, 0.56347006616, -0.57031127268))
DIRECTION /= np.linalg.norm(DIRECTION)
SUN_RADIUS = math.radians(0.2665)
RECONSTRUCTION_SIGMA = 0.70
WAVELENGTHS = np.arange(410.0, 711.0, 25.0)
def aperture_bounds(direction: np.ndarray) -> dict[str, float]:
    """Padded floor intersections, including rays traveling toward negative X."""
    x = np.asarray((SILL, TOP)) * direction[0] / -direction[2]
    y = np.asarray((SILL, TOP)) * direction[1] / -direction[2]
    return {
        "minX": round(float(np.min(x)) - 0.18, 6),
        "minY": round(float(np.min(y)) - 0.18, 6),
        "maxX": round(WINDOW_WIDTH + float(np.max(x)) + 0.18, 6),
        "maxY": round(float(np.max(y)) + 0.18, 6),
    }


# Pixel bounds are derived from the aperture, never from a screen-space guess.
BOUNDS = aperture_bounds(DIRECTION)


def normalized(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def make_surfaces() -> tuple[np.ndarray, np.ndarray]:
    """Smooth nonperiodic Gaussian glass relief; all values are in meters.

    Front and back share their broad pane bow. The back has additional low
    amplitude thickness variations. These are geometry, not image gradients;
    their analytic slopes determine Snell refraction and local light density.
    """
    rng = np.random.default_rng(SEED)
    front = np.empty((PANE_COUNT, 5, 5), dtype=np.float64)
    thickness = np.empty((PANE_COUNT, 8, 5), dtype=np.float64)
    for pane in range(PANE_COUNT):
        for array, minimum, maximum, amplitude in (
            (front, 0.14, 0.40, 0.00055),
            (thickness, 0.055, 0.17, 0.00100),
        ):
            count = array.shape[1]
            array[pane, :, 0] = rng.uniform(-0.04, PANE_WIDTH + 0.04, count)
            array[pane, :, 1] = rng.uniform(SILL - 0.10, TOP + 0.10, count)
            array[pane, :, 2] = rng.uniform(minimum, maximum, count)
            array[pane, :, 3] = rng.uniform(minimum, maximum * 1.35, count)
            array[pane, :, 4] = rng.uniform(-amplitude, amplitude, count)
    return front, thickness


FRONT, THICKNESS = make_surfaces()


def relief(x: np.ndarray, z: np.ndarray, pane: np.ndarray, back: bool):
    h = np.zeros_like(x)
    gx = np.zeros_like(x)
    gz = np.zeros_like(x)
    local_x = x - pane * PANE_WIDTH
    for coefficients in ((FRONT, THICKNESS) if back else (FRONT,)):
        for term in range(coefficients.shape[1]):
            center_x, center_z, sigma_x, sigma_z, amplitude = coefficients[pane, term].T
            dx = (local_x - center_x) / sigma_x
            dz = (z - center_z) / sigma_z
            value = amplitude * np.exp(-0.5 * (dx * dx + dz * dz))
            h += value
            gx -= value * dx / sigma_x
            gz -= value * dz / sigma_z
    if back:
        h += GLASS_THICKNESS
    return h, gx, gz


def intersect_surface(p: np.ndarray, d: np.ndarray, pane: np.ndarray, back: bool):
    t = ((GLASS_THICKNESS if back else 0.0) - p[:, 1]) / d[:, 1]
    # Newton intersections with the analytic surface, not a thin-lens shortcut.
    for _ in range(3):
        hit = p + t[:, None] * d
        h, gx, gz = relief(hit[:, 0], hit[:, 2], pane, back)
        t -= (hit[:, 1] - h) / (d[:, 1] - gx * d[:, 0] - gz * d[:, 2])
    hit = p + t[:, None] * d
    h, gx, gz = relief(hit[:, 0], hit[:, 2], pane, back)
    assert np.max(np.abs(hit[:, 1] - h)) < 1e-7
    normal = normalized(np.column_stack((gx, -np.ones_like(gx), gz)))
    return hit, normal


def refract(d: np.ndarray, normal: np.ndarray, n1: float, n2: float):
    cos_i = -np.sum(d * normal, axis=1)
    eta = n1 / n2
    k = 1 - eta * eta * (1 - cos_i * cos_i)
    assert np.all(k > 0), "Unexpected total internal reflection in mild glass relief"
    cos_t = np.sqrt(k)
    out = eta * d + (eta * cos_i - cos_t)[:, None] * normal
    rs = ((n1 * cos_i - n2 * cos_t) / (n1 * cos_i + n2 * cos_t)) ** 2
    rp = ((n1 * cos_t - n2 * cos_i) / (n1 * cos_t + n2 * cos_i)) ** 2
    return normalized(out), 1 - (rs + rp) * 0.5


def glass_ior(wavelength: float) -> float:
    """N-BK7 Sellmeier model; wavelength in nm, Sellmeier lambda in microns."""
    l2 = (wavelength / 1000.0) ** 2
    return math.sqrt(1 + sum(b * l2 / (l2 - c) for b, c in (
        (1.03961212, 0.00600069867),
        (0.231792344, 0.0200179144),
        (1.01046945, 103.560653),
    )))


def spectral_rgb_weights() -> np.ndarray:
    """Analytic CIE 1931 matching functions, sampled across a 5778 K source.

    Wyman/Sloan/Shirley 2013 piecewise Gaussian fits; integrated XYZ is
    converted to linear sRGB, then white-balanced to neutral direct sunlight.
    Intermediate matching weights can be negative; only final RGB is clipped.
    """
    def g(mu, left, right):
        scale = np.where(WAVELENGTHS < mu, left, right)
        return np.exp(-0.5 * ((WAVELENGTHS - mu) * scale) ** 2)

    xyz = np.stack((
        0.362 * g(442.0, 0.0624, 0.0374) + 1.056 * g(599.8, 0.0264, 0.0323)
        - 0.065 * g(501.1, 0.0490, 0.0382),
        0.821 * g(568.8, 0.0213, 0.0247) + 0.286 * g(530.9, 0.0613, 0.0322),
        1.217 * g(437.0, 0.0845, 0.0278) + 0.681 * g(459.0, 0.0385, 0.0725),
    ), axis=1)
    wavelength_m = WAVELENGTHS * 1e-9
    source = wavelength_m ** -5 / np.expm1(0.01438776877 / (wavelength_m * 5778.0))
    source /= np.max(source)
    xyz_to_rgb = np.asarray(((3.2406, -1.5372, -0.4986),
                             (-0.9689, 1.8758, 0.0415),
                             (0.0557, -0.2040, 1.0570)))
    weights = (xyz @ xyz_to_rgb.T) * source[:, None]
    # Include clear-glass Fresnel spectral loss in the neutral reference.
    references = []
    for wavelength in WAVELENGTHS:
        d = DIRECTION[None, :]
        n = np.asarray(((0.0, -1.0, 0.0),))
        inside, transmission1 = refract(d, n, 1, glass_ior(wavelength))
        _, transmission2 = refract(inside, n, glass_ior(wavelength), 1)
        references.append(float(transmission1[0] * transmission2[0]))
    weights /= np.sum(weights * np.asarray(references)[:, None], axis=0)
    return weights


def aperture_open(x: np.ndarray, z: np.ndarray) -> np.ndarray:
    # A 1.1 mm smooth imperfection in the muntin edge is geometric occlusion.
    edge_relief = 0.0011 * np.exp(-((z - 1.48) / 0.15) ** 2)
    edge_relief -= 0.0007 * np.exp(-((z - 2.25) / 0.22) ** 2)
    open_mask = (x > 0.025) & (x < WINDOW_WIDTH - 0.025)
    open_mask &= (z > SILL + 0.025) & (z < TOP - 0.025)
    for divider in range(1, PANE_COUNT):
        open_mask &= np.abs(x - divider * PANE_WIDTH - edge_relief) > 0.011
    open_mask &= np.abs(z - CROSSBAR) > 0.013
    return open_mask


def sample_aperture(first: int, stop: int, nx: int, nz: int):
    ids = np.arange(first, stop, dtype=np.float64)
    # Irrational Kronecker sequences with shared samples across wavelengths
    # avoid stochastic chromatic noise and make all reruns deterministic.
    u = np.mod(ids * 0.7548776662466927 + (SEED % 97) / 97, 1)
    v = np.mod(ids * 0.5698402909980532 + (SEED % 89) / 89, 1)
    jitter_x = np.mod(ids * 0.4384471871911697 + 0.31, 1)
    jitter_z = np.mod(ids * 0.3281733978857760 + 0.73, 1)
    x = (np.mod(ids, nx) + jitter_x) / nx * WINDOW_WIDTH
    z = SILL + (np.floor(ids / nx) + jitter_z) / nz * (TOP - SILL)
    radius, angle = np.sqrt(u) * math.tan(SUN_RADIUS), v * 2 * math.pi
    tangent = normalized(np.cross(DIRECTION, np.asarray((0.0, 0.0, 1.0))))
    bitangent = np.cross(DIRECTION, tangent)
    d = normalized(DIRECTION + radius[:, None] * (
        np.cos(angle)[:, None] * tangent + np.sin(angle)[:, None] * bitangent
    ))
    p = np.column_stack((x, np.zeros_like(x), z))
    opened = aperture_open(x, z)
    p, d = p[opened], d[opened]
    pane = np.clip(np.floor(p[:, 0] / PANE_WIDTH).astype(np.intp), 0, PANE_COUNT - 1)
    return p, d, pane


def splat(field: np.ndarray, x: np.ndarray, y: np.ndarray, energy: np.ndarray) -> float:
    # Conservative bilinear photon deposition in the exported floor rectangle.
    px = (x - BOUNDS["minX"]) / (BOUNDS["maxX"] - BOUNDS["minX"]) * WIDTH - 0.5
    py = (y - BOUNDS["minY"]) / (BOUNDS["maxY"] - BOUNDS["minY"]) * HEIGHT - 0.5
    ix, iy = np.floor(px).astype(np.intp), np.floor(py).astype(np.intp)
    fx, fy = px - ix, py - iy
    contained = (ix >= 0) & (ix + 1 < WIDTH) & (iy >= 0) & (iy + 1 < HEIGHT)
    assert np.all(contained), "Increase the derived border; transported energy escaped"
    for dx, dy, weight in ((0, 0, (1-fx)*(1-fy)), (1, 0, fx*(1-fy)),
                           (0, 1, (1-fx)*fy), (1, 1, fx*fy)):
        bins = (iy + dy) * WIDTH + ix + dx
        field += np.bincount(bins, weights=energy * weight, minlength=WIDTH * HEIGHT).reshape(HEIGHT, WIDTH)
    return float(np.sum(energy))


def reconstruction_filter(field: np.ndarray) -> np.ndarray:
    """A 0.70 pixel Gaussian photon-reconstruction kernel; sun blur is traced."""
    radius = 3
    positions = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (positions / RECONSTRUCTION_SIGMA) ** 2)
    kernel /= kernel.sum()
    for axis in (0, 1):
        padding = [(0, 0), (0, 0), (0, 0)]
        padding[axis] = (radius, radius)
        padded = np.pad(field, padding)
        result = np.zeros_like(field)
        for index, weight in enumerate(kernel):
            slices = [slice(None), slice(None), slice(None)]
            slices[axis] = slice(index, index + field.shape[axis])
            result += weight * padded[tuple(slices)]
        field = result
    return field


def png_rgba(path: Path, rgba: np.ndarray) -> None:
    def chunk(name: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload))
    scanlines = b"".join(b"\x00" + row.tobytes() for row in rgba)
    payload = b"\x89PNG\r\n\x1a\n"
    payload += chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 6, 0, 0, 0))
    payload += chunk(b"sRGB", b"\x00")
    payload += chunk(b"IDAT", zlib.compress(scanlines, 9))
    payload += chunk(b"IEND", b"")
    path.write_bytes(payload)


def run(args: argparse.Namespace) -> None:
    global DIRECTION, BOUNDS
    started = time.monotonic()
    if args.direction is not None:
        DIRECTION = normalized(np.asarray(args.direction, dtype=np.float64))
        BOUNDS = aperture_bounds(DIRECTION)
    image_path = args.output_dir / f"{args.name}.png"
    metadata_path = args.output_dir / f"{args.name}.json"
    if not args.overwrite and (image_path.exists() or metadata_path.exists()):
        raise FileExistsError(f"Refusing to replace existing bake: {image_path}; use --overwrite explicitly")
    nx = args.aperture_samples
    nz = round(nx * (TOP - SILL) / WINDOW_WIDTH)
    total = nx * nz
    fields = np.zeros((len(WAVELENGTHS), HEIGHT, WIDTH), dtype=np.float64)
    sums = np.zeros((len(WAVELENGTHS), 3), dtype=np.float64)
    max_angle = 0.0
    min_thickness = 1.0
    for first in range(0, total, args.chunk_size):
        stop = min(first + args.chunk_size, total)
        p, d, pane = sample_aperture(first, stop, nx, nz)
        if not len(p):
            continue
        front, front_normal = intersect_surface(p, d, pane, False)
        for index, wavelength in enumerate(WAVELENGTHS):
            ior = glass_ior(float(wavelength))
            inside, t1 = refract(d, front_normal, 1.0, ior)
            back, back_normal = intersect_surface(front, inside, pane, True)
            out, t2 = refract(inside, back_normal, ior, 1.0)
            min_thickness = min(min_thickness, float(np.min(back[:, 1] - front[:, 1])))
            frame_exit = back + ((FRAME_DEPTH - back[:, 1]) / out[:, 1])[:, None] * out
            frame_open = aperture_open(frame_exit[:, 0], frame_exit[:, 2])
            # Clear crown glass: only Fresnel losses; bulk absorption negligible
            # over 6 mm in this stylized clear pane. No untracked brightness gain.
            energy = t1 * t2 * frame_open
            distance = -back[:, 2] / out[:, 2]
            floor = back + distance[:, None] * out
            assert np.all(distance > 0) and np.all(np.isfinite(floor))
            assert np.all((energy >= 0) & (energy <= 1))
            sums[index, 0] += len(p)
            sums[index, 1] += float(np.sum(t1 * t2))
            sums[index, 2] += splat(fields[index], floor[:, 0], floor[:, 1], energy)
            max_angle = max(max_angle, float(np.max(np.arccos(np.clip(np.sum(d * out, axis=1), -1, 1)))))
        print(f"Transported {stop:,}/{total:,} aperture samples × {len(WAVELENGTHS)} wavelengths", flush=True)

    assert min_thickness > 0.003, "Unexpected thin/overlapping surface"
    assert np.allclose(fields.sum(axis=(1, 2)), sums[:, 2], rtol=2e-12)
    assert np.all(sums[:, 2] <= sums[:, 1]) and np.all(sums[:, 1] <= sums[:, 0])
    pixel_area = ((BOUNDS["maxX"] - BOUNDS["minX"]) / WIDTH
                  * (BOUNDS["maxY"] - BOUNDS["minY"]) / HEIGHT)
    sample_area = WINDOW_WIDTH * (TOP - SILL) / total
    # Dividing by the flat aperture->floor Jacobian makes a clear, flat pane's
    # interior reference 1.0. Fresnel compensation lives in spectral weights.
    expected_flat_density = -DIRECTION[2] / DIRECTION[1]
    fields *= sample_area / pixel_area / expected_flat_density
    weights = spectral_rgb_weights()
    linear = np.einsum("khw,kc->hwc", fields, weights, optimize=True)
    linear = np.maximum(reconstruction_filter(linear), 0)
    assert np.all(np.isfinite(linear)) and np.max(linear) > 0
    energy = np.max(linear, axis=2)
    bright = energy[energy > 0.5]
    exposure = args.exposure if args.exposure is not None else 0.88 / float(np.percentile(bright, 99.8))
    alpha = np.clip(energy * exposure, 0, 1)
    color = np.divide(linear, energy[:, :, None], out=np.ones_like(linear), where=energy[:, :, None] > 1e-12)
    srgb = np.where(color <= 0.0031308, 12.92 * color, 1.055 * color ** (1 / 2.4) - 0.055)
    rgba = np.round(np.concatenate((np.clip(srgb, 0, 1), alpha[:, :, None]), axis=2) * 255).astype(np.uint8)
    assert np.count_nonzero(rgba[:, :, 3]) > WIDTH * HEIGHT * 0.1
    assert np.max(rgba[[0, -1], :, 3]) == 0 and np.max(rgba[:, [0, -1], 3]) == 0
    args.output_dir.mkdir(parents=True, exist_ok=True)
    png_rgba(image_path, rgba)
    if args.preview:
        # Diagnostic display only; uses this exact optical field, no second
        # renderer. A grey floor makes neutral light and its alpha inspectable.
        background = np.asarray((0.27, 0.25, 0.22))
        preview_rgb = srgb * alpha[:, :, None] + background * (1 - alpha[:, :, None])
        preview_rgba = np.round(np.concatenate((np.clip(preview_rgb, 0, 1),
                                               np.ones_like(alpha[:, :, None])), axis=2) * 255).astype(np.uint8)
        png_rgba(args.preview, preview_rgba)
    metadata = {
        "schemaVersion": 1,
        "image": f"/2d-textures/{args.name}.png",
        "width": WIDTH, "height": HEIGHT, "bounds": BOUNDS,
        "aperture": {"width": WINDOW_WIDTH, "bottom": SILL, "top": TOP,
                     "panes": PANE_COUNT, "horizontalBarHeight": CROSSBAR,
                     "outerFrameWidth": 0.025, "verticalBarWidth": 0.022,
                     "horizontalBarWidth": 0.026, "frameDepth": FRAME_DEPTH},
        "direction": dict(zip(("x", "y", "z"), DIRECTION.tolist())),
        "pathPosition": args.path_position,
        "coordinates": {"units": "meters", "x": "along window toward the right",
                        "y": "from window into room", "z": "up",
                        "windowPlane": "Y=0", "receiver": "Z=0",
                        "imageOrigin": "top-left = (minX, minY)",
                        "imageAxes": "+column = +X; +row = +Y",
                        "pixelMapping": "centers at min + (index+0.5)/dimension * span"},
        "transport": {"method": "deterministic forward spectral ray deposition",
                      "glassThicknessMeters": GLASS_THICKNESS,
                      "glassModel": "N-BK7 Sellmeier (clear crown glass proxy)",
                      "iorAt410nm": glass_ior(410), "iorAt710nm": glass_ior(710),
                      "interfaces": "two analytic, gently uneven surfaces; Newton intersection + vector Snell",
                      "surfaceModel": "shared Gaussian pane bow plus nonperiodic Gaussian thickness variation",
                      "frontCoefficients": FRONT.tolist(), "thicknessCoefficients": THICKNESS.tolist(),
                      "coefficientOrder": ["centerXWithinPane", "centerZ", "sigmaX", "sigmaZ", "amplitude"],
                      "reflection": "unpolarized dielectric Fresnel at both interfaces",
                      "sunAngularRadiusDegrees": 0.2665, "sunDisk": "uniform radiance",
                      "sourceSpectrumKelvin": 5778, "wavelengthsNm": WAVELENGTHS.tolist(),
                      "colorMatching": "Wyman/Sloan/Shirley CIE 1931 fits; XYZ to linear sRGB; neutral clear-pane white balance",
                      "seed": SEED, "apertureSamples": [nx, nz],
                      "raysTotal": total * len(WAVELENGTHS),
                      "deposition": "energy-conserving bilinear splat",
                      "reconstructionSigmaPixels": RECONSTRUCTION_SIGMA},
        "encoding": {"format": "8-bit sRGB straight-alpha RGBA PNG",
                     "rgb": "sRGB(linear energy / max linear energy); white in neutral illuminated regions",
                     "alpha": "clamp(max linear energy * exposure, 0, 1); zero outside transported footprint",
                     "normalization": "flat clear-pane floor irradiance = 1 before exposure",
                     "exposure": exposure,
                     "display": "project as an RGBA overlay on the floor; scale contribution with CSS opacity",
                     "padding": "fully transparent boundary pixels; transparent RGB is white"},
        "checks": {"allFinite": True, "conservativeDeposition": True,
                   "clearPaneMeanTransmission": float(np.mean(sums[:, 1] / sums[:, 0])),
                   "meanEnergyAfterFrame": float(np.mean(sums[:, 2] / total)),
                   "minimumMeasuredThicknessMeters": min_thickness,
                   "maximumRefractionAngleDegrees": math.degrees(max_angle),
                   "nonzeroAlphaPixels": int(np.count_nonzero(rgba[:, :, 3])),
                   "pngSha256": hashlib.sha256(image_path.read_bytes()).hexdigest()},
        "limits": [f"One authored {args.path_position * 24:05.2f}-hour source direction, not geographic solar ephemeris.",
                   "Direct illumination only: no room bounce, sky illumination, fabric, or object occlusion.",
                   "No multiple internal reflections, polarization state, or absorption tint.",
                   "Clear crown glass and small manufacturing-like relief are authored proxies, not measured glazing.",
                   "Finite sampled spectrum and photon reconstruction bound detail; RGB overlay is display art direction, not photometric radiance."],
        "references": ["https://www.schott.com/shop/advanced-optics/en/Optical-Glass/N-BK7/c/glass-N-BK7",
                       "https://jcgt.org/published/0002/02/01/"]
    }
    metadata["checks"]["bakeSeconds"] = round(time.monotonic() - started, 2)
    metadata["encoding"]["exposureSource"] = "explicit shared keyframe exposure" if args.exposure is not None else "99.8th percentile of this frame"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"image": str(image_path), "bounds": BOUNDS,
                      "checks": metadata["checks"], "seconds": round(time.monotonic() - started, 2)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "public/2d-textures")
    parser.add_argument("--aperture-samples", type=int, default=4096,
                        help="Horizontal aperture samples; vertical count derives from its physical aspect")
    parser.add_argument("--chunk-size", type=int, default=65536)
    parser.add_argument("--preview", type=Path, help="Optional diagnostic composite over a neutral grey floor")
    parser.add_argument("--name", default="room-sunlight-morning", help="Output basename, without extension")
    parser.add_argument("--direction", nargs=3, type=float, metavar=("X", "Y", "Z"),
                        help="Actual room resolver direction converted to X along window, Y into room, Z up")
    parser.add_argument("--path-position", type=float, default=0.375, help="Normalized authored time; midnight=0, noon=0.5")
    parser.add_argument("--exposure", type=float, help="Shared fixed exposure, avoiding independently normalized keyframe brightness")
    parser.add_argument("--overwrite", action="store_true", help="Explicitly replace an existing optical bake")
    arguments = parser.parse_args()
    if arguments.aperture_samples < 256 or arguments.chunk_size < 1024:
        parser.error("Use at least 256 aperture samples and a 1024 sample chunk")
    if not re.fullmatch(r"room-sunlight-[a-z0-9-]+", arguments.name):
        parser.error("Name must start with room-sunlight- and contain only lowercase letters, digits, and hyphens")
    if not math.isfinite(arguments.path_position) or not 0 <= arguments.path_position <= 1:
        parser.error("Path position must be a finite normalized time")
    if arguments.exposure is not None and (not math.isfinite(arguments.exposure) or arguments.exposure <= 0):
        parser.error("Exposure must be finite and positive")
    if arguments.direction is not None:
        vector = np.asarray(arguments.direction)
        if not np.all(np.isfinite(vector)) or np.linalg.norm(vector) == 0 or vector[1] <= 0 or vector[2] >= 0:
            parser.error("Direction must be finite, into the room (+Y), and downward (-Z)")
    run(arguments)
