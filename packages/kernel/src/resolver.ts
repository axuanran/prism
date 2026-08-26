import { EngineDiagnosticCode, diagnostic } from "@prism/contracts-data";
import type { Diagnostic } from "@prism/contracts-data";
import semver from "semver";
import { normalizeRequirement } from "./capability.js";
import type { AnyPluginDefinition } from "./plugin.js";

export interface ProviderRecord {
  readonly capabilityId: string;
  /** Contract version declared by the provider's token. */
  readonly version: string;
  readonly pluginId: string;
}

export interface BindingRecord {
  /** Key inside the plugin's `requires` map. */
  readonly key: string;
  readonly capabilityId: string;
  readonly range: string;
  readonly optional: boolean;
  /** Undefined when an optional requirement is unsatisfied. */
  readonly providerPluginId: string | undefined;
}

export interface Resolution {
  /** Start order. Reverse it to stop. */
  readonly order: readonly AnyPluginDefinition[];
  readonly providers: ReadonlyMap<string, ProviderRecord>;
  readonly bindings: ReadonlyMap<string, readonly BindingRecord[]>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Resolves the capability dependency graph.
 *
 * Detects, in one pass so the inspector can show every problem at once:
 * duplicate plugin ids, duplicate providers, missing capabilities, semver
 * mismatches and dependency cycles.
 */
export function resolvePlugins(
  plugins: readonly AnyPluginDefinition[],
): Resolution {
  const diagnostics: Diagnostic[] = [];

  const byId = new Map<string, AnyPluginDefinition>();
  for (const plugin of plugins) {
    const existing = byId.get(plugin.id);
    if (existing) {
      diagnostics.push(
        diagnostic(
          EngineDiagnosticCode.PLUGIN_DUPLICATE_ID,
          `Duplicate plugin id "${plugin.id}".`,
          { details: { pluginId: plugin.id } },
        ),
      );
      continue;
    }
    byId.set(plugin.id, plugin);
  }

  const providers = new Map<string, ProviderRecord>();
  for (const plugin of byId.values()) {
    for (const token of plugin.provides ?? []) {
      const existing = providers.get(token.id);
      if (existing) {
        diagnostics.push(
          diagnostic(
            EngineDiagnosticCode.CAPABILITY_DUPLICATE_PROVIDER,
            `Capability "${token.id}" is provided by both "${existing.pluginId}" and "${plugin.id}".`,
            { details: { capabilityId: token.id, plugins: [existing.pluginId, plugin.id] } },
          ),
        );
        continue;
      }
      providers.set(token.id, {
        capabilityId: token.id,
        version: token.version,
        pluginId: plugin.id,
      });
    }
  }

  const bindings = new Map<string, readonly BindingRecord[]>();
  const edges = new Map<string, Set<string>>();

  for (const plugin of byId.values()) {
    const pluginBindings: BindingRecord[] = [];
    const dependsOn = new Set<string>();

    for (const [key, spec] of Object.entries(plugin.requires ?? {})) {
      const { token, range, optional } = normalizeRequirement(spec);
      const provider = providers.get(token.id);

      if (!provider) {
        if (!optional) {
          diagnostics.push(
            diagnostic(
              EngineDiagnosticCode.CAPABILITY_MISSING,
              `Plugin "${plugin.id}" requires capability "${token.id}" (${range}) but no plugin provides it.`,
              { details: { pluginId: plugin.id, capabilityId: token.id, range } },
            ),
          );
        }
        pluginBindings.push({
          key,
          capabilityId: token.id,
          range,
          optional,
          providerPluginId: undefined,
        });
        continue;
      }

      if (!semver.satisfies(provider.version, range, { includePrerelease: true })) {
        diagnostics.push(
          diagnostic(
            EngineDiagnosticCode.CAPABILITY_VERSION_MISMATCH,
            `Plugin "${plugin.id}" requires capability "${token.id}" ${range}, but "${provider.pluginId}" provides ${provider.version}.`,
            {
              details: {
                pluginId: plugin.id,
                capabilityId: token.id,
                range,
                providedVersion: provider.version,
                providerPluginId: provider.pluginId,
              },
            },
          ),
        );
      }

      dependsOn.add(provider.pluginId);
      pluginBindings.push({
        key,
        capabilityId: token.id,
        range,
        optional,
        providerPluginId: provider.pluginId,
      });
    }

    bindings.set(plugin.id, pluginBindings);
    edges.set(plugin.id, dependsOn);
  }

  const order = topologicalOrder(byId, edges, diagnostics);
  return { order, providers, bindings, diagnostics };
}

/**
 * Depth-first topological sort. Emits the concrete cycle path rather than a
 * bare "cycle detected", because a five-plugin cycle is otherwise unfindable.
 */
function topologicalOrder(
  byId: ReadonlyMap<string, AnyPluginDefinition>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  diagnostics: Diagnostic[],
): readonly AnyPluginDefinition[] {
  const order: AnyPluginDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      const path = [...stack.slice(start), id];
      diagnostics.push(
        diagnostic(
          EngineDiagnosticCode.PLUGIN_DEPENDENCY_CYCLE,
          `Plugin dependency cycle: ${path.join(" -> ")}.`,
          { details: { cycle: path } },
        ),
      );
      return;
    }

    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, "done");

    const plugin = byId.get(id);
    if (plugin) order.push(plugin);
  };

  for (const id of byId.keys()) visit(id);
  return order;
}
