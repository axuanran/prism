import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
} from "@prismengine/contracts-storage";
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
    version: "0.1.2",
    provides: [StorageCapabilityToken, AtomicWriteCapabilityToken],
    migrations: postgresStorageMigrations(handle.db, handle.schema),
    register(context) {
      const storage = new PostgresStorage(handle.db, handle.schema, context.events);
      context.provide(StorageCapabilityToken, storage);
      context.provide(AtomicWriteCapabilityToken, storage);
    },
    async stop() {
      if (handle.owned) await handle.db.destroy();
    },
  });
}
