# ADR 0015: Optional compiler semantics are versioned plugin extensions

**Status:** Accepted and implemented by Step 0A

## Context

Quantity and Dataset Grain can change whether a Pipeline is legal and what its output means, but neither is required for every Prism application. Hard-coding them into Kernel would make Kernel understand calculation-specific concepts; implementing them inside a private Solution would duplicate generic compiler behavior and bind the Solution to calculation internals.

The architecture must prove that optional semantics can affect compilation through public contracts while Backend execution remains unaware of how those facts were inferred.

## Decision

Kernel remains generic. It enforces exact extension-point version equality and otherwise stores typed contributions without interpreting them (`packages/kernel/src/extension.ts`, `packages/kernel/src/registries.ts`).

Calculation contracts define:

- `TypeAnalysisExtensionPoint` for expression type semantics;
- `PlanAnalysisExtensionPoint` for static SemanticPlan analysis;
- explicit `AnalysisResult = not-applicable | handled | invalid`;
- deterministic conflict rejection when more than one extension handles the same subject;
- `AnalyzerRequirement` so authored Pipelines fail when a safety analyzer is absent;
- analyzer identity containing extension contract version and analyzer semantic version (`packages/contracts-calculation/src/analysis.ts`, `packages/contracts-calculation/src/pipeline.ts`).

Three versions remain distinct:

```text
Extension contract version  calculation.type-analysis@1.0.0
Annotation contract version type.quantity@1.0.0
Analyzer semantic version   quantity-analyzer@1.2.0
Package version             @prism/plugin-type-quantity@0.8.3
```

Only semantic changes enter plan identity. README/UI-only package releases do not alter plan hashes.

Typed `SemanticAnnotation<JsonValue>` values carry plugin meaning through ValueType, Arrow metadata and SemanticPlan. SemanticPlan v2 records the exact analyzers used and their contract/semantic versions; node annotations and constraints are deterministic JSON and participate in `planHash` (`packages/contracts-data/src/semantic-annotation.ts`, `packages/contracts-data/src/arrow.ts`, `packages/contracts-calculation/src/semantic-plan.ts`).

Static meaning and data facts are separate. A Plan analyzer may emit a `PlanConstraint` saying actual data must satisfy uniqueness/cardinality. Snapshot sealing or Runtime validates that constraint; Runtime never re-infers Grain.

## Consequences

- Installing an analysis plugin changes compiler capability without modifying calculation-memory internals or any Backend.
- Uninstalling a required analyzer produces `REQUIRED_ANALYZER_MISSING`, never a silent downgrade to plain Decimal/Table semantics.
- Multiple handlers produce `ANALYSIS_EXTENSION_CONFLICT`; plugin order and numeric priority cannot silently override type meaning.
- Extension-point versions are exact in V0.1. Compatibility ranges/adapters are deferred until real ecosystem evidence exists.
- Analysis semantic-version changes alter plan hashes even when operation/backend/package versions do not.
- Backend consumes an analyzed SemanticPlan and still enforces concrete runtime cardinality rules encoded by operations/constraints; it does not run static analyzers.

## Cost to reverse

Moving Quantity/Grain into Kernel would expand Kernel dependencies and make optional calculation semantics mandatory. Letting analyzers modify compiler internals would create deep-import coupling. Removing analyzer identities or annotations from SemanticPlan would allow the same hash to mean different things under different analysis rules, invalidating replay evidence.
