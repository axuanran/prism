import { PrismError } from "@prismengine/contracts-data";
import { StorageDiagnosticCode } from "@prismengine/contracts-storage";
import type { MigrationJournal } from "@prismengine/kernel";
import type { Kysely } from "kysely";
import type { PostgresDatabase, PostgresStorageOptions } from "./database.js";
import { openDatabase } from "./database.js";
import { ensureMigrationJournalTable } from "./migrations.js";

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

  async applied(pluginId: string): Promise<readonly string[]> {
    return this.guard("read migration journal", async () => {
      await this.initialize();
      const rows = await this.db
        .withSchema(this.schema)
        .selectFrom("prism_migration")
        .select("migration_id")
        .where("plugin_id", "=", pluginId)
        .orderBy("applied_at", "asc")
        .orderBy("migration_id", "asc")
        .execute();
      return rows.map((row) => row.migration_id);
    });
  }

  async record(pluginId: string, migrationId: string): Promise<void> {
    await this.guard("record migration", async () => {
      await this.initialize();
      await this.db
        .withSchema(this.schema)
        .insertInto("prism_migration")
        .values({ plugin_id: pluginId, migration_id: migrationId, applied_at: new Date() })
        .onConflict((conflict) => conflict.columns(["plugin_id", "migration_id"]).doNothing())
        .execute();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.owned) await this.db.destroy();
  }

  private initialize(): Promise<void> {
    this.initialized ??= ensureMigrationJournalTable(this.db, this.schema);
    return this.initialized;
  }

  private async guard<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw PrismError.of(
        StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
        `PostgreSQL storage could not ${operation}.`,
        { cause: error instanceof Error ? error.message : String(error) },
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
