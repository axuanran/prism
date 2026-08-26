import { PrismError } from "@prism/contracts-data";
import { StorageDiagnosticCode } from "@prism/contracts-storage";
import type { ResourceStatus } from "@prism/kernel";
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
  readonly applied_at: ColumnType<Date, Date, never>;
}

export interface PostgresDatabase {
  readonly resource: ResourceTable;
  readonly resource_revision: ResourceRevisionTable;
  readonly document: DocumentTable;
  readonly prism_migration: PrismMigrationTable;
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
