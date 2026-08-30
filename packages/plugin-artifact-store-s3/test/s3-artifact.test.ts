import {
  artifactManifestObjectKey,
  artifactObjectKey,
  artifactRef,
  canonicalArtifactFiles,
} from "@prismengine/contracts-artifact";
import { systemCallContext } from "@prismengine/contracts-data";
import {
  S3ArtifactStore,
  readBoundedS3Body,
  type S3ArtifactClient,
} from "@prismengine/plugin-artifact-store-s3";
import { describe, expect, it } from "vitest";

class MemoryS3Client implements S3ArtifactClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly getRequests: { readonly key: string; readonly maxBytes: number }[] = [];
  versioning = "Enabled";
  objectLock = true;

  async headObject(input: { readonly key: string }): Promise<boolean> {
    return this.objects.has(input.key);
  }

  async putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
  }): Promise<"created" | "exists"> {
    if (this.objects.has(input.key)) return "exists";
    this.objects.set(input.key, Uint8Array.from(input.body));
    return "created";
  }

  async getObject(input: {
    readonly key: string;
    readonly maxBytes: number;
  }): Promise<Uint8Array> {
    this.getRequests.push({ key: input.key, maxBytes: input.maxBytes });
    const value = this.objects.get(input.key);
    if (value === undefined) throw new Error("NotFound");
    return readBoundedS3Body(value, { maxBytes: input.maxBytes });
  }

  async bucketVersioning(): Promise<string | undefined> {
    return this.versioning;
  }

  async objectLockEnabled(): Promise<boolean> {
    return this.objectLock;
  }
}

const context = systemCallContext({ correlationId: "s3-artifact-test" });

describe("S3 Artifact Store", () => {
  it("stores canonical immutable objects, verifies content, and probes Object Lock", async () => {
    const client = new MemoryS3Client();
    const store = new S3ArtifactStore({
      bucket: "artifacts",
      prefix: "hospital-a",
      retentionDays: 365,
      client,
    });
    const input = {
      contentType: "application/prism-test",
      files: [
        { path: "z.txt", content: new TextEncoder().encode("z") },
        { path: "a.txt", content: new TextEncoder().encode("a") },
      ],
    };
    const first = await store.putImmutable(context, input);
    const second = await store.putImmutable(context, {
      ...input,
      files: [...input.files].reverse(),
    });
    expect(second).toEqual(first);
    expect(await store.stat(context, first)).toMatchObject({
      hash: first.hash,
      size: 2,
      fileCount: 2,
      files: [
        { path: "a.txt", size: 1 },
        { path: "z.txt", size: 1 },
      ],
    });
    await expect(store.read(context, first, "a.txt")).resolves.toEqual(
      new TextEncoder().encode("a"),
    );
    await expect(store.verify(context, first)).resolves.toBe(true);
    await expect(store.productionReadiness(context)).resolves.toMatchObject({
      id: "artifact-store.production",
      passed: true,
      evidence: expect.stringContaining('"objectLock":true'),
    });

    const manifestKey = [...client.objects.keys()].find((key) =>
      key.endsWith("/manifest.json"),
    );
    if (manifestKey === undefined) throw new Error("Artifact manifest was not stored");
    expect(
      client.getRequests
        .filter((request) => request.key === manifestKey)
        .every((request) => request.maxBytes === 1_048_576),
    ).toBe(true);
    expect(
      client.getRequests
        .filter((request) => request.key.endsWith(".txt"))
        .every((request) => request.maxBytes === 1),
    ).toBe(true);
    const undeclaredKey = `${manifestKey.slice(0, -"manifest.json".length)}undeclared.txt`;
    client.objects.set(undeclaredKey, new TextEncoder().encode("secret"));
    await expect(store.verify(context, first)).resolves.toBe(true);
    await expect(store.read(context, first, "undeclared.txt")).rejects.toMatchObject({
      diagnostics: [{ code: "ARTIFACT_FILE_NOT_FOUND" }],
    });
    expect(client.getRequests.map((request) => request.key)).not.toContain(undeclaredKey);

    const fileKey = [...client.objects.keys()].find((key) => key.endsWith("/a.txt"));
    if (fileKey === undefined) throw new Error("Artifact file was not stored");
    client.objects.set(fileKey, new TextEncoder().encode("tampered"));
    await expect(store.read(context, first, "a.txt")).rejects.toMatchObject({
      diagnostics: [{ code: "ARTIFACT_OBJECT_SIZE_MISMATCH" }],
    });
    await expect(store.verify(context, first)).resolves.toBe(false);
  });

  it("refuses to publish a manifest over conflicting preexisting file bytes", async () => {
    const client = new MemoryS3Client();
    const prefix = "hospital-a";
    const input = {
      contentType: "application/prism-test",
      files: [
        { path: "a.txt", content: new TextEncoder().encode("expected-private-bytes") },
      ],
    };
    const ref = artifactRef(input.contentType, canonicalArtifactFiles(input));
    const fileKey = artifactObjectKey(ref.hash, "a.txt", prefix);
    const manifestKey = artifactManifestObjectKey(ref.hash, prefix);
    client.objects.set(fileKey, new TextEncoder().encode("attacker-private-bytes"));
    const store = new S3ArtifactStore({
      bucket: "artifacts",
      prefix,
      retentionDays: 365,
      client,
    });

    let failure: unknown;
    try {
      await store.putImmutable(context, input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      diagnostics: [
        {
          code: "ARTIFACT_IMMUTABLE_CONFLICT",
          details: { hash: ref.hash, path: "a.txt" },
        },
      ],
    });
    expect(JSON.stringify(failure)).not.toContain("attacker-private-bytes");
    expect(JSON.stringify(failure)).not.toContain("expected-private-bytes");
    expect(client.objects.has(manifestKey)).toBe(false);
  });

  it("publishes and verifies when preexisting file bytes are exact", async () => {
    const client = new MemoryS3Client();
    const prefix = "hospital-a";
    const input = {
      contentType: "application/prism-test",
      files: [{ path: "a.txt", content: new TextEncoder().encode("canonical") }],
    };
    const ref = artifactRef(input.contentType, canonicalArtifactFiles(input));
    const fileKey = artifactObjectKey(ref.hash, "a.txt", prefix);
    const manifestKey = artifactManifestObjectKey(ref.hash, prefix);
    client.objects.set(fileKey, Uint8Array.from(input.files[0]!.content));
    const store = new S3ArtifactStore({
      bucket: "artifacts",
      prefix,
      retentionDays: 365,
      client,
    });

    await expect(store.putImmutable(context, input)).resolves.toEqual(ref);
    expect(client.objects.has(manifestKey)).toBe(true);
    await expect(store.verify(context, ref)).resolves.toBe(true);
  });

  it("publishes no S3 object for a non-portable Artifact tree", async () => {
    const client = new MemoryS3Client();
    const store = new S3ArtifactStore({
      bucket: "artifacts",
      retentionDays: 365,
      client,
    });

    await expect(
      store.putImmutable(context, {
        contentType: "application/test",
        files: [{ path: "secret:stream", content: new Uint8Array() }],
      }),
    ).rejects.toThrow("ARTIFACT_PATH_INVALID");
    await expect(
      store.putImmutable(context, {
        contentType: "application/test",
        files: [
          { path: "A.txt", content: new Uint8Array() },
          { path: "a.txt", content: new Uint8Array() },
        ],
      }),
    ).rejects.toThrow("ARTIFACT_PATH_COLLISION");
    expect(client.objects.size).toBe(0);
  });

  it("bounds Web and Node-style S3 response streams before allocation", async () => {
    let readerAccessCount = 0;
    const untouchedBody = {
      getReader() {
        readerAccessCount += 1;
        throw new Error("declared oversized body must not be read");
      },
    };
    await expect(
      readBoundedS3Body(untouchedBody, {
        maxBytes: 8,
        declaredBytes: 9,
      }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "ARTIFACT_OBJECT_SIZE_MISMATCH" }],
    });
    expect(readerAccessCount).toBe(0);

    let cancelCount = 0;
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-overflow-object"));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const overflowFailure = await readBoundedS3Body(overflow, {
      maxBytes: 8,
    }).catch((error: unknown) => error);
    expect(overflowFailure).toMatchObject({
      diagnostics: [{ code: "ARTIFACT_OBJECT_SIZE_MISMATCH" }],
    });
    expect(JSON.stringify(overflowFailure)).not.toContain("private-overflow-object");
    expect(cancelCount).toBe(1);

    let destroyCount = 0;
    const nodeBody = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("private-node-overflow");
      },
      destroy() {
        destroyCount += 1;
      },
    };
    await expect(readBoundedS3Body(nodeBody, { maxBytes: 8 })).rejects.toMatchObject({
      diagnostics: [{ code: "ARTIFACT_OBJECT_SIZE_MISMATCH" }],
    });
    expect(destroyCount).toBe(1);

    const valid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("A"));
        controller.enqueue(new TextEncoder().encode("B"));
        controller.close();
      },
    });
    await expect(
      readBoundedS3Body(valid, { maxBytes: 2, declaredBytes: 2 }),
    ).resolves.toEqual(new TextEncoder().encode("AB"));
    await expect(
      readBoundedS3Body(new TextEncoder().encode("AB"), {
        maxBytes: 3,
        declaredBytes: 3,
      }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "ARTIFACT_OBJECT_SIZE_MISMATCH" }],
    });
  });

  it("fails readiness when bucket versioning or Object Lock is disabled", async () => {
    expect(
      () =>
        new S3ArtifactStore({
          bucket: "artifacts",
          retentionDays: 30,
          maxManifestBytes: 0,
          client: new MemoryS3Client(),
        }),
    ).toThrow("ARTIFACT_S3_CONFIGURATION_INVALID");
    const client = new MemoryS3Client();
    client.objectLock = false;
    const store = new S3ArtifactStore({
      bucket: "artifacts",
      retentionDays: 30,
      client,
    });
    await expect(store.productionReadiness(context)).resolves.toMatchObject({
      passed: false,
    });
  });
});
