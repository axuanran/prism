import { assertKernelId, assertKernelVersion } from "./identity.js";

/**
 * Typed extension points.
 *
 * The kernel must not know what a pipeline operation or an HTTP route is.
 * It only knows that a plugin can define a typed collection point and that
 * other plugins can contribute to it. `plugin-calculation` defines the
 * operation point; `plugin-http` defines the route point.
 */

declare const EXTENSION_TYPE: unique symbol;

export interface ExtensionPoint<TContribution> {
  readonly id: string;
  readonly version: string;
  readonly [EXTENSION_TYPE]?: (value: TContribution) => TContribution;
}

export function defineExtensionPoint<TContribution>(spec: {
  id: string;
  version: string;
}): ExtensionPoint<TContribution> {
  assertKernelId(spec.id, "extension.id");
  assertKernelVersion(spec.version, "extension.version");
  return Object.freeze({ id: spec.id, version: spec.version });
}

export interface Contribution<TContribution> {
  /** Plugin that contributed the value. Used for diagnostics and inspection. */
  readonly pluginId: string;
  readonly value: TContribution;
}

export interface ExtensionRegistry {
  contribute<T>(point: ExtensionPoint<T>, value: T): void;
  all<T>(point: ExtensionPoint<T>): readonly Contribution<T>[];
  values<T>(point: ExtensionPoint<T>): readonly T[];
}
