import { describe, expect, it } from "vitest";
import { EngineDiagnosticCode, PrismError } from "@prismengine/contracts-data";
import { createEngine, defineCapability, defineExtensionPoint, definePlugin } from "@prismengine/kernel";

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
      provides: [CounterCapability],
      register(ctx) {
        ctx.provide(CounterCapability, { next: () => 1 });
      },
      start: () => void order.push("a"),
    });

    const b = definePlugin({
      id: "b",
      version: "0.1.0",
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
      provides: [CounterCapability],
      register(ctx) {
        ctx.provide(CounterCapability, { next: () => 1 });
      },
      stop: () => void order.push("provider"),
    });

    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
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
      provides: [CapA],
      requires: { b: CapB },
      register(ctx) {
        ctx.provide(CapA, { greet: () => "a" });
      },
    });

    const b = definePlugin({
      id: "b",
      version: "0.1.0",
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
      register: () => void events.push("first:register"),
      stop: () => void events.push("first:stop"),
    });
    const broken = definePlugin({
      id: "broken-register",
      version: "0.1.0",
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

  it("blocks access to a capability the plugin did not declare", async () => {
    let thrown: unknown;

    const sneaky = definePlugin({
      id: "sneaky",
      version: "0.1.0",
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
    let captured: { provide: (token: typeof CounterCapability, service: Counter) => void } | undefined;

    const late = definePlugin({
      id: "late",
      version: "0.1.0",
      // Both are declared, so the failure below is about phase, not declaration.
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
      register(ctx) {
        ctx.extensions.contribute(V1, { name: "v1" });
      },
    });
    const incompatible = definePlugin({
      id: "extension-v2",
      version: "0.1.0",
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
      register(ctx) {
        ctx.extensions.contribute(V1, "value");
      },
    });
    const reader = definePlugin({
      id: "versioned-reader",
      version: "0.1.0",
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
      register(ctx) {
        ctx.extensions.contribute(WidgetPoint, { name: "from-host" });
      },
    });

    const addon = definePlugin({
      id: "addon",
      version: "0.1.0",
      register(ctx) {
        ctx.extensions.contribute(WidgetPoint, { name: "from-addon" });
      },
    });

    let collected: readonly { pluginId: string; value: Widget }[] = [];

    const reader = definePlugin({
      id: "reader",
      version: "0.1.0",
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
      migrations: [
        { id: "0001-init", up: async () => void ran.push("0001-init") },
        { id: "0002-more", up: async () => void ran.push("0002-more") },
      ],
    });

    const engine = createEngine({ plugins: [plugin] });
    await engine.start();
    await engine.stop();
    await engine.start();

    expect(ran).toEqual(["0001-init", "0002-more"]);
  });

  it("exposes the dependency graph for the capability inspector", async () => {
    const consumer = definePlugin({
      id: "consumer",
      version: "0.1.0",
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
