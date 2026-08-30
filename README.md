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
packages/project-sdk                    browser project ABI helpers and public types
packages/contracts-data                 JSON, Codec, Decimal, Arrow Dataset, RunPin
packages/contracts-governance           exact change approval and target-fingerprint contract
packages/contracts-artifact             provider-neutral immutable Artifact contract
packages/contracts-secret               persistable SecretRef and runtime resolution contract
packages/contracts-worker               Worker launcher/transport and isolation profile contract
packages/contracts-storage              Resource/Document storage contracts
packages/contracts-calculation          PipelineSpec, analysis extensions, SemanticPlan
packages/contracts-organization         generic organization contracts
packages/contracts-project              unified Visual/Code Material and Project Release refs
packages/plugin-storage-memory          development/test storage provider
packages/plugin-storage-postgres        durable Kysely/PostgreSQL provider
packages/plugin-calculation-memory      semantic lowering + memory backend
packages/plugin-organization-basic      generic organization provider
packages/plugin-http-fastify            explicit HTTP route host
packages/plugin-governance-approval     durable request/review/authorize workflow
packages/plugin-studio-api              generic Resource/Organization/Calculation HTTP adapter
packages/plugin-type-quantity           optional dimensional type algebra
packages/plugin-dataset-grain           optional Dataset/Plan grain analysis
packages/plugin-material-registry       shared Material discovery for Studio and Runtime
packages/plugin-code-project            source Draft CAS and immutable Source revisions
packages/plugin-project-build           isolated Build Worker and approval-gated Releases
packages/plugin-artifact-store-local     local content-addressed Artifact provider
packages/plugin-artifact-store-s3       S3-compatible Object Lock production Artifact provider
packages/plugin-audit-export-s3         append-only audit export to S3 Object Lock COMPLIANCE
packages/plugin-observability-otel       OTLP HTTP traces/metrics and collector readiness
packages/plugin-secret-local            allowlisted development env/file Secret provider
packages/plugin-secret-vault            Vault KV v2 production Secret provider
packages/plugin-worker-local            development-only local child-process launcher
packages/plugin-worker-container        Docker container launcher with framed IPC bridge
packages/plugin-project-runtime         Active Release CAS and App/Action worker runtime
apps/host                               production Project control-plane composition
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

Run the real PostgreSQL 17 persistence suite without a preinstalled server:

```sh
pnpm test:postgres:embedded
```

The runner uses the packaged native binary on Linux and macOS. On Windows it
uses the `Ubuntu` WSL distribution when available because PostgreSQL refuses to
run under an administrator account; set `PRISM_TEST_WSL_DISTRO` to select a
different distribution. The cluster binds only to `127.0.0.1`, uses test-only
trust authentication inside WSL, and is removed after the suite.

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

## Production Host

`@prismengine/host` is the runnable, domain-neutral Project control plane. It
composes PostgreSQL storage/migration journal, S3 Artifact and WORM audit
providers, Vault, OTLP, the remote Docker Worker launcher, Code Projects,
Build, Runtime and `http.fastify`. Configuration is strict environment input;
logs expose only a redacted summary.

Production startup requires hash-pinned external evidence and acquires a
PostgreSQL advisory session lock for the deployment ID. A second Host for the
same deployment fails with `HOST_SINGLE_WRITER_UNAVAILABLE`; this prevents
independent Runtime managers from serving different Active Releases. Migrations
also use cross-process PostgreSQL advisory locks.

`deploy/helm/prism` installs one Recreate-strategy Host pod with non-root,
read-only-rootfs, seccomp, dropped capabilities, mTLS Docker credentials,
read-only evidence and default-deny NetworkPolicy. The chart intentionally
requires image digests and explicit egress CIDRs.

`plugin-studio-api` supplies the remaining live Studio contracts: generic
configuration-exposed Resource lifecycle, Organization people/units/
assignments, and Calculation operation/validation/preview execution. Dedicated
Project and Visual Resources remain inaccessible through generic mutation
routes, so the adapter cannot bypass their exact validation lifecycles.

Critical production mutations require an exact, unexpired durable Approval.
Only permission/method/route/fingerprint and governance metadata are stored;
request params/body/Secret values are discarded after hashing. Requester,
reviewer and publisher must be three distinct principals, and the Approval ID
is copied into the mutation Audit record.
The Approval atomically becomes `CONSUMED/PENDING` before the handler, so its
ID cannot be replayed. Handler completion records `SUCCEEDED` or `FAILED`; a
failed business attempt requires a new Approval rather than reusing authority.

## Generic Studio

Core Studio contains the generic JSON Schema renderer, presentation mapping,
custom editor registry, Vue Flow pipeline editor, Resource UI, Organization UI,
developer Capability inspector, and the Code Projects control plane. The
Visual Pipeline workspace edits one complete build-scoped pipeline through
server-generated exact Material refs, explicit Draft save, validation,
Draft-to-published Diff and Release composition. It contains no
hospital-performance page or private API.
Studio includes a Change Approvals workspace. A critical operation without an
Approval ID creates an exact request and stops; a second principal reviews it,
then a third principal repeats the operation with the approved ID and identical
change reason.

Run the domain-neutral offline mock:

```sh
VITE_USE_MOCKS=true pnpm --filter @prismengine/studio dev
```

A Solution supplies its own host routes and domain pages while reusing public Studio foundations after those APIs stabilize.

Live Studio does not send principal or role headers. Its host owns the
session/token boundary and supplies a trusted request principal to
`http.fastify`; local development must opt into an explicit development
principal.

Production mode fails closed until the host provides trusted OIDC/session
identity, route permissions, OpenTelemetry, and evidence for single-hospital
deployment isolation, external Artifact/Secret storage, audit-chain/WORM
controls, PostgreSQL PITR, restore drills, worker container isolation and
signed supply-chain artifacts. `storage.memory`, `artifact.store.local` and
`secret.local` are deliberately classified as development providers.

Production adapters are included but never auto-configured:

- `artifact.store.s3` uses the shared canonical Artifact hash/layout and probes
  Bucket Versioning plus Object Lock;
- `secret.vault` supports host-owned tokens or Kubernetes auth and reads one
  selected Vault KV v2 field;
- `storage.audit-export.s3` exports sequence/hash-bound audit records with S3
  Object Lock `COMPLIANCE` retention and verifies remote bytes idempotently.
- `worker.launcher@1.0.0` is required by Build and Runtime;
  `worker.launcher.local` is process-only and fails production readiness;
  `worker.launcher.container` bridges the existing IPC protocol over framed
  stdin/stdout and enforces non-root, no network, read-only rootfs, dropped
  capabilities, no-new-privileges, PID/CPU/memory limits and explicit mounts.
- `plugin-observability-otel` installs the Node OpenTelemetry SDK with OTLP
  HTTP trace/metric exporters and requires a live collector health probe;
  auth headers are never included in readiness evidence.

`composeProductionReadiness` combines these live probes with deployment-owned
PITR, restore, isolation, OTLP and supply-chain checks. No endpoint, token,
credential or hospital identifier is stored in this repository.

`pnpm production:verify-postgres-restore` performs a real `pg_dump` /
`pg_restore` drill into a disposable database whose name must begin with
`prism_restore_verify_`. Destructive restore is blocked unless
`PRISM_RESTORE_VERIFY_ALLOW_DESTRUCTIVE` exactly equals that database name. It
compares source/restored logical dumps, verifies audit-chain links, and writes
mode-0600 `backup-restore.verified` evidence. Connection passwords are passed
through `PGPASSWORD`, not command arguments or evidence.

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

The same workflow builds `docker/worker.Dockerfile`, deploys only the
Build/Runtime/bridge production dependency closure, includes an offline pnpm
store, pushes version and commit tags to GHCR with BuildKit provenance/SBOM,
and keyless-signs the immutable image digest with cosign. Production
configuration references the digest, never a mutable tag.

Publishing requires the repository `NPM_TOKEN` secret. Until `@prismengine/platform@0.1.0` and `@prismengine/plugin-sdk@0.1.0` exist in the registry, private Solutions may validate with temporary local links but must not commit those links or a generated lockfile.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @prismengine/studio build
pnpm --dir apps/studio test:e2e
```

Primary gates:

- source and test TypeScript compile cleanly;
- ESLint reports zero errors and warnings;
- Memory/PostgreSQL share one storage contract suite;
- PostgreSQL tests use a real server;
- architecture tests protect dependency direction, database-driver isolation and license metadata;
- Studio builds independently of every private Solution.
- Playwright drives real Chromium against a real in-memory HTTP Host for the
  Author → Reviewer → Publisher Approval lifecycle.

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
