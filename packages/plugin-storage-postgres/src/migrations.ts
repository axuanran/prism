import { PrismError } from "@prismengine/contracts-data";
import { StorageDiagnosticCode } from "@prismengine/contracts-storage";
import type { Migration } from "@prismengine/kernel";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PostgresDatabase } from "./database.js";

export const INITIAL_STORAGE_MIGRATION_ID = "0001_storage_schema";

export async function ensureMigrationJournalTable(
  db: Kysely<PostgresDatabase>,
  schema: string,
): Promise<void> {
  await db.schema.createSchema(schema).ifNotExists().execute();
  await db.schema
    .withSchema(schema)
    .createTable("prism_migration")
    .ifNotExists()
    .addColumn("plugin_id", "text", (column) => column.notNull())
    .addColumn("migration_id", "text", (column) => column.notNull())
    .addColumn("applied_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("prism_migration_pk", ["plugin_id", "migration_id"])
    .execute();
}

async function createStorageSchema(
  db: Kysely<PostgresDatabase>,
  schema: string,
): Promise<void> {
  const schemaBuilder = db.schema.withSchema(schema);

  await db.schema.createSchema(schema).ifNotExists().execute();

  await schemaBuilder
    .createTable("resource")
    .ifNotExists()
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("id", "text", (column) => column.notNull())
    .addColumn("current_revision", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("resource_pk", ["kind", "id"])
    .addCheckConstraint("resource_current_revision_positive", sql`current_revision > 0`)
    .execute();

  await schemaBuilder
    .createTable("resource_revision")
    .ifNotExists()
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("id", "text", (column) => column.notNull())
    .addColumn("revision", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("spec", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("resource_revision_pk", ["kind", "id", "revision"])
    .addForeignKeyConstraint(
      "resource_revision_resource_fk",
      ["kind", "id"],
      "resource",
      ["kind", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint(
      "resource_revision_status_known",
      sql`status in ('draft', 'published', 'archived')`,
    )
    .execute();

  await schemaBuilder
    .createTable("document")
    .ifNotExists()
    .addColumn("collection", "text", (column) => column.notNull())
    .addColumn("id", "text", (column) => column.notNull())
    .addColumn("body", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("document_pk", ["collection", "id"])
    .execute();

  await ensureMigrationJournalTable(db, schema);

  await sql`
    create or replace function ${sql.id(schema, "protect_resource_revision_content")}()
    returns trigger
    language plpgsql
    as $function$
    begin
      -- Content is immutable forever after draft. Status is also one-way:
      -- published may become archived; archived is terminal. Without the
      -- status guards, a raw client could thaw published -> draft and mutate
      -- spec in a second UPDATE, bypassing the content check.
      if old.status <> 'draft'
         and (new.spec is distinct from old.spec or new.name is distinct from old.name) then
        raise exception 'resource revision %/%/% is immutable after draft', old.kind, old.id, old.revision
          using errcode = '23000';
      end if;
      if old.status = 'published' and new.status not in ('published', 'archived') then
        raise exception 'published resource revision %/%/% cannot return to %', old.kind, old.id, old.revision, new.status
          using errcode = '23000';
      end if;
      if old.status = 'archived' and new.status <> 'archived' then
        raise exception 'archived resource revision %/%/% is terminal', old.kind, old.id, old.revision
          using errcode = '23000';
      end if;
      return new;
    end
    $function$
  `.execute(db);

  await sql`
    do $block$
    begin
      if not exists (
        select 1
        from pg_trigger trigger
        join pg_class table_class on table_class.oid = trigger.tgrelid
        join pg_namespace namespace on namespace.oid = table_class.relnamespace
        where trigger.tgname = 'resource_revision_content_immutable'
          and namespace.nspname = ${sql.lit(schema)}
          and table_class.relname = 'resource_revision'
          and not trigger.tgisinternal
      ) then
        create trigger resource_revision_content_immutable
        before update on ${sql.id(schema, "resource_revision")}
        for each row execute function ${sql.id(schema, "protect_resource_revision_content")}();
      end if;
    end
    $block$
  `.execute(db);
}

/**
 * Existing V0.1 databases already journaled 0001 before status transitions
 * were protected. Replacing the function is a separate migration so they are
 * hardened too; silently editing an applied migration only fixes fresh DBs.
 */
async function hardenRevisionStatusTransitions(
  db: Kysely<PostgresDatabase>,
  schema: string,
): Promise<void> {
  await sql`
    create or replace function ${sql.id(schema, "protect_resource_revision_content")}()
    returns trigger
    language plpgsql
    as $function$
    begin
      if old.status <> 'draft'
         and (new.spec is distinct from old.spec or new.name is distinct from old.name) then
        raise exception 'resource revision %/%/% is immutable after draft', old.kind, old.id, old.revision
          using errcode = '23000';
      end if;
      if old.status = 'published' and new.status not in ('published', 'archived') then
        raise exception 'published resource revision %/%/% cannot return to %', old.kind, old.id, old.revision, new.status
          using errcode = '23000';
      end if;
      if old.status = 'archived' and new.status <> 'archived' then
        raise exception 'archived resource revision %/%/% is terminal', old.kind, old.id, old.revision
          using errcode = '23000';
      end if;
      return new;
    end
    $function$
  `.execute(db);
}

export const IMMUTABLE_STATUS_MIGRATION_ID = "0002_immutable_revision_status";

/** V0.1 migrations are forward-only. There is deliberately no down migration. */
export function postgresStorageMigrations(
  db: Kysely<PostgresDatabase>,
  schema: string,
): readonly Migration[] {
  return [
    {
      id: INITIAL_STORAGE_MIGRATION_ID,
      async up(): Promise<void> {
        try {
          await createStorageSchema(db, schema);
        } catch (error) {
          if (error instanceof PrismError) throw error;
          throw PrismError.of(
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL storage schema migration failed.",
            { cause: error instanceof Error ? error.message : String(error) },
          );
        }
      },
    },
    {
      id: IMMUTABLE_STATUS_MIGRATION_ID,
      async up(): Promise<void> {
        try {
          await hardenRevisionStatusTransitions(db, schema);
        } catch (error) {
          if (error instanceof PrismError) throw error;
          throw PrismError.of(
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL revision-status migration failed.",
            { cause: error instanceof Error ? error.message : String(error) },
          );
        }
      },
    },
  ];
}
