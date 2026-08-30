import { describe, expect, it } from "vitest";
import { EngineDiagnosticCode, PrismError } from "@prismengine/contracts-data";
import {
  InMemoryMigrationJournal,
  MIGRATION_JOURNAL_MAX_ENTRIES,
  createEngine,
  defineCapability,
  defineExtensionPoint,
  definePlugin,
  type AppliedMigration,
  type MigrationJournal,
} from "@prismengine/kernel";
function deferred<T>() {
  // tsconfig.test targets the compatibility lib that predates Promise.withResolvers.
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface Greeter {
  greet(): string;
}

interface Counter {
  next(): number;
}

const GreeterCapability = defineCapability<Greeter>({
  id: "test.greeter",
  version: "1.2.0",
});

const CounterCapability = defineCapability<Counter>({
  id: "test.counter",
  version: "1.0.0",
});

const greeterPlugin = definePlugin({
  id: "greeter",
  version: "0.1.0",
  engineRange: "^0.1.20",
  provides: [GreeterCapability],
  register(ctx) {
    ctx.provide(GreeterCapability, { greet: () => "hello" });
  },
});

async function codesFrom(start: () => Promise<unknown>): Promise<readonly string[]> {
  try {
    await start();
  } catch (error) {
    if (error instanceof PrismError) return error.diagnostics.map((d) => d.code);
    throw error;
  }
  throw new Error("expected engine start to fail");
}

describe("engine lifecycle", () => {
  it("resolves capabilities and injects the provider's service", async () => {
    let greeting = "";

    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: GreeterCapability },
      start(ctx) {
        greeting = ctx.dependencies.greeter.greet();
      },
    });

    const engine = createEngine({ plugins: [consumer, greeterPlugin] });
    await engine.start();

    expect(greeting).toBe("hello");
    expect(engine.currentPhase).toBe("started");
  });

  it("starts providers before consumers regardless of input order", async () => {
    const order: string[] = [];

    const a = definePlugin({
      id: "a",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [CounterCapability],
      register(ctx) {
        ctx.provide(CounterCapability, { next: () => 1 });
      },
      start: () => void order.push("a"),
    });

    const b = definePlugin({
      id: "b",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { counter: CounterCapability },
      start: () => void order.push("b"),
    });

    const engine = createEngine({ plugins: [b, a] });
    await engine.start();

    expect(order).toEqual(["a", "b"]);
  });

  it("stops in reverse start order", async () => {
    const order: string[] = [];

    const provider = definePlugin({
      id: "provider",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [CounterCapability],
      register(ctx) {
        ctx.provide(CounterCapability, { next: () => 1 });
      },
      stop: () => void order.push("provider"),
    });

    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { counter: CounterCapability },
      stop: () => void order.push("consumer"),
    });

    const engine = createEngine({ plugins: [provider, consumer] });
    await engine.start();
    await engine.stop();

    expect(order).toEqual(["consumer", "provider"]);
    expect(engine.currentPhase).toBe("stopped");
  });

  it("fails when a required capability has no provider", async () => {
    const orphan = definePlugin({
      id: "orphan",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: GreeterCapability },
    });

    const engine = createEngine({ plugins: [orphan] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.CAPABILITY_MISSING,
    );
  });

  it("tolerates an unsatisfied optional capability", async () => {
    let seen: Greeter | undefined = { greet: () => "placeholder" };

    const plugin = definePlugin({
      id: "optional-consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: { token: GreeterCapability, optional: true } },
      start(ctx) {
        seen = ctx.dependencies.greeter;
      },
    });

    const engine = createEngine({ plugins: [plugin] });
    await engine.start();

    expect(seen).toBeUndefined();
  });

  it("fails on a semver mismatch between requirement and provider", async () => {
    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: { token: GreeterCapability, range: "^2.0.0" } },
    });

    const engine = createEngine({ plugins: [greeterPlugin, consumer] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.CAPABILITY_VERSION_MISMATCH,
    );
  });

  it("accepts a compatible minor version (identity is the id, not the version)", async () => {
    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: { token: GreeterCapability, range: "^1.0.0" } },
    });

    const engine = createEngine({ plugins: [greeterPlugin, consumer] });
    await expect(engine.start()).resolves.toBeUndefined();
  });

  it("rejects a dependency cycle and names the path", async () => {
    const CapA = defineCapability<Greeter>({ id: "cycle.a", version: "1.0.0" });
    const CapB = defineCapability<Greeter>({ id: "cycle.b", version: "1.0.0" });

    const a = definePlugin({
      id: "a",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [CapA],
      requires: { b: CapB },
      register(ctx) {
        ctx.provide(CapA, { greet: () => "a" });
      },
    });

    const b = definePlugin({
      id: "b",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [CapB],
      requires: { a: CapA },
      register(ctx) {
        ctx.provide(CapB, { greet: () => "b" });
      },
    });

    const engine = createEngine({ plugins: [a, b] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.PLUGIN_DEPENDENCY_CYCLE,
    );
  });

  it("rejects two providers of the same capability", async () => {
    const rival = definePlugin({
      id: "rival",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [GreeterCapability],
      register(ctx) {
        ctx.provide(GreeterCapability, { greet: () => "other" });
      },
    });

    const engine = createEngine({ plugins: [greeterPlugin, rival] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.CAPABILITY_DUPLICATE_PROVIDER,
    );
  });

  it("rolls back already-started plugins when a later start fails", async () => {
    const events: string[] = [];

    const provider = definePlugin({
      id: "provider",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [CounterCapability],
      register(ctx) {
        ctx.provide(CounterCapability, { next: () => 1 });
      },
      start: () => void events.push("provider:start"),
      stop: () => void events.push("provider:stop"),
    });

    const broken = definePlugin({
      id: "broken",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { counter: CounterCapability },
      start() {
        events.push("broken:start");
        throw new Error("boom");
      },
      stop: () => void events.push("broken:stop"),
    });

    const engine = createEngine({ plugins: [provider, broken] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.PLUGIN_START_FAILED,
    );

    // The failing plugin did not complete start, but may still own resources
    // allocated during register/start. It cleans itself before providers roll
    // back in reverse order.
    expect(events).toEqual([
      "provider:start",
      "broken:start",
      "broken:stop",
      "provider:stop",
    ]);
  });

  it("cleans every registered plugin when registration fails", async () => {
    const events: string[] = [];

    const first = definePlugin({
      id: "first",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register: () => void events.push("first:register"),
      stop: () => void events.push("first:stop"),
    });
    const broken = definePlugin({
      id: "broken-register",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register() {
        events.push("broken:register");
        throw new Error("register failed");
      },
      stop: () => void events.push("broken:stop"),
    });

    const engine = createEngine({ plugins: [first, broken] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.PLUGIN_REGISTER_FAILED,
    );
    expect(events).toEqual([
      "first:register",
      "broken:register",
      "broken:stop",
      "first:stop",
    ]);
  });

  it("sanitizes non-Prism lifecycle failures while preserving cleanup", async () => {
    const registerEvents: string[] = [];
    const registerFailurePlugin = definePlugin({
      id: "private-register-failure",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register() {
        registerEvents.push("register");
        throw new Error("postgres://admin:private-password@db.internal/plugin-register");
      },
      stop() {
        registerEvents.push("stop");
        throw { credential: "private-stop-credential" };
      },
    });
    const registerEngine = createEngine({ plugins: [registerFailurePlugin] });
    let registerFailure: unknown;
    try {
      await registerEngine.start();
    } catch (error) {
      registerFailure = error;
    }
    expect(registerFailure).toMatchObject({
      diagnostics: [
        {
          code: EngineDiagnosticCode.PLUGIN_REGISTER_FAILED,
          message: "Plugin lifecycle callback failed.",
          details: { pluginId: "private-register-failure", errorType: "Error" },
        },
      ],
    });
    expect(registerEvents).toEqual(["register", "stop"]);
    expect(registerEngine.inspect().diagnostics).toMatchObject([
      {
        code: EngineDiagnosticCode.PLUGIN_STOP_FAILED,
        message: "Plugin lifecycle cleanup failed.",
        details: { pluginId: "private-register-failure", errorType: "object" },
      },
    ]);
    expect(
      JSON.stringify({
        failure: registerFailure,
        inspection: registerEngine.inspect(),
      }),
    ).not.toContain("private-password");
    expect(JSON.stringify(registerEngine.inspect())).not.toContain(
      "private-stop-credential",
    );

    const startEvents: string[] = [];
    const startFailurePlugin = definePlugin({
      id: "private-start-failure",
      version: "0.1.0",
      engineRange: "^0.1.20",
      start() {
        startEvents.push("start");
        throw { endpoint: "https://private.example", token: "private-token" };
      },
      stop() {
        startEvents.push("stop");
        const failure = new Error("private stop stack");
        failure.name = "Private-Credential-Error";
        throw failure;
      },
    });
    const startEngine = createEngine({ plugins: [startFailurePlugin] });
    let startFailure: unknown;
    try {
      await startEngine.start();
    } catch (error) {
      startFailure = error;
    }
    expect(startFailure).toMatchObject({
      diagnostics: [
        {
          code: EngineDiagnosticCode.PLUGIN_START_FAILED,
          message: "Plugin lifecycle callback failed.",
          details: { pluginId: "private-start-failure", errorType: "object" },
        },
      ],
    });
    expect(startEvents).toEqual(["start", "stop"]);
    expect(startEngine.inspect().diagnostics).toMatchObject([
      {
        code: EngineDiagnosticCode.PLUGIN_STOP_FAILED,
        message: "Plugin lifecycle cleanup failed.",
        details: { pluginId: "private-start-failure", errorType: "Error" },
      },
    ]);
    const serializedStartFailure = JSON.stringify({
      failure: startFailure,
      inspection: startEngine.inspect(),
    });
    expect(serializedStartFailure).not.toContain("private-token");
    expect(serializedStartFailure).not.toContain("private.example");
    expect(serializedStartFailure).not.toContain("private stop stack");
  });

  it("preserves structured Prism lifecycle diagnostics", async () => {
    const plugin = definePlugin({
      id: "structured-failure",
      version: "0.1.0",
      engineRange: "^0.1.20",
      start() {
        throw PrismError.of("STRUCTURED_PLUGIN_FAILURE", "Structured failure.", {
          safe: true,
        });
      },
    });
    const engine = createEngine({ plugins: [plugin] });

    await expect(engine.start()).rejects.toMatchObject({
      diagnostics: [
        {
          code: "STRUCTURED_PLUGIN_FAILURE",
          message: "Structured failure.",
          details: { safe: true },
        },
      ],
    });
  });

  it("blocks access to a capability the plugin did not declare", async () => {
    let thrown: unknown;

    const sneaky = definePlugin({
      id: "sneaky",
      version: "0.1.0",
      engineRange: "^0.1.20",
      start(ctx) {
        try {
          ctx.services.get(GreeterCapability);
        } catch (error) {
          thrown = error;
        }
      },
    });

    const engine = createEngine({ plugins: [greeterPlugin, sneaky] });
    await engine.start();

    expect(thrown).toBeInstanceOf(PrismError);
    expect((thrown as PrismError).diagnostics[0]?.code).toBe(
      EngineDiagnosticCode.CAPABILITY_UNDECLARED_ACCESS,
    );
  });

  it("blocks providing a capability that was not declared in `provides`", async () => {
    const liar = definePlugin({
      id: "liar",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.provide(GreeterCapability, { greet: () => "nope" });
      },
    });

    const engine = createEngine({ plugins: [liar] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.CAPABILITY_NOT_PROVIDED,
    );
  });

  it("freezes the capability registry after the register phase", async () => {
    let thrown: unknown;
    let captured:
      { provide: (token: typeof CounterCapability, service: Counter) => void } | undefined;

    const late = definePlugin({
      id: "late",
      version: "0.1.0",
      engineRange: "^0.1.20", // Both are declared, so the failure below is about phase, not declaration.
      provides: [GreeterCapability, CounterCapability],
      register(ctx) {
        ctx.provide(GreeterCapability, { greet: () => "early" });
        captured = ctx;
      },
      start() {
        try {
          captured?.provide(CounterCapability, { next: () => 2 });
        } catch (error) {
          thrown = error;
        }
      },
    });

    const engine = createEngine({ plugins: [late] });
    await engine.start();

    expect((thrown as PrismError).diagnostics[0]?.code).toBe(
      EngineDiagnosticCode.LIFECYCLE_PHASE_VIOLATION,
    );
  });
  it("rejects a contribution compiled for another extension-point version", async () => {
    const V1 = defineExtensionPoint<{ readonly name: string }>({
      id: "test.versioned-extension",
      version: "1.0.0",
    });
    const V2 = defineExtensionPoint<{ readonly name: string }>({
      id: "test.versioned-extension",
      version: "2.0.0",
    });
    const first = definePlugin({
      id: "extension-v1",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.extensions.contribute(V1, { name: "v1" });
      },
    });
    const incompatible = definePlugin({
      id: "extension-v2",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.extensions.contribute(V2, { name: "v2" });
      },
    });

    const engine = createEngine({ plugins: [first, incompatible] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.EXTENSION_POINT_VERSION_MISMATCH,
    );
  });

  it("rejects reading contributions through another point version", async () => {
    const V1 = defineExtensionPoint<string>({
      id: "test.versioned-read",
      version: "1.0.0",
    });
    const V2 = defineExtensionPoint<string>({
      id: "test.versioned-read",
      version: "2.0.0",
    });
    const writer = definePlugin({
      id: "versioned-writer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.extensions.contribute(V1, "value");
      },
    });
    const reader = definePlugin({
      id: "versioned-reader",
      version: "0.1.0",
      engineRange: "^0.1.20",
      start(ctx) {
        ctx.extensions.values(V2);
      },
    });

    const engine = createEngine({ plugins: [writer, reader] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.EXTENSION_POINT_VERSION_MISMATCH,
    );
  });

  it("collects typed extension contributions with their owner", async () => {
    interface Widget {
      readonly name: string;
    }
    const WidgetPoint = defineExtensionPoint<Widget>({
      id: "test.widgets",
      version: "1.0.0",
    });

    const host = definePlugin({
      id: "host",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.extensions.contribute(WidgetPoint, { name: "from-host" });
      },
    });

    const addon = definePlugin({
      id: "addon",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(ctx) {
        ctx.extensions.contribute(WidgetPoint, { name: "from-addon" });
      },
    });

    let collected: readonly { pluginId: string; value: Widget }[] = [];

    const reader = definePlugin({
      id: "reader",
      version: "0.1.0",
      engineRange: "^0.1.20",
      start(ctx) {
        collected = ctx.extensions.all(WidgetPoint);
      },
    });

    const engine = createEngine({ plugins: [host, addon, reader] });
    await engine.start();

    expect(collected.map((c) => `${c.pluginId}:${c.value.name}`)).toEqual([
      "host:from-host",
      "addon:from-addon",
    ]);
  });

  it("runs each migration once and records it", async () => {
    const ran: string[] = [];

    const plugin = definePlugin({
      id: "migrating",
      version: "0.1.0",
      engineRange: "^0.1.20",
      migrations: [
        {
          id: "0001-init",
          checksum: "1".repeat(64),
          risk: "low",
          requiresBackup: false,
          externalEffects: [],
          up: async () => void ran.push("0001-init"),
        },
        {
          id: "0002-more",
          checksum: "2".repeat(64),
          risk: "low",
          requiresBackup: false,
          externalEffects: [],
          up: async () => void ran.push("0002-more"),
        },
      ],
    });

    const engine = createEngine({ plugins: [plugin] });
    await engine.start();
    await engine.stop();
    await engine.start();

    expect(ran).toEqual(["0001-init", "0002-more"]);
  });
  it("preflights every pending migration before mutation and detects checksum drift", async () => {
    const ran: string[] = [];
    const journal = new InMemoryMigrationJournal();
    const migration = {
      id: "0001-risky",
      checksum: "a".repeat(64),
      risk: "high" as const,
      requiresBackup: true,
      externalEffects: [],
      preflight: async () => void ran.push("preflight"),
      up: async () => void ran.push("up"),
    };
    const plugin = definePlugin({
      id: "preflight",
      version: "0.1.0",
      engineRange: "^0.1.20",
      migrations: [migration],
    });
    const rejected = createEngine({ plugins: [plugin], migrationJournal: journal });
    await expect(rejected.start()).rejects.toThrow("MIGRATION_BACKUP_REQUIRED");
    expect(ran).toEqual([]);

    const accepted = createEngine({
      plugins: [plugin],
      migrationJournal: journal,
      confirmMigrationBackup: () => true,
    });
    await accepted.start();
    expect(ran).toEqual(["preflight", "up"]);
    await accepted.stop();

    const changed = definePlugin({
      id: "preflight",
      version: "0.1.1",
      engineRange: "^0.1.20",
      migrations: [{ ...migration, checksum: "b".repeat(64) }],
    });
    const drifted = createEngine({ plugins: [changed], migrationJournal: journal });
    await expect(drifted.start()).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH");
  });

  it("does not query the migration journal for migration-free plugins", async () => {
    let journalCalls = 0;
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
    const plugin = definePlugin({
      id: "without-migrations",
      version: "1.0.0",
      engineRange: "^0.1.20",
    });

    const engine = createEngine({ plugins: [plugin], migrationJournal: journal });
    await engine.start();
    expect(journalCalls).toBe(0);
  });

  it("rejects corrupt migration journal snapshots before migration work", async () => {
    const migration = {
      id: "0001-safe",
      checksum: "a".repeat(64),
      risk: "high" as const,
      requiresBackup: true,
      externalEffects: ["declared effect"],
      preflight: async () => undefined,
      up: async () => undefined,
    };
    const snapshots: readonly unknown[] = [
      { private: "private-object" },
      [
        { id: migration.id, checksum: migration.checksum },
        { id: migration.id, checksum: migration.checksum },
      ],
      Array.from({ length: MIGRATION_JOURNAL_MAX_ENTRIES + 1 }, (_, index) => ({
        id: `oversized-${index}`,
      })),
      [{ id: migration.id, checksum: "private-checksum" }],
      [{ id: "private\nmigration", checksum: migration.checksum }],
    ];

    for (const snapshot of snapshots) {
      let approvalCalls = 0;
      let preflightCalls = 0;
      let upCalls = 0;
      let startCalls = 0;
      let runCalls = 0;
      const plugin = definePlugin({
        id: "journal-reader",
        version: "1.0.0",
        engineRange: "^0.1.20",
        migrations: [
          {
            ...migration,
            preflight: async () => {
              preflightCalls += 1;
            },
            up: async () => {
              upCalls += 1;
            },
          },
        ],
        start() {
          startCalls += 1;
        },
      });
      const journal: MigrationJournal = {
        applied: async () => snapshot as readonly AppliedMigration[],
        record: async () => undefined,
        run: async () => {
          runCalls += 1;
          return "applied";
        },
      };
      const engine = createEngine({
        plugins: [plugin],
        migrationJournal: journal,
        confirmMigrationBackup: () => {
          approvalCalls += 1;
          return true;
        },
        approveMigrationExternalEffects: () => {
          approvalCalls += 1;
          return true;
        },
      });

      let failure: unknown;
      try {
        await engine.start();
      } catch (error) {
        failure = error;
      }
      expect((failure as PrismError).diagnostics).toMatchObject([
        {
          code: "MIGRATION_JOURNAL_INVALID",
          message: "Migration journal returned invalid metadata.",
          details: { pluginId: plugin.id },
        },
      ]);
      expect(JSON.stringify(failure)).not.toContain("private");
      expect(approvalCalls).toBe(0);
      expect(preflightCalls).toBe(0);
      expect(upCalls).toBe(0);
      expect(startCalls).toBe(0);
      expect(runCalls).toBe(0);
    }
  });

  it("accepts the journal row boundary and checksum-less legacy rows", async () => {
    let preflightCalls = 0;
    let upCalls = 0;
    let startCalls = 0;
    const migration = {
      id: "historical-0",
      checksum: "b".repeat(64),
      risk: "low" as const,
      requiresBackup: false,
      externalEffects: [],
      preflight: async () => {
        preflightCalls += 1;
      },
      up: async () => {
        upCalls += 1;
      },
    };
    const snapshot = Array.from({ length: MIGRATION_JOURNAL_MAX_ENTRIES }, (_, index) => ({
      id: `historical-${index}`,
    }));
    const journal: MigrationJournal = {
      applied: async () => snapshot,
      record: async () => undefined,
      run: async (_pluginId, _migrationId, _checksum, _action) => "skipped",
    };
    const plugin = definePlugin({
      id: "legacy-journal",
      version: "1.0.0",
      engineRange: "^0.1.20",
      migrations: [migration],
      start() {
        startCalls += 1;
      },
    });

    const engine = createEngine({ plugins: [plugin], migrationJournal: journal });
    await engine.start();
    expect(preflightCalls).toBe(0);
    expect(upCalls).toBe(0);
    expect(startCalls).toBe(1);
  });
  it("serializes the same migration across concurrent Engines", async () => {
    const journal = new InMemoryMigrationJournal();
    const started = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const plugin = definePlugin({
      id: "concurrent-migration",
      version: "0.1.0",
      engineRange: "^0.1.20",
      migrations: [
        {
          id: "0001-once",
          checksum: "c".repeat(64),
          risk: "low",
          requiresBackup: false,
          externalEffects: [],
          async up() {
            runs += 1;
            started.resolve();
            await release.promise;
          },
        },
      ],
    });
    const first = createEngine({ plugins: [plugin], migrationJournal: journal });
    const second = createEngine({ plugins: [plugin], migrationJournal: journal });
    const firstStart = first.start();
    await started.promise;
    const secondStart = second.start();
    release.resolve();
    await Promise.all([firstStart, secondStart]);
    expect(runs).toBe(1);
    await Promise.all([first.stop(), second.stop()]);
  });

  it("exposes the dependency graph for the capability inspector", async () => {
    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: { greeter: GreeterCapability },
    });

    const engine = createEngine({ plugins: [greeterPlugin, consumer] });
    await engine.start();

    const inspection = engine.inspect();
    expect(inspection.startOrder).toEqual(["greeter", "consumer"]);
    expect(inspection.capabilities).toEqual([
      { id: "test.greeter", version: "1.2.0", providedBy: "greeter" },
    ]);
    expect(inspection.plugins.find((p) => p.id === "consumer")?.requires).toEqual([
      {
        key: "greeter",
        capabilityId: "test.greeter",
        range: "^1.2.0",
        optional: false,
        resolvedTo: "greeter",
      },
    ]);
  });

  it("restarts cleanly after a stop", async () => {
    const events: string[] = [];

    const provider = definePlugin({
      id: "restartable",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [GreeterCapability],
      register(ctx) {
        events.push("register");
        ctx.provide(GreeterCapability, { greet: () => "hello" });
        ctx.resources.define({
          kind: "restartable.thing",
          title: "可重启资源",
          config: { schema: { type: "object" } },
          exposure: { configuration: true },
        });
      },
      start: () => void events.push("start"),
      stop: () => void events.push("stop"),
    });

    const engine = createEngine({ plugins: [provider] });
    await engine.start();
    await engine.stop();
    // A second boot must not trip the frozen capability registry, and must not
    // double-register the resource type.
    await engine.start();

    expect(events).toEqual(["register", "start", "stop", "register", "start"]);
    expect(engine.currentPhase).toBe("started");

    const inspection = engine.inspect();
    expect(inspection.capabilities).toHaveLength(1);
    expect(inspection.resourceTypes.map((type) => type.kind)).toEqual([
      "restartable.thing",
    ]);
    expect(inspection.startOrder).toEqual(["restartable"]);

    await engine.stop();
  });

  it("gives each boot a distinct id, so cross-boot caches can invalidate", async () => {
    const engine = createEngine({ plugins: [greeterPlugin] });
    expect(engine.bootId).toBe(0);

    await engine.start();
    const first = engine.bootId;
    expect(first).toBe(1);

    await engine.stop();
    await engine.start();

    // The engine reference survives a restart; the state behind it does not.
    // Anything cached against the reference alone would never invalidate.
    expect(engine.bootId).toBe(2);

    await engine.stop();
  });

  it("retries cleanly after a failed boot without an intervening stop", async () => {
    let failNext = true;

    const flaky = definePlugin({
      id: "flaky",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [GreeterCapability],
      register(ctx) {
        ctx.provide(GreeterCapability, { greet: () => "hello" });
      },
      start() {
        if (failNext) {
          failNext = false;
          throw new Error("first boot fails");
        }
      },
    });

    const engine = createEngine({ plugins: [flaky] });
    await expect(codesFrom(() => engine.start())).resolves.toContain(
      EngineDiagnosticCode.PLUGIN_START_FAILED,
    );

    // A failed boot leaves the capability store frozen and partial writes in
    // the registries. Retrying directly must not fail for those reasons.
    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.currentPhase).toBe("started");
    expect(engine.inspect().capabilities).toHaveLength(1);

    await engine.stop();
  });
});
