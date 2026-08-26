import type { AnyPluginDefinition } from "@prism/plugin-sdk";
import { calculationPlugin } from "@prism/plugin-calculation-memory";
import { grainPlugin } from "@prism/plugin-dataset-grain";
import { quantityPlugin } from "@prism/plugin-type-quantity";
import { storageMemoryPlugin } from "@prism/plugin-storage-memory";

export * from "@prism/plugin-sdk";
export * from "@prism/plugin-calculation-memory";
export * from "@prism/plugin-type-quantity";
export * from "@prism/plugin-dataset-grain";
export * from "@prism/plugin-storage-memory";
export * from "@prism/plugin-storage-postgres";
export * from "@prism/plugin-http-fastify";
export * from "@prism/plugin-organization-basic";

export const PRISM_PLATFORM_VERSION = "0.1.0";

/**
 * Default public distribution composition.
 *
 * Quantity/Grain are optional plugins architecturally but enabled by the
 * platform distribution. Consumer plugins must still declare their Capability
 * requirements: platform defaults never erase dependency edges.
 */
export interface PrismPlatformOptions {
  /** Defaults to storage.memory. Production hosts normally pass PostgreSQL. */
  readonly storage?: AnyPluginDefinition | false;
  readonly calculation?: boolean;
  readonly quantity?: boolean;
  readonly grain?: boolean;
  readonly additionalPlugins?: readonly AnyPluginDefinition[];
}

export function prismPlatform(
  options: PrismPlatformOptions = {},
): readonly AnyPluginDefinition[] {
  return [
    ...(options.storage === false
      ? []
      : [options.storage ?? storageMemoryPlugin]),
    ...(options.calculation === false ? [] : [calculationPlugin]),
    ...(options.quantity === false ? [] : [quantityPlugin]),
    ...(options.grain === false ? [] : [grainPlugin]),
    ...(options.additionalPlugins ?? []),
  ];
}
