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
import type { EventBus, Resource, ResourceQuery } from "@prism/kernel";
import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { PostgresDatabase, ResourceRevisionTable } from "./database.js";

const NOOP_EVENTS: EventBus = {
  async publish(): Promise<void> {},
  subscribe: () => () => {},
};

type DatabaseExecutor = Kysely<PostgresDatabase> | Transaction<PostgresDatabase>;
type RevisionRow = Selectable<ResourceRevisionTable>;

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

function nextTimestamp(previous?: Date | string): Date {
  const now = Date.now();
  if (previous === undefined) return new Date(now);
  const prior = previous instanceof Date ? previous.getTime() : Date.parse(previous);
  return new Date(Math.max(now, prior + 1));
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function freezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else {
    for (const item of Object.values(value)) freezeJson(item);
  }
  return Object.freeze(value);
}

function mapResource<TSpec>(row: RevisionRow): Resource<TSpec> {
  assertJsonValue(row.spec, "/spec");
  const spec = freezeJson(row.spec) as TSpec;
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    name: row.name,
    revision: row.revision,
    status: row.status,
    spec,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  });
}

function naturalNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function jsonDocument<TDocument extends { readonly id: string }>(
  value: unknown,
): TDocument {
  assertJsonValue(value, "/document");
  return freezeJson(value) as unknown as TDocument;
}

async function guarded<T>(operation: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PrismError) throw error;
    throw storageError(
      StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
      `PostgreSQL storage could not ${operation}.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

class PostgresResourceStore implements ResourceStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly schema: string,
    private readonly events: EventBus,
  ) {}

  async get<TSpec>(
    _context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec> | null> {
    return guarded("load a resource", async () => {
      let query = this.db
        .withSchema(this.schema)
        .selectFrom("resource_revision as revision")
        .innerJoin("resource as logical", (join) =>
          join
            .onRef("logical.kind", "=", "revision.kind")
            .onRef("logical.id", "=", "revision.id"),
        )
        .selectAll("revision")
        .where("revision.kind", "=", kind)
        .where("revision.id", "=", id);
      query =
        revision === undefined
          ? query.whereRef("revision.revision", "=", "logical.current_revision")
          : query.where("revision.revision", "=", revision);
      const row = await query.executeTakeFirst();
      return row === undefined ? null : mapResource<TSpec>(row);
    });
  }

  async getPublished<TSpec>(
    _context: CallContext,
    kind: string,
    id: string,
  ): Promise<Resource<TSpec> | null> {
    return guarded("load a published resource", async () => {
      const row = await this.db
        .withSchema(this.schema)
        .selectFrom("resource_revision")
        .selectAll()
        .where("kind", "=", kind)
        .where("id", "=", id)
        .where("status", "=", "published")
        .orderBy("revision", "desc")
        .executeTakeFirst();
      return row === undefined ? null : mapResource<TSpec>(row);
    });
  }

  async list(
    _context: CallContext,
    query: ResourceQuery,
  ): Promise<readonly Resource[]> {
    return guarded("list resources", async () => {
      let statement = this.db
        .withSchema(this.schema)
        .selectFrom("resource_revision as revision")
        .innerJoin("resource as logical", (join) =>
          join
            .onRef("logical.kind", "=", "revision.kind")
            .onRef("logical.id", "=", "revision.id")
            .onRef("logical.current_revision", "=", "revision.revision"),
        )
        .selectAll("revision");
      if (query.kind !== undefined) statement = statement.where("revision.kind", "=", query.kind);
      if (query.status !== undefined) {
        statement = statement.where("revision.status", "=", query.status);
      }
      if (query.nameContains !== undefined) {
        statement = statement.where(
          sql<boolean>`position(${query.nameContains} in ${sql.ref("revision.name")}) > 0`,
        );
      }
      const rows = await statement.execute();
      return rows.map((row) => mapResource(row));
    });
  }

  async listRevisions(
    _context: CallContext,
    kind: string,
    id: string,
  ): Promise<readonly Resource[]> {
    return guarded("list resource revisions", async () => {
      const rows = await this.db
        .withSchema(this.schema)
        .selectFrom("resource_revision")
        .selectAll()
        .where("kind", "=", kind)
        .where("id", "=", id)
        .orderBy("revision", "asc")
        .execute();
      return rows.map((row) => mapResource(row));
    });
  }

  async saveDraft<TSpec>(
    context: CallContext,
    command: SaveDraftCommand<TSpec>,
  ): Promise<Resource<TSpec>> {
    assertJsonValue(command.spec, "/spec");
    const resource = await guarded("save a draft", () =>
      this.db.transaction().execute(async (transaction) => {
        const database = transaction.withSchema(this.schema);
        const id = command.id ?? crypto.randomUUID();
        const logical = await database
          .selectFrom("resource")
          .selectAll()
          .where("kind", "=", command.kind)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();

        if (logical === undefined) {
          const now = nextTimestamp();
          await database
            .insertInto("resource")
            .values({
              kind: command.kind,
              id,
              current_revision: 1,
              created_at: now,
              updated_at: now,
            })
            .execute();
          const row = await database
            .insertInto("resource_revision")
            .values({
              kind: command.kind,
              id,
              revision: 1,
              status: "draft",
              name: command.name,
              spec: command.spec,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return mapResource<TSpec>(row);
        }

        const current = await this.revision(
          transaction,
          command.kind,
          id,
          logical.current_revision,
        );
        if (current.status === "archived") {
          throw storageError(
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            `Archived resource ${command.kind}/${id} cannot be edited.`,
            { kind: command.kind, id },
          );
        }

        const now = nextTimestamp(current.updated_at);
        let row: RevisionRow;
        if (current.status === "draft") {
          row = await database
            .updateTable("resource_revision")
            .set({ name: command.name, spec: command.spec, updated_at: now })
            .where("kind", "=", command.kind)
            .where("id", "=", id)
            .where("revision", "=", current.revision)
            .returningAll()
            .executeTakeFirstOrThrow();
        } else {
          const revision = current.revision + 1;
          row = await database
            .insertInto("resource_revision")
            .values({
              kind: command.kind,
              id,
              revision,
              status: "draft",
              name: command.name,
              spec: command.spec,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await database
            .updateTable("resource")
            .set({ current_revision: revision, updated_at: now })
            .where("kind", "=", command.kind)
            .where("id", "=", id)
            .execute();
        }
        if (current.status === "draft") {
          await database
            .updateTable("resource")
            .set({ updated_at: now })
            .where("kind", "=", command.kind)
            .where("id", "=", id)
            .execute();
        }
        return mapResource<TSpec>(row);
      }),
    );
    await this.events.publish(ResourceEventType.DraftSaved, resource, {
      correlationId: context.correlationId,
    });
    return resource;
  }

  async publish<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision: number,
  ): Promise<Resource<TSpec>> {
    const resource = await guarded("publish a resource", () =>
      this.db.transaction().execute(async (transaction) => {
        const database = transaction.withSchema(this.schema);
        const logical = await database
          .selectFrom("resource")
          .selectAll()
          .where("kind", "=", kind)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (logical === undefined) throw resourceNotFound(kind, id);
        const current = await this.revision(transaction, kind, id, revision);
        if (current.status !== "draft") throw publishedImmutable(kind, id, revision);
        const now = nextTimestamp(current.updated_at);
        const row = await database
          .updateTable("resource_revision")
          .set({ status: "published", updated_at: now })
          .where("kind", "=", kind)
          .where("id", "=", id)
          .where("revision", "=", revision)
          .returningAll()
          .executeTakeFirstOrThrow();
        await database
          .updateTable("resource")
          .set({ updated_at: now })
          .where("kind", "=", kind)
          .where("id", "=", id)
          .execute();
        return mapResource<TSpec>(row);
      }),
    );
    await this.events.publish(ResourceEventType.Published, resource, {
      correlationId: context.correlationId,
    });
    return resource;
  }

  async clone<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec>> {
    const resource = await guarded("clone a resource", () =>
      this.db.transaction().execute(async (transaction) => {
        const database = transaction.withSchema(this.schema);
        const logical = await database
          .selectFrom("resource")
          .selectAll()
          .where("kind", "=", kind)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (logical === undefined) throw resourceNotFound(kind, id);
        const sourceRevision = revision ?? logical.current_revision;
        const source = await this.revision(transaction, kind, id, sourceRevision);
        assertJsonValue(source.spec, "/spec");
        const latest = await this.revision(
          transaction,
          kind,
          id,
          logical.current_revision,
        );
        const nextRevision = logical.current_revision + 1;
        const now = nextTimestamp(latest.updated_at);
        const row = await database
          .insertInto("resource_revision")
          .values({
            kind,
            id,
            revision: nextRevision,
            status: "draft",
            name: source.name,
            spec: source.spec,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await database
          .updateTable("resource")
          .set({ current_revision: nextRevision, updated_at: now })
          .where("kind", "=", kind)
          .where("id", "=", id)
          .execute();
        return mapResource<TSpec>(row);
      }),
    );
    await this.events.publish(ResourceEventType.DraftSaved, resource, {
      correlationId: context.correlationId,
    });
    return resource;
  }

  async archive(context: CallContext, kind: string, id: string): Promise<void> {
    await guarded("archive a resource", () =>
      this.db.transaction().execute(async (transaction) => {
        const database = transaction.withSchema(this.schema);
        const logical = await database
          .selectFrom("resource")
          .selectAll()
          .where("kind", "=", kind)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (logical === undefined) throw resourceNotFound(kind, id);
        const latest = await this.revision(
          transaction,
          kind,
          id,
          logical.current_revision,
        );
        const now = nextTimestamp(latest.updated_at);
        await database
          .updateTable("resource_revision")
          .set({ status: "archived", updated_at: now })
          .where("kind", "=", kind)
          .where("id", "=", id)
          .execute();
        await database
          .updateTable("resource")
          .set({ updated_at: now })
          .where("kind", "=", kind)
          .where("id", "=", id)
          .execute();
      }),
    );
    await this.events.publish(ResourceEventType.Archived, Object.freeze({ kind, id }), {
      correlationId: context.correlationId,
    });
  }

  private async revision(
    db: DatabaseExecutor,
    kind: string,
    id: string,
    revision: number,
  ): Promise<RevisionRow> {
    const row = await db
      .withSchema(this.schema)
      .selectFrom("resource_revision")
      .selectAll()
      .where("kind", "=", kind)
      .where("id", "=", id)
      .where("revision", "=", revision)
      .executeTakeFirst();
    if (row === undefined) throw revisionNotFound(kind, id, revision);
    return row;
  }
}

class PostgresDocumentCollection<TDocument extends { readonly id: string }>
  implements DocumentCollection<TDocument>
{
  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly schema: string,
    private readonly collection: string,
  ) {}

  async get(_context: CallContext, id: string): Promise<TDocument | null> {
    return guarded("load a document", async () => {
      const row = await this.db
        .withSchema(this.schema)
        .selectFrom("document")
        .select("body")
        .where("collection", "=", this.collection)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : jsonDocument<TDocument>(row.body);
    });
  }

  async getMany(
    _context: CallContext,
    ids: readonly string[],
  ): Promise<readonly TDocument[]> {
    if (ids.length === 0) return [];
    return guarded("load documents", async () => {
      const rows = await this.db
        .withSchema(this.schema)
        .selectFrom("document")
        .select(["id", "body"])
        .where("collection", "=", this.collection)
        .where("id", "in", ids)
        .execute();
      const byId = new Map(rows.map((row) => [row.id, row.body]));
      const documents: TDocument[] = [];
      for (const id of ids) {
        const body = byId.get(id);
        if (body !== undefined) documents.push(jsonDocument<TDocument>(body));
      }
      return documents;
    });
  }

  async find(
    _context: CallContext,
    query: DocumentQuery = {},
  ): Promise<readonly TDocument[]> {
    return guarded("find documents", async () => {
      let statement = this.db
        .withSchema(this.schema)
        .selectFrom("document")
        .select("body")
        .where("collection", "=", this.collection);
      for (const [field, expected] of Object.entries(query.where ?? {})) {
        statement = statement.where(
          sql<boolean>`${sql.ref("body")} -> ${field} = ${JSON.stringify(expected)}::jsonb`,
        );
      }
      for (const order of query.orderBy ?? []) {
        statement = statement.orderBy(
          sql`${sql.ref("body")} -> ${order.field}`,
          order.direction,
        );
      }
      const offset = naturalNumber(query.offset, 0);
      const limit = naturalNumber(query.limit, Number.POSITIVE_INFINITY);
      if (offset > 0) statement = statement.offset(offset);
      if (Number.isFinite(limit)) statement = statement.limit(limit);
      const rows = await statement.execute();
      return rows.map((row) => jsonDocument<TDocument>(row.body));
    });
  }

  async put(_context: CallContext, document: TDocument): Promise<TDocument> {
    assertJsonValue(document, "/document");
    return guarded("store a document", async () => {
      const now = new Date();
      const row = await this.db
        .withSchema(this.schema)
        .insertInto("document")
        .values({
          collection: this.collection,
          id: document.id,
          body: document,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["collection", "id"]).doUpdateSet({
            body: document,
            updated_at: now,
          }),
        )
        .returning("body")
        .executeTakeFirstOrThrow();
      return jsonDocument<TDocument>(row.body);
    });
  }

  async putMany(
    _context: CallContext,
    documents: readonly TDocument[],
  ): Promise<void> {
    documents.forEach((document, index) =>
      assertJsonValue(document, `/documents/${index}`),
    );
    if (documents.length === 0) return;
    await guarded("store documents", () =>
      this.db.transaction().execute(async (transaction) => {
        const now = new Date();
        await transaction
          .withSchema(this.schema)
          .insertInto("document")
          .values(
            documents.map((document) => ({
              collection: this.collection,
              id: document.id,
              body: document,
              created_at: now,
              updated_at: now,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["collection", "id"]).doUpdateSet((updates) => ({
              body: updates.ref("excluded.body"),
              updated_at: updates.ref("excluded.updated_at"),
            })),
          )
          .execute();
      }),
    );
  }

  async delete(_context: CallContext, id: string): Promise<void> {
    await guarded("delete a document", async () => {
      await this.db
        .withSchema(this.schema)
        .deleteFrom("document")
        .where("collection", "=", this.collection)
        .where("id", "=", id)
        .execute();
    });
  }

  async count(_context: CallContext, query: DocumentQuery = {}): Promise<number> {
    return guarded("count documents", async () => {
      let statement = this.db
        .withSchema(this.schema)
        .selectFrom("document")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("collection", "=", this.collection);
      for (const [field, expected] of Object.entries(query.where ?? {})) {
        statement = statement.where(
          sql<boolean>`${sql.ref("body")} -> ${field} = ${JSON.stringify(expected)}::jsonb`,
        );
      }
      const row = await statement.executeTakeFirstOrThrow();
      return Number(row.count);
    });
  }
}

export class PostgresStorage implements StorageCapability {
  readonly resources: ResourceStore;

  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly schema: string,
    events: EventBus = NOOP_EVENTS,
  ) {
    this.resources = new PostgresResourceStore(db, schema, events);
  }

  collection<TDocument extends { readonly id: string }>(
    name: string,
  ): DocumentCollection<TDocument> {
    return new PostgresDocumentCollection<TDocument>(this.db, this.schema, name);
  }
}
