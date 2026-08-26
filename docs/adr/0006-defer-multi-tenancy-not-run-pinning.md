# ADR 0006: Defer multi-tenancy, not run evidence

**Status:** Accepted and implemented at the Core contract level

## Context

V0.1 targets one deployment boundary. Mandatory tenancy would add partition, authorization and storage rules before a deployment contract exists. Deterministic calculations, however, must already remain attributable to the exact definition, inputs, effective time and implementation versions that produced them (`packages/contracts-data/src/call-context.ts`, `packages/contracts-data/src/run-pin.ts`).

Adding an explicit call context later to dozens of Capability methods would be broad and error-prone. Adding evidence only after real runs exist would be impossible: missing historical fingerprints cannot be reconstructed honestly.

## Decision

Every Capability call receives explicit `CallContext` containing principal, temporal context, correlation ID and cancellation signal. `tenantId` is deferred.

Core defines `RunPin` as reusable evidence:

```text
DefinitionRef + DefinitionFingerprint
Dataset/Parameter fingerprints
Effective time
Engine/Operation/Backend/Business-component versions
Semantic plan hash
```

Definition reference and fingerprint are complementary: the reference locates content; the one-way fingerprint verifies content. Parameter declarations belong to plan identity and affect `planHash`; bound parameter values belong to run input identity and affect `InputSnapshot`. Backend and business-component identities belong to run identity, not semantic plan identity (`packages/contracts-data/src/run-pin.ts`, `packages/plugin-calculation-memory/src/runtime.ts`, `packages/plugin-calculation-memory/src/memory-backend.ts`).

## Consequences

- Authorization, attribution, temporal selection and cancellation are visible in method signatures rather than ambient process state.
- Generic Solutions can persist RunPin beside their own run records without Core knowing the domain.
- Input fingerprints are evidence, not automatically a durable snapshot. A provider/host must materialize or version source data to guarantee later byte-identical replay.
- Current Dataset execution may re-stream mutable sources after fingerprinting; a durable Solution must bind inputs to immutable snapshots.
- Adding tenancy later remains broad but compiler-guided because context is explicit.

## Cost to reverse

Removing explicit context changes every Capability method and reintroduces ambient authority. Removing RunPin loses evidence irreversibly for any run created without it. Adding either back later would require contract, persistence, API, replay and migration changes (`packages/contracts-data/src/call-context.ts`, `packages/contracts-data/src/run-pin.ts`).
