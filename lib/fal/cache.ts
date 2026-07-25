import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Extraction cache root. On Vercel (and any serverless host) the repo tree
// is read-only — only /tmp is writable — so the cache lives there:
// functional within an instance's lifetime, ephemeral across cold starts.
// The collection-zip export/import is the durable path for user materials.
export const CACHE_ROOT = process.env.LOOM_CACHE_DIR
  ? path.resolve(process.env.LOOM_CACHE_DIR)
  : process.env.VERCEL
    ? "/tmp/loom-cache"
    : path.resolve(process.cwd(), "cache");

export interface CachedMap {
  name: string;
  file: string;
}

export interface Manifest {
  endpoint: string;
  hash: string;
  createdAt: string;
  prompt?: string;
  sourceFilename?: string;
  maps: CachedMap[];
  rawResponsePath: string;
}

export function hashBytes(bytes: Uint8Array, salt: string): string {
  const h = createHash("sha256");
  h.update(salt);
  h.update(bytes);
  return h.digest("hex").slice(0, 32);
}

export function cacheDir(hash: string): string {
  return path.join(CACHE_ROOT, hash);
}

export async function readManifest(hash: string): Promise<Manifest | null> {
  const dir = cacheDir(hash);
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

export async function ensureCacheDir(hash: string): Promise<string> {
  const dir = cacheDir(hash);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeManifest(m: Manifest): Promise<void> {
  const dir = await ensureCacheDir(m.hash);
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(m, null, 2),
    "utf8",
  );
}

export async function writeBinary(
  hash: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = await ensureCacheDir(hash);
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, bytes);
  return abs;
}

export async function writeText(
  hash: string,
  filename: string,
  text: string,
): Promise<string> {
  const dir = await ensureCacheDir(hash);
  const abs = path.join(dir, filename);
  await fs.writeFile(abs, text, "utf8");
  return abs;
}

export async function readCachedFile(
  hash: string,
  filename: string,
): Promise<Uint8Array | null> {
  const abs = path.join(cacheDir(hash), filename);
  const rel = path.relative(cacheDir(hash), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** Remove a cached extraction (its whole directory). Only accepts names
 *  that look like our hex hashes so a bad hash can't escape CACHE_ROOT. */
export async function deleteCacheEntry(hash: string): Promise<boolean> {
  if (!/^[a-f0-9]{8,64}$/.test(hash)) return false;
  const dir = cacheDir(hash);
  // Belt-and-braces: resolved dir must stay inside the cache root.
  if (!dir.startsWith(CACHE_ROOT + path.sep)) return false;
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

export async function listCacheEntries(): Promise<Manifest[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(CACHE_ROOT);
  } catch {
    return [];
  }
  const entries: Manifest[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const m = await readManifest(name);
    if (m) entries.push(m);
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return entries;
}
