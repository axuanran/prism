# Prism Engine Project State

> Snapshot date: 2026-08-29
>
> This file is an operational handoff. It distinguishes the public/released baseline from the active working tree. The working tree contained substantial user-owned changes when this snapshot was written; those changes are not automatically released or production-approved.

## Repository role

Prism Engine is the domain-neutral, open-source execution and authoring platform. It owns generic contracts, immutable identities, capability resolution, storage, calculation, project build/runtime isolation, visual composition infrastructure, governance, observability, secret resolution, and production adapters.

It must not contain hospital, performance, RBRVS, DRG, Oracle, or other customer/domain policy.

The hospital/performance product is maintained separately in `prism-hos-perf`.

## Identity and release invariants

These rules are load-bearing:

- `ProjectRelease` is the only top-level release identity. Do not introduce Visual Release or Solution Release as a competing top-level concept.
- Runtime execution uses exact resource revisions, fingerprints, Material versions, Artifact hashes, dependency-lock hashes, and Runtime Profile fingerprints. It never resolves “latest” at execution time.
- `ProjectBuildArtifactSet` is immutable and reusable. A Visual Resource change may produce a new `ProjectRelease` without rerunning package installation, typechecking, tests, Vite, or esbuild.
- Visual authoring configures a Code Material instance. It never mutates the Code Material source, version, or Artifact.
- Runtime Profile identity is independent of filesystem paths. Build, Monaco, Release, Candidate READY, Runtime Instance, and RunPin must agree on the exact Profile and SDK Types fingerprints.
- Candidate mismatch must fail before activation. The previous Active Release remains authoritative.
- Fingerprints exclude display metadata such as names, descriptions, actors, timestamps, process IDs, and deployment paths unless that data changes execution semantics.
- Public release CI must pass manifest/ref/registry preflight before dependency installation, builds, SBOM signing, container pushes, or npm publication. The root and every public package share one version; internal workspace specs are canonical; the ref is exactly `refs/tags/v<version>`; every npm package version is definitely absent.
- Normal, partial-npm recovery, exact publication and finalization require `github.ref_protected == true` plus exact `refs/tags/v<version>` before registry access. Image and npm publication evidence bind that ref to the exact 40-hex source SHA; repository tag protection/rulesets are a deployment prerequisite.
- Privileged release execution is `workflow_dispatch`-only with exactly one `ubuntu-latest` publish job, a 90-minute timeout, same-ref noncancelling concurrency, fixed PostgreSQL 17 health bounds, and exact permissions `{contents: read, id-token: write, packages: write}`.
- Every third-party GitHub Action in the privileged release job is pinned to one reviewed 40-hex commit and checked against an exact repository/SHA/use-count allowlist. Mutable tags, unknown repositories, changed pins and missing/extra uses fail deterministic workflow validation.
- Worker and Host Docker builds pin both the Dockerfile 1.7 frontend index and Node 24 Bookworm Slim multiarch index by exact SHA-256 digest; both build/runtime stages use only the pinned `NODE_IMAGE`, and release workflow overrides are prohibited.
- pnpm toolchain identity is cryptographic: root `packageManager`, all Docker Corepack preparations and pinned setup action agree on pnpm `11.21.0` plus the official SHA-512 package hash. Version/integrity workflow overrides are prohibited.
- Node identity is exact `24.20.0`: root engine, pinned setup-node input, and all Worker/Host build/runtime stages agree. Each Docker stage asserts `node --version` against `NODE_VERSION`; workflow overrides are prohibited.
- `.dockerignore` is an exact no-negation allowlist boundary excluding VCS/CI metadata, credentials/env/logs, dependencies/build caches/output/tests, prepared release artifacts, SBOM/Sigstore/image evidence, tarballs and smoke output. Both Dockerfiles copy the filtered root once; both release builds use only `context: .`.
- Sensitive environment is step-scoped: npm token only to npm identity verification and exact publication; PostgreSQL URL/required flag only to the required database test; anonymous registry smoke explicitly clears the token. Job-level sensitive env is prohibited.
- Checkout sets `persist-credentials: false`. GHCR credentials exist only during digest build/sign/verify/evidence, are explicitly removed before npm work and anonymous smoke, then are reacquired immediately before final digest tagging.
- The workflow-dispatch npm dist-tag is validated before registry access with canonical lowercase ASCII syntax (1–64 characters, not SemVer), projected once into `RELEASE_NPM_TAG`, and referenced only as a quoted shell variable. Direct input interpolation in run blocks is prohibited.
- Every package manifest under `packages/` has one canonical bounded `@prismengine/<lowercase slug>` identity before registry URL or shell-list construction; duplicate/invalid names report manifest path only. Anonymous smoke discovers `private !== true` packages only.
- Release CI sets `PRISM_REQUIRE_POSTGRES_TESTS=1`; an unavailable configured database is fatal during test collection and cannot become a green release through skipped PostgreSQL suites. Probe failure output contains candidate count and bounded error types only, never URLs, credentials or driver messages.
- After build/test/Studio gates and before SBOM, signing, GHCR or npm side effects, release CI actual-packs every public package into ignored `release/npm/`. It validates identity/inventory/entrypoints and writes sorted `release-packages.json` containing filename, byte count, SHA-256 and npm-compatible SHA-512 SRI only after every confined regular tarball succeeds.
- Custom supply-chain evidence is keyless-signed and verified against the exact repository `release.yml@tag` identity before upload: prepared package SRI evidence, image identity evidence, and the always-run npm publication success/failure journal. Each artifact is uploaded with its Sigstore bundle.
- npm publication consumes only prepared `.tgz` files in deterministic internal runtime-dependency order. Before mutation it rehashes the complete evidence closure and checks every registry version: exact SRI is safely skipped, `404` is published, mismatch/indeterminate state fails closed. `resume-packages` permits an explicit mixed 200/404 preflight; `publication-result.json` journals plan/progress/final verification and is uploaded even on failure.
- Completion bounded-verifies `/-/package/<name>/dist-tags` and requires the validated npm tag to map exactly to the root version. During mixed-state resume, tags for existing exact versions must converge before any missing package is published. Wrong-version mapping fails immediately; missing/indeterminate mappings retry then fail. Automation never moves or repairs a dist-tag.
- Worker and Host builds push and sign canonical digests only. Release jobs are serialized per ref without cancellation; version and full source-SHA GHCR tags are created only after npm publication and anonymous registry smoke succeed.
- Normal release stores version/source-SHA/repository/Worker/Host digests in `release-images.json`. `finalize-only` recovery requires those canonical digests, exact release ref, all npm packages already visible and both keyless signatures bound to this repository workflow/ref; it skips build/npm publication, repeats anonymous smoke, then creates tags.

## Released baseline

The workspace manifests identify the public package line as `0.1.20`.

The released Project foundation includes:

- Code Project source drafts with CAS and immutable published Source revisions.
- isolated Build Worker with frozen pnpm, TypeScript, tests, Vite, and esbuild.
- immutable Build Artifact Sets and content-addressed Client, Server, Material, manifest, test, and Profile SDK Types Artifacts.
- immutable Project Releases composed from an exact Build Artifact Set and exact Visual Resource revisions.
- Release activation, rollback, Candidate health checks, client Release identity checks, RunPins, logs, cancellation, timeout, and crash recovery.
- Code Material declaration, build, Release-scoped catalog, exact Artifact execution, and generic `context.materials.execute`.
- exact Runtime Profile identity, full Candidate READY Profile identity, SDK Types fingerprint validation, and Monaco Profile type injection.

Use the registry and release workflow as proof of publication. A package manifest version alone is not proof that every working-tree change is published.

## Active working-tree snapshot

At audit time, the Core working tree was intentionally not clean: approximately 155 modified paths and 47 untracked paths. Treat all of them as user-owned work.

The active tree extends beyond the released Project foundation and includes work in these areas:

- governance and exact approval flows;
- requester/reviewer/publisher separation;
- secrets and provider-safe secret resolution;
- Worker contracts and bounded isolation;
- S3, WORM, OpenTelemetry, and other production adapters;
- Production Host composition;
- Docker and Helm deployment assets;
- host-level end-to-end coverage;
- expanded generic Studio surfaces;
- hardened validation, diagnostics, cancellation, identity bounds, cleanup, and provider conformance.
- post-`0.1.20` `project.visual-pipeline` contracts, exact Material refs, V1 Visual Operator semantics, graph/configuration validation, fingerprints, Draft/Publish endpoints, and revision diff support;

`README.md` and `docs/architecture.md` describe this active architecture in greater detail. They were already modified during the audit and must be preserved as user work.

Do not describe the active snapshot as released until its exact commits pass CI, are published where applicable, and are deployed through the intended release path.

## Current Project/Visual model

```text
Project Source Draft
→ immutable Source Revision
→ isolated Build
→ immutable ProjectBuildArtifactSet
→ ProjectRelease composition
   + exact Runtime Profile
   + exact Visual Resource revisions
→ Candidate Worker READY
→ activation / rollback
→ RunPin / trace / explain
```

Visual V1 is intentionally bounded:

```text
executionModel = ROW_MAP
cardinality = ONE_TO_ONE
grainEffect = PRESERVE
backend = calculation.memory
```

Broader FILTER, FLAT_MAP, AGGREGATE, row expansion, allocation, joins, and declared output grains require explicit analyzer/compiler support. They must not be admitted by bypassing the Visual Operator contract.

## Production safety rules

- Preserve AtomicWrite boundaries; do not replace them with provider-specific transactions in domain code.
- Preserve capability-based composition; hosts choose providers, consumers depend on contracts.
- Keep Artifact identity provider-independent and content-addressed.
- Keep errors bounded and sanitized. Never persist or return secrets, raw tokens, host paths, or uncontrolled provider diagnostics.
- Keep retry behavior bounded and explicit.
- Clean temporary files on every failed startup/build/materialization path without racing ownership transferred to a live Worker.
- Legacy Releases without provable Profile/Artifact Set identity are `LEGACY_PROFILE_UNRESOLVED`; they may be inspected but not silently reactivated with today’s Profile.

## Verification commands

Run only the gates relevant to the changed surface during development; run the full set before release:

```text
pnpm release:preflight
pnpm install --frozen-lockfile
pnpm build:ci
pnpm typecheck:ci
pnpm lint
pnpm test
pnpm --filter @prismengine/studio build
pnpm release:verify-packages
```

PostgreSQL verification requires `PRISM_TEST_DATABASE_URL`; release CI also requires `PRISM_REQUIRE_POSTGRES_TESTS=1` and must finish with zero skipped PostgreSQL tests. Local development may omit both and receive an explicit sanitized skip reason.

For Studio behavior, run the actual API and Studio, then browser-drive the changed surface. A component compile is not visual proof.

## Handoff procedure

Before continuing active work:

1. Read `README.md` and `docs/architecture.md`.
2. Inspect `git status` and preserve every existing dirty path.
3. Separate released facts from working-tree facts in reviews and release notes.
4. Reuse existing package/contracts/provider patterns; do not create parallel conventions.
5. Verify exported-symbol call sites before changing contracts.
6. Commit only coherent vertical slices with behavioral proof.
7. Publish Core packages before upgrading downstream repositories.

## Next decision boundary

The next safe action is not to add domain concepts. First reconcile the active production-hardening tree into coherent, tested commits and establish which parts are intended for the next public release. Project Visual work should continue only through the generic exact-identity chain; hospital behavior remains downstream.
