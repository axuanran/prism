import type { ConfigurationContract } from "./schema.js";
import type { ExposureDeclaration } from "./exposure.js";
import type { PresentationSpec } from "./presentation.js";

/**
 * The resource model: the unit business users actually edit in the studio.
 *
 * Invariant: a published revision is immutable. Editing a published resource
 * clones it into a new draft revision. Performance runs pin the revision they
 * executed, so a payout can always be re-explained against the exact config.
 */

export type ResourceStatus = "draft" | "published" | "archived";

export interface Resource<TSpec = unknown> {
  readonly id: string;
  /** Resource type identifier, e.g. "performance.scheme". */
  readonly kind: string;
  readonly name: string;
  /** Monotonic per resource id. */
  readonly revision: number;
  readonly status: ResourceStatus;
  readonly spec: TSpec;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  /** Omitted means "current published revision". */
  readonly revision?: number;
}

export interface ResourceTypeDefinition<TSpec = unknown> {
  /** Globally unique, plugin-namespaced, e.g. "calculation.pipeline". */
  readonly kind: string;
  /** Business-facing singular label. Developer ids never reach business UI. */
  readonly title: string;
  readonly description?: string;
  readonly config: ConfigurationContract<TSpec>;
  readonly presentation?: PresentationSpec;
  /**
   * Which surfaces may see this resource type. Configuration exposure is what
   * makes it appear in the generic studio at all.
   */
  readonly exposure: ExposureDeclaration;
}

export interface ResourceQuery {
  readonly kind?: string;
  readonly status?: ResourceStatus;
  readonly nameContains?: string;
}
