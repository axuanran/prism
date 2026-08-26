# ADR 0012: Run evidence carries definition references and fingerprints

**Status:** Accepted and implemented in Core contracts

## Context

A deterministic run must later answer two separate questions:

1. Which definition should replay load?
2. Is the loaded content exactly what originally ran?

A fingerprint answers the second question but is one-way; it cannot identify a Resource kind, logical ID or revision. A reference answers the first but trusts storage immutability without independent content evidence.

## Decision

`RunPin` carries both:

- `definition: DefinitionRef { kind, id, revision }` locates content;
- `definitionFingerprint` verifies the stored content used for compilation.

The reference and fingerprint participate in `isSameRunPin`. The fingerprint is computed from the stored JSON representation rather than a decoded domain object, because persisted bytes—not decoder behavior—are replay evidence (`packages/contracts-data/src/run-pin.ts`).

Core defines the evidence shape but does not prescribe a domain run entity or replay service. A Solution that implements replay treats the pin reference as authoritative, reloads exactly that revision and compares the stored content fingerprint before executing.

## Consequences

- Run evidence retains both an address and independent verification.
- A corrupted or illegally modified revision can be detected even if its logical revision number remains unchanged.
- Fingerprint algorithm/version stability becomes part of persistence compatibility.
- Historical records created without a fingerprint cannot recover it from a one-way hash or reference alone.

## Cost to reverse

Removing `DefinitionRef` forces replay to depend on duplicate domain fields or an external hash index. Removing `definitionFingerprint` discards independent content evidence. Either reversal changes `RunPin`, equality, persistence, API serialization and every Solution replay implementation (`packages/contracts-data/src/run-pin.ts`).
