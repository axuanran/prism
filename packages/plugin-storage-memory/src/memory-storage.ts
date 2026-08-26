import type { CallContext } from "@prism/contracts-data";
import { PrismError, assertJsonValue } from "@prism/contracts-data";
import type {
  DocumentCollection,
  DocumentQuery,
  ResourceStore,
  SaveDraftCommand,
  StorageCapability,
} from "@prism/contracts-storage";
import {
  ResourceEventType,
  StorageDiagnosticCode,
} from "@prism/contracts-storage";
import type {
  EventBus,
  Resource,
  ResourceQuery,
} from "@prism/kernel";

const NOOP_EVENTS: EventBus = {
  async publish(): Promise<void> {},
  subscribe: () => () => {},
};

function cloneValue<T>(value: T, seen = new Map<object, object>()): T {
  if (value === null || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneValue(item, seen));
    return copy as T;
  }

  const copy: object = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if ("value" in descriptor) descriptor.value = cloneValue(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy as T;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen);
  }
  return Object.freeze(value) as T;
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function storageError(
  code: (typeof StorageDiagnosticCode)[keyof typeof StorageDiagnosticCode],
  message: string,
  details: Readonly<Record<string, unknown>>,
): PrismError {
  return PrismError.of(code, message, details);
}

function resourceNotFound(kind: string, id: string): PrismError {
  return storageError(
    StorageDiagnosticCode.RESOURCE_NOT_FOUND,
    `Resource ${kind}/${id} was not found.`,
    { kind, id },
  );
}

function revisionNotFound(kind: string, id: string, revision: number): PrismError {
  return storageError(
    StorageDiagnosticCode.RESOURCE_REVISION_NOT_FOUND,
    `Resource ${kind}/${id} revision ${revision} was not found.`,
    { kind, id, revision },
  );
}

function publishedImmutable(kind: string, id: string, revision: number): PrismError {
  return storageError(
    StorageDiagnosticCode.RESOURCE_PUBLISHED_IMMUTABLE,
    `Published resource ${kind}/${id} revision ${revision} is immutable.`,
    { kind, id, revision },
  );
}

function latest(revisions: readonly Resource[]): Resource {
  return revisions[revisions.length - 1]!;
}

function nextTimestamp(previous?: string): string {
  const now = Date.now();
  if (previous === undefined) return new Date(now).toISOString();
  return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
}

class MemoryResourceStore implements ResourceStore {
  private readonly byKind = new Map<string, Map<string, Resource[]>>();

  constructor(private readonly events: EventBus) {}

  async get<TSpec>(
    _context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec> | null> {
    const revisions = this.revisionsFor(kind, id);
    if (revisions === undefined) return null;
    const resource =
      revision === undefined
        ? latest(revisions)
        : revisions.find((candidate) => candidate.revision === revision);
    return resource === undefined ? null : immutableCopy(resource as Resource<TSpec>);
  }

  async getPublished<TSpec>(
    _context: CallContext,
    kind: string,
    id: string,
  ): Promise<Resource<TSpec> | null> {
    const revisions = this.revisionsFor(kind, id);
    if (revisions === undefined) return null;
    const resource = revisions.findLast((candidate) => candidate.status === "published");
    return resource === undefined ? null : immutableCopy(resource as Resource<TSpec>);
  }

  async list(_context: CallContext, query: ResourceQuery): Promise<readonly Resource[]> {
    const matches: Resource[] = [];
    for (const [kind, resources] of this.byKind) {
      if (query.kind !== undefined && query.kind !== kind) continue;
      for (const revisions of resources.values()) {
        const resource = latest(revisions);
        if (query.status !== undefined && query.status !== resource.status) continue;
        if (
          query.nameContains !== undefined &&
          !resource.name.includes(query.nameContains)
        ) {
          continue;
        }
        matches.push(immutableCopy(resource));
      }
    }
    return matches;
  }

  async listRevisions(
    _context: CallContext,
    kind: string,
    id: string,
  ): Promise<readonly Resource[]> {
    return (this.revisionsFor(kind, id) ?? []).map((resource) => immutableCopy(resource));
  }

  async saveDraft<TSpec>(
    context: CallContext,
    command: SaveDraftCommand<TSpec>,
  ): Promise<Resource<TSpec>> {
    // The same JSON rule both providers enforce. Memory storage happily keeps
    // a Decimal or a Date alive by reference, which is exactly how a spec that
    // cannot survive a real database reached production once already.
    assertJsonValue(command.spec, "/spec");

    let resource: Resource<TSpec>;

    if (command.id === undefined || this.revisionsFor(command.kind, command.id) === undefined) {
      // PUT semantics: a caller-chosen id creates the resource when absent.
      // Scheme ids are business-meaningful and are referenced by a run's pin,
      // so the caller must be able to choose one.
      const now = nextTimestamp();
      const id = command.id ?? this.newId(command.kind);
      resource = {
        id,
        kind: command.kind,
        name: command.name,
        revision: 1,
        status: "draft",
        spec: immutableCopy(command.spec),
        createdAt: now,
        updatedAt: now,
      };
      this.resourcesFor(command.kind).set(id, [resource]);
    } else {
      const revisions = this.revisionsFor(command.kind, command.id);
      if (revisions === undefined) throw resourceNotFound(command.kind, command.id);
      const current = latest(revisions);

      if (current.status === "draft") {
        resource = {
          ...current,
          name: command.name,
          spec: immutableCopy(command.spec),
          updatedAt: nextTimestamp(current.updatedAt),
        } as Resource<TSpec>;
        revisions[revisions.length - 1] = resource;
      } else if (current.status === "published") {
        const now = nextTimestamp(current.updatedAt);
        resource = {
          id: current.id,
          kind: current.kind,
          name: command.name,
          revision: current.revision + 1,
          status: "draft",
          spec: immutableCopy(command.spec),
          createdAt: now,
          updatedAt: now,
        };
        revisions.push(resource);
      } else {
        throw storageError(
          StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
          `Archived resource ${command.kind}/${command.id} cannot be edited.`,
          { kind: command.kind, id: command.id },
        );
      }
    }

    const result = immutableCopy(resource);
    await this.events.publish(ResourceEventType.DraftSaved, result, {
      correlationId: context.correlationId,
    });
    return result;
  }

  async publish<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision: number,
  ): Promise<Resource<TSpec>> {
    const revisions = this.revisionsFor(kind, id);
    if (revisions === undefined) throw resourceNotFound(kind, id);
    const index = revisions.findIndex((candidate) => candidate.revision === revision);
    if (index < 0) throw revisionNotFound(kind, id, revision);
    const current = revisions[index];
    if (current === undefined) throw revisionNotFound(kind, id, revision);
    if (current.status !== "draft") throw publishedImmutable(kind, id, revision);

    const published: Resource = {
      ...current,
      status: "published",
      updatedAt: nextTimestamp(current.updatedAt),
    };
    revisions[index] = published;
    const result = immutableCopy(published as Resource<TSpec>);
    await this.events.publish(ResourceEventType.Published, result, {
      correlationId: context.correlationId,
    });
    return result;
  }

  async clone<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec>> {
    const revisions = this.revisionsFor(kind, id);
    if (revisions === undefined) throw resourceNotFound(kind, id);
    const source =
      revision === undefined
        ? latest(revisions)
        : revisions.find((candidate) => candidate.revision === revision);
    if (source === undefined) throw revisionNotFound(kind, id, revision ?? -1);

    const now = nextTimestamp(latest(revisions).updatedAt);
    const draft: Resource<TSpec> = {
      id: source.id,
      kind: source.kind,
      name: source.name,
      revision: latest(revisions).revision + 1,
      status: "draft",
      spec: immutableCopy(source.spec) as TSpec,
      createdAt: now,
      updatedAt: now,
    };
    revisions.push(draft);
    const result = immutableCopy(draft);
    await this.events.publish(ResourceEventType.DraftSaved, result, {
      correlationId: context.correlationId,
    });
    return result;
  }

  async archive(context: CallContext, kind: string, id: string): Promise<void> {
    const revisions = this.revisionsFor(kind, id);
    if (revisions === undefined) throw resourceNotFound(kind, id);
    const now = nextTimestamp(latest(revisions).updatedAt);
    for (let index = 0; index < revisions.length; index += 1) {
      const resource = revisions[index];
      if (resource !== undefined) {
        revisions[index] = { ...resource, status: "archived", updatedAt: now };
      }
    }
    await this.events.publish(
      ResourceEventType.Archived,
      immutableCopy({ kind, id }),
      { correlationId: context.correlationId },
    );
  }

  private resourcesFor(kind: string): Map<string, Resource[]> {
    let resources = this.byKind.get(kind);
    if (resources === undefined) {
      resources = new Map();
      this.byKind.set(kind, resources);
    }
    return resources;
  }

  private revisionsFor(kind: string, id: string): Resource[] | undefined {
    return this.byKind.get(kind)?.get(id);
  }

  private newId(kind: string): string {
    let id = crypto.randomUUID();
    while (this.revisionsFor(kind, id) !== undefined) id = crypto.randomUUID();
    return id;
  }
}

function fieldValue(document: object, field: string): unknown {
  return Reflect.get(document, field);
}

function matchesWhere(
  document: object,
  where: DocumentQuery["where"],
): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([field, expected]) =>
    Object.is(fieldValue(document, field), expected),
  );
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function naturalNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

class MemoryDocumentCollection<TDocument extends { readonly id: string }>
  implements DocumentCollection<TDocument>
{
  private readonly documents = new Map<string, TDocument>();

  async get(_context: CallContext, id: string): Promise<TDocument | null> {
    const document = this.documents.get(id);
    return document === undefined ? null : immutableCopy(document);
  }

  async getMany(
    _context: CallContext,
    ids: readonly string[],
  ): Promise<readonly TDocument[]> {
    const documents: TDocument[] = [];
    for (const id of ids) {
      const document = this.documents.get(id);
      if (document !== undefined) documents.push(immutableCopy(document));
    }
    return documents;
  }

  async find(
    _context: CallContext,
    query: DocumentQuery = {},
  ): Promise<readonly TDocument[]> {
    const documents = [...this.documents.values()].filter((document) =>
      matchesWhere(document, query.where),
    );
    if (query.orderBy !== undefined) {
      documents.sort((left, right) => {
        for (const order of query.orderBy ?? []) {
          const comparison = compareValues(
            fieldValue(left, order.field),
            fieldValue(right, order.field),
          );
          if (comparison !== 0) return order.direction === "asc" ? comparison : -comparison;
        }
        return 0;
      });
    }
    const offset = naturalNumber(query.offset, 0);
    const limit = naturalNumber(query.limit, Number.POSITIVE_INFINITY);
    return documents.slice(offset, offset + limit).map((document) => immutableCopy(document));
  }

  async put(_context: CallContext, document: TDocument): Promise<TDocument> {
    assertJsonValue(document, "/document");
    const stored = immutableCopy(document);
    this.documents.set(document.id, stored);
    return immutableCopy(stored);
  }

  async putMany(
    _context: CallContext,
    documents: readonly TDocument[],
  ): Promise<void> {
    // Validate everything before storing anything: a half-written batch is
    // harder to reason about than a rejected one.
    documents.forEach((document, index) => assertJsonValue(document, `/documents/${index}`));
    const stored = documents.map((document) => immutableCopy(document));
    for (const document of stored) this.documents.set(document.id, document);
  }

  async delete(_context: CallContext, id: string): Promise<void> {
    this.documents.delete(id);
  }

  async count(_context: CallContext, query: DocumentQuery = {}): Promise<number> {
    let count = 0;
    for (const document of this.documents.values()) {
      if (matchesWhere(document, query.where)) count += 1;
    }
    return count;
  }
}

export class MemoryStorage implements StorageCapability {
  readonly resources: ResourceStore;
  private readonly collections = new Map<
    string,
    MemoryDocumentCollection<{ readonly id: string }>
  >();

  constructor(events: EventBus = NOOP_EVENTS) {
    this.resources = new MemoryResourceStore(events);
  }

  collection<TDocument extends { readonly id: string }>(
    name: string,
  ): DocumentCollection<TDocument> {
    let collection = this.collections.get(name);
    if (collection === undefined) {
      collection = new MemoryDocumentCollection();
      this.collections.set(name, collection);
    }
    // The collection name is the runtime type boundary; repeated callers own its document type.
    const typedCollection = collection as unknown as DocumentCollection<TDocument>;
    return typedCollection;
  }
}

export function createMemoryStorage(events?: EventBus): MemoryStorage {
  return new MemoryStorage(events);
}
