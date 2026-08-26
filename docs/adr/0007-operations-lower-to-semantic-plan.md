# ADR 0007: Operations lower to a declarative semantic plan

**Status:** Accepted and implemented

## Context

If an operation compiles directly to a JavaScript execution closure, a Rust/DataFusion backend can neither inspect nor push down its meaning. It must call back into JavaScript or reimplement every operator, creating two semantic authorities. V0.1 needs one definition of operation meaning and a replaceable physical executor (`packages/contracts-calculation/src/operation.ts`, `packages/contracts-calculation/src/backend.ts`).

## Decision

Calculation has three explicit layers:

1. authored `PipelineSpec`;
2. typed, versioned, serializable `SemanticPlan`;
3. backend-owned opaque `ExecutablePlan` (`packages/contracts-calculation/src/pipeline.ts`, `packages/contracts-calculation/src/semantic-plan.ts`, `packages/contracts-calculation/src/backend.ts`).

`OperationDefinition` is a compiler frontend. It provides `infer`, optional `validate`, and pure `lower(request): SemanticPlanNode`; it executes no data. Lowering owns `low-code configuration -> semantic meaning` (`packages/contracts-calculation/src/operation.ts`, `packages/plugin-calculation-memory/src/lowering.ts`).

`CalculationBackend` owns physical execution through `supports(node)`, whole-plan `compile`, and `execute`. Backends contribute through `BackendExtensionPoint`. V0.1 selects one backend only when it supports every node; the memory backend is the fallback. Node-level partitioning/hopping is explicitly deferred (`packages/contracts-calculation/src/backend.ts`, `packages/plugin-calculation-memory/src/runtime.ts`, `packages/plugin-calculation-memory/src/memory-backend.ts`).

## Consequences

- Operator semantics have one declarative authority independent of physical backend.
- Plan hashing includes lowered semantics plus engine/operation versions. It deliberately excludes backend identity so the same semantic plan has the same plan hash across executors; backend ID/version is recorded in the run version stamp instead (`packages/plugin-calculation-memory/src/runtime.ts`, `packages/contracts-data/src/run-pin.ts`).
- A later Rust/Arrow/DataFusion backend can inspect and compile the same plan without per-row JavaScript callbacks.
- V0.1 cannot mix backends within one plan. Partitioning would require explicit boundary materialization, Arrow ownership, trace merging, and error attribution.
- A selected backend compile failure is an error; fallback selection occurs before compile, not as a retry (`packages/plugin-calculation-memory/src/runtime.ts`).

## Cost to reverse

Returning to closure-only operations would remove backend substitution, invalidate semantic plan/hash compatibility, strand backend adapters, and push execution concerns back into every operation. Reversal would affect contracts, all operation definitions, lowering, runtime, backends, traces, run pins, Studio descriptors, and replay tests (`packages/contracts-calculation/src/operation.ts`, `packages/plugin-calculation-memory/src/operations.ts`, `packages/plugin-calculation-memory/src/runtime.ts`).
