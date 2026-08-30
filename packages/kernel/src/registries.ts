import { EngineDiagnosticCode, PrismError } from "@prismengine/contracts-data";
import type { Diagnostic } from "@prismengine/contracts-data";
import type { CapabilityToken } from "./capability.js";
import type {
  DiagnosticsSink,
  Logger,
  ResourceTypeRegistry,
  ServiceAccessor,
} from "./context.js";
import type { EventBus, EventHandler, PrismEvent, Unsubscribe } from "./events.js";
import {
  assertEventCorrelationId,
  assertEventSubscription,
  assertEventType,
} from "./events.js";
import type { Contribution, ExtensionPoint, ExtensionRegistry } from "./extension.js";
import type { ResourceTypeDefinition } from "./resource.js";

/**
 * Every kernel registry has the same shape: one engine-wide store, plus a
 * per-plugin scoped view that tags each write with its owning plugin id.
 * Ownership is what turns the capability inspector and the exposure rules into
 * something enforceable rather than advisory.
 */

interface CapabilityEntry {
  readonly pluginId: string;
  readonly version: string;
  readonly service: unknown;
}

/** Global capability store. Frozen once the register phase completes. */
export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  private frozen = false;

  provide(pluginId: string, token: CapabilityToken<unknown>, service: unknown): void {
    if (this.frozen) {
      throw PrismError.of(
        EngineDiagnosticCode.LIFECYCLE_PHASE_VIOLATION,
        `Plugin "${pluginId}" tried to provide capability "${token.id}" after the register phase.`,
        { pluginId, capabilityId: token.id },
      );
    }
    const existing = this.entries.get(token.id);
    if (existing) {
      throw PrismError.of(
        EngineDiagnosticCode.CAPABILITY_DUPLICATE_PROVIDER,
        `Capability "${token.id}" already provided by "${existing.pluginId}".`,
        { capabilityId: token.id, pluginId, existingPluginId: existing.pluginId },
      );
    }
    this.entries.set(token.id, { pluginId, version: token.version, service });
  }

  freeze(): void {
    this.frozen = true;
  }

  lookup(capabilityId: string): CapabilityEntry | undefined {
    return this.entries.get(capabilityId);
  }

  ids(): readonly string[] {
    return [...this.entries.keys()];
  }
}

/**
 * Per-plugin view over the capability registry. `allowed` holds the capability
 * ids the plugin declared in `requires` plus those it provides itself.
 * Anything else throws: an undeclared edge would make the dependency graph a
 * decorative diagram.
 */
export class ScopedServiceAccessor implements ServiceAccessor {
  constructor(
    private readonly pluginId: string,
    private readonly registry: CapabilityRegistry,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  get<TService>(token: CapabilityToken<TService>): TService {
    const service = this.tryGet(token);
    if (service === undefined) {
      throw PrismError.of(
        EngineDiagnosticCode.CAPABILITY_NOT_PROVIDED,
        `Capability "${token.id}" is declared by "${this.pluginId}" but no provider is registered.`,
        { pluginId: this.pluginId, capabilityId: token.id },
      );
    }
    return service;
  }

  tryGet<TService>(token: CapabilityToken<TService>): TService | undefined {
    if (!this.allowed.has(token.id)) {
      throw PrismError.of(
        EngineDiagnosticCode.CAPABILITY_UNDECLARED_ACCESS,
        `Plugin "${this.pluginId}" accessed capability "${token.id}" without declaring it in "requires".`,
        { pluginId: this.pluginId, capabilityId: token.id },
      );
    }
    return this.registry.lookup(token.id)?.service as TService | undefined;
  }
}

interface ResourceTypeEntry {
  readonly pluginId: string;
  readonly definition: ResourceTypeDefinition;
}

export class ResourceTypeStore {
  private readonly entries = new Map<string, ResourceTypeEntry>();

  define(pluginId: string, definition: ResourceTypeDefinition): void {
    const existing = this.entries.get(definition.kind);
    if (existing) {
      throw PrismError.of(
        EngineDiagnosticCode.RESOURCE_TYPE_DUPLICATE,
        `Resource type "${definition.kind}" already defined by "${existing.pluginId}".`,
        { kind: definition.kind, pluginId },
      );
    }
    this.entries.set(definition.kind, { pluginId, definition });
  }

  get(kind: string): ResourceTypeDefinition | undefined {
    return this.entries.get(kind)?.definition;
  }

  list(): readonly ResourceTypeDefinition[] {
    return [...this.entries.values()].map((entry) => entry.definition);
  }

  ownerOf(kind: string): string | undefined {
    return this.entries.get(kind)?.pluginId;
  }

  scopedTo(pluginId: string): ResourceTypeRegistry {
    return {
      define: (definition) => this.define(pluginId, definition as ResourceTypeDefinition),
      get: (kind) => this.get(kind),
      list: () => this.list(),
      ownerOf: (kind) => this.ownerOf(kind),
    };
  }
}

interface ExtensionPointEntry {
  readonly version: string;
  readonly contributions: Contribution<unknown>[];
}

export class ExtensionStore {
  private readonly points = new Map<string, ExtensionPointEntry>();

  contribute<T>(pluginId: string, point: ExtensionPoint<T>, value: T): void {
    const entry = this.points.get(point.id);
    if (entry !== undefined && entry.version !== point.version) {
      throw extensionVersionMismatch(point.id, entry.version, point.version, pluginId);
    }
    if (entry !== undefined) {
      entry.contributions.push({ pluginId, value });
    } else {
      this.points.set(point.id, {
        version: point.version,
        contributions: [{ pluginId, value }],
      });
    }
  }

  all<T>(point: ExtensionPoint<T>): readonly Contribution<T>[] {
    const entry = this.points.get(point.id);
    if (entry === undefined) return [];
    if (entry.version !== point.version) {
      throw extensionVersionMismatch(point.id, entry.version, point.version);
    }
    return entry.contributions as readonly Contribution<T>[];
  }

  pointIds(): readonly string[] {
    return [...this.points.keys()];
  }

  scopedTo(pluginId: string): ExtensionRegistry {
    return {
      contribute: (point, value) => this.contribute(pluginId, point, value),
      all: <T>(point: ExtensionPoint<T>) => this.all<T>(point),
      values: <T>(point: ExtensionPoint<T>) =>
        this.all<T>(point).map((contribution) => contribution.value),
    };
  }
}

function extensionVersionMismatch(
  pointId: string,
  registeredVersion: string,
  requestedVersion: string,
  pluginId?: string,
): PrismError {
  return PrismError.of(
    EngineDiagnosticCode.EXTENSION_POINT_VERSION_MISMATCH,
    `Extension point "${pointId}" version mismatch: registered ${registeredVersion}, requested ${requestedVersion}.`,
    {
      pointId,
      registeredVersion,
      requestedVersion,
      ...(pluginId === undefined ? {} : { pluginId }),
    },
  );
}

export class EventBusStore {
  // One store holds handlers for every event type; the payload type is
  // recovered at the subscribe/publish boundary, which is where it is
  // checkable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, Set<EventHandler<any>>>();

  constructor(
    private readonly onHandlerError?: (error: unknown, event: PrismEvent) => void,
  ) {}

  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): Unsubscribe {
    assertEventSubscription(type);
    // See the handlers field above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const set = this.handlers.get(type) ?? new Set<EventHandler<any>>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  async publish(source: string, event: Omit<PrismEvent, "source">): Promise<void> {
    assertEventType(event.type);
    if (event.correlationId !== undefined) {
      assertEventCorrelationId(event.correlationId);
    }
    const full: PrismEvent = { ...event, source };
    for (const pattern of matchingPatterns(full.type)) {
      for (const handler of this.handlers.get(pattern) ?? []) {
        try {
          await handler(full);
        } catch (error) {
          // A failing subscriber must never abort the publisher.
          this.onHandlerError?.(error, full);
        }
      }
    }
  }

  scopedTo(pluginId: string): EventBus {
    return {
      publish: (type, payload, options) =>
        this.publish(pluginId, {
          type,
          payload,
          occurredAt: new Date().toISOString(),
          ...(options?.correlationId === undefined
            ? {}
            : { correlationId: options.correlationId }),
        }),
      subscribe: (type, handler) => this.subscribe(type, handler),
    };
  }
}

/** Exact type, every trailing-wildcard prefix, and the global "*". */
function matchingPatterns(type: string): readonly string[] {
  const patterns = [type, "*"];
  const segments = type.split(".");
  for (let i = segments.length - 1; i > 0; i -= 1) {
    patterns.push(`${segments.slice(0, i).join(".")}.*`);
  }
  return patterns;
}

export class DiagnosticsCollector implements DiagnosticsSink {
  private readonly items: Diagnostic[] = [];

  report(item: Diagnostic): void {
    this.items.push(item);
  }

  reportAll(items: readonly Diagnostic[]): void {
    this.items.push(...items);
  }

  toArray(): readonly Diagnostic[] {
    return [...this.items];
  }
}

export function consoleLogger(pluginId: string): Logger {
  const emit = (
    level: "log" | "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    const line = `[${pluginId}] ${message}`;
    if (details) console[level](line, details);
    else console[level](line);
  };

  return {
    debug: (message, details) => emit("log", message, details),
    info: (message, details) => emit("info", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
  };
}

export function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
