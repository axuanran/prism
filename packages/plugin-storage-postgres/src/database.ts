import { PrismError } from "@prismengine/contracts-data";
import { StorageDiagnosticCode } from "@prismengine/contracts-storage";
import type { ResourceStatus } from "@prismengine/kernel";
import type { ColumnType } from "kysely";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

export interface ResourceTable {
  readonly kind: string;
  readonly id: string;
  current_revision: number;
  readonly created_at: ColumnType<Date, Date, never>;
  updated_at: ColumnType<Date, Date, Date>;
}

export interface ResourceRevisionTable {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  status: ResourceStatus;
  name: string;
  spec: unknown;
  readonly created_at: ColumnType<Date, Date, never>;
  updated_at: ColumnType<Date, Date, Date>;
}

export interface DocumentTable {
  readonly collection: string;
  readonly id: string;
  body: unknown;
  readonly created_at: ColumnType<Date, Date, never>;
  updated_at: ColumnType<Date, Date, Date>;
}

export interface PrismMigrationTable {
  readonly plugin_id: string;
  readonly migration_id: string;
  readonly checksum: string | null;
  readonly applied_at: ColumnType<Date, Date, never>;
}
export interface AuditJournalTable {
  readonly sequence: ColumnType<string, string, never>;
  readonly id: string;
  readonly recorded_at: ColumnType<Date, Date, never>;
  readonly principal_id: string;
  readonly action: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly before_fingerprint: string | null;
  readonly after_fingerprint: string | null;
  readonly reason: string | null;
  readonly correlation_id: string;
  readonly approval_id: string | null;
  readonly previous_hash: string | null;
  readonly entry_hash: string;
}

export interface PostgresDatabase {
  readonly resource: ResourceTable;
  readonly resource_revision: ResourceRevisionTable;
  readonly document: DocumentTable;
  readonly prism_migration: PrismMigrationTable;
  readonly audit_journal: AuditJournalTable;
}

export interface PostgresConnectionOptions {
  readonly connectionString: string;
  readonly db?: never;
  readonly schema?: string;
}

export interface PostgresKyselyOptions {
  readonly db: Kysely<PostgresDatabase>;
  readonly connectionString?: never;
  readonly schema?: string;
}

export type PostgresStorageOptions = PostgresConnectionOptions | PostgresKyselyOptions;

export interface DatabaseHandle {
  readonly db: Kysely<PostgresDatabase>;
  readonly schema: string;
  readonly owned: boolean;
}

export function validateSchemaName(schema = "prism"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw PrismError.of(
      StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
      `Invalid PostgreSQL schema name: ${schema}`,
      { schema },
    );
  }
  return schema;
}

export function openDatabase(options: PostgresStorageOptions): DatabaseHandle {
  const schema = validateSchemaName(options.schema);
  if (options.db !== undefined) return { db: options.db, schema, owned: false };

  return {
    db: new Kysely<PostgresDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: options.connectionString }),
      }),
    }),
    schema,
    owned: true,
  };
}
