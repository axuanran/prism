# ADR 0002: `CallContext` is an explicit first parameter

**Status:** Accepted and implemented

## Context

Capability calls need principal attribution, effective time, correlation, cancellation, and optional locale. An ambient principal/service locator would hide those inputs and make authorization/replay depend on process state (`packages/contracts-data/src/call-context.ts`).

## Decision

Business and data capability methods take `CallContext` first. It carries `principal`, `asOf`, `correlationId`, optional `signal`, and optional `locale`. HTTP constructs it from headers; bootstrap/scheduled work uses `systemCallContext` (`packages/contracts-data/src/call-context.ts`, `packages/plugin-http-fastify/src/plugin.ts`).

Infrastructure accessors that are not business calls remain exceptions: `StorageCapability.collection(name)` selects a collection, while HTTP `address()`/route registration manages transport wiring (`packages/contracts-storage/src/capability.ts`, `packages/plugin-http-fastify/src/http.ts`).

## Consequences

- Authorization inputs and temporal reads are visible and testable.
- Correlation is available for callers to attach to events, diagnostics, and logs; propagation is explicit and not automatic (`packages/kernel/src/events.ts`, `packages/plugin-http-fastify/src/plugin.ts`).
- Cancellation propagates through dataset streaming.
- Signatures are more verbose.
- `validAt` and `knownAs` remain distinct; V0.1 records pins without claiming a full bitemporal store (`packages/contracts-data/src/dataset.ts`, `packages/contracts-data/src/call-context.ts`).

## Cost to reverse

Ambient context would change every capability interface/implementation, remove compiler enforcement, complicate concurrency, and require safe async propagation across HTTP, events, datasets, and tests. Restoring explicit context later would again touch every method (`packages/contracts-data/src/call-context.ts`).
