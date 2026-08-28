import {
  MaterialExtensionPoint,
  MaterialRegistryCapabilityToken,
  validateMaterialManifest,
  type MaterialManifest,
  type MaterialRegistryCapability,
} from "@prismengine/contracts-project";
import { PrismError, hasErrors } from "@prismengine/contracts-data";
import { definePlugin, type ExtensionRegistry } from "@prismengine/kernel";

export const materialRegistryPlugin = definePlugin({
  id: "project.material-registry",
  version: "0.1.17",
  provides: [MaterialRegistryCapabilityToken],
  register(context) {
    context.provide(
      MaterialRegistryCapabilityToken,
      new DefaultMaterialRegistry(context.extensions),
    );
  },
});

class DefaultMaterialRegistry implements MaterialRegistryCapability {
  constructor(private readonly extensions: ExtensionRegistry) {}

  list(): readonly MaterialManifest[] {
    const values = this.extensions.values(MaterialExtensionPoint);
    const identities = new Set<string>();
    for (const value of values) {
      const validation = validateMaterialManifest(value);
      if (hasErrors(validation.diagnostics)) throw new PrismError(validation.diagnostics);
      const identity = `${value.id}\u0000${value.version}`;
      if (identities.has(identity)) {
        throw PrismError.of(
          "MATERIAL_IDENTITY_DUPLICATE",
          `Material ${value.id}@${value.version} has multiple providers.`,
          { id: value.id, version: value.version },
        );
      }
      identities.add(identity);
    }
    return [...values].sort((left, right) =>
      left.id.localeCompare(right.id) || compareVersion(left.version, right.version));
  }

  get(id: string, version?: string): MaterialManifest | null {
    const matches = this.list().filter((value) =>
      value.id === id && (version === undefined || value.version === version));
    return matches.at(-1) ?? null;
  }
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
