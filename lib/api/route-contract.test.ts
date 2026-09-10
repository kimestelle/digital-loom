import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fal/client", () => ({
  extractPatina: vi.fn(),
}));
vi.mock("@/lib/fal/cache", async () => import("../fal/cache"));
vi.mock("@/lib/core/mapAsset", async () => import("../core/mapAsset"));
vi.mock("@/lib/core/materialPackage", async () =>
  import("../core/materialPackage")
);

import { GET as getSampleFile } from "../../app/api/samples/[...path]/route";
import { GET as listSamples } from "../../app/api/samples/route";
import { POST as postPatina } from "../../app/api/patina/route";
import { extractPatina } from "@/lib/fal/client";

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const CACHE_HASH = "a".repeat(32);

interface SamplePayload {
  samples: Array<{
    label: string;
    prompt: string | null;
    hash: string;
    maps: Array<{ name: string; file: string; url: string }>;
  }>;
}

interface JsonError {
  error: string;
}

const mockedExtractPatina = vi.mocked(extractPatina);

function patinaRequest({
  bytes = PNG_BYTES,
  filename = "source.png",
  contentType = "image/png",
  prompt = "red silk",
  userKey,
}: {
  bytes?: Uint8Array<ArrayBuffer>;
  filename?: string;
  contentType?: string;
  prompt?: string;
  userKey?: string;
} = {}): Request {
  const form = new FormData();
  form.set("image", new File([bytes], filename, { type: contentType }));
  form.set("prompt", prompt);
  return new Request("http://localhost/api/patina", {
    method: "POST",
    body: form,
    headers: userKey ? { "x-fal-key": userKey } : undefined,
  });
}

describe("built-in sample and pre-generated material contracts", () => {
  it("lists real samples and serves the red-silk maps through confined URLs", async () => {
    const response = await listSamples();
    const payload = (await response.json()) as SamplePayload;
    const silk = payload.samples.find((sample) => sample.label === "red silk");

    expect(response.status).toBe(200);
    expect(silk).toBeDefined();
    expect(silk?.hash).toBe("71871d958aa681541baf9159cbf98bc4");
    expect(silk?.maps.map((map) => map.name)).toEqual([
      "albedo",
      "normal",
      "roughness",
      "height",
    ]);
    for (const map of silk?.maps ?? []) {
      expect(map.url).toBe(`/api/samples/red-silk/${map.file}`);
      const mapResponse = await getSampleFile(
        new Request(`http://localhost${map.url}`),
        { params: Promise.resolve({ path: ["red-silk", map.file] }) },
      );
      expect(mapResponse.status).toBe(200);
      expect(mapResponse.headers.get("content-type")).toBe("image/png");
      expect((await mapResponse.arrayBuffer()).byteLength).toBeGreaterThan(24);
    }
  });

  it("keeps the boot pregen manifest aligned with complete on-disk maps", async () => {
    const pregenRoot = path.join(
      process.cwd(),
      "public",
      "pregen",
      "silk-sample",
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(pregenRoot, "manifest.json"), "utf8"),
    ) as {
      hash: string;
      maps: Array<{ name: string; file: string }>;
    };

    expect(manifest.hash).toBe("71871d958aa681541baf9159cbf98bc4");
    expect(manifest.maps.map((map) => map.name)).toEqual([
      "albedo",
      "normal",
      "roughness",
      "height",
    ]);
    for (const map of manifest.maps) {
      const stat = await fs.stat(path.join(pregenRoot, map.file));
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(24);
    }
  });

  it("rejects sample traversal and reports missing files without reading outside samples", async () => {
    const traversal = await getSampleFile(new Request("http://localhost"), {
      params: Promise.resolve({ path: ["..", "package.json"] }),
    });
    const missing = await getSampleFile(new Request("http://localhost"), {
      params: Promise.resolve({ path: ["red-silk", "missing.png"] }),
    });

    expect(traversal.status).toBe(403);
    expect(await traversal.text()).toBe("forbidden");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("not found");
  });
});

describe("Patina route contract without a paid extraction", () => {
  beforeEach(() => mockedExtractPatina.mockReset());

  it("rejects malformed bodies, missing files, unsupported media, and long prompts", async () => {
    const malformed = await postPatina(
      new Request("http://localhost/api/patina", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const missingForm = new FormData();
    const missing = await postPatina(
      new Request("http://localhost/api/patina", {
        method: "POST",
        body: missingForm,
      }),
    );
    const unsupported = await postPatina(
      patinaRequest({ filename: "source.gif", contentType: "image/gif" }),
    );
    const longPrompt = await postPatina(
      patinaRequest({ prompt: "x".repeat(501) }),
    );

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "expected multipart form data",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing 'image' file field" });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toEqual({
      error: "image must be PNG, JPEG, or WebP",
    });
    expect(longPrompt.status).toBe(400);
    expect(await longPrompt.json()).toEqual({
      error: "prompt must be 500 characters or fewer",
    });
    expect(mockedExtractPatina).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "maps a successful extraction response when cacheHit=%s",
    async (cacheHit) => {
      mockedExtractPatina.mockResolvedValue({
        hash: CACHE_HASH,
        cacheHit,
        manifest: {
          endpoint: "fal-ai/patina/material/extract",
          hash: CACHE_HASH,
          createdAt: "2026-09-10T12:00:00.000Z",
          prompt: "red silk",
          sourceFilename: "source.png",
          maps: [{ name: "albedo", file: "albedo.png" }],
          rawResponsePath: "response.json",
        },
      });

      const response = await postPatina(patinaRequest({ userKey: "test-user-key" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        hash: CACHE_HASH,
        endpoint: "fal-ai/patina/material/extract",
        createdAt: "2026-09-10T12:00:00.000Z",
        cacheHit,
        maps: [
          {
            name: "albedo",
            file: "albedo.png",
            url: `/api/cache/${CACHE_HASH}/albedo.png`,
          },
        ],
      });
      expect(mockedExtractPatina).toHaveBeenCalledOnce();
      const [bytes, filename, contentType, prompt, userKey] =
        mockedExtractPatina.mock.calls[0];
      expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));
      expect({ filename, contentType, prompt, userKey }).toEqual({
        filename: "source.png",
        contentType: "image/png",
        prompt: "red silk",
        userKey: "test-user-key",
      });
    },
  );

  it("returns a bounded JSON failure when an extraction cannot be consumed", async () => {
    const failedExtraction = {
      get hash(): never {
        throw new Error("fal upstream unavailable");
      },
      manifest: {},
      cacheHit: false,
    };
    mockedExtractPatina.mockResolvedValue(failedExtraction as never);

    const response = await postPatina(patinaRequest());

    expect(response.status).toBe(500);
    expect((await response.json()) as JsonError).toEqual({
      error: "fal upstream unavailable",
    });
  });
});

describe("isolated cache import and retrieval contract", () => {
  let cacheRoot = "";
  let previousCacheRoot: string | undefined;
  let importMaps: typeof import("../../app/api/cache/import/route").POST;
  let getCachedFile: typeof import("../../app/api/cache/[hash]/[file]/route").GET;
  let listCache: typeof import("../../app/api/cache/route").GET;

  beforeAll(async () => {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loom-api-contract-"));
    previousCacheRoot = process.env.LOOM_CACHE_DIR;
    process.env.LOOM_CACHE_DIR = cacheRoot;
    ({ POST: importMaps } = await import("../../app/api/cache/import/route"));
    ({ GET: getCachedFile } = await import(
      "../../app/api/cache/[hash]/[file]/route"
    ));
    ({ GET: listCache } = await import("../../app/api/cache/route"));
  });

  afterAll(async () => {
    if (previousCacheRoot === undefined) delete process.env.LOOM_CACHE_DIR;
    else process.env.LOOM_CACHE_DIR = previousCacheRoot;
    if (cacheRoot.startsWith(`${os.tmpdir()}${path.sep}loom-api-contract-`)) {
      await fs.rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("round-trips an imported canonical map package without touching the real cache", async () => {
    const form = new FormData();
    form.set("hash", CACHE_HASH);
    form.set("prompt", "isolated silk");
    form.set("sourceFilename", "source.png");
    form.set(
      "albedo",
      new File([PNG_BYTES], "albedo.png", { type: "image/png" }),
    );

    const imported = await importMaps(
      new Request("http://localhost/api/cache/import", {
        method: "POST",
        body: form,
      }),
    );
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ ok: true, existed: false });

    const listed = await listCache();
    const listedPayload = (await listed.json()) as {
      entries: Array<{
        hash: string;
        prompt: string | null;
        sourceFilename: string | null;
        maps: Array<{ name: string; file: string; url: string }>;
      }>;
    };
    expect(listedPayload.entries).toHaveLength(1);
    expect(listedPayload.entries[0]).toMatchObject({
      hash: CACHE_HASH,
      prompt: "isolated silk",
      sourceFilename: "source.png",
      maps: [
        {
          name: "albedo",
          file: "albedo.png",
          url: `/api/cache/${CACHE_HASH}/albedo.png`,
        },
      ],
    });

    const retrieved = await getCachedFile(new Request("http://localhost"), {
      params: Promise.resolve({ hash: CACHE_HASH, file: "albedo.png" }),
    });
    expect(retrieved.status).toBe(200);
    expect(retrieved.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await retrieved.arrayBuffer()))).toEqual(
      Array.from(PNG_BYTES),
    );

    const idempotent = await importMaps(
      new Request("http://localhost/api/cache/import", {
        method: "POST",
        body: form,
      }),
    );
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toEqual({ ok: true, existed: true });
  });

  it("rejects cache traversal and returns 404 for a valid missing entry", async () => {
    const badHash = await getCachedFile(new Request("http://localhost"), {
      params: Promise.resolve({ hash: "../cache", file: "albedo.png" }),
    });
    const badFile = await getCachedFile(new Request("http://localhost"), {
      params: Promise.resolve({ hash: CACHE_HASH, file: "../manifest.json" }),
    });
    const missing = await getCachedFile(new Request("http://localhost"), {
      params: Promise.resolve({ hash: "f".repeat(32), file: "albedo.png" }),
    });

    expect(badHash.status).toBe(400);
    expect(await badHash.text()).toBe("bad path");
    expect(badFile.status).toBe(400);
    expect(await badFile.text()).toBe("bad path");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("not found");
  });
});
