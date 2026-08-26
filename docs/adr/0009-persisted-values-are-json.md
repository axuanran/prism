# ADR 0009: Persisted values are JSON

**Status:** Accepted and implemented

## Context

A storage contract that accepts arbitrary TypeScript values is dishonest once any provider writes JSONB. `undefined`, non-finite numbers, `bigint`, functions and symbols are not JSON. `Date`, `Decimal` and custom classes may stringify, but parsing cannot restore prototypes.

Memory storage previously accepted these values by reference while PostgreSQL could not. That would make provider selection change application semantics—the exact opposite of a Capability contract.

## Decision

Core defines recursive `JsonValue` / `JsonObject` and a paired `Codec<TDomain, TStored extends JsonValue>`. Both Memory and PostgreSQL call the same `assertJsonValue` before writing a Resource spec or Document body (`packages/contracts-data/src/json.ts`, `packages/plugin-storage-memory/src/memory-storage.ts`, `packages/plugin-storage-postgres/src/postgres-storage.ts`).

The guard rejects non-JSON values with `NOT_JSON_STORABLE` and a JSON-style path. `putMany` validates the entire batch before writing anything, avoiding half-persisted input.

A domain class crosses storage only through a codec:

```text
TDomain -> Codec.encode -> JsonValue -> provider
provider -> JsonValue -> Codec.decode -> TDomain
```

`decimalCodec` is the first shared codec, not a special provider rule.

## Consequences

- Memory and PostgreSQL implement one legal-value contract and share one conformance suite.
- Provider swapping cannot depend on JavaScript object identity/prototypes.
- Encoding/decoding is visible code rather than implicit `JSON.stringify` behavior.
- Storage validates JSON storability, not a Resource type's JSON Schema or domain semantics; those remain adapter/service responsibilities.
- Other codecs can add Date, identifier or value-object representations without widening the provider contract.

## Cost to reverse

Allowing arbitrary values would either make Memory looser than durable providers or require provider-specific serialization policy. Both outcomes break substitutability and every shared conformance test (`packages/testing/src/storage-conformance.ts`, `packages/contracts-storage/src/capability.ts`).
