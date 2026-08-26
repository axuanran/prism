# ADR 0011: Table-owning plugins own migrations

**Status:** Accepted and implemented

## Context

The kernel must coordinate startup without learning a PostgreSQL schema or importing a storage implementation. Conversely, the plugin that owns tables is the component that can evolve them coherently with its code. A host-owned global migration list would move implementation detail into the composition root and make plugin replacement incomplete (`packages/kernel/src/plugin.ts`, `packages/plugin-storage-postgres/src/index.ts`).

Migration failure can leave external effects even when startup later rolls back plugin lifecycles. The engine records a migration only after `up` completes; a failed unrecorded migration is retried on the next start (`packages/kernel/src/engine.ts`).

## Decision

Each `PluginDefinition` declares its own ordered `migrations`. The engine discovers those declarations from the resolved plugin graph, runs unapplied migrations before that plugin's `start`, and uses a `MigrationJournal` keyed by plugin ID and migration ID to skip and record completed work. The engine owns discovery, ordering, execution, and recording; it does not own table definitions (`packages/kernel/src/plugin.ts`, `packages/kernel/src/engine.ts`).

PostgreSQL storage owns forward-only migration `0001_storage_schema`. It creates the plugin's `resource`, `resource_revision`, `document`, and `prism_migration` tables plus the revision-content trigger. `createPostgresMigrationJournal` persists engine migration records in `prism_migration` (`packages/plugin-storage-postgres/src/migrations.ts`, `packages/plugin-storage-postgres/src/migration-journal.ts`, `packages/plugin-storage-postgres/src/index.ts`).

V0.1 has no `down` migration and no engine-managed migration transaction. Every migration must therefore be idempotent: a partially failed `up` may run again against effects it already created.

## Consequences

- Schema evolution stays with the plugin that owns the schema.
- Replacing storage does not require teaching the kernel about a new database.
- Migrations run in resolved plugin order and declaration array order.
- Completion is durable only when the host supplies a durable journal; the default engine journal is in memory (`packages/kernel/src/engine.ts`).
- `createPostgresMigrationJournal({ connectionString })` owns a separate database pool. Its creator must call `dispose()`. The storage plugin's owned pool is closed on normal stop and when registration, migration, or startup fails because Kernel cleans the failing plugin as well as already-started plugins (`packages/plugin-storage-postgres/src/database.ts`, `packages/plugin-storage-postgres/src/index.ts`, `packages/plugin-storage-postgres/src/migration-journal.ts`, `packages/kernel/src/engine.ts`).
- Forward-only operation simplifies V0.1 but makes migration review and idempotency load-bearing. Applied migration definitions are never edited silently: status-transition hardening shipped as `0002_immutable_revision_status`, so databases that had already journaled `0001` also receive it (`packages/plugin-storage-postgres/src/migrations.ts`).

## Cost to reverse

Moving migrations into the kernel or host would require changing `PluginDefinition`, startup sequencing, every owning plugin, journal keys, composition, and tests. Adding rollback later would require a transactional contract or explicit `down` semantics, rules for irreversible data changes, journal state beyond applied IDs, and recovery behavior for partially failed migrations (`packages/kernel/src/plugin.ts`, `packages/kernel/src/engine.ts`).
