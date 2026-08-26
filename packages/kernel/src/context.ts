import type { Diagnostic } from "@prism/contracts-data";
import type { EventBus } from "./events.js";
import type { ResourceTypeDefinition } from "./resource.js";
import type {
  CapabilityToken,
  RequirementMap,
  ResolvedDependencies,
} from "./capability.js";
import type { ExtensionRegistry } from "./extension.js";

export interface PluginIdentity {
  readonly id: string;
  readonly version: string;
}

export interface Logger {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface DiagnosticsSink {
  report(diagnostic: Diagnostic): void;
}

/**
 * Capability access is restricted to what the plugin declared in `requires`.
 * Reaching for an undeclared capability is a `CAPABILITY_UNDECLARED_ACCESS`
 * error, not a lucky success - otherwise the dependency graph is fiction.
 *
 * Business code should use `ctx.dependencies`; this accessor exists for
 * dynamic/optional lookups.
 */
export interface ServiceAccessor {
  get<TService>(token: CapabilityToken<TService>): TService;
  tryGet<TService>(token: CapabilityToken<TService>): TService | undefined;
}

/** Registry of configurable resource types. Kernel-generic: kind + schema. */
export interface ResourceTypeRegistry {
  define<TSpec>(definition: ResourceTypeDefinition<TSpec>): void;
  get(kind: string): ResourceTypeDefinition | undefined;
  list(): readonly ResourceTypeDefinition[];
  /** Owning plugin of a resource kind. */
  ownerOf(kind: string): string | undefined;
}

export interface PluginContext<TRequires extends RequirementMap = RequirementMap> {
  readonly plugin: PluginIdentity;
  readonly dependencies: ResolvedDependencies<TRequires>;
  readonly services: ServiceAccessor;
  readonly resources: ResourceTypeRegistry;
  readonly extensions: ExtensionRegistry;
  readonly events: EventBus;
  readonly diagnostics: DiagnosticsSink;
  readonly logger: Logger;
}

/**
 * Register-phase context. Capability provision is only legal here: after the
 * register phase the capability registry is frozen, so `start()` can assume a
 * complete, stable graph.
 */
export interface PluginRegisterContext<
  TRequires extends RequirementMap = RequirementMap,
> extends PluginContext<TRequires> {
  provide<TService>(token: CapabilityToken<TService>, service: TService): void;
}
