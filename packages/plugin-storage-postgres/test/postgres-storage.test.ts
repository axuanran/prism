import {
  D,
  DataDiagnosticCode,
  decimalCodec,
  systemCallContext,
} from "@prism/contracts-data";
import type { DecimalString } from "@prism/contracts-data";
import { StorageCapabilityToken } from "@prism/contracts-storage";
import { createEngine } from "@prism/kernel";
import type { Engine, Resource } from "@prism/kernel";
import {
  createPostgresMigrationJournal,
  storagePostgresPlugin,
} from "@prism/plugin-storage-postgres";
import type {
  PostgresDatabase,
  PostgresMigrationJournal,
} from "@prism/plugin-storage-postgres";
import {
  createScratchDatabase,
  describeStorageContract,
  probePostgres,
} from "@prism/testing";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const context = systemCallContext({ correlationId: "postgres-storage-test" });
const probe = await probePostgres();
const postgresUrl = probe.url;

if (postgresUrl === undefined) {
  console.error(`POSTGRESQL PERSISTENCE TESTS SKIPPED: ${probe.reason}`);
}

const describeRealPostgres = postgresUrl === undefined ? describe.skip : describe;

interface RunningEngine {
  readonly engine: Engine;
  readonly journal: PostgresMigrationJournal;
}

async function boot(connectionString: string): Promise<RunningEngine> {
  const journal = createPostgresMigrationJournal({ connectionString });
  const engine = createEngine({
    plugins: [storagePostgresPlugin({ connectionString })],
    migrationJournal: journal,
  });
  await engine.start();
  return { engine, journal };
}

async function shutdown(running: RunningEngine): Promise<void> {
  await running.engine.stop();
  await running.journal.dispose();
}

function rawDatabase(connectionString: string): Kysely<PostgresDatabase> {
  return new Kysely<PostgresDatabase>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });
}

function requirePostgresUrl(): string {
  if (postgresUrl === undefined) throw new Error("PostgreSQL test registered without a target");
  return postgresUrl;
}

describeRealPostgres("real PostgreSQL 17 storage", () => {
  describeStorageContract("postgresql", async () => {
    const scratch = await createScratchDatabase(requirePostgresUrl(), "contract");
    const running = await boot(scratch.url);
    return {
      storage: running.engine.capability(StorageCapabilityToken),
      async dispose(): Promise<void> {
        await shutdown(running);
        await scratch.drop();
      },
    };
  });

  it("lets the database trigger independently refuse published content updates", async () => {
    const scratch = await createScratchDatabase(requirePostgresUrl(), "trigger");
    const database = rawDatabase(scratch.url);
    const journal = createPostgresMigrationJournal({ db: database });
    const engine = createEngine({
      plugins: [storagePostgresPlugin({ db: database })],
      migrationJournal: journal,
    });

    try {
      await engine.start();
      const resources = engine.capability(StorageCapabilityToken).resources;
      const draft = await resources.saveDraft(context, {
        kind: "trigger.scheme",
        id: "frozen",
        name: "Original",
        spec: { coefficient: "1.25" },
      });
      await resources.publish(context, draft.kind, draft.id, draft.revision);

      await expect(
        database
          .withSchema("prism")
          .updateTable("resource_revision")
          .set({ name: "Tampered", spec: { coefficient: "999" } })
          .where("kind", "=", draft.kind)
          .where("id", "=", draft.id)
          .where("revision", "=", draft.revision)
          .execute(),
      ).rejects.toThrow(/immutable after draft/);

      // A two-step attack used to bypass the trigger: thaw published -> draft
      // without touching content, then mutate content while OLD.status=draft.
      // Status transitions themselves must therefore be one-way in the DB.
      await expect(
        database
          .withSchema("prism")
          .updateTable("resource_revision")
          .set({ status: "draft" })
          .where("kind", "=", draft.kind)
          .where("id", "=", draft.id)
          .where("revision", "=", draft.revision)
          .execute(),
      ).rejects.toThrow(/cannot return to draft/);

      expect(await resources.get(context, draft.kind, draft.id, draft.revision)).toMatchObject({
        name: "Original",
        spec: { coefficient: "1.25" },
      });
    } finally {
      await engine.stop();
      await journal.dispose();
      await database.destroy();
      await scratch.drop();
    }
  });

  it("persists migration execution and does not rerun it on a second boot", async () => {
    const scratch = await createScratchDatabase(requirePostgresUrl(), "migration");
    const first = await boot(scratch.url);
    try {
      expect(await first.journal.applied("storage.postgres")).toEqual([
        "0001_storage_schema",
        "0002_immutable_revision_status",
      ]);
    } finally {
      await shutdown(first);
    }

    const second = await boot(scratch.url);
    try {
      expect(await second.journal.applied("storage.postgres")).toEqual([
        "0001_storage_schema",
        "0002_immutable_revision_status",
      ]);
      const database = rawDatabase(scratch.url);
      try {
        const row = await database
          .withSchema("prism")
          .selectFrom("prism_migration")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("plugin_id", "=", "storage.postgres")
          .where("migration_id", "=", "0001_storage_schema")
          .executeTakeFirstOrThrow();
        expect(Number(row.count)).toBe(1);
      } finally {
        await database.destroy();
      }
    } finally {
      await shutdown(second);
      await scratch.drop();
    }
  });

  it("keeps published history unchanged across two engines and fresh plugin instances", async () => {
    const scratch = await createScratchDatabase(requirePostgresUrl(), "durability");
    const first = await boot(scratch.url);
    let expectedHistory: readonly Resource[] | undefined;

    try {
      const resources = first.engine.capability(StorageCapabilityToken).resources;
      const draft = await resources.saveDraft(context, {
        kind: "durable.scheme",
        id: "same-database",
        name: "Durable",
        spec: { value: "12345678901234567890123456.78" },
      });
      await resources.publish(context, draft.kind, draft.id, draft.revision);
      await resources.saveDraft(context, {
        kind: draft.kind,
        id: draft.id,
        name: "Later draft",
        spec: { value: "0.01" },
      });
      expectedHistory = await resources.listRevisions(context, draft.kind, draft.id);
    } finally {
      await shutdown(first);
    }
    if (expectedHistory === undefined) throw new Error("First engine wrote no history");

    const second = await boot(scratch.url);
    try {
      const resources = second.engine.capability(StorageCapabilityToken).resources;
      expect(
        await resources.listRevisions(context, "durable.scheme", "same-database"),
      ).toEqual(expectedHistory);
      expect(
        await resources.getPublished(context, "durable.scheme", "same-database"),
      ).toEqual(expectedHistory[0]);
    } finally {
      await shutdown(second);
      await scratch.drop();
    }
  });

  it("round-trips 203 decimal properties through JSONB and a reconnect bit-exact", async () => {
    const scratch = await createScratchDatabase(requirePostgresUrl(), "decimal");
    const fixed = [
      "12345678901234567890123456.78",
      "0.01",
      "-999999999999999999999999.99",
    ];
    const generated = Array.from({ length: 200 }, (_, index) => {
      const sign = index % 3 === 0 ? "-" : "";
      const whole = `${index + 1}${((index + 17) ** 5).toString().padStart(12, "0")}`;
      const fraction = ((index * 7919 + 104729) % 1_000_000)
        .toString()
        .padStart(6, "0");
      return `${sign}${whole}.${fraction}`;
    });
    const values = [...fixed, ...generated];
    const encoded = values.map((value, index) => ({
      id: `decimal-${index}`,
      value: decimalCodec.encode(new D(value)),
    }));

    for (const nonFinite of [new D(Infinity), new D(-Infinity), new D(NaN)]) {
      expect(() => decimalCodec.encode(nonFinite)).toThrowError(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: DataDiagnosticCode.DECIMAL_MALFORMED }),
          ]),
        }),
      );
    }

    const first = await boot(scratch.url);
    try {
      await first.engine
        .capability(StorageCapabilityToken)
        .collection<{ readonly id: string; readonly value: DecimalString }>("decimal.values")
        .putMany(context, encoded);
    } finally {
      await shutdown(first);
    }

    const second = await boot(scratch.url);
    try {
      const collection = second.engine
        .capability(StorageCapabilityToken)
        .collection<{ readonly id: string; readonly value: DecimalString }>("decimal.values");
      const loaded = await collection.getMany(
        context,
        encoded.map((item) => item.id),
      );
      expect(loaded).toHaveLength(203);
      loaded.forEach((item, index) => {
        const expected = encoded[index]!;
        expect(item).toEqual(expected);
        expect(decimalCodec.decode(item.value).toFixed()).toBe(new D(values[index]!).toFixed());
      });
      expect(await collection.count(context)).toBe(203);
    } finally {
      await shutdown(second);
      await scratch.drop();
    }
  });
});
