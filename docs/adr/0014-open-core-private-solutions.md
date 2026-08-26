# ADR 0014: Prism Core is Apache-2.0; hospital solutions are private consumers

**Status:** Accepted and implemented

## Context

Prism has two distinct product concerns:

- a generic capability/plugin Kernel, calculation runtime, persistence providers, testing SDK, and Studio foundation that should be inspectable, reusable, and independently valuable;
- hospital-performance domain knowledge, customer integrations, deployment configuration, proprietary rules, migration templates, and commercial workflows that should remain private.

Putting both in one repository would let hospital-specific assumptions leak into the generic engine. Forking Prism into a private hospital variant would create two cores, require cherry-picks, and eventually make upgrades non-repeatable.

The license must permit closed commercial Solutions to consume the engine while preserving attribution and an explicit patent grant. A strong copyleft license would add legal ambiguity that does not serve this product model.

## Decision

This repository is **Prism Core**, open source under Apache License 2.0. The root contains `LICENSE` and `NOTICE`; the root manifest and every publishable `@prismengine/*` package declare `"license": "Apache-2.0"`. An architecture test prevents package metadata from drifting (`LICENSE`, `NOTICE`, `package.json`, `test/architecture.test.ts`).

Hospital Performance is a separate private/commercial repository with an independent version line. It consumes versioned public Prism packages and never forks, vendors, or imports Prism internals.

The placement test is deliberately simple:

```text
remove the word “hospital”
  still independently useful  -> Prism Core
  no independent meaning      -> Hospital Performance Solution
```

Prism Core owns generic mechanisms: Capability/Plugin lifecycle, Resource revisions, Storage contracts/providers, Dataset/Arrow types, Decimal/Codec boundaries, calculation IR/backends/operators, RunPin/replay evidence, testing infrastructure, and generic Studio capabilities.

The private Solution owns hospital semantics: physician/nursing/medical-technology models, RBRVS/DRG rules, hospital indicator systems, point/cost/personnel policies, hospital pipelines, HIS/Oracle adapters, XLSX migration templates, customer-specific UI/configuration, deployment, and support.

A private project that needs a missing generic capability contributes it to Prism Core, waits for a versioned release, and upgrades its dependency. It never copies the capability into a private Core fork.

## Consequences

- The open engine must remain useful and testable without any hospital-performance repository.
- The private Solution may remain closed while consuming Apache-2.0 packages, subject to license obligations and professional legal review.
- Prism internals should be hidden through package `exports`; private consumers should depend only on supported public packages. A future private-repository architecture test should reject `/src/`, `/internal/`, Git source URLs, and cross-repository relative imports.
- Prism and Hospital Performance use independent versions. A Solution release records its compatible Prism Platform version rather than copying the Core version.
- A future `@prismengine/platform` may provide one supported distribution identity and common public entry point. It must be a real API surface, not an empty dependency bundle; it is not created by this decision before that public API is designed.
- Apache-2.0 grants copyright and patent rights but does not grant Prism trademarks. `NOTICE` attribution must remain in redistributed derivative works as required by the license.

## Cost to reverse

Moving hospital code into this repository would require extracting customer data, proprietary adapters, domain rules, deployment secrets, and independent release history later—after coupling already exists. Forking Core would create permanent upgrade and security-maintenance cost. Changing the Core license after external contributions would require legal review and potentially contributor consent; selecting the intended license before public release avoids that path.
