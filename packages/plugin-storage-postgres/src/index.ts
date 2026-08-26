import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import { definePlugin } from "@prismengine/kernel";
import { openDatabase } from "./database.js";
import type { PostgresStorageOptions } from "./database.js";
import { postgresStorageMigrations } from "./migrations.js";
import { PostgresStorage } from "./postgres-storage.js";

export type {
  PostgresConnectionOptions,
  PostgresDatabase,
  PostgresKyselyOptions,
  PostgresStorageOptions,
} from "./database.js";
export {
  createPostgresMigrationJournal,
  type PostgresMigrationJournal,
} from "./migration-journal.js";
export { INITIAL_STORAGE_MIGRATION_ID } from "./migrations.js";
export { PostgresStorage } from "./postgres-storage.js";

export function storagePostgresPlugin(options: PostgresStorageOptions) {
  const handle = openDatabase(options);
  return definePlugin({
    id: "storage.postgres",
    version: "0.1.0",
    provides: [StorageCapabilityToken],
    migrations: postgresStorageMigrations(handle.db, handle.schema),
    register(context) {
      context.provide(
        StorageCapabilityToken,
        new PostgresStorage(handle.db, handle.schema, context.events),
      );
    },
    async stop() {
      if (handle.owned) await handle.db.destroy();
    },
  });
}
