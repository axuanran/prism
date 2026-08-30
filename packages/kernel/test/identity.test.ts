import { EngineDiagnosticCode, type PrismError } from "@prismengine/contracts-data";
import {
  KERNEL_DESCRIPTION_MAX_LENGTH,
  KERNEL_ID_MAX_LENGTH,
  KERNEL_MIGRATION_EXTERNAL_EFFECT_MAX_LENGTH,
  KERNEL_MIGRATION_EXTERNAL_EFFECTS_MAX,
  KERNEL_MIGRATION_ID_MAX_LENGTH,
  KERNEL_REQUIREMENT_KEY_MAX_LENGTH,
  KERNEL_VERSION_MAX_LENGTH,
  createEngine,
  defineCapability,
  defineExtensionPoint,
  definePlugin,
  resolvePlugins,
  type AnyPluginDefinition,
  type MigrationJournal,
} from "@prismengine/kernel";
import { describe, expect, it } from "vitest";

describe("Kernel identity metadata", () => {
  it("fails fast in typed constructors", () => {
    expect(() => defineCapability({ id: "invalid capability", version: "1.0.0" })).toThrow(
      "KERNEL_IDENTITY_INVALID",
    );
    expect(() => defineCapability({ id: "valid.capability", version: "latest" })).toThrow(
      "KERNEL_IDENTITY_INVALID",
    );
    expect(() => defineExtensionPoint({ id: "invalid.*", version: "1.0.0" })).toThrow(
      "KERNEL_IDENTITY_INVALID",
    );
    expect(() =>
      definePlugin({
        id: "plugin",
        version: "0.1.0",
        engineRange: "not-a-range",
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
    expect(() =>
      definePlugin({
        id: "plugin",
        version: "0.1.0",
        engineRange: "^0.1.20",
        description: `private\n${"d".repeat(KERNEL_DESCRIPTION_MAX_LENGTH)}`,
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");

    const token = defineCapability({ id: "valid.capability", version: "1.0.0" });
    expect(() =>
      definePlugin({
        id: "plugin",
        version: "0.1.0",
        engineRange: "^0.1.20",
        requires: { "invalid key": token },
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
    const migration = {
      id: "0001_valid",
      checksum: "a".repeat(64),
      risk: "low" as const,
      requiresBackup: false,
      externalEffects: [],
      async up() {},
    };
    expect(() =>
      definePlugin({
        id: "duplicate-migrations",
        version: "0.1.0",
        engineRange: "^0.1.20",
        migrations: [migration, migration],
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
    expect(() =>
      definePlugin({
        id: "invalid-checksum",
        version: "0.1.0",
        engineRange: "^0.1.20",
        migrations: [{ ...migration, checksum: "A".repeat(64) }],
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
    expect(() =>
      definePlugin({
        id: "invalid-effects",
        version: "0.1.0",
        engineRange: "^0.1.20",
        migrations: [
          {
            ...migration,
            externalEffects: Array.from(
              { length: KERNEL_MIGRATION_EXTERNAL_EFFECTS_MAX + 1 },
              () => "effect",
            ),
          },
        ],
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
    for (const invalidMigration of [
      { ...migration, risk: "critical" },
      { ...migration, requiresBackup: "yes" },
      { ...migration, externalEffects: [""] },
      { ...migration, externalEffects: ["private\neffect"] },
      {
        ...migration,
        externalEffects: ["e".repeat(KERNEL_MIGRATION_EXTERNAL_EFFECT_MAX_LENGTH + 1)],
      },
      { ...migration, preflight: "not-a-function" },
      { ...migration, up: "not-a-function" },
    ]) {
      expect(() =>
        definePlugin({
          id: "invalid-migration-shape",
          version: "0.1.0",
          engineRange: "^0.1.20",
          migrations: [invalidMigration] as never,
        }),
      ).toThrow("KERNEL_IDENTITY_INVALID");
    }
    expect(() =>
      definePlugin({
        id: "invalid-migrations",
        version: "0.1.0",
        engineRange: "^0.1.20",
        migrations: {} as never,
      }),
    ).toThrow("KERNEL_IDENTITY_INVALID");
  });

  it("rejects untrusted plain definitions before maps or callbacks", async () => {
    let callbacks = 0;
    const invalid = {
      id: "private\nplugin-id",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register() {
        callbacks += 1;
      },
    } as unknown as AnyPluginDefinition;

    const resolution = resolvePlugins([invalid]);
    expect(resolution.order).toEqual([]);
    expect(resolution.providers.size).toBe(0);
    expect(resolution.bindings.size).toBe(0);
    expect(resolution.diagnostics).toEqual([
      {
        code: EngineDiagnosticCode.KERNEL_IDENTITY_INVALID,
        severity: "error",
        message: "Kernel identity metadata is invalid.",
        details: { pluginIndex: 0, field: "id" },
      },
    ]);
    expect(JSON.stringify(resolution.diagnostics)).not.toContain("private");

    const engine = createEngine({ plugins: [invalid] });
    let failure: unknown;
    try {
      await engine.start();
    } catch (error) {
      failure = error;
    }
    expect((failure as PrismError).diagnostics).toMatchObject([
      { code: EngineDiagnosticCode.KERNEL_IDENTITY_INVALID },
    ]);
    expect(String(failure)).not.toContain("private");
    expect(callbacks).toBe(0);
  });

  it("rejects plain invalid migrations before journal, approvals, or callbacks", async () => {
    let journalCalls = 0;
    let approvalCalls = 0;
    let callbacks = 0;
    const journal: MigrationJournal = {
      applied: async () => {
        journalCalls += 1;
        return [];
      },
      record: async () => {
        journalCalls += 1;
      },
      run: async () => {
        journalCalls += 1;
        return "applied";
      },
    };
    const invalid = {
      id: "migration-plugin",
      version: "0.1.0",
      engineRange: "^0.1.20",
      migrations: [
        {
          id: "private\nmigration",
          checksum: "a".repeat(64),
          risk: "high",
          requiresBackup: true,
          externalEffects: ["private-effect"],
          up() {
            callbacks += 1;
          },
        },
      ],
      register() {
        callbacks += 1;
      },
    } as unknown as AnyPluginDefinition;

    const resolution = resolvePlugins([invalid]);
    expect(resolution.order).toEqual([]);
    expect(resolution.diagnostics).toMatchObject([
      {
        code: EngineDiagnosticCode.KERNEL_IDENTITY_INVALID,
        details: { pluginIndex: 0, field: "migration.id" },
      },
    ]);
    expect(JSON.stringify(resolution.diagnostics)).not.toContain("private");

    const engine = createEngine({
      plugins: [invalid],
      migrationJournal: journal,
      confirmMigrationBackup: async () => {
        approvalCalls += 1;
        return true;
      },
      approveMigrationExternalEffects: async () => {
        approvalCalls += 1;
        return true;
      },
    });
    await expect(engine.start()).rejects.toMatchObject({
      diagnostics: [{ code: EngineDiagnosticCode.KERNEL_IDENTITY_INVALID }],
    });
    expect(journalCalls).toBe(0);
    expect(approvalCalls).toBe(0);
    expect(callbacks).toBe(0);
  });

  it("accepts exact identity and requirement-key boundaries", () => {
    const exactVersion = `1.0.0+${"a".repeat(KERNEL_VERSION_MAX_LENGTH - 6)}`;
    expect(exactVersion).toHaveLength(KERNEL_VERSION_MAX_LENGTH);
    const token = defineCapability({
      id: "c".repeat(KERNEL_ID_MAX_LENGTH),
      version: exactVersion,
    });
    const point = defineExtensionPoint({
      id: "e".repeat(KERNEL_ID_MAX_LENGTH),
      version: exactVersion,
    });
    expect(point.id).toHaveLength(KERNEL_ID_MAX_LENGTH);
    const provider = definePlugin({
      id: "p".repeat(KERNEL_ID_MAX_LENGTH),
      version: exactVersion,
      engineRange: "^0.1.20",
      description: "d".repeat(KERNEL_DESCRIPTION_MAX_LENGTH),
      provides: [token],
      migrations: [
        {
          id: "m".repeat(KERNEL_MIGRATION_ID_MAX_LENGTH),
          checksum: "a".repeat(64),
          risk: "high",
          requiresBackup: true,
          externalEffects: Array.from(
            { length: KERNEL_MIGRATION_EXTERNAL_EFFECTS_MAX },
            () => "e".repeat(KERNEL_MIGRATION_EXTERNAL_EFFECT_MAX_LENGTH),
          ),
          async preflight() {},
          async up() {},
        },
      ],
    });
    const requirementKey = "r".repeat(KERNEL_REQUIREMENT_KEY_MAX_LENGTH);
    const consumer = definePlugin({
      id: "consumer",
      version: "1.0.0",
      engineRange: "^0.1.20",
      requires: { [requirementKey]: token },
    });

    const resolution = resolvePlugins([consumer, provider]);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.order.map((plugin) => plugin.id)).toEqual([provider.id, consumer.id]);
    expect(resolution.bindings.get(consumer.id)).toMatchObject([
      { key: requirementKey, capabilityId: token.id, providerPluginId: provider.id },
    ]);
  });
});
