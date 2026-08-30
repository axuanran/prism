import { assertKernelId, assertKernelVersion } from "./identity.js";

/**
 * Capability tokens.
 *
 * Identity is the `id` alone. `version` on the token is the contract version
 * a provider implements; consumers match it with a semver range. Baking the
 * version into identity would make `^1.0.0` unable to bind a 1.2.0 provider.
 */

declare const CAPABILITY_TYPE: unique symbol;

export interface CapabilityToken<TService> {
  readonly id: string;
  /** Semver of the contract shape this token describes. */
  readonly version: string;
  /**
   * Phantom, invariant type carrier. Never present at runtime.
   * Invariance is what stops `CapabilityToken<A>` binding where `<B>` is
   * expected - a covariant marker would erase the whole point.
   */
  readonly [CAPABILITY_TYPE]?: (service: TService) => TService;
}

/**
 * Erased token for positions that hold heterogeneous tokens, e.g. `provides`.
 * `any` is required, not sloppiness: the phantom carrier is invariant, so
 * `never` (or `unknown`) would reject every concrete token.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapabilityToken = CapabilityToken<any>;

/** The service type a token carries. */
export type CapabilityService<T> = T extends CapabilityToken<infer S> ? S : never;

export function defineCapability<TService>(spec: {
  id: string;
  version: string;
}): CapabilityToken<TService> {
  assertKernelId(spec.id, "capability.id");
  assertKernelVersion(spec.version, "capability.version");
  return Object.freeze({ id: spec.id, version: spec.version });
}

export interface CapabilityRequirement<TService = unknown> {
  readonly token: CapabilityToken<TService>;
  /** Semver range. Defaults to `^{token.version}`. */
  readonly range?: string;
  readonly optional?: boolean;
}

/** A requirement may be written as the bare token when defaults suffice. */
export type RequirementSpec<TService = unknown> =
  CapabilityToken<TService> | CapabilityRequirement<TService>;

// A heterogeneous map of differently-typed requirements. The phantom carrier
// is invariant, so unknown/never would reject every concrete token; precision
// is recovered by ResolvedDependencies<TRequires>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequirementMap = Readonly<Record<string, RequirementSpec<any>>>;

/**
 * Maps a `requires` map to the injected dependency object.
 * Optional requirements widen to `| undefined`, so a plugin cannot forget to
 * handle an absent provider.
 */
export type ResolvedDependencies<TRequires extends RequirementMap> = {
  readonly [K in keyof TRequires]: TRequires[K] extends CapabilityRequirement<infer S>
    ? TRequires[K] extends { readonly optional: true }
      ? S | undefined
      : S
    : TRequires[K] extends CapabilityToken<infer S>
      ? S
      : never;
};

export function normalizeRequirement<TService>(spec: RequirementSpec<TService>): Required<
  Omit<CapabilityRequirement<TService>, "range">
> & {
  readonly range: string;
} {
  const requirement: CapabilityRequirement<TService> =
    "token" in spec ? spec : { token: spec };
  return {
    token: requirement.token,
    range: requirement.range ?? `^${requirement.token.version}`,
    optional: requirement.optional ?? false,
  };
}
