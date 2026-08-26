# ADR 0004: Decimal arithmetic and explicit allocation remainders

**Status:** Accepted and implemented

## Context

Binary floating point can lose cents. Weighted allocation also creates minor-unit remainders after rounding; leaving their destination implicit makes payouts non-reproducible and totals fail reconciliation (`packages/contracts-data/src/decimal.ts`, `packages/contracts-calculation/src/allocation.ts`).

## Decision

In-memory financial values and allocations use `decimal.js` through the high-precision `D` clone. Rounding is explicit at storage/reporting edges. Serialized values use `DecimalString` through explicit codecs rather than pretending JSON restores class instances (`packages/contracts-data/src/decimal.ts`, `packages/contracts-data/src/json.ts`).

Every Arrow decimal column has required precision and scale. `DecimalType` follows Decimal128 limits rather than pretending decimals are unbounded at the column boundary (`packages/contracts-data/src/value-type.ts`, `packages/contracts-data/src/arrow.ts`).

Every allocation has an `AllocationPolicy`: scale, rounding, zero-weight behavior, negative-weight permission, and a deterministic remainder policy. Supported policies are largest remainder, designated row, or rejection. Default: scale 2, half-up, largest remainder, error on zero weight (`packages/contracts-calculation/src/allocation.ts`).

## Consequences

- Allocation conserves the total exactly at configured scale.
- Largest-remainder ties use deterministic ordering.
- Arrow writes reject scale loss/precision overflow instead of silently rounding.
- Financial paths cannot casually mix native number arithmetic.
- Policy and decimal handling cost more code but make reconciliation reviewable (`packages/plugin-calculation-memory/src/memory-backend.ts`).

## Cost to reverse

Switching computation to `number` would alter domains, expressions, semantic plans, backend execution, storage/wire conversion, tests, and persisted expectations. Changing remainder defaults changes payouts and requires operation-version/replay compatibility work (`packages/contracts-calculation/src/allocation.ts`, `packages/contracts-data/src/run-pin.ts`).
