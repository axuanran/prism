import { systemCallContext } from "@prismengine/contracts-data";
import type { StorageCapability } from "@prismengine/contracts-storage";
import {
  S3AuditExportCapability,
  readBoundedAuditBody,
  type AuditWormClient,
} from "@prismengine/plugin-audit-export-s3";
import { createMemoryStorage } from "@prismengine/plugin-storage-memory";
import { describe, expect, it } from "vitest";

class MemoryWormClient implements AuditWormClient {
  readonly objects = new Map<string, Uint8Array>();
  putCount = 0;
  getCount = 0;
  readonly getRequests: { readonly key: string; readonly maxBytes: number }[] = [];
  objectLock = true;

  async putImmutable(input: {
    readonly key: string;
    readonly body: Uint8Array;
  }): Promise<"created" | "exists"> {
    this.putCount += 1;
    if (this.objects.has(input.key)) return "exists";
    this.objects.set(input.key, Uint8Array.from(input.body));
    return "created";
  }

  async getObject(input: {
    readonly key: string;
    readonly maxBytes: number;
  }): Promise<Uint8Array> {
    this.getCount += 1;
    this.getRequests.push({ key: input.key, maxBytes: input.maxBytes });
    const value = this.objects.get(input.key);
    if (value === undefined) throw new Error("NotFound");
    return readBoundedAuditBody(value, { maxBytes: input.maxBytes });
  }

  async bucketVersioning(): Promise<string> {
    return "Enabled";
  }

  async objectLockEnabled(): Promise<boolean> {
    return this.objectLock;
  }
}

const context = {
  ...systemCallContext({ correlationId: "audit-export-s3-test" }),
  changeReason: "test export",
};

describe("S3 Object Lock audit export", () => {
  it("exports by hash-bound sequence idempotently and detects remote tampering", async () => {
    const storage = createMemoryStorage();
    await storage.resources.saveDraft(context, {
      kind: "audit.export.test",
      id: "one",
      name: "One",
      spec: { value: 1 },
      expectedUpdatedAt: null,
    });
    await storage.resources.saveDraft(context, {
      kind: "audit.export.test",
      id: "two",
      name: "Two",
      spec: { value: 2 },
      expectedUpdatedAt: null,
    });
    const client = new MemoryWormClient();
    const exporter = new S3AuditExportCapability(storage, {
      bucket: "audit",
      prefix: "hospital-a",
      retentionDays: 3650,
      client,
    });
    await expect(exporter.exportRange(context)).resolves.toEqual({
      exported: 2,
      verified: 2,
      lastSequence: 2,
    });
    await expect(exporter.exportRange(context)).resolves.toEqual({
      exported: 0,
      verified: 2,
      lastSequence: 2,
    });
    await expect(exporter.verifyRange(context)).resolves.toEqual({
      exported: 0,
      verified: 2,
      lastSequence: 2,
    });
    await expect(exporter.productionReadiness(context)).resolves.toMatchObject({
      id: "audit-worm-export",
      passed: true,
    });
    expect(
      client.getRequests.every(
        (request) => client.objects.get(request.key)?.byteLength === request.maxBytes,
      ),
    ).toBe(true);

    const firstKey = [...client.objects.keys()].sort()[0];
    if (firstKey === undefined) throw new Error("Audit record was not exported");
    client.objects.set(firstKey, new TextEncoder().encode("tampered"));
    await expect(exporter.verifyRange(context)).rejects.toThrow("AUDIT_EXPORT_MISMATCH");
  });

  it("rejects invalid ranges before source verification or remote I/O", async () => {
    const storage = createMemoryStorage();
    let listCount = 0;
    let verifyCount = 0;
    const countingStorage: StorageCapability = {
      resources: storage.resources,
      audit: {
        list: (call, query) => {
          listCount += 1;
          return storage.audit.list(call, query);
        },
        verify: (call) => {
          verifyCount += 1;
          return storage.audit.verify(call);
        },
      },
      productionReadiness: (call) => storage.productionReadiness(call),
      collection<TDocument extends { readonly id: string }>(name: string) {
        return storage.collection<TDocument>(name);
      },
    };
    const client = new MemoryWormClient();
    const exporter = new S3AuditExportCapability(countingStorage, {
      bucket: "audit",
      retentionDays: 3650,
      client,
    });
    const invalidRanges: readonly [number, number][] = [
      [-1, 1],
      [Number.NaN, 1],
      [0, 0],
      [0, 1.5],
      [0, 1_001],
    ];
    for (const [afterSequence, limit] of invalidRanges) {
      await expect(
        exporter.exportRange(context, afterSequence, limit),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "AUDIT_EXPORT_RANGE_INVALID" }],
      });
      await expect(
        exporter.verifyRange(context, afterSequence, limit),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "AUDIT_EXPORT_RANGE_INVALID" }],
      });
    }
    expect(verifyCount).toBe(0);
    expect(listCount).toBe(0);
    expect(client.putCount).toBe(0);
    expect(client.getCount).toBe(0);

    await expect(exporter.exportRange(context, 0, 1_000)).resolves.toEqual({
      exported: 0,
      verified: 0,
      lastSequence: 0,
    });
    await expect(exporter.verifyRange(context, 0, 1_000)).resolves.toEqual({
      exported: 0,
      verified: 0,
      lastSequence: 0,
    });
    expect(verifyCount).toBe(2);
    expect(listCount).toBe(2);
  });

  it("rejects a broken source chain before any immutable S3 operation", async () => {
    const storage = createMemoryStorage();
    await storage.resources.saveDraft(context, {
      kind: "audit.export.test",
      id: "broken",
      name: "Broken",
      spec: { value: 1 },
      expectedUpdatedAt: null,
    });
    const brokenStorage: StorageCapability = {
      resources: storage.resources,
      audit: {
        list: (call, query) => storage.audit.list(call, query),
        verify: async () => ({
          valid: false,
          checked: 1,
          brokenAtSequence: 1,
        }),
      },
      productionReadiness: (call) => storage.productionReadiness(call),
      collection<TDocument extends { readonly id: string }>(name: string) {
        return storage.collection<TDocument>(name);
      },
    };
    const client = new MemoryWormClient();
    const exporter = new S3AuditExportCapability(brokenStorage, {
      bucket: "audit",
      retentionDays: 3650,
      client,
    });

    await expect(exporter.exportRange(context)).rejects.toMatchObject({
      diagnostics: [
        {
          code: "AUDIT_EXPORT_SOURCE_INVALID",
          details: { checked: 1, brokenAtSequence: 1 },
        },
      ],
    });
    await expect(exporter.verifyRange(context)).rejects.toMatchObject({
      diagnostics: [{ code: "AUDIT_EXPORT_SOURCE_INVALID" }],
    });
    expect(client.putCount).toBe(0);
    expect(client.getCount).toBe(0);
    expect(client.objects.size).toBe(0);
  });

  it("bounds Web and Node-style WORM object streams before allocation", async () => {
    let readerAccessCount = 0;
    const untouchedBody = {
      getReader() {
        readerAccessCount += 1;
        throw new Error("declared oversized audit body must not be read");
      },
    };
    await expect(
      readBoundedAuditBody(untouchedBody, {
        maxBytes: 8,
        declaredBytes: 9,
      }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "AUDIT_EXPORT_OBJECT_SIZE_MISMATCH" }],
    });
    expect(readerAccessCount).toBe(0);

    let cancelCount = 0;
    const webBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-audit-overflow"));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const overflowFailure = await readBoundedAuditBody(webBody, {
      maxBytes: 8,
    }).catch((error: unknown) => error);
    expect(overflowFailure).toMatchObject({
      diagnostics: [{ code: "AUDIT_EXPORT_OBJECT_SIZE_MISMATCH" }],
    });
    expect(JSON.stringify(overflowFailure)).not.toContain("private-audit-overflow");
    expect(cancelCount).toBe(1);

    let destroyCount = 0;
    const nodeBody = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("private-node-audit-overflow");
      },
      destroy() {
        destroyCount += 1;
      },
    };
    await expect(readBoundedAuditBody(nodeBody, { maxBytes: 8 })).rejects.toMatchObject({
      diagnostics: [{ code: "AUDIT_EXPORT_OBJECT_SIZE_MISMATCH" }],
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
      readBoundedAuditBody(valid, { maxBytes: 2, declaredBytes: 2 }),
    ).resolves.toEqual(new TextEncoder().encode("AB"));
    await expect(
      readBoundedAuditBody(new TextEncoder().encode("AB"), {
        maxBytes: 3,
        declaredBytes: 3,
      }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "AUDIT_EXPORT_OBJECT_SIZE_MISMATCH" }],
    });
  });
});
