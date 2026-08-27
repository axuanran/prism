# Prism Engine

Prism Engine is an open-source, domain-neutral TypeScript runtime for composing typed capabilities through plugins. It provides a small Kernel, calculation semantics and backends, revision-aware resources, interchangeable storage providers, testing infrastructure, and a generic Vue Studio foundation.

License: [Apache-2.0](LICENSE). Attribution: [NOTICE](NOTICE).

## Product boundary

This repository is **Prism Core**. Hospital Performance is a separate private/commercial repository; it consumes released public `@prismengine/*` packages and is not a fork or subdirectory of Core.

```text
remove the word “hospital”
  still independently useful  -> Prism Core
  no independent meaning      -> private Hospital Performance Solution
```

Core owns generic mechanisms: Plugin/Capability lifecycle, Resource revisions, JSON/Codec boundaries, Arrow datasets, calculation IR/backends/operators, storage providers, RunPin evidence, testing SDK, and generic Studio infrastructure.

The private Solution owns hospital domain contracts, performance rules and pipelines, HIS/Oracle adapters, XLSX migrations, customer UI/configuration, deployment, and commercial support. A missing generic capability lands and releases in Core first; the Solution upgrades its dependency. It never imports `@prismengine/*/src/*`, private internals, Git source URLs, or cross-repository paths.

See [ADR 0014](docs/adr/0014-open-core-private-solutions.md).

## Architecture

```text
Host application
      │ compile-time composition
      ▼
Prism Kernel
  ├─ capability registry + typed dependency injection
  ├─ plugin graph + lifecycle + rollback cleanup
  ├─ resource/configuration/presentation registries
  └─ typed extension points
      │
      ├─ storage.memory / storage.postgres
      ├─ calculation.memory
      ├─ organization.basic
      ├─ http.fastify
      └─ external/private Solution plugins
```

A plugin is a **capability boundary**, not a code-granularity unit. Services, repositories, validators, entities and helper functions remain normal internal modules.

Consumers depend on `CapabilityToken<T>`, never a concrete implementation package. The same provider-independent storage conformance suite runs against Memory and real PostgreSQL.

## Packages

```text
packages/kernel                         plugin graph, lifecycle, registries
packages/plugin-sdk                     supported plugin-authoring facade
packages/platform                       compatible public distribution/composition
packages/contracts-data                 JSON, Codec, Decimal, Arrow Dataset, RunPin
packages/contracts-storage              Resource/Document storage contracts
packages/contracts-calculation          PipelineSpec, analysis extensions, SemanticPlan
packages/contracts-organization         generic organization contracts
packages/contracts-project              unified Visual/Code Material and Project Release refs
packages/plugin-storage-memory          development/test storage provider
packages/plugin-storage-postgres        durable Kysely/PostgreSQL provider
packages/plugin-calculation-memory      semantic lowering + memory backend
packages/plugin-organization-basic      generic organization provider
packages/plugin-http-fastify            explicit HTTP route host
packages/plugin-type-quantity           optional dimensional type algebra
packages/plugin-dataset-grain           optional Dataset/Plan grain analysis
packages/plugin-material-registry       shared Material discovery for Studio and Runtime
packages/plugin-code-project            source Draft CAS and immutable Source revisions
packages/testing                        engine/data/PG/conformance test fixtures
apps/studio                             generic configuration/pipeline UI foundation
```

## Calculation model

```text
PipelineSpec
    ↓ infer / normalize / lower
SemanticPlan          Prism-owned, serializable typed IR
    ↓ backend lowering
ExecutablePlan
    ↓
CalculationBackend
```

Operations only infer and lower. They never execute. V0.1 selects one backend for the whole plan; node-level backend hopping is intentionally deferred. `plugin-calculation-memory` interprets the semantic plan. A future DataFusion backend consumes the same IR.

## Persistence boundary

Resource specs and documents are `JsonValue`, not arbitrary JavaScript objects. `assertJsonValue` rejects `Decimal`, `Date`, `bigint`, `undefined`, non-finite numbers, functions, symbols and class instances. Domain values cross storage through explicit paired `Codec` implementations.

```text
Domain Decimal
    ↓ decimalCodec.encode
DecimalString
    ↓ Memory or PostgreSQL JSONB
DecimalString
    ↓ decimalCodec.decode
Domain Decimal
```

PostgreSQL separates logical resource identity from immutable revision content. Database triggers enforce content immutability and one-way status transitions after draft. Plugin-owned migrations are forward-only and recorded by a durable journal.

## Creating a plugin

```ts
import { defineCapability, definePlugin } from "@prismengine/kernel";

interface GreetingCapability {
  greet(name: string): string;
}

export const Greeting = defineCapability<GreetingCapability>({
  id: "example.greeting",
  version: "1.0.0",
});

export const greetingPlugin = definePlugin({
  id: "example.greeting.basic",
  version: "0.1.0",
  provides: [Greeting],
  register(context) {
    context.provide(Greeting, {
      greet: (name) => `Hello, ${name}`,
    });
  },
});
```

Dependencies are inferred directly from `requires`; undeclared service access throws. Capability identity is the stable ID, while semver ranges belong to provisions/requirements.

## PostgreSQL

Start a real local PostgreSQL from Bash/WSL:

```sh
./scripts/dev-postgres.sh
export PRISM_TEST_DATABASE_URL=postgres://prism@127.0.0.1:55432/postgres
```

Compose the provider at the host root:

```ts
import { createEngine } from "@prismengine/kernel";
import {
  createPostgresMigrationJournal,
  storagePostgresPlugin,
} from "@prismengine/plugin-storage-postgres";

const connectionString = process.env.DATABASE_URL!;
const migrationJournal = createPostgresMigrationJournal({ connectionString });
const engine = createEngine({
  plugins: [storagePostgresPlugin({ connectionString })],
  migrationJournal,
});

try {
  await engine.start();
  // Compose application plugins here.
} finally {
  await engine.stop();
  await migrationJournal.dispose();
}
```

CI runs a real `postgres:17` service and fails if the PostgreSQL suite executes zero tests. No fake database substitutes for persistence verification.

## Generic Studio

Core Studio contains the generic JSON Schema renderer, presentation mapping, custom editor registry, Vue Flow pipeline editor, Resource UI, Organization UI, and developer Capability inspector. It contains no hospital-performance page or private API.

Run the domain-neutral offline mock:

```sh
VITE_USE_MOCKS=true pnpm --filter @prismengine/studio dev
```

A Solution supplies its own host routes and domain pages while reusing public Studio foundations after those APIs stabilize.

## Toolchain

```text
Node.js                 24+
pnpm                    11.21
TypeScript compiler     7.0.2 native
Compiler API tooling    TypeScript 6 compatibility package
```

Prism runtime packages depend on neither compiler. Local compilation uses TS7 default parallelism; CI fixes `--checkers 2 --builders 2`. See [ADR 0013](docs/adr/0013-typescript-7-native-compiler.md).

## Public release

All public packages share one compatible version line. `@prismengine/platform` uses exact workspace versions, and `pnpm pack` rewrites them to exact public versions in the tarball. The manually dispatched release workflow runs build/typecheck/lint, real PostgreSQL tests and Studio build before publishing Apache-2.0 packages with npm provenance. It then installs Platform/SDK/Testing from the registry in a fresh directory, checks peers, imports the default composition, rejects leaked workspace/link dependencies, and verifies LICENSE/NOTICE (`.github/workflows/release.yml`).

Publishing requires the repository `NPM_TOKEN` secret. Until `@prismengine/platform@0.1.0` and `@prismengine/plugin-sdk@0.1.0` exist in the registry, private Solutions may validate with temporary local links but must not commit those links or a generated lockfile.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @prismengine/studio build
```

Primary gates:

- source and test TypeScript compile cleanly;
- ESLint reports zero errors and warnings;
- Memory/PostgreSQL share one storage contract suite;
- PostgreSQL tests use a real server;
- architecture tests protect dependency direction, database-driver isolation and license metadata;
- Studio builds independently of every private Solution.

## Architecture decisions

- [Architecture](docs/architecture.md)
- [ADR 0001: Capability identity is the ID](docs/adr/0001-capability-identity-is-the-id.md)
- [ADR 0002: CallContext is explicit](docs/adr/0002-explicit-call-context.md)
- [ADR 0003: Dataset and DataBatch are the Arrow batch boundary](docs/adr/0003-dataset-data-batch-boundary.md)
- [ADR 0004: Decimal and allocation remainder policy](docs/adr/0004-decimal-and-allocation-remainders.md)
- [ADR 0005: The kernel excludes transports and presentation](docs/adr/0005-kernel-excludes-exposure-transports.md)
- [ADR 0006: Multi-tenancy is deferred; run pinning is not](docs/adr/0006-defer-multi-tenancy-not-run-pinning.md)
- [ADR 0007: Operations lower to a declarative semantic plan](docs/adr/0007-operations-lower-to-semantic-plan.md)
- [ADR 0008: Serialized decimals have an honest type](docs/adr/0008-decimal-string-serialization-boundary.md)
- [ADR 0009: Persisted values are JSON](docs/adr/0009-persisted-values-are-json.md)
- [ADR 0010: Resource identity is separate from immutable revisions](docs/adr/0010-resource-identity-and-immutable-revisions.md)
- [ADR 0011: Table-owning plugins own migrations](docs/adr/0011-plugin-owned-forward-only-migrations.md)
- [ADR 0012: Run pins carry definition references and fingerprints](docs/adr/0012-run-pin-definition-reference-and-fingerprint.md)
- [ADR 0013: TypeScript 7 compiles Prism while TS6 serves tooling APIs](docs/adr/0013-typescript-7-native-compiler.md)
- [ADR 0014: Prism Core is Apache-2.0; hospital solutions are private consumers](docs/adr/0014-open-core-private-solutions.md)
- [ADR 0015: Optional compiler semantics are versioned plugin extensions](docs/adr/0015-compiler-semantics-are-plugin-extensions.md)
