# ADR 0008: Serialized decimals have an honest type

**Status:** Accepted and implemented in Core contracts

## Context

A TypeScript field typed as `Decimal` is not a `Decimal` after JSON serialization and parsing. Structural typing cannot restore a class prototype. Memory providers can hide this defect by retaining live object graphs; JSONB and HTTP expose it.

A real private Solution found this bug when a resource was read through HTTP, saved as a new revision, then reached computation with a string where code expected a `Decimal` method. The generic lesson belongs in Core even though the domain reproduction remains private.

## Decision

Core separates computation and serialized representations:

```text
Decimal       in-memory computation
DecimalString persisted/wire representation
```

`decimalString` and `decimalCodec.encode` serialize only finite values to canonical non-exponent strings. `parseDecimalString` and `decimalCodec.decode` restore `Decimal` explicitly or emit `DECIMAL_MALFORMED` with a path. `Infinity`, `-Infinity` and `NaN` are rejected (`packages/contracts-data/src/decimal.ts`, `packages/contracts-data/src/json.ts`).

Domain packages define stored DTOs separately from runtime domain objects whenever a decimal crosses persistence. Core never claims that `JSON.parse` recreates a domain class.

## Consequences

- Persistence behavior no longer depends on whether a provider happens to retain JavaScript prototypes.
- Encoders/decoders are explicit, paired, searchable and testable.
- Arrow decimal columns separately require fixed precision and scale; `DecimalString` concerns JSON persistence, not Arrow physical layout.
- Existing stringly decimal configuration may migrate incrementally, but live `Decimal` objects are rejected by `assertJsonValue` at every provider boundary.

## Cost to reverse

Typing serialized fields as `Decimal` would reintroduce an unchecked prototype assumption and make providers observably different. Reversal would affect codecs, schemas, persisted data, adapters and historical resource revisions (`packages/contracts-data/src/decimal.ts`, `packages/contracts-data/src/json.ts`).
