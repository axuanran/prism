import { PrismError } from "@prismengine/contracts-data";
import { StorageDiagnosticCode } from "@prismengine/contracts-storage";
import type { AppliedMigration, MigrationJournal } from "@prismengine/kernel";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PostgresDatabase, PostgresStorageOptions } from "./database.js";
import { openDatabase } from "./database.js";
import { ensureMigrationJournalTable } from "./migrations.js";
import { postgresProviderFailure } from "./provider-failure.js";

export interface PostgresMigrationJournal extends MigrationJournal {
  dispose(): Promise<void>;
}

class DurablePostgresMigrationJournal implements PostgresMigrationJournal {
  private initialized: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly schema: string,
    private readonly owned: boolean,
  ) {}

  async applied(pluginId: string): Promise<readonly AppliedMigration[]> {
    return this.guard("read migration journal", async () => {
      await this.initialize();
      const rows = await this.db
        .withSchema(this.schema)
        .selectFrom("prism_migration")
        .select(["migration_id", "checksum"])
        .where("plugin_id", "=", pluginId)
        .orderBy("applied_at", "asc")
        .orderBy("migration_id", "asc")
        .execute();
      return rows.map((row) => ({
        id: row.migration_id,
        ...(row.checksum === null ? {} : { checksum: row.checksum }),
      }));
    });
  }

  async record(pluginId: string, migrationId: string, checksum: string): Promise<void> {
    await this.guard("record migration", async () => {
      await this.initialize();
      await this.db
        .withSchema(this.schema)
        .insertInto("prism_migration")
        .values({
          plugin_id: pluginId,
          migration_id: migrationId,
          checksum,
          applied_at: new Date(),
        })
        .onConflict((conflict) =>
          conflict.columns(["plugin_id", "migration_id"]).doNothing(),
        )
        .execute();
    });
  }
  async run(
    pluginId: string,
    migrationId: string,
    checksum: string,
    action: () => Promise<void>,
  ): Promise<"applied" | "skipped"> {
    return this.guard("run migration", async () => {
      await this.initialize();
      return this.db.connection().execute(async (connection) => {
        const lockKey = JSON.stringify([this.schema, pluginId, migrationId]);
        await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0))`.execute(
          connection,
        );
        try {
          const existing = await connection
            .withSchema(this.schema)
            .selectFrom("prism_migration")
            .select("checksum")
            .where("plugin_id", "=", pluginId)
            .where("migration_id", "=", migrationId)
            .executeTakeFirst();
          if (existing !== undefined) {
            if (existing.checksum !== null && existing.checksum !== checksum) {
              throw PrismError.of(
                "MIGRATION_CHECKSUM_MISMATCH",
                "An applied migration implementation changed.",
                {
                  pluginId,
                  migrationId,
                  expected: existing.checksum,
                  actual: checksum,
                },
              );
            }
            return "skipped";
          }
          await action();
          await connection
            .withSchema(this.schema)
            .insertInto("prism_migration")
            .values({
              plugin_id: pluginId,
              migration_id: migrationId,
              checksum,
              applied_at: new Date(),
            })
            .execute();
          return "applied";
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(
            connection,
          );
        }
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.owned) await this.db.destroy();
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.db.connection().execute(async (connection) => {
      const lockKey = JSON.stringify([this.schema, "migration-journal"]);
      await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0))`.execute(
        connection,
      );
      try {
        await ensureMigrationJournalTable(connection, this.schema);
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(
          connection,
        );
      }
    });
    return this.initialized;
  }

  private async guard<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw postgresProviderFailure(
        error,
        StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
        `PostgreSQL storage could not ${operation}.`,
      );
    }
  }
}

export function createPostgresMigrationJournal(
  options: PostgresStorageOptions,
): PostgresMigrationJournal {
  const handle = openDatabase(options);
  return new DurablePostgresMigrationJournal(handle.db, handle.schema, handle.owned);
}
