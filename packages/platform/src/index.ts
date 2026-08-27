import type { AnyPluginDefinition } from "@prismengine/plugin-sdk";
import { calculationPlugin } from "@prismengine/plugin-calculation-memory";
import { grainPlugin } from "@prismengine/plugin-dataset-grain";
import { quantityPlugin } from "@prismengine/plugin-type-quantity";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";

export * from "@prismengine/plugin-sdk";
export * from "@prismengine/plugin-calculation-memory";
export * from "@prismengine/plugin-type-quantity";
export * from "@prismengine/plugin-dataset-grain";
export * from "@prismengine/plugin-storage-memory";
export * from "@prismengine/plugin-storage-postgres";
export * from "@prismengine/plugin-http-fastify";
export * from "@prismengine/plugin-organization-basic";

export const PRISM_PLATFORM_VERSION = "0.1.2";

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
