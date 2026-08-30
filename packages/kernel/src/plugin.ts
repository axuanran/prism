import type { AnyCapabilityToken, RequirementMap } from "./capability.js";
import type { PluginContext, PluginRegisterContext } from "./context.js";
import { assertPluginDefinition } from "./identity.js";

export interface Migration {
  /** Unique within the plugin; recorded so it runs at most once. */
  readonly id: string;
  /** Immutable checksum of the migration implementation/DDL. */
  readonly checksum: string;
  readonly risk: "low" | "medium" | "high";
  readonly requiresBackup: boolean;
  readonly externalEffects: readonly string[];
  preflight?(context: MigrationContext): Promise<void>;
  up(context: MigrationContext): Promise<void>;
}

export interface MigrationContext {
  readonly pluginId: string;
}

export interface PluginDefinition<TRequires extends RequirementMap = RequirementMap> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  /** Semver range of compatible Prism Engine versions. */
  readonly engineRange?: string;

  /** Declared capability dependencies. The only legal way to reach another plugin. */
  readonly requires?: TRequires;

  /** Capability contracts this plugin implements. */
  readonly provides?: readonly AnyCapabilityToken[];

  readonly migrations?: readonly Migration[];

  /**
   * Wiring phase. Provide capabilities, define resource types, contribute
   * extensions. Must not perform I/O against other plugins' services: not
   * every plugin has started yet.
   */
  register?(context: PluginRegisterContext<TRequires>): void | Promise<void>;

  /** Runtime phase. Dependencies are started before this plugin. */
  start?(context: PluginContext<TRequires>): void | Promise<void>;

  /** Runs in reverse dependency order. */
  stop?(context: PluginContext<TRequires>): void | Promise<void>;
}

/**
 * Identity function that pins `TRequires` so `ctx.dependencies` is typed from
 * the `requires` map. This is the DI seam - inference is the whole product.
 */
export function definePlugin<const TRequires extends RequirementMap>(
  definition: PluginDefinition<TRequires>,
): PluginDefinition<TRequires> {
  assertPluginDefinition(definition);
  return definition;
}

/** Erased form used by the engine internals. */
export type AnyPluginDefinition = PluginDefinition<RequirementMap>;
