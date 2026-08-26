# ADR 0010: Resource identity is separate from immutable revisions

**Status:** Accepted and implemented

## Context

A configurable resource has one logical identity but many revisions. Reads need a current-revision pointer, while replay and audit need old published content to remain addressable and unchanged. Keeping identity and content in one mutable row would either overwrite history or duplicate current-resource state across revisions (`packages/contracts-storage/src/capability.ts`, `packages/plugin-storage-postgres/src/postgres-storage.ts`).

Service-only immutability is insufficient for durable storage. Another code path, a later implementation defect, or direct SQL could update content without passing through the storage service checks.

## Decision

PostgreSQL separates the model into two tables:

- `resource` owns logical key `(kind, id)`, `current_revision`, and aggregate timestamps;
- `resource_revision` owns key `(kind, id, revision)`, lifecycle `status`, `name`, JSONB `spec`, and revision timestamps.

The revision table has a foreign key to the logical resource. A `BEFORE UPDATE` database trigger raises SQLSTATE `23000` when the old row is not a draft and an update changes `name` or `spec`. It also enforces one-way status transitions: published may become archived but never draft, and archived is terminal. This closes a two-step SQL bypass—thaw published to draft without changing content, then mutate content while `OLD.status = draft`. Draft content remains editable; once the row has left draft, content immutability is enforced by PostgreSQL, not only by `PostgresStorage` (`packages/plugin-storage-postgres/src/database.ts`, `packages/plugin-storage-postgres/src/migrations.ts`, `packages/plugin-storage-postgres/src/postgres-storage.ts`).

## Consequences

- Current reads join the logical row to `current_revision`; exact revision reads remain stable.
- Saving an existing draft updates that revision. Editing a published revision creates a new draft revision and advances the logical pointer (`packages/plugin-storage-postgres/src/postgres-storage.ts`).
- Publishing and archiving may change lifecycle status without changing revision content.
- Deleting a logical resource cascades to its revisions at the database level.
- The provider-independent storage contract tests ordered history and immutable content against memory and PostgreSQL (`packages/testing/src/storage-conformance.ts`, `packages/plugin-storage-memory/test/memory-storage.test.ts`, `packages/plugin-storage-postgres/test/postgres-storage.test.ts`).
- The trigger protects `name`, `spec`, and one-way lifecycle status after draft. It is not a general authorization or resource-schema validator.

## Cost to reverse

Collapsing identity and revisions into one table would require rewriting current and historical queries, revision allocation, clone/publish/archive behavior, foreign keys, migration logic, and replay assumptions. Removing the trigger while retaining two tables is mechanically cheaper but would weaken immutability from a database invariant back to a service convention and require equivalent protection for every writer (`packages/contracts-data/src/run-pin.ts`, `packages/plugin-storage-postgres/src/postgres-storage.ts`).
