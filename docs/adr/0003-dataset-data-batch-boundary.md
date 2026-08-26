# ADR 0003: `Dataset` and `DataBatch` are the Arrow batch boundary

**Status:** Accepted and implemented; provider limitation documented below

## Context

Monthly calculation can touch thousands of subjects and many metrics. Per-row capability calls create N+1 boundaries and prevent columnar execution. Row objects also make a future Arrow/DataFusion backend pay conversion costs before it begins (`packages/contracts-data/src/dataset.ts`).

## Decision

Calculation batch data crosses capability boundaries through a named, schema-bearing `Dataset`. Its contract requires `stream(context)` to be re-iterable with the same immutable `DataBatch` values. Each batch wraps an Apache Arrow `RecordBatch`; the logical `TableType` remains the Prism schema (`packages/contracts-data/src/dataset.ts`, `packages/contracts-data/src/arrow.ts`).

`Row[]` is an explicit materialization escape hatch, not the core ABI. `datasetFromRows`, `arrowBatchFromRows`, `materializeBatchRows`, and `collectRows` support seeds, JSON/presentation edges, and row-oriented internals (`packages/contracts-data/src/dataset.ts`, `packages/contracts-data/src/arrow.ts`, `packages/contracts-data/src/value-type.ts`). Domain point/list queries may return objects, arrays, or maps (`packages/contracts-organization/src/capability.ts`).

## Consequences

- Calculation batches cross plugins in bounded columnar groups and observe cancellation.
- Stable names, logical schemas, Arrow types, and metadata are contracts.
- Columnar code uses `DataBatch.getColumn` without allocating rows.
- The memory backend currently materializes and reconstructs Arrow datasets at multiple node boundaries; this is a visible V0.1 cost, not a columnar implementation claim (`packages/plugin-calculation-memory/src/memory-backend.ts`).
- `DecimalType` needs column-level precision and scale because Arrow Decimal128 does (`packages/contracts-data/src/value-type.ts`, `packages/contracts-data/src/arrow.ts`).
- Organization’s deferred dataset provider re-queries mutable storage on each stream and therefore does not fully meet the stable re-iteration contract (`packages/plugin-organization-basic/src/plugin.ts`).

## Cost to reverse

Returning row promises/arrays from calculation would change contracts, lowering/backends, runtime fingerprints, performance, HTTP serialization, and tests. Replacing Arrow with another physical ABI later would require new adapters and backend work; removing the batch boundary would also rewrite every calculation signature (`packages/contracts-data/src/dataset.ts`, `packages/contracts-calculation/src/backend.ts`).
