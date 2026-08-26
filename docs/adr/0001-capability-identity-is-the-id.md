# ADR 0001: Capability identity is the ID

**Status:** Accepted and implemented

## Context

A provider implements one version of a typed capability contract, while consumers accept a semver range. If version were part of runtime identity, a consumer requiring `^1.0.0` could not bind a compatible `1.2.0` provider because the registry keys would differ (`packages/kernel/src/capability.ts`).

## Decision

`CapabilityToken.id` is the complete runtime identity. `CapabilityToken.version` describes the contract version a provider implements. A requirement matches one provider by ID, then checks its version against the normalized semver range. A bare token means `^<token.version>` (`packages/kernel/src/capability.ts`, `packages/kernel/src/resolver.ts`).

## Consequences

- One engine graph permits one provider per capability ID; duplicate providers are resolution errors (`packages/kernel/src/resolver.ts`).
- Compatible minor/patch providers can replace each other without changing consumer token identity.
- Breaking contracts require a new incompatible major range and coordinated providers/consumers; they do not create parallel registry identities automatically.
- Inspection can report stable capability IDs separately from provided versions (`packages/kernel/src/engine.ts`).

## Cost to reverse

Versioned identity would change registry keys, duplicate-provider rules, requirement normalization, resolver bindings, scoped access, host lookup, inspection, tests, and every token/caller assumption. Supporting multiple major versions simultaneously would also require an explicit provider-selection model rather than a key-format change (`packages/kernel/src/registries.ts`, `packages/kernel/src/resolver.ts`, `packages/kernel/src/engine.ts`).
