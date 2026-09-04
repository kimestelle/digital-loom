export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
  maxInflationRatio: number;
}

export const LOOM_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 512 * 1024 * 1024,
  maxEntries: 2_048,
  maxEntryBytes: 40 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxInflationRatio: 250,
};

interface LoadedZipEntry {
  dir: boolean;
  name: string;
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
}

export function assertArchiveInputSize(
  byteLength: number,
  limits: ArchiveLimits = LOOM_ARCHIVE_LIMITS,
): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error("loom archive is empty");
  }
  if (byteLength > limits.maxCompressedBytes) {
    throw new Error("loom archive exceeds the compressed-size limit");
  }
}

/**
 * JSZip reads central-directory sizes before inflating file contents. Inspect
 * those sizes first so a small, hostile zip cannot allocate unbounded memory.
 */
export function assertSafeArchiveContents(
  files: Record<string, LoadedZipEntry>,
  limits: ArchiveLimits = LOOM_ARCHIVE_LIMITS,
): void {
  const entries = Object.values(files).filter((entry) => !entry.dir);
  if (entries.length > limits.maxEntries) {
    throw new Error("loom archive contains too many files");
  }
  let total = 0;
  for (const entry of entries) {
    const compressed = entry._data?.compressedSize;
    const uncompressed = entry._data?.uncompressedSize;
    if (
      !Number.isSafeInteger(compressed) ||
      !Number.isSafeInteger(uncompressed) ||
      (compressed as number) < 0 ||
      (uncompressed as number) < 0
    ) {
      throw new Error(`loom archive has no trustworthy size for ${entry.name}`);
    }
    if ((uncompressed as number) > limits.maxEntryBytes) {
      throw new Error(`loom archive entry ${entry.name} exceeds the size limit`);
    }
    if (
      /(^|\/)manifest\.json$|(^|\/)material\.json$/.test(entry.name) &&
      (uncompressed as number) > limits.maxManifestBytes
    ) {
      throw new Error(`loom archive manifest ${entry.name} exceeds the size limit`);
    }
    if (
      (uncompressed as number) > 1024 * 1024 &&
      (uncompressed as number) /
        Math.max(1, compressed as number) >
        limits.maxInflationRatio
    ) {
      throw new Error(`loom archive entry ${entry.name} has an unsafe inflation ratio`);
    }
    total += uncompressed as number;
    if (total > limits.maxTotalBytes) {
      throw new Error("loom archive expands beyond the total-size limit");
    }
  }
}
