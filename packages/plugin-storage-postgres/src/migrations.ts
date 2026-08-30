import { createHash } from "node:crypto";
import type { Migration } from "@prismengine/kernel";
import { StorageDiagnosticCode } from "@prismengine/contracts-storage";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PostgresDatabase } from "./database.js";
import { postgresProviderFailure } from "./provider-failure.js";

export const INITIAL_STORAGE_MIGRATION_ID = "0001_storage_schema";

function migrationChecksum(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

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
    .addColumn("checksum", "text")
    .addColumn("applied_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("prism_migration_pk", ["plugin_id", "migration_id"])
    .execute();
  await sql`
    alter table ${sql.id(schema, "prism_migration")}
      add column if not exists checksum text
  `.execute(db);
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
export const AUDIT_JOURNAL_MIGRATION_ID = "0003_append_only_audit_journal";
export const AUDIT_APPROVAL_MIGRATION_ID = "0004_audit_approval_identity";

async function createAuditJournal(
  db: Kysely<PostgresDatabase>,
  schema: string,
): Promise<void> {
  await db.schema
    .withSchema(schema)
    .createTable("audit_journal")
    .ifNotExists()
    .addColumn("sequence", "bigserial", (column) => column.primaryKey())
    .addColumn("id", "text", (column) => column.notNull().unique())
    .addColumn("recorded_at", "timestamptz", (column) => column.notNull())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("action", "text", (column) => column.notNull())
    .addColumn("target_kind", "text", (column) => column.notNull())
    .addColumn("target_id", "text", (column) => column.notNull())
    .addColumn("before_fingerprint", "text")
    .addColumn("after_fingerprint", "text")
    .addColumn("reason", "text")
    .addColumn("correlation_id", "text", (column) => column.notNull())
    .addColumn("previous_hash", "text")
    .addColumn("entry_hash", "text", (column) => column.notNull())
    .execute();
  await db.schema
    .withSchema(schema)
    .createIndex("audit_journal_target_idx")
    .ifNotExists()
    .on("audit_journal")
    .columns(["target_kind", "target_id", "sequence"])
    .execute();
  await sql`
    create or replace function ${sql.id(schema, "protect_audit_journal")}()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'audit journal is append-only'
        using errcode = '23000';
    end
    $function$;

    do $block$
    begin
      if not exists (
        select 1
        from pg_trigger
        where tgname = 'audit_journal_append_only'
          and tgrelid = ${sql.lit(`${schema}.audit_journal`)}::regclass
      ) then
        create trigger audit_journal_append_only
          before update or delete on ${sql.id(schema, "audit_journal")}
          for each row execute function ${sql.id(schema, "protect_audit_journal")}();
      end if;
    end
    $block$
  `.execute(db);
}
async function addAuditApprovalIdentity(
  db: Kysely<PostgresDatabase>,
  schema: string,
): Promise<void> {
  await sql`
    alter table ${sql.id(schema, "audit_journal")}
      add column if not exists approval_id text
  `.execute(db);
  await db.schema
    .withSchema(schema)
    .createIndex("audit_journal_approval_idx")
    .ifNotExists()
    .on("audit_journal")
    .column("approval_id")
    .execute();
}

/** V0.1 migrations are forward-only. There is deliberately no down migration. */
export function postgresStorageMigrations(
  db: Kysely<PostgresDatabase>,
  schema: string,
): readonly Migration[] {
  return [
    {
      id: INITIAL_STORAGE_MIGRATION_ID,
      checksum: migrationChecksum("0001_storage_schema:v1:resource-revision-document"),
      risk: "medium",
      requiresBackup: false,
      externalEffects: [],
      async up(): Promise<void> {
        try {
          await createStorageSchema(db, schema);
        } catch (error) {
          throw postgresProviderFailure(
            error,
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL storage schema migration failed.",
          );
        }
      },
    },
    {
      id: IMMUTABLE_STATUS_MIGRATION_ID,
      checksum: migrationChecksum("0002_immutable_revision_status:v1:status-trigger"),
      risk: "low",
      requiresBackup: false,
      externalEffects: [],
      async up(): Promise<void> {
        try {
          await hardenRevisionStatusTransitions(db, schema);
        } catch (error) {
          throw postgresProviderFailure(
            error,
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL revision-status migration failed.",
          );
        }
      },
    },
    {
      id: AUDIT_JOURNAL_MIGRATION_ID,
      checksum: migrationChecksum("0003_append_only_audit_journal:v1:hash-chain-trigger"),
      risk: "low",
      requiresBackup: false,
      externalEffects: [],
      async up(): Promise<void> {
        try {
          await createAuditJournal(db, schema);
        } catch (error) {
          throw postgresProviderFailure(
            error,
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL audit-journal migration failed.",
          );
        }
      },
    },
    {
      id: AUDIT_APPROVAL_MIGRATION_ID,
      checksum: migrationChecksum("0004_audit_approval_identity:v1:approval-column-index"),
      risk: "low",
      requiresBackup: false,
      externalEffects: [],
      async up(): Promise<void> {
        try {
          await addAuditApprovalIdentity(db, schema);
        } catch (error) {
          throw postgresProviderFailure(
            error,
            StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
            "PostgreSQL audit-approval migration failed.",
          );
        }
      },
    },
  ];
}
