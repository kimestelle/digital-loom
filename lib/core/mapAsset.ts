/** Byte-level identity carried by persisted and exported map images. */
export interface MapAssetMetadata {
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_IMAGE_DIMENSION = 262_144;
const MAX_IMAGE_PIXELS = 268_435_456;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return null;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (JPEG_SOF.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") {
    return {
      width: uint24le(bytes, 24) + 1,
      height: uint24le(bytes, 27) + 1,
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      height:
        1 +
        ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    };
  }
  if (
    kind === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  return null;
}

function readCString(bytes: Uint8Array, start: number): [string, number] | null {
  const end = bytes.indexOf(0, start);
  if (end < 0) return null;
  return [ascii(bytes, start, end - start), end + 1];
}

function exrDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x76 ||
    bytes[1] !== 0x2f ||
    bytes[2] !== 0x31 ||
    bytes[3] !== 0x01
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    const nameResult = readCString(bytes, offset);
    if (!nameResult) return null;
    const [name, afterName] = nameResult;
    if (!name) return null;
    const typeResult = readCString(bytes, afterName);
    if (!typeResult) return null;
    const [type, afterType] = typeResult;
    if (afterType + 4 > bytes.length) return null;
    const size = view.getUint32(afterType, true);
    const dataOffset = afterType + 4;
    if (dataOffset + size > bytes.length) return null;
    if (name === "dataWindow" && type === "box2i" && size >= 16) {
      const minX = view.getInt32(dataOffset, true);
      const minY = view.getInt32(dataOffset + 4, true);
      const maxX = view.getInt32(dataOffset + 8, true);
      const maxY = view.getInt32(dataOffset + 12, true);
      return { width: maxX - minX + 1, height: maxY - minY + 1 };
    }
    offset = dataOffset + size;
  }
  return null;
}

export function imageDimensions(bytes: ArrayBuffer): { width: number; height: number } | null {
  const view = new Uint8Array(bytes);
  return (
    pngDimensions(view) ??
    jpegDimensions(view) ??
    webpDimensions(view) ??
    exrDimensions(view)
  );
}

export function validateMapAssetMetadata(
  value: unknown,
  label = "map asset",
): MapAssetMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} metadata must be an object`);
  }
  const raw = value as Partial<Record<keyof MapAssetMetadata, unknown>>;
  const allowed = new Set(["sha256", "byteLength", "width", "height"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}`);
  }
  if (typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) {
    throw new Error(`${label} sha256 must be 64 lowercase hex characters`);
  }
  for (const key of ["byteLength", "width", "height"] as const) {
    const number = raw[key];
    if (!Number.isSafeInteger(number) || (number as number) <= 0) {
      throw new Error(`${label} ${key} must be a positive integer`);
    }
  }
  if (
    (raw.width as number) > MAX_IMAGE_DIMENSION ||
    (raw.height as number) > MAX_IMAGE_DIMENSION ||
    (raw.width as number) * (raw.height as number) > MAX_IMAGE_PIXELS
  ) {
    throw new Error(`${label} dimensions exceed the supported limit`);
  }
  return {
    sha256: raw.sha256,
    byteLength: raw.byteLength as number,
    width: raw.width as number,
    height: raw.height as number,
  };
}

export async function inspectMapAsset(bytes: ArrayBuffer): Promise<MapAssetMetadata> {
  if (bytes.byteLength === 0) throw new Error("map asset is empty");
  const dimensions = imageDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error("map asset has no readable image dimensions");
  }
  const bounded = validateMapAssetMetadata(
    {
      sha256: await sha256Hex(bytes),
      byteLength: bytes.byteLength,
      ...dimensions,
    },
  );
  return bounded;
}

export async function verifyMapAsset(
  bytes: ArrayBuffer,
  expected: MapAssetMetadata,
  label = "map asset",
): Promise<MapAssetMetadata> {
  const metadata = validateMapAssetMetadata(expected, label);
  if (bytes.byteLength !== metadata.byteLength) {
    throw new Error(
      `${label} byte length mismatch: expected ${metadata.byteLength}, found ${bytes.byteLength}`,
    );
  }
  const dimensions = imageDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width !== metadata.width ||
    dimensions.height !== metadata.height
  ) {
    throw new Error(
      `${label} dimensions mismatch: expected ${metadata.width}×${metadata.height}`,
    );
  }
  const digest = await sha256Hex(bytes);
  if (digest !== metadata.sha256) {
    throw new Error(`${label} sha256 mismatch`);
  }
  return metadata;
}

/** Package identity depends only on the complete, named byte set. */
export async function mapPackageSha256(
  bytesByFile: Map<string, ArrayBuffer>,
): Promise<string> {
  if (bytesByFile.size === 0) throw new Error("map package has no bytes");
  const parts = await Promise.all(
    [...bytesByFile]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([file, bytes]) => `${file}:${await sha256Hex(bytes)}`),
  );
  return sha256Hex(
    new TextEncoder().encode(`loom-map-package/1\n${parts.join("\n")}`).buffer,
  );
}
