import {
  EngineDiagnosticCode,
  PrismError,
  diagnostic,
  hasErrors,
} from "@prismengine/contracts-data";
import type { Diagnostic } from "@prismengine/contracts-data";
import { normalizeRequirement } from "./capability.js";
import type { CapabilityToken, RequirementMap } from "./capability.js";
import type { Logger, PluginContext, PluginRegisterContext } from "./context.js";
import type { EventBus } from "./events.js";
import type { AnyPluginDefinition, Migration } from "./plugin.js";
import { assertKernelId } from "./identity.js";
import { resolvePlugins } from "./resolver.js";
import type { Resolution } from "./resolver.js";
import {
  CapabilityRegistry,
  DiagnosticsCollector,
  EventBusStore,
  ExtensionStore,
  ResourceTypeStore,
  ScopedServiceAccessor,
  silentLogger,
} from "./registries.js";
import type { ResourceTypeDefinition } from "./resource.js";
import { ENGINE_VERSION } from "./version.js";

export { ENGINE_VERSION } from "./version.js";

export interface AppliedMigration {
  readonly id: string;
  readonly checksum?: string;
}

export const MIGRATION_JOURNAL_MAX_ENTRIES = 10_000;

/** Records which migrations already ran. Storage plugins supply a durable one. */
export interface MigrationJournal {
  applied(pluginId: string): Promise<readonly AppliedMigration[]>;
  record(pluginId: string, migrationId: string, checksum: string): Promise<void>;
  run(
    pluginId: string,
    migrationId: string,
    checksum: string,
    action: () => Promise<void>,
  ): Promise<"applied" | "skipped">;
}

export class InMemoryMigrationJournal implements MigrationJournal {
  private readonly entries = new Map<string, Map<string, string>>();
  private readonly locks = new Map<string, Promise<void>>();

  async applied(pluginId: string): Promise<readonly AppliedMigration[]> {
    return [...(this.entries.get(pluginId) ?? [])].map(([id, checksum]) => ({
      id,
      checksum,
    }));
  }

  async record(pluginId: string, migrationId: string, checksum: string): Promise<void> {
    const entries = this.entries.get(pluginId) ?? new Map<string, string>();
    entries.set(migrationId, checksum);
    this.entries.set(pluginId, entries);
  }

  async run(
    pluginId: string,
    migrationId: string,
    checksum: string,
    action: () => Promise<void>,
  ): Promise<"applied" | "skipped"> {
    const key = `${pluginId}\u0000${migrationId}`;
    const prior = this.locks.get(key) ?? Promise.resolve();
    let result: "applied" | "skipped" = "skipped";
    const current = prior.then(async () => {
      const existing = this.entries.get(pluginId)?.get(migrationId);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw PrismError.of(
            "MIGRATION_CHECKSUM_MISMATCH",
            "An applied migration implementation changed.",
            { pluginId, migrationId, expected: existing, actual: checksum },
          );
        }
        return;
      }
      await action();
      await this.record(pluginId, migrationId, checksum);
      result = "applied";
    });
    this.locks.set(key, current);
    try {
      await current;
      return result;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export interface EngineOptions {
  readonly plugins: readonly AnyPluginDefinition[];
  readonly logger?: (pluginId: string) => Logger;
  readonly migrationJournal?: MigrationJournal;
  readonly onEventHandlerError?: (error: unknown) => void;
  readonly confirmMigrationBackup?: (
    pluginId: string,
    migration: Migration,
  ) => boolean | Promise<boolean>;
  readonly approveMigrationExternalEffects?: (
    pluginId: string,
    migration: Migration,
  ) => boolean | Promise<boolean>;
}

export type EnginePhase = "created" | "resolved" | "registered" | "started" | "stopped";

export interface CapabilityInfo {
  readonly id: string;
  readonly version: string;
  readonly providedBy: string;
}

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly provides: readonly string[];
  readonly requires: readonly {
    readonly key: string;
    readonly capabilityId: string;
    readonly range: string;
    readonly optional: boolean;
    readonly resolvedTo: string | undefined;
  }[];
  readonly resourceKinds: readonly string[];
}

/** What the capability inspector renders. Developer-facing, not business UI. */
export interface EngineInspection {
  readonly phase: EnginePhase;
  readonly engineVersion: string;
  readonly startOrder: readonly string[];
  readonly plugins: readonly PluginInfo[];
  readonly capabilities: readonly CapabilityInfo[];
  readonly resourceTypes: readonly ResourceTypeDefinition[];
  readonly extensionPoints: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

interface PluginRuntime {
  readonly definition: AnyPluginDefinition;
  readonly context: PluginRegisterContext<RequirementMap>;
}

export class Engine {
  /**
   * Registries are rebuilt on restart, not reused: the capability registry is
   * frozen after `register`, and the resource-type and extension stores reject
   * duplicates. Reusing them would make a second `start()` either throw or,
   * worse, silently double-register.
   *
   * `events` and the migration journal deliberately survive a restart -
   * subscribers outlive a boot cycle, and a migration must not run twice.
   */
  private capabilities = new CapabilityRegistry();
  private resourceTypes = new ResourceTypeStore();
  private extensions = new ExtensionStore();
  private readonly events: EventBusStore;
  private diagnostics = new DiagnosticsCollector();
  private runtimes: PluginRuntime[] = [];
  private started: PluginRuntime[] = [];
  private readonly makeLogger: (pluginId: string) => Logger;
  private readonly journal: MigrationJournal;

  private resolution: Resolution | undefined;
  private phase: EnginePhase = "created";
  private boot = 0;

  constructor(private readonly options: EngineOptions) {
    this.makeLogger = options.logger ?? silentLogger.bind(null);
    this.journal = options.migrationJournal ?? new InMemoryMigrationJournal();
    this.events = new EventBusStore((error) => options.onEventHandlerError?.(error));
  }

  get currentPhase(): EnginePhase {
    return this.phase;
  }

  /**
   * Increments on every successful boot.
   *
   * Anything cached across a boundary the engine can cross - a seeded fixture,
   * a warmed lookup, a memoized capability handle - must compare this, not the
   * engine reference. The reference survives a restart; the state behind it
   * does not.
   */
  get bootId(): number {
    return this.boot;
  }

  /** Engine-wide bus for hosts and tests. Plugins get a scoped view instead. */
  get eventBus(): EventBus {
    return this.events.scopedTo("engine");
  }

  /**
   * discover -> resolve -> register -> start.
   *
   * Any resolution error aborts before a single plugin runs: a partially wired
   * engine is worse than a failed boot. A failure during `start` rolls back by
   * stopping everything already started, in reverse order.
   */
  async start(): Promise<void> {
    if (this.phase === "started") return;

    // Every boot after the first begins from clean registries, including a
    // retry after a FAILED boot. A failed `register` leaves partial writes and
    // a failed `start` leaves the capability store frozen; reusing either
    // would make the retry fail for reasons that have nothing to do with the
    // original fault.
    if (this.phase !== "created") {
      this.capabilities = new CapabilityRegistry();
      this.resourceTypes = new ResourceTypeStore();
      this.extensions = new ExtensionStore();
      this.diagnostics = new DiagnosticsCollector();
      this.runtimes = [];
      this.started = [];
    }

    const resolution = resolvePlugins(this.options.plugins);
    this.resolution = resolution;
    this.diagnostics.reportAll(resolution.diagnostics);
    if (hasErrors(resolution.diagnostics)) {
      throw new PrismError(
        resolution.diagnostics.filter((d) => d.severity === "error"),
        "Plugin resolution failed.",
      );
    }
    this.phase = "resolved";

    for (const definition of resolution.order) {
      const context = this.createContext(definition);
      const runtime = { definition, context };
      this.runtimes.push(runtime);
      try {
        await definition.register?.(context);
      } catch (error) {
        // Registration may allocate external resources before throwing.
        // Nothing has "started" yet, so rollback() has nothing to stop; clean
        // every registered runtime explicitly, including the failing one.
        await this.cleanupRegistered();
        throw wrap(error, EngineDiagnosticCode.PLUGIN_REGISTER_FAILED, definition.id);
      }
    }

    // Capabilities are frozen here so `start()` can assume a complete graph.
    this.capabilities.freeze();
    this.phase = "registered";
    try {
      await this.preflightMigrations(this.runtimes.map((runtime) => runtime.definition));
    } catch (error) {
      await this.cleanupRegistered();
      throw wrap(error, EngineDiagnosticCode.PLUGIN_START_FAILED, "migration-preflight");
    }

    for (const runtime of this.runtimes) {
      try {
        await this.runMigrations(runtime.definition);
        await runtime.definition.start?.(runtime.context);
        this.started.push(runtime);
      } catch (error) {
        // The current plugin is not in `started`: start did not complete. It
        // may still own a pool/socket allocated during register or start, so
        // clean it before rolling back those that did complete.
        await this.cleanupRuntime(runtime);
        await this.rollback();
        throw wrap(error, EngineDiagnosticCode.PLUGIN_START_FAILED, runtime.definition.id);
      }
    }

    this.boot += 1;
    this.phase = "started";
  }

  async stop(): Promise<void> {
    await this.rollback();
    this.phase = "stopped";
  }

  /**
   * Host-side capability access.
   *
   * Legitimate here and nowhere else: the host is what composed the plugin
   * list, so it already knows the whole graph. Plugins stay restricted to
   * their declared `requires` - this is not a back door for them.
   */
  capability<TService>(token: CapabilityToken<TService>): TService {
    const entry = this.capabilities.lookup(token.id);
    if (!entry) {
      throw PrismError.of(
        EngineDiagnosticCode.CAPABILITY_NOT_PROVIDED,
        `No plugin provides capability "${token.id}".`,
        { capabilityId: token.id },
      );
    }
    return entry.service as TService;
  }

  inspect(): EngineInspection {
    const bindings = this.resolution?.bindings;
    return {
      phase: this.phase,
      engineVersion: ENGINE_VERSION,
      startOrder: (this.resolution?.order ?? []).map((p) => p.id),
      plugins: this.options.plugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        ...(plugin.description ? { description: plugin.description } : {}),
        provides: (plugin.provides ?? []).map((token) => token.id),
        requires: (bindings?.get(plugin.id) ?? []).map((binding) => ({
          key: binding.key,
          capabilityId: binding.capabilityId,
          range: binding.range,
          optional: binding.optional,
          resolvedTo: binding.providerPluginId,
        })),
        resourceKinds: this.resourceTypes
          .list()
          .filter((definition) => this.resourceTypes.ownerOf(definition.kind) === plugin.id)
          .map((definition) => definition.kind),
      })),
      capabilities: this.capabilities.ids().map((id) => {
        const entry = this.capabilities.lookup(id);
        return {
          id,
          version: entry?.version ?? "0.0.0",
          providedBy: entry?.pluginId ?? "unknown",
        };
      }),
      resourceTypes: this.resourceTypes.list(),
      extensionPoints: this.extensions.pointIds(),
      diagnostics: this.diagnostics.toArray(),
    };
  }

  private async rollback(): Promise<void> {
    for (const runtime of [...this.started].reverse()) {
      await this.cleanupRuntime(runtime);
    }
    this.started.length = 0;
  }

  /** Cleans runtimes that registered but never reached a successful start. */
  private async cleanupRegistered(): Promise<void> {
    for (const runtime of [...this.runtimes].reverse()) {
      await this.cleanupRuntime(runtime);
    }
  }

  /** Best effort: one failing cleanup must never strand the rest. */
  private async cleanupRuntime(runtime: PluginRuntime): Promise<void> {
    try {
      await runtime.definition.stop?.(runtime.context);
    } catch (error) {
      if (error instanceof PrismError) {
        this.diagnostics.reportAll(error.diagnostics);
        return;
      }
      this.diagnostics.report(
        diagnostic(
          EngineDiagnosticCode.PLUGIN_STOP_FAILED,
          "Plugin lifecycle cleanup failed.",
          {
            details: {
              pluginId: runtime.definition.id,
              errorType: lifecycleErrorType(error),
            },
          },
        ),
      );
    }
  }

  private async preflightMigrations(
    definitions: readonly AnyPluginDefinition[],
  ): Promise<void> {
    for (const definition of definitions) {
      if ((definition.migrations?.length ?? 0) === 0) continue;
      const applied = parseAppliedMigrations(
        definition.id,
        await this.journal.applied(definition.id),
      );
      for (const migration of definition.migrations ?? []) {
        if (!/^[0-9a-f]{64}$/u.test(migration.checksum)) {
          throw PrismError.of(
            "MIGRATION_CHECKSUM_INVALID",
            "Migration checksum must be a lowercase SHA-256 value.",
            { pluginId: definition.id, migrationId: migration.id },
          );
        }
        if (applied.has(migration.id)) {
          const recordedChecksum = applied.get(migration.id);
          if (recordedChecksum !== undefined && recordedChecksum !== migration.checksum) {
            throw PrismError.of(
              "MIGRATION_CHECKSUM_MISMATCH",
              "An applied migration implementation changed.",
              {
                pluginId: definition.id,
                migrationId: migration.id,
                expected: recordedChecksum,
                actual: migration.checksum,
              },
            );
          }
          continue;
        }
        if (
          migration.requiresBackup &&
          (await this.options.confirmMigrationBackup?.(definition.id, migration)) !== true
        ) {
          throw PrismError.of(
            "MIGRATION_BACKUP_REQUIRED",
            "Migration requires an explicitly confirmed backup.",
            { pluginId: definition.id, migrationId: migration.id, risk: migration.risk },
          );
        }
        if (
          migration.externalEffects.length > 0 &&
          (await this.options.approveMigrationExternalEffects?.(
            definition.id,
            migration,
          )) !== true
        ) {
          throw PrismError.of(
            "MIGRATION_EXTERNAL_EFFECTS_APPROVAL_REQUIRED",
            "Migration declares external effects that require explicit approval.",
            {
              pluginId: definition.id,
              migrationId: migration.id,
              externalEffects: migration.externalEffects,
            },
          );
        }
        await migration.preflight?.({ pluginId: definition.id });
      }
    }
  }

  private async runMigrations(definition: AnyPluginDefinition): Promise<void> {
    for (const migration of definition.migrations ?? []) {
      await this.journal.run(definition.id, migration.id, migration.checksum, () =>
        migration.up({ pluginId: definition.id }),
      );
    }
  }

  private createContext(
    definition: AnyPluginDefinition,
  ): PluginRegisterContext<RequirementMap> {
    const declared = new Set<string>();
    for (const spec of Object.values(definition.requires ?? {})) {
      declared.add(normalizeRequirement(spec).token.id);
    }
    for (const token of definition.provides ?? []) declared.add(token.id);

    const services = new ScopedServiceAccessor(definition.id, this.capabilities, declared);

    // Lazy getters: a provider is registered during its own register phase,
    // which topological order guarantees runs before any dependent's.
    const dependencies: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(definition.requires ?? {})) {
      const { token, optional } = normalizeRequirement(spec);
      Object.defineProperty(dependencies, key, {
        enumerable: true,
        get: () => (optional ? services.tryGet(token) : services.get(token)),
      });
    }

    const providable = new Set((definition.provides ?? []).map((token) => token.id));

    return {
      plugin: { id: definition.id, version: definition.version },
      dependencies: dependencies as never,
      services,
      resources: this.resourceTypes.scopedTo(definition.id),
      extensions: this.extensions.scopedTo(definition.id),
      events: this.events.scopedTo(definition.id),
      diagnostics: this.diagnostics,
      logger: this.makeLogger(definition.id),
      provide: <TService>(token: CapabilityToken<TService>, service: TService) => {
        if (!providable.has(token.id)) {
          throw PrismError.of(
            EngineDiagnosticCode.CAPABILITY_NOT_PROVIDED,
            `Plugin "${definition.id}" provided capability "${token.id}" without declaring it in "provides".`,
            { pluginId: definition.id, capabilityId: token.id },
          );
        }
        this.capabilities.provide(
          definition.id,
          token as CapabilityToken<unknown>,
          service,
        );
      },
    } satisfies PluginRegisterContext<RequirementMap>;
  }
}
function parseAppliedMigrations(
  pluginId: string,
  value: unknown,
): Map<string, string | undefined> {
  if (!Array.isArray(value) || value.length > MIGRATION_JOURNAL_MAX_ENTRIES) {
    throw migrationJournalInvalid(pluginId, "snapshot");
  }
  const applied = new Map<string, string | undefined>();
  for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
    const item = value[entryIndex];
    let id: unknown;
    let checksum: unknown;
    try {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw migrationJournalInvalid(pluginId, "entry", entryIndex);
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw migrationJournalInvalid(pluginId, "entry", entryIndex);
      }
      const record = item as Readonly<Record<string, unknown>>;
      id = record.id;
      checksum = record.checksum;
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw migrationJournalInvalid(pluginId, "entry", entryIndex);
    }
    try {
      assertKernelId(id, "id");
    } catch {
      throw migrationJournalInvalid(pluginId, "id", entryIndex);
    }
    if (applied.has(id)) throw migrationJournalInvalid(pluginId, "id", entryIndex);
    if (
      checksum !== undefined &&
      (typeof checksum !== "string" || !/^[0-9a-f]{64}$/u.test(checksum))
    ) {
      throw migrationJournalInvalid(pluginId, "checksum", entryIndex);
    }
    applied.set(id, checksum);
  }
  return applied;
}

function migrationJournalInvalid(
  pluginId: string,
  field: string,
  entryIndex?: number,
): PrismError {
  return PrismError.of(
    "MIGRATION_JOURNAL_INVALID",
    "Migration journal returned invalid metadata.",
    {
      pluginId,
      field,
      ...(entryIndex === undefined ? {} : { entryIndex }),
    },
  );
}

function wrap(error: unknown, code: string, pluginId: string): PrismError {
  if (error instanceof PrismError) return error;
  return PrismError.of(code, "Plugin lifecycle callback failed.", {
    pluginId,
    errorType: lifecycleErrorType(error),
  });
}

function lifecycleErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}

export function createEngine(options: EngineOptions): Engine {
  return new Engine(options);
}

/** Narrow view handed to host code that only needs to read the graph. */
export type EngineHandle = Pick<Engine, "inspect" | "eventBus" | "stop">;

export type { PluginContext };
