import { PrismError, systemCallContext } from "@prismengine/contracts-data";
import {
  ResourceEventType,
  StorageCapabilityToken,
  StorageDiagnosticCode,
} from "@prismengine/contracts-storage";
import type { StorageCapability } from "@prismengine/contracts-storage";
import { createEngine, definePlugin } from "@prismengine/kernel";
import { describeStorageContract } from "@prismengine/testing";
import { describe, expect, it } from "vitest";
import {
  createMemoryStorage,
  storageMemoryPlugin,
} from "@prismengine/plugin-storage-memory";

const context = systemCallContext({ correlationId: "storage-memory-test" });

describeStorageContract("memory", async () => {
  let failure:
    | { readonly point: "after-operation" | "before-commit" | "after-commit"; readonly operationIndex?: number }
    | undefined;
  const storage = createMemoryStorage(undefined, {
    hit(point) {
      if (
        failure !== undefined &&
        failure.point === point.point &&
        (failure.operationIndex === undefined ||
          ("operationIndex" in point && failure.operationIndex === point.operationIndex))
      ) {
        failure = undefined;
        throw new Error("Injected atomic write failure");
      }
    },
  });
  return {
    storage,
    atomicWrite: storage,
    injectAtomicFailure(point, operationIndex) {
      failure = {
        point,
        ...(operationIndex === undefined ? {} : { operationIndex }),
      };
    },
    async dispose() {},
  };
});

async function diagnosticCodes(operation: () => Promise<unknown>): Promise<readonly string[]> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof PrismError) return error.diagnostics.map((item) => item.code);
    throw error;
  }
  throw new Error("Expected operation to reject with PrismError");
}

describe("memory resource store", () => {
  it("publishes a draft and edits it as a new draft revision", async () => {
    const resources = createMemoryStorage().resources;
    const draft = await resources.saveDraft(context, {
      kind: "example.policy",
      name: "Example policy",
      spec: { pointValue: "10", nested: { coefficient: "1.2" } },
    });
    const published = await resources.publish<typeof draft.spec>(
      context,
      draft.kind,
      draft.id,
      draft.revision,
    );
    const edited = await resources.saveDraft(context, {
      kind: draft.kind,
      id: draft.id,
      name: "Example policy revised",
      spec: { pointValue: "11", nested: { coefficient: "1.1" } },
    });

    expect(draft.revision).toBe(1);
    expect(published.status).toBe("published");
    expect(edited).toMatchObject({ revision: 2, status: "draft" });
    expect(edited.createdAt > published.updatedAt).toBe(true);
    await expect(resources.getPublished(context, draft.kind, draft.id)).resolves.toMatchObject({
      revision: 1,
      status: "published",
      spec: { pointValue: "10" },
    });
    await expect(resources.get(context, draft.kind, draft.id)).resolves.toMatchObject({
      revision: 2,
      status: "draft",
      spec: { pointValue: "11" },
    });
  });

  it("updates an existing draft in place and bumps updatedAt", async () => {
    const resources = createMemoryStorage().resources;
    const first = await resources.saveDraft(context, {
      kind: "calculation.pipeline",
      name: "First name",
      spec: { version: 1 },
    });
    const updated = await resources.saveDraft(context, {
      kind: first.kind,
      id: first.id,
      name: "Updated name",
      spec: { version: 2 },
    });

    expect(updated.revision).toBe(1);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt > first.updatedAt).toBe(true);
    await expect(resources.listRevisions(context, first.kind, first.id)).resolves.toHaveLength(1);
  });

  it("rejects every direct published-revision mutation with the exact code", async () => {
    const resources = createMemoryStorage().resources;
    const draft = await resources.saveDraft(context, {
      kind: "performance.metric",
      name: "Workload",
      spec: { nested: { weight: "1" } },
    });
    const published = await resources.publish(context, draft.kind, draft.id, 1);

    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.spec)).toBe(true);
    expect(Object.isFrozen((published.spec as { nested: object }).nested)).toBe(true);
    expect(
      await diagnosticCodes(() => resources.publish(context, draft.kind, draft.id, 1)),
    ).toEqual([StorageDiagnosticCode.RESOURCE_PUBLISHED_IMMUTABLE]);
  });

  it("keeps an archived-then-revived definition frozen, so pinned runs stay honest", async () => {
    // The hole this closes: archive flipped a published revision to
    // "archived", and a general status setter could then flip it back to
    // "draft", after which saveDraft overwrote the exact revision a run had
    // pinned. Reviving must go through clone into a NEW revision.
    const resources = createMemoryStorage().resources;
    const draft = await resources.saveDraft(context, {
      kind: "example.policy",
      name: "Scheme",
      spec: { pointValue: "10" },
    });
    await resources.publish(context, draft.kind, draft.id, 1);
    await resources.archive(context, draft.kind, draft.id);

    // No back door exists on the contract at all.
    expect("setStatus" in resources).toBe(false);

    // Editing an archived resource in place is refused.
    expect(
      await diagnosticCodes(() =>
        resources.saveDraft(context, {
          kind: draft.kind,
          id: draft.id,
          name: "Scheme",
          spec: { pointValue: "999" },
        }),
      ),
    ).toEqual([StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED]);

    // The pinned revision still reads exactly as it was published.
    const pinned = await resources.get<{ pointValue: string }>(
      context,
      draft.kind,
      draft.id,
      1,
    );
    expect(pinned?.spec).toEqual({ pointValue: "10" });
  });

  it("clones a chosen revision and archives every revision", async () => {
    const resources = createMemoryStorage().resources;
    const draft = await resources.saveDraft(context, {
      kind: "example.policy",
      name: "Scheme",
      spec: { pointValue: "10" },
    });
    await resources.publish(context, draft.kind, draft.id, 1);
    const cloned = await resources.clone<{ pointValue: string }>(
      context,
      draft.kind,
      draft.id,
      1,
    );

    expect(cloned).toMatchObject({ revision: 2, status: "draft", spec: { pointValue: "10" } });
    await resources.archive(context, draft.kind, draft.id);
    const revisions = await resources.listRevisions(context, draft.kind, draft.id);
    expect(revisions.map((revision) => revision.status)).toEqual(["archived", "archived"]);
    await expect(resources.getPublished(context, draft.kind, draft.id)).resolves.toBeNull();
  });

  it("emits the scoped publish event when provided through the plugin", async () => {
    let storage: StorageCapability | undefined;
    const consumer = definePlugin({
      id: "storage-memory-test-consumer",
      version: "0.1.0",
      requires: { storage: StorageCapabilityToken },
      start(pluginContext) {
        storage = pluginContext.dependencies.storage;
      },
    });
    const engine = createEngine({ plugins: [consumer, storageMemoryPlugin] });
    const events: Array<{ type: string; source: string; correlationId?: string }> = [];
    engine.eventBus.subscribe(ResourceEventType.Published, (event) => {
      events.push({
        type: event.type,
        source: event.source,
        ...(event.correlationId === undefined
          ? {}
          : { correlationId: event.correlationId }),
      });
    });
    await engine.start();
    if (storage === undefined) throw new Error("Storage consumer did not start");

    const draft = await storage.resources.saveDraft(context, {
      kind: "example.policy",
      name: "Scheme",
      spec: {},
    });
    await storage.resources.publish(context, draft.kind, draft.id, draft.revision);

    expect(events).toEqual([
      {
        type: ResourceEventType.Published,
        source: "storage.memory",
        correlationId: context.correlationId,
      },
    ]);
  });
});

interface TestDocument {
  readonly id: string;
  readonly team: string;
  readonly score: number;
  readonly active: boolean;
}

describe("memory document collections", () => {
  it("isolates collections by name", async () => {
    const storage = createMemoryStorage();
    const people = storage.collection<TestDocument>("organization.people");
    const results = storage.collection<TestDocument>("performance.results");
    const document = { id: "same-id", team: "A", score: 10, active: true };

    await people.put(context, document);

    await expect(people.get(context, document.id)).resolves.toEqual(document);
    await expect(results.get(context, document.id)).resolves.toBeNull();
  });

  it("filters, orders, and pages documents", async () => {
    const collection = createMemoryStorage().collection<TestDocument>("test.documents");
    await collection.putMany(context, [
      { id: "a", team: "A", score: 10, active: true },
      { id: "b", team: "B", score: 40, active: true },
      { id: "c", team: "A", score: 20, active: false },
      { id: "d", team: "A", score: 30, active: true },
      { id: "e", team: "A", score: 40, active: true },
    ]);

    const page = await collection.find(context, {
      where: { team: "A", active: true },
      orderBy: [
        { field: "score", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
      offset: 1,
      limit: 2,
    });

    expect(page.map((document) => document.id)).toEqual(["d", "a"]);
    await expect(collection.count(context, { where: { team: "A" } })).resolves.toBe(4);
    await expect(collection.getMany(context, ["e", "missing", "a"])).resolves.toEqual([
      { id: "e", team: "A", score: 40, active: true },
      { id: "a", team: "A", score: 10, active: true },
    ]);
  });
});
