import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const RELEASE_EVIDENCE_MAX_BYTES = 1024 * 1024;
const REGISTRY_METADATA_MAX_BYTES = 64 * 1024;
const NPM_PACKAGE_SUFFIX_MAX_LENGTH = 128;
const PREPARED_TARBALL_MAX_BYTES = 64 * 1024 * 1024;
const DOCKERFILE_SYNTAX =
  "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
const NODE_IMAGE =
  "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const NODE_VERSION = "24.20.0";
const PNPM_VERSION = "11.21.0";
const PNPM_INTEGRITY =
  "sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1";
const PACKAGE_MANAGER = `pnpm@${PNPM_VERSION}+${PNPM_INTEGRITY}`;
const DOCKER_CONTEXT_EXCLUSIONS = [
  ".git",
  ".github",
  ".env*",
  "**/.env*",
  ".npmrc",
  "**/.npmrc",
  "*.log",
  "**/*.log",
  "node_modules",
  "**/node_modules",
  "dist",
  "**/dist",
  "*.tsbuildinfo",
  "**/*.tsbuildinfo",
  ".turbo",
  "**/.turbo",
  "coverage",
  "**/coverage",
  ".pnpm-store",
  "**/.pnpm-store",
  "release",
  "release-images.json*",
  "prism-engine.spdx.json*",
  "*.tgz",
  "test",
  "**/test",
  "tests",
  "**/tests",
  ".worker-image-smoke",
];

export class ReleasePreflightError extends Error {
  constructor(issues) {
    super(["Release preflight failed:", ...issues.map((issue) => `- ${issue}`)].join("\n"));
    this.name = "ReleasePreflightError";
    this.issues = Object.freeze([...issues]);
  }
}
const RELEASE_ACTION_PINS = new Map([
  ["actions/checkout", { sha: "11d5960a326750d5838078e36cf38b85af677262", count: 1 }],
  ["pnpm/action-setup", { sha: "b906affcce14559ad1aafd4ab0e942779e9f58b1", count: 1 }],
  ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", count: 1 }],
  ["anchore/sbom-action", { sha: "e22c389904149dbc22b58101806040fa8d37a610", count: 1 }],
  [
    "sigstore/cosign-installer",
    { sha: "398d4b0eeef1380460a10c8013a76f728fb906ac", count: 1 },
  ],
  [
    "docker/setup-buildx-action",
    { sha: "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", count: 1 },
  ],
  ["docker/login-action", { sha: "c94ce9fb468520275223c153574b00df6fe4bcc9", count: 2 }],
  [
    "docker/build-push-action",
    { sha: "10e90e3645eae34f1e60eeb005ba3a3d33f178e8", count: 2 },
  ],
  [
    "actions/upload-artifact",
    { sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", count: 2 },
  ],
]);

export function validateDockerBuildInputs(workerSource, hostSource, workflowSource) {
  const issues = [];
  for (const [name, source] of [
    ["worker", workerSource],
    ["host", hostSource],
  ]) {
    const lines = source.replace(/\r\n/gu, "\n").split("\n");
    if (lines[0] !== DOCKERFILE_SYNTAX) {
      issues.push(`${name} Dockerfile frontend digest does not match`);
    }
    if (
      lines.filter((line) => line.startsWith("ARG NODE_IMAGE=")).length !== 1 ||
      lines[1] !== `ARG NODE_IMAGE=${NODE_IMAGE}`
    ) {
      issues.push(`${name} Dockerfile Node image digest does not match`);
    }
    const fromLines = lines.filter((line) => /^FROM\s+/u.test(line));
    if (
      fromLines.length !== 2 ||
      fromLines[0] !== "FROM ${NODE_IMAGE} AS build" ||
      fromLines[1] !== "FROM ${NODE_IMAGE} AS runtime"
    ) {
      issues.push(`${name} Dockerfile stages must use only the pinned Node image`);
    }
  }
  if (workflowSource.includes("NODE_IMAGE")) {
    issues.push("release workflow must not override the pinned Node image");
  }
  return Object.freeze(issues);
}

export function validatePnpmToolchain(
  rootManifestSource,
  workerSource,
  hostSource,
  workflowSource,
) {
  const issues = [];
  try {
    const manifest = JSON.parse(rootManifestSource);
    if (manifest.packageManager !== PACKAGE_MANAGER) {
      issues.push("root packageManager does not match the pnpm integrity pin");
    }
  } catch {
    issues.push("root packageManager does not match the pnpm integrity pin");
  }
  for (const [name, source, expectedCount] of [
    ["worker", workerSource, 2],
    ["host", hostSource, 1],
  ]) {
    const lines = source.replace(/\r\n/gu, "\n").split("\n");
    if (
      lines.filter((line) => line === `ARG PNPM_VERSION=${PNPM_VERSION}`).length !==
        expectedCount ||
      lines.filter((line) => line === `ARG PNPM_INTEGRITY=${PNPM_INTEGRITY}`).length !==
        expectedCount
    ) {
      issues.push(`${name} Dockerfile pnpm arguments do not match the integrity pin`);
    }
    const preparations =
      source.match(/corepack prepare pnpm@\$\{PNPM_VERSION\}\+\$\{PNPM_INTEGRITY\}/gu) ??
      [];
    if (preparations.length !== expectedCount) {
      issues.push(`${name} Dockerfile Corepack preparation is not integrity-pinned`);
    }
  }
  const pnpmSetup = actionUseBlock(workflowSource, "pnpm/action-setup");
  if (pnpmSetup === undefined || !pnpmSetup.includes(`version: ${PNPM_VERSION}`)) {
    issues.push("release pnpm setup version does not match the integrity pin");
  }
  if (
    workflowSource.includes("PNPM_VERSION") ||
    workflowSource.includes("PNPM_INTEGRITY")
  ) {
    issues.push("release workflow must not override the pnpm integrity pin");
  }
  return Object.freeze(issues);
}

export function validateNodeToolchain(
  rootManifestSource,
  workerSource,
  hostSource,
  workflowSource,
) {
  const issues = [];
  try {
    const manifest = JSON.parse(rootManifestSource);
    if (manifest.engines?.node !== NODE_VERSION) {
      issues.push("root Node engine does not match the exact release version");
    }
  } catch {
    issues.push("root Node engine does not match the exact release version");
  }
  for (const [name, source] of [
    ["worker", workerSource],
    ["host", hostSource],
  ]) {
    const lines = source.replace(/\r\n/gu, "\n").split("\n");
    if (
      lines.filter((line) => line === `ARG NODE_VERSION=${NODE_VERSION}`).length !== 2 ||
      source.match(/test "\$\(node --version\)" = "v\$\{NODE_VERSION\}"/gu)?.length !== 2 ||
      !lines.includes(`ARG NODE_IMAGE=${NODE_IMAGE}`)
    ) {
      issues.push(`${name} Dockerfile Node version checks do not match the pinned image`);
    }
  }
  const nodeSetup = actionUseBlock(workflowSource, "actions/setup-node");
  if (nodeSetup === undefined || !nodeSetup.includes(`node-version: ${NODE_VERSION}`)) {
    issues.push("release setup-node version does not match the exact Node version");
  }
  if (workflowSource.includes("NODE_VERSION")) {
    issues.push("release workflow must not override the exact Node version");
  }
  return Object.freeze(issues);
}

export function validateDockerBuildContext(
  dockerIgnoreSource,
  workerSource,
  hostSource,
  workflowSource,
) {
  const issues = [];
  const exclusions = dockerIgnoreSource
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    exclusions.length !== DOCKER_CONTEXT_EXCLUSIONS.length ||
    exclusions.some((line, index) => line !== DOCKER_CONTEXT_EXCLUSIONS[index])
  ) {
    issues.push("Docker build context exclusions do not match the allowlist");
  }
  if (exclusions.some((line) => line.startsWith("!"))) {
    issues.push("Docker build context exclusions must not re-include files");
  }
  for (const [name, source] of [
    ["worker", workerSource],
    ["host", hostSource],
  ]) {
    if (source.match(/^COPY \. \.$/gmu)?.length !== 1) {
      issues.push(`${name} Dockerfile must copy the filtered source context once`);
    }
  }
  const contexts = workflowSource
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("context:"));
  if (
    contexts.length !== 2 ||
    contexts.some((line) => line !== "context: .") ||
    workflowSource.includes("build-contexts:")
  ) {
    issues.push("release image builds must use only the filtered root context");
  }
  return Object.freeze(issues);
}

export function validateReleaseWorkflow(source) {
  const issues = [];
  if (
    !source.includes(
      "concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false",
    )
  ) {
    issues.push("release workflow must serialize each ref without cancellation");
  }
  if (
    !source.includes("finalize-only:") ||
    !source.includes("resume-packages:") ||
    !source.includes("worker-digest:") ||
    !source.includes("host-digest:")
  ) {
    issues.push("release workflow must declare explicit recovery inputs");
  }
  const conflicting = workflowStep(source, "Reject conflicting recovery modes");
  if (
    conflicting === undefined ||
    !conflicting.includes("if: ${{ inputs['finalize-only'] && inputs['resume-packages'] }}")
  ) {
    issues.push("release workflow must reject conflicting recovery modes");
  }

  const normalPreflight = workflowStep(source, "Ref, manifest, and npm version preflight");
  if (
    normalPreflight === undefined ||
    !normalPreflight.includes(
      "if: ${{ !inputs['finalize-only'] && !inputs['resume-packages'] }}",
    ) ||
    !normalPreflight.includes("--mode release") ||
    !normalPreflight.includes('--npm-tag "$RELEASE_NPM_TAG"') ||
    !isolatesNpmTag(normalPreflight)
  ) {
    issues.push("release preflight must validate an environment-isolated npm tag");
  }

  const npmRecovery = workflowStep(source, "Partial npm publication recovery preflight");
  if (
    npmRecovery === undefined ||
    !npmRecovery.includes(
      "if: ${{ inputs['resume-packages'] && !inputs['finalize-only'] }}",
    ) ||
    !npmRecovery.includes("--mode resume") ||
    !npmRecovery.includes('--npm-tag "$RELEASE_NPM_TAG"') ||
    !isolatesNpmTag(npmRecovery)
  ) {
    issues.push("partial npm recovery must preflight mixed registry state");
  }
  issues.push(...validateWorkflowExecutionEnvelope(source));
  issues.push(...validateWorkflowActionPins(source));
  issues.push(...validateWorkflowCredentialScopes(source));
  issues.push(...validateWorkflowCredentialLifetime(source));
  issues.push(...validateWorkflowProtectedRef(source));
  issues.push(...validateWorkflowEvidenceSignatures(source));

  const recoveryPreflight = workflowStep(source, "Finalization recovery preflight");
  if (
    recoveryPreflight === undefined ||
    !recoveryPreflight.includes(
      "if: ${{ inputs['finalize-only'] && !inputs['resume-packages'] }}",
    ) ||
    !recoveryPreflight.includes("--mode finalize") ||
    !recoveryPreflight.includes("--worker-digest \"${{ inputs['worker-digest'] }}\"") ||
    !recoveryPreflight.includes("--host-digest \"${{ inputs['host-digest'] }}\"")
  ) {
    issues.push(
      "finalization recovery must preflight exact ref, manifests, npm, and digests",
    );
  }

  for (const image of ["worker", "host"]) {
    const title =
      image === "worker"
        ? "Build and publish isolated Worker image"
        : "Build and publish Production Host image";
    const id = image === "worker" ? "worker-build" : "host-build";
    const build = workflowStep(source, title);
    const expectedOutput =
      `outputs: type=image,name=ghcr.io/\${{ github.repository }}/${image},` +
      "push-by-digest=true,name-canonical=true,push=true";
    if (
      build === undefined ||
      !build.includes("if: ${{ !inputs['finalize-only'] }}") ||
      !build.includes(expectedOutput) ||
      build.includes("\n          tags:")
    ) {
      issues.push(
        `${image} image build must be normal-only and push by digest without tags`,
      );
    }
    const signed =
      `ghcr.io/\${{ github.repository }}/${image}@` + `\${{ steps.${id}.outputs.digest }}`;
    if (!source.includes(signed)) {
      issues.push(`${image} image signature must use the exact build digest`);
    }
  }

  const verification = workflowStep(source, "Verify supplied image signatures");
  if (
    verification === undefined ||
    !verification.includes("if: ${{ inputs['finalize-only'] }}") ||
    !verification.includes(
      'IDENTITY="https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF"',
    ) ||
    !verification.includes(
      '--certificate-oidc-issuer "https://token.actions.githubusercontent.com"',
    ) ||
    !verification.includes(
      `"ghcr.io/\${{ github.repository }}/worker@\${{ inputs['worker-digest'] }}"`,
    ) ||
    !verification.includes(
      `"ghcr.io/\${{ github.repository }}/host@\${{ inputs['host-digest'] }}"`,
    )
  ) {
    issues.push("finalization recovery must verify both exact digest signatures");
  }

  const publish = workflowStep(source, "Publish exact Apache-2.0 package tarballs");
  if (
    publish === undefined ||
    !publish.includes("if: ${{ !inputs['finalize-only'] }}") ||
    !publish.includes("--mode publish") ||
    !publish.includes('--npm-tag "$RELEASE_NPM_TAG"') ||
    publish.includes("pnpm --recursive") ||
    !isolatesNpmTag(publish)
  ) {
    issues.push("npm publication must use exact prepared tarballs with an isolated tag");
  }

  const publicationUpload = workflowStep(
    source,
    "Upload npm publication recovery evidence",
  );
  if (
    publicationUpload === undefined ||
    !publicationUpload.includes("if: ${{ always() && !inputs['finalize-only'] }}") ||
    !publicationUpload.includes("release/npm/publication-result.json")
  ) {
    issues.push("npm publication journal must upload after success or failure");
  }

  const preparation = workflowStep(source, "Prepare public package tarballs");
  const preparationIndex = source.indexOf("- name: Prepare public package tarballs");
  const sbomIndex = source.indexOf("- name: Generate SPDX SBOM");
  if (
    preparation === undefined ||
    !preparation.includes("if: ${{ !inputs['finalize-only'] }}") ||
    !preparation.includes("run: pnpm release:prepare-packages") ||
    preparationIndex < 0 ||
    sbomIndex <= preparationIndex
  ) {
    issues.push("normal release must prepare actual package tarballs before SBOM");
  }

  const supplyChainUpload = workflowStep(source, "Upload signed supply-chain evidence");
  if (supplyChainUpload === undefined || !supplyChainUpload.includes("release/npm/")) {
    issues.push("release supply-chain evidence must include prepared package tarballs");
  }

  const evidence = workflowStep(source, "Record signed image identities");
  if (
    evidence === undefined ||
    !evidence.includes("release-images.json") ||
    !evidence.includes("workerDigest: process.env.WORKER_DIGEST") ||
    !evidence.includes("hostDigest: process.env.HOST_DIGEST")
  ) {
    issues.push("normal release must record exact signed image identities");
  }

  const smoke = workflowStep(
    source,
    "Smoke-install public distribution from a clean directory",
  );
  if (
    smoke === undefined ||
    !smoke.includes("if (manifest.private !== true) console.log(manifest.name);")
  ) {
    issues.push("registry smoke must discover public packages only");
  }

  const verificationIndex = source.indexOf("- name: Verify supplied image signatures");
  const smokeIndex = source.indexOf(
    "- name: Smoke-install public distribution from a clean directory",
  );
  const finalizeIndex = source.indexOf("- name: Finalize Worker and Host release tags");
  if (
    verificationIndex < 0 ||
    smokeIndex <= verificationIndex ||
    finalizeIndex <= smokeIndex
  ) {
    issues.push("signature verification, registry smoke, and final tags must be ordered");
  }

  const finalize = workflowStep(source, "Finalize Worker and Host release tags");
  if (
    finalize === undefined ||
    !finalize.includes('VERSION="${{ steps.worker-version.outputs.version }}"')
  ) {
    issues.push("final image tags must use the verified manifest version");
  }
  const finalDigestVariables = [
    `WORKER_DIGEST="\${{ inputs['finalize-only'] && inputs['worker-digest'] || steps.worker-build.outputs.digest }}"`,
    `HOST_DIGEST="\${{ inputs['finalize-only'] && inputs['host-digest'] || steps.host-build.outputs.digest }}"`,
  ];
  if (
    finalize === undefined ||
    finalDigestVariables.some((value) => !finalize.includes(value))
  ) {
    issues.push("final image tags must select normal or verified recovery digests");
  }
  for (const image of ["worker", "host"]) {
    const variable = image === "worker" ? "WORKER_DIGEST" : "HOST_DIGEST";
    const required = [
      `--tag "ghcr.io/\${{ github.repository }}/${image}:$VERSION"`,
      `--tag "ghcr.io/\${{ github.repository }}/${image}:sha-$GITHUB_SHA"`,
      `"ghcr.io/\${{ github.repository }}/${image}@${"$"}${variable}"`,
    ];
    if (finalize === undefined || required.some((value) => !finalize.includes(value))) {
      issues.push(
        `${image} final tags must reference version, source SHA, and selected exact digest`,
      );
    }
  }
  return Object.freeze(issues);
}

function workflowStep(source, name) {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  const end = source.indexOf("\n      - ", start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}
function validateWorkflowExecutionEnvelope(source) {
  const issues = [];
  const permissionsIndex = source.indexOf("\npermissions:");
  const triggerBlock = permissionsIndex < 0 ? source : source.slice(0, permissionsIndex);
  if (
    !triggerBlock.includes("on:\n  workflow_dispatch:\n    inputs:") ||
    /^\s{2}(?:push|pull_request|pull_request_target|schedule|workflow_call):/mu.test(
      triggerBlock,
    )
  ) {
    issues.push("release workflow trigger must be workflow_dispatch only");
  }

  const concurrencyIndex = source.indexOf("\nconcurrency:");
  const permissionsBlock =
    permissionsIndex < 0 || concurrencyIndex <= permissionsIndex
      ? ""
      : source.slice(permissionsIndex + "\npermissions:".length, concurrencyIndex);
  const permissionLines = permissionsBlock
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    permissionLines.join("\n") !==
    ["contents: read", "id-token: write", "packages: write"].join("\n")
  ) {
    issues.push("release workflow permissions must match the exact minimal set");
  }

  const jobsIndex = source.indexOf("\njobs:");
  const jobsBlock = jobsIndex < 0 ? "" : source.slice(jobsIndex + "\njobs:".length);
  const jobNames = [...jobsBlock.matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):\s*$/gmu)].map(
    (match) => match[1],
  );
  if (jobNames.length !== 1 || jobNames[0] !== "publish") {
    issues.push("release workflow must contain exactly one publish job");
  }
  if (
    countOccurrences(source, "runs-on: ubuntu-latest") !== 1 ||
    countOccurrences(source, "timeout-minutes: 90") !== 1
  ) {
    issues.push("release publish job must use ubuntu-latest with a 90-minute timeout");
  }

  for (const required of [
    "image: postgres:17",
    "- 55432:5432",
    '--health-cmd "pg_isready -U prism"',
    "--health-interval 5s",
    "--health-timeout 5s",
    "--health-retries 10",
  ]) {
    if (countOccurrences(source, required) !== 1) {
      issues.push("release PostgreSQL service health envelope is invalid");
      break;
    }
  }
  if (
    !source.includes(
      "concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false",
    )
  ) {
    issues.push("release concurrency envelope is invalid");
  }
  return issues;
}

function validateWorkflowActionPins(source) {
  const issues = [];
  const counts = new Map();
  const useLines = source
    .split(/\r?\n/u)
    .filter((line) => /^\s*(?:-\s+)?uses:/u.test(line));
  for (const line of useLines) {
    const match = /^\s*(?:-\s+)?uses:\s*([^@\s]+)@([^\s#]+)/u.exec(line);
    if (match === null) {
      issues.push("release workflow contains an unparseable action reference");
      continue;
    }
    const [, repository, reference] = match;
    const expected = RELEASE_ACTION_PINS.get(repository);
    if (expected === undefined) {
      issues.push("release workflow uses an unapproved action repository");
      continue;
    }
    counts.set(repository, (counts.get(repository) ?? 0) + 1);
    if (!/^[0-9a-f]{40}$/u.test(reference) || reference !== expected.sha) {
      issues.push(`${repository} action pin does not match the allowlist`);
    }
  }
  for (const [repository, expected] of RELEASE_ACTION_PINS) {
    if ((counts.get(repository) ?? 0) !== expected.count) {
      issues.push(`${repository} action use count does not match the allowlist`);
    }
  }
  return issues;
}

function validateWorkflowCredentialScopes(source) {
  const issues = [];
  const stepsIndex = source.indexOf("\n    steps:");
  const jobScope = stepsIndex < 0 ? source : source.slice(0, stepsIndex);
  for (const name of [
    "NODE_AUTH_TOKEN:",
    "PRISM_TEST_DATABASE_URL:",
    "PRISM_REQUIRE_POSTGRES_TESTS:",
  ]) {
    if (jobScope.includes(name)) {
      issues.push("release workflow exposes sensitive environment at job scope");
      break;
    }
  }

  const npmIdentity = workflowStep(
    source,
    "Verify npm token and @prismengine scope access",
  );
  const exactPublish = workflowStep(source, "Publish exact Apache-2.0 package tarballs");
  const tokenBinding = "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}";
  if (
    countOccurrences(source, tokenBinding) !== 2 ||
    npmIdentity === undefined ||
    !npmIdentity.includes(tokenBinding) ||
    exactPublish === undefined ||
    !exactPublish.includes(tokenBinding)
  ) {
    issues.push("npm token must be scoped to identity verification and publication only");
  }

  const postgresTests = workflowStep(source, "Run required PostgreSQL tests");
  if (
    countOccurrences(source, "PRISM_TEST_DATABASE_URL:") !== 1 ||
    countOccurrences(source, "PRISM_REQUIRE_POSTGRES_TESTS:") !== 1 ||
    postgresTests === undefined ||
    !postgresTests.includes("PRISM_TEST_DATABASE_URL:") ||
    !postgresTests.includes('PRISM_REQUIRE_POSTGRES_TESTS: "1"')
  ) {
    issues.push("PostgreSQL test environment must be scoped to the required test step");
  }

  const smoke = workflowStep(
    source,
    "Smoke-install public distribution from a clean directory",
  );
  if (
    countOccurrences(source, "NODE_AUTH_TOKEN:") !== 3 ||
    smoke === undefined ||
    !smoke.includes('NODE_AUTH_TOKEN: ""')
  ) {
    issues.push("registry smoke must explicitly clear the npm token");
  }
  return issues;
}

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

function isolatesNpmTag(step) {
  const runIndex = step.indexOf("run:");
  const run = runIndex < 0 ? step : step.slice(runIndex);
  return (
    step.includes("RELEASE_NPM_TAG: ${{ inputs['npm-tag'] }}") &&
    !run.includes("inputs['npm-tag']") &&
    !run.includes("inputs.npm-tag")
  );
}
function validateWorkflowProtectedRef(source) {
  const issues = [];
  for (const name of [
    "Ref, manifest, and npm version preflight",
    "Partial npm publication recovery preflight",
    "Finalization recovery preflight",
    "Publish exact Apache-2.0 package tarballs",
  ]) {
    const step = workflowStep(source, name);
    const runIndex = step?.indexOf("run:") ?? -1;
    const run = runIndex < 0 ? "" : step.slice(runIndex);
    if (
      step === undefined ||
      !step.includes("RELEASE_REF_PROTECTED: ${{ github.ref_protected }}") ||
      !run.includes('--ref-protected "$RELEASE_REF_PROTECTED"') ||
      run.includes("github.ref_protected")
    ) {
      issues.push("release mutation paths must receive an isolated protected-ref value");
      break;
    }
  }
  if (
    countOccurrences(source, "RELEASE_REF_PROTECTED: ${{ github.ref_protected }}") !== 4
  ) {
    issues.push("protected-ref projection count does not match release paths");
  }
  const publish = workflowStep(source, "Publish exact Apache-2.0 package tarballs");
  if (publish === undefined || !publish.includes('--source-sha "$GITHUB_SHA"')) {
    issues.push("exact publication must bind the release source SHA");
  }
  const imageEvidence = workflowStep(source, "Record signed image identities");
  if (
    imageEvidence === undefined ||
    !imageEvidence.includes("RELEASE_REF: ${{ github.ref }}") ||
    !imageEvidence.includes("ref: process.env.RELEASE_REF") ||
    !imageEvidence.includes("sourceSha: process.env.RELEASE_SOURCE_SHA")
  ) {
    issues.push("release image evidence must bind exact ref and source SHA");
  }
  return issues;
}

function validateWorkflowEvidenceSignatures(source) {
  const issues = [];
  const packageSign = workflowStep(source, "Keyless-sign prepared package evidence");
  const imageSign = workflowStep(source, "Keyless-sign image identity evidence");
  const verify = workflowStep(source, "Verify custom release evidence");
  const upload = workflowStep(source, "Upload signed supply-chain evidence");
  const identity =
    'IDENTITY="https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF"';
  const issuer = '--certificate-oidc-issuer "https://token.actions.githubusercontent.com"';
  if (
    packageSign === undefined ||
    !packageSign.includes("if: ${{ !inputs['finalize-only'] }}") ||
    !packageSign.includes("--bundle release/npm/release-packages.json.sigstore.json") ||
    !packageSign.includes("release/npm/release-packages.json")
  ) {
    issues.push("prepared package evidence must be keyless-signed");
  }
  if (
    imageSign === undefined ||
    !imageSign.includes("if: ${{ !inputs['finalize-only'] }}") ||
    !imageSign.includes("--bundle release-images.json.sigstore.json") ||
    !imageSign.includes("release-images.json")
  ) {
    issues.push("image identity evidence must be keyless-signed");
  }
  if (
    verify === undefined ||
    !verify.includes(identity) ||
    countOccurrences(verify, issuer) !== 2 ||
    !verify.includes("--bundle release/npm/release-packages.json.sigstore.json") ||
    !verify.includes("--bundle release-images.json.sigstore.json")
  ) {
    issues.push("custom release evidence signatures must verify workflow identity");
  }
  if (
    upload === undefined ||
    !upload.includes("release/npm/*.tgz") ||
    !upload.includes("release/npm/release-packages.json") ||
    !upload.includes("release/npm/release-packages.json.sigstore.json") ||
    !upload.includes("release-images.json") ||
    !upload.includes("release-images.json.sigstore.json")
  ) {
    issues.push("signed supply-chain upload must contain exact evidence and bundles");
  }
  const packageSignIndex = source.indexOf("- name: Keyless-sign prepared package evidence");
  const imageSignIndex = source.indexOf("- name: Keyless-sign image identity evidence");
  const verifyIndex = source.indexOf("- name: Verify custom release evidence");
  const uploadIndex = source.indexOf("- name: Upload signed supply-chain evidence");
  if (
    packageSignIndex < 0 ||
    imageSignIndex <= packageSignIndex ||
    verifyIndex <= imageSignIndex ||
    uploadIndex <= verifyIndex
  ) {
    issues.push("custom evidence must be signed and verified before upload");
  }

  const publicationSign = workflowStep(source, "Keyless-sign npm publication result");
  const publicationUpload = workflowStep(
    source,
    "Upload npm publication recovery evidence",
  );
  if (
    publicationSign === undefined ||
    !publicationSign.includes(
      "if: ${{ always() && !inputs['finalize-only'] && hashFiles('release/npm/publication-result.json') != '' }}",
    ) ||
    !publicationSign.includes(
      "--bundle release/npm/publication-result.json.sigstore.json",
    ) ||
    !publicationSign.includes(identity) ||
    !publicationSign.includes(issuer)
  ) {
    issues.push("npm publication result must be always-run signed and verified");
  }
  if (
    publicationUpload === undefined ||
    !publicationUpload.includes("if: ${{ always() && !inputs['finalize-only'] }}") ||
    !publicationUpload.includes("release/npm/publication-result.json") ||
    !publicationUpload.includes("release/npm/publication-result.json.sigstore.json")
  ) {
    issues.push("npm publication result and bundle must upload on failure");
  }
  const publishIndex = source.indexOf("- name: Publish exact Apache-2.0 package tarballs");
  const publicationSignIndex = source.indexOf(
    "- name: Keyless-sign npm publication result",
  );
  const publicationUploadIndex = source.indexOf(
    "- name: Upload npm publication recovery evidence",
  );
  const smokeIndex = source.indexOf(
    "- name: Smoke-install public distribution from a clean directory",
  );
  if (
    publishIndex < 0 ||
    publicationSignIndex <= publishIndex ||
    publicationUploadIndex <= publicationSignIndex ||
    smokeIndex <= publicationUploadIndex
  ) {
    issues.push("publication evidence sign, upload, and smoke order is invalid");
  }
  return issues;
}

function validateWorkflowCredentialLifetime(source) {
  const issues = [];
  const checkout = actionUseBlock(source, "actions/checkout");
  if (checkout === undefined || !checkout.includes("persist-credentials: false")) {
    issues.push("checkout must not persist GitHub credentials");
  }

  const firstLoginName = "Login to GHCR for digest operations";
  const logoutName = "Logout GHCR before npm operations";
  const smokeName = "Smoke-install public distribution from a clean directory";
  const finalLoginName = "Login to GHCR for final tags";
  const finalizeName = "Finalize Worker and Host release tags";
  const firstLogin = workflowStep(source, firstLoginName);
  const logout = workflowStep(source, logoutName);
  const finalLogin = workflowStep(source, finalLoginName);
  const firstLoginIndex = source.indexOf(`- name: ${firstLoginName}`);
  const logoutIndex = source.indexOf(`- name: ${logoutName}`);
  const npmIdentityIndex = source.indexOf(
    "- name: Verify npm token and @prismengine scope access",
  );
  const publishIndex = source.indexOf("- name: Publish exact Apache-2.0 package tarballs");
  const smokeIndex = source.indexOf(`- name: ${smokeName}`);
  const finalLoginIndex = source.indexOf(`- name: ${finalLoginName}`);
  const finalizeIndex = source.indexOf(`- name: ${finalizeName}`);
  if (
    firstLogin === undefined ||
    logout === undefined ||
    finalLogin === undefined ||
    !logout.includes("run: docker logout ghcr.io") ||
    firstLoginIndex < 0 ||
    logoutIndex <= firstLoginIndex ||
    npmIdentityIndex <= logoutIndex ||
    publishIndex <= npmIdentityIndex ||
    smokeIndex <= publishIndex ||
    finalLoginIndex <= smokeIndex ||
    finalizeIndex <= finalLoginIndex
  ) {
    issues.push("GHCR credential login, logout, smoke, and final login order is invalid");
  }
  const betweenLogoutAndSmoke =
    logoutIndex >= 0 && smokeIndex > logoutIndex
      ? source.slice(logoutIndex, smokeIndex)
      : source;
  if (betweenLogoutAndSmoke.includes("docker/login-action@")) {
    issues.push("GHCR credentials must remain absent during npm operations and smoke");
  }
  const nextAfterFinalLogin = source.indexOf(
    "\n      - ",
    finalLoginIndex + finalLoginName.length,
  );
  if (
    nextAfterFinalLogin < 0 ||
    source.indexOf(`- name: ${finalizeName}`, nextAfterFinalLogin) !==
      nextAfterFinalLogin + "\n      ".length
  ) {
    issues.push("final GHCR login must occur immediately before tag finalization");
  }
  return issues;
}

function actionUseBlock(source, repository) {
  const marker = `uses: ${repository}@`;
  const useIndex = source.indexOf(marker);
  if (useIndex < 0) return undefined;
  const start = source.lastIndexOf("\n      - ", useIndex);
  const end = source.indexOf("\n      - ", useIndex);
  return source.slice(start < 0 ? 0 : start, end < 0 ? source.length : end);
}

export async function runReleasePreflight({
  root = repositoryRoot,
  mode = "manifest",
  ref,
  refProtected,
  sourceSha,
  registry = "https://registry.npmjs.org",
  fetchImpl = globalThis.fetch,
  workerDigest,
  hostDigest,
  npmTag,
  packImpl = defaultPack,
  preparePackImpl = defaultActualPack,
  prepareMaxBytes = PREPARED_TARBALL_MAX_BYTES,
  publisherImpl = defaultPublishTarball,
  publishPollAttempts = 20,
  publishPollDelayMs = 30_000,
  sleepImpl = delay,
} = {}) {
  if (
    mode !== "manifest" &&
    mode !== "release" &&
    mode !== "resume" &&
    mode !== "publish" &&
    mode !== "finalize" &&
    mode !== "packages" &&
    mode !== "prepare"
  ) {
    throw new ReleasePreflightError([`unsupported mode ${JSON.stringify(mode)}`]);
  }

  const issues = [];
  const rootManifest = readManifest(join(root, "package.json"), issues);
  const version = rootManifest?.version;
  if (typeof version !== "string" || !validVersion(version)) {
    issues.push("package.json has an invalid version");
  }

  const packageDirectory = join(root, "packages");
  let entries = [];
  try {
    entries = readdirSync(packageDirectory, { withFileTypes: true });
  } catch {
    issues.push("packages directory cannot be read");
  }

  const packages = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativePath = `packages/${entry.name}/package.json`;
      return {
        relativePath,
        manifest: readManifest(join(root, relativePath), issues),
      };
    })
    .filter(({ manifest }) => manifest !== undefined)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const internalNames = new Set();
  for (const { relativePath, manifest } of packages) {
    if (!canonicalInternalPackageName(manifest.name)) {
      issues.push(`${relativePath} has an invalid internal package name`);
      continue;
    }
    if (internalNames.has(manifest.name)) {
      issues.push(`${relativePath} duplicates an internal package name`);
    }
    internalNames.add(manifest.name);
  }

  const publicPackages = packages.filter(({ manifest }) => manifest.private !== true);
  for (const { relativePath, manifest } of publicPackages) {
    if (manifest.version !== version) {
      issues.push(`${relativePath} version must equal root version ${String(version)}`);
    }
  }

  const allowedWorkspaceSpec = `workspace:${String(version)}`;
  for (const { relativePath, manifest } of packages) {
    for (const section of dependencySections) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      if (
        typeof dependencies !== "object" ||
        dependencies === null ||
        Array.isArray(dependencies)
      ) {
        issues.push(`${relativePath} ${section} must be an object`);
        continue;
      }
      for (const [name, spec] of Object.entries(dependencies)) {
        if (internalNames.has(name) && spec !== allowedWorkspaceSpec) {
          issues.push(
            `${relativePath} ${section}.${name} must be workspace:${String(version)}`,
          );
        }
      }
    }
  }

  if (issues.length > 0) throw new ReleasePreflightError(issues);
  const releaseMode =
    mode === "release" || mode === "resume" || mode === "publish" || mode === "finalize";
  if (releaseMode && refProtected !== "true") {
    throw new ReleasePreflightError(["release ref must be protected"]);
  }
  if (mode === "publish" && !canonicalSourceSha(sourceSha)) {
    throw new ReleasePreflightError(["release source SHA is invalid"]);
  }

  if (
    (mode === "release" || mode === "resume" || mode === "publish") &&
    !canonicalNpmTag(npmTag)
  ) {
    throw new ReleasePreflightError(["npm dist-tag is invalid"]);
  }
  const releaseRef = ref ?? process.env.GITHUB_REF;
  if (releaseMode) {
    const expectedRef = `refs/tags/v${version}`;
    if (releaseRef !== expectedRef) {
      throw new ReleasePreflightError([
        `release ref must be ${expectedRef}; received ${String(releaseRef)}`,
      ]);
    }
  }

  if (mode === "finalize") {
    const digestIssues = [];
    if (!canonicalImageDigest(workerDigest)) {
      digestIssues.push("worker image digest must be canonical SHA-256");
    }
    if (!canonicalImageDigest(hostDigest)) {
      digestIssues.push("host image digest must be canonical SHA-256");
    }
    if (digestIssues.length > 0) throw new ReleasePreflightError(digestIssues);
  }

  if (mode === "release" || mode === "finalize") {
    const registryIssues = await verifyRegistryPackages({
      publicPackages,
      version,
      registry,
      fetchImpl,
      expectedStatus: mode === "release" ? 404 : 200,
    });
    if (registryIssues.length > 0) throw new ReleasePreflightError(registryIssues);
  }

  if (mode === "resume") {
    const registryIssues = await verifyRegistryPackages({
      publicPackages,
      version,
      registry,
      fetchImpl,
      expectedStatus: [200, 404],
    });
    if (registryIssues.length > 0) throw new ReleasePreflightError(registryIssues);
  }

  if (mode === "packages") {
    const packageIssues = await verifyPublicPackages(root, publicPackages, packImpl);
    if (packageIssues.length > 0) throw new ReleasePreflightError(packageIssues);
  }

  if (mode === "prepare") {
    const packageIssues = await preparePublicPackages({
      root,
      publicPackages,
      version,
      packImpl: preparePackImpl,
      maxTarballBytes: prepareMaxBytes,
    });
    if (packageIssues.length > 0) throw new ReleasePreflightError(packageIssues);
  }

  if (mode === "publish") {
    const publicationIssues = await publishPreparedPackages({
      root,
      packages,
      publicPackages,
      version,
      npmTag,
      ref: releaseRef,
      sourceSha,
      registry,
      fetchImpl,
      publisherImpl,
      pollAttempts: publishPollAttempts,
      pollDelayMs: publishPollDelayMs,
      sleepImpl,
    });
    if (publicationIssues.length > 0) throw new ReleasePreflightError(publicationIssues);
  }

  return Object.freeze({
    mode,
    version,
    publicPackageCount: publicPackages.length,
  });
}

async function verifyRegistryPackages({
  publicPackages,
  version,
  registry,
  fetchImpl,
  expectedStatus,
}) {
  if (typeof fetchImpl !== "function") return ["registry lookup is unavailable"];
  let registryBase;
  try {
    registryBase = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  } catch {
    return ["registry URL is invalid"];
  }
  const expectedStatuses = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  const issues = new Array(publicPackages.length);
  await Promise.all(
    publicPackages.map(async ({ manifest }, index) => {
      const packageName = manifest.name;
      const endpoint = new URL(
        `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
        registryBase,
      );
      try {
        const response = await fetchImpl(endpoint, {
          headers: { accept: "application/json" },
        });
        if (expectedStatuses.includes(response.status)) return;
        if (expectedStatus === 404 && response.status === 200) {
          issues[index] = `${packageName}@${version} already exists in the registry`;
        } else if (expectedStatus === 200 && response.status === 404) {
          issues[index] = `${packageName}@${version} is not available in the registry`;
        } else {
          issues[index] =
            `${packageName}@${version} registry lookup was indeterminate ` +
            `(HTTP ${String(response.status)})`;
        }
      } catch {
        issues[index] = `${packageName}@${version} registry lookup was indeterminate`;
      }
    }),
  );
  return issues.filter((issue) => typeof issue === "string");
}

function canonicalImageDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

async function publishPreparedPackages({
  root,
  packages,
  publicPackages,
  version,
  npmTag,
  ref,
  sourceSha,
  registry,
  fetchImpl,
  publisherImpl,
  pollAttempts,
  pollDelayMs,
  sleepImpl,
}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof publisherImpl !== "function" ||
    typeof sleepImpl !== "function" ||
    !Number.isSafeInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > 100 ||
    !Number.isSafeInteger(pollDelayMs) ||
    pollDelayMs < 0 ||
    pollDelayMs > 60_000
  ) {
    return ["package publication is unavailable"];
  }
  const prepared = await loadPreparedPackages(root, publicPackages, version);
  if (prepared.issues.length > 0) return prepared.issues;
  const topology = publicationTopology(packages, publicPackages);
  if (topology.issues.length > 0) return topology.issues;
  const entries = new Map(prepared.entries.map((entry) => [entry.name, entry]));

  let registryBase;
  try {
    registryBase = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  } catch {
    return ["registry URL is invalid"];
  }
  const initial = await Promise.all(
    topology.order.map(async (name) => ({
      name,
      state: await registryPackageState({
        registryBase,
        name,
        version,
        fetchImpl,
      }),
    })),
  );
  const initialIssues = [];
  const journalPackages = [];
  for (const result of initial) {
    const entry = entries.get(result.name);
    if (result.state.kind === "indeterminate") {
      initialIssues.push(`${result.name}@${version} registry metadata is indeterminate`);
      continue;
    }
    if (result.state.kind === "present" && result.state.integrity !== entry.integrity) {
      initialIssues.push(`${result.name}@${version} registry integrity does not match`);
      continue;
    }
    journalPackages.push({
      name: result.name,
      filename: entry.filename,
      integrity: entry.integrity,
      state: result.state.kind === "present" ? "EXISTING_VERIFIED" : "PENDING_PUBLICATION",
      tagState: "PENDING",
    });
  }
  if (initialIssues.length > 0) return initialIssues;

  const existingNames = initial
    .filter((result) => result.state.kind === "present")
    .map((result) => result.name);
  if (existingNames.length > 0) {
    let existingTagsVerified = false;
    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      const tags = await Promise.all(
        existingNames.map(async (name) => ({
          name,
          state: await registryTagState({
            registryBase,
            name,
            npmTag,
            fetchImpl,
          }),
        })),
      );
      let pending = false;
      for (const result of tags) {
        if (result.state.kind === "present" && result.state.version === version) {
          continue;
        }
        if (result.state.kind === "present" && result.state.version !== version) {
          return [`${result.name} npm dist-tag mapping does not match release version`];
        }
        pending = true;
      }
      if (!pending) {
        existingTagsVerified = true;
        break;
      }
      if (attempt < pollAttempts) await sleepImpl(pollDelayMs);
    }
    if (!existingTagsVerified) {
      return ["existing package npm dist-tag verification did not converge"];
    }
  }

  const journal = {
    schemaVersion: 1,
    version,
    npmTag,
    ref,
    sourceSha,
    status: "PLANNED",
    integrityStatus: "PENDING",
    tagStatus: "PENDING",
    packages: journalPackages,
  };
  if (!(await writePublicationJournal(root, journal))) {
    return ["package publication journal could not be written"];
  }

  for (let index = 0; index < journal.packages.length; index += 1) {
    const item = journal.packages[index];
    if (item.state === "EXISTING_VERIFIED") continue;
    try {
      await publisherImpl({
        root,
        tarballPath: `./release/npm/${item.filename}`,
        npmTag,
        packageName: item.name,
        version,
      });
      item.state = "PUBLISHED_AWAITING_VERIFICATION";
      journal.status = "PUBLISHING";
      if (!(await writePublicationJournal(root, journal))) {
        return ["package publication journal could not be written"];
      }
    } catch {
      item.state = "PUBLISH_FAILED";
      journal.status = "FAILED";
      await writePublicationJournal(root, journal);
      return [`package publication failed at topology index ${String(index)}`];
    }
  }

  let integrityVerified = false;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const verified = await Promise.all(
      journal.packages.map(async (item) => ({
        item,
        state: await registryPackageState({
          registryBase,
          name: item.name,
          version,
          fetchImpl,
        }),
      })),
    );
    let pending = false;
    for (const result of verified) {
      if (
        result.state.kind === "present" &&
        result.state.integrity === result.item.integrity
      ) {
        continue;
      }
      if (
        result.state.kind === "present" &&
        result.state.integrity !== result.item.integrity
      ) {
        journal.status = "VERIFICATION_FAILED";
        journal.integrityStatus = "FAILED";
        await writePublicationJournal(root, journal);
        return [`${result.item.name}@${version} registry integrity does not match`];
      }
      pending = true;
    }
    if (!pending) {
      for (const item of journal.packages) item.state = "INTEGRITY_VERIFIED";
      journal.status = "VERIFYING_TAGS";
      journal.integrityStatus = "VERIFIED";
      if (!(await writePublicationJournal(root, journal))) {
        return ["package publication journal could not be written"];
      }
      integrityVerified = true;
      break;
    }
    if (attempt < pollAttempts) await sleepImpl(pollDelayMs);
  }

  if (!integrityVerified) {
    journal.status = "VERIFICATION_FAILED";
    journal.integrityStatus = "FAILED";
    await writePublicationJournal(root, journal);
    return ["published package integrity verification did not converge"];
  }

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const tags = await Promise.all(
      journal.packages.map(async (item) => ({
        item,
        state: await registryTagState({
          registryBase,
          name: item.name,
          npmTag,
          fetchImpl,
        }),
      })),
    );
    let pending = false;
    for (const result of tags) {
      if (result.state.kind === "present" && result.state.version === version) {
        continue;
      }
      if (result.state.kind === "present" && result.state.version !== version) {
        result.item.tagState = "MISMATCH";
        journal.status = "TAG_VERIFICATION_FAILED";
        journal.tagStatus = "FAILED";
        await writePublicationJournal(root, journal);
        return [`${result.item.name} npm dist-tag mapping does not match release version`];
      }
      pending = true;
    }
    if (!pending) {
      for (const item of journal.packages) {
        item.state = "VERIFIED";
        item.tagState = "VERIFIED";
      }
      journal.status = "VERIFIED";
      journal.tagStatus = "VERIFIED";
      if (!(await writePublicationJournal(root, journal))) {
        return ["package publication journal could not be written"];
      }
      return [];
    }
    if (attempt < pollAttempts) await sleepImpl(pollDelayMs);
  }

  journal.status = "TAG_VERIFICATION_FAILED";
  journal.tagStatus = "FAILED";
  await writePublicationJournal(root, journal);
  return ["npm dist-tag verification did not converge"];
}

async function loadPreparedPackages(root, publicPackages, version) {
  const outputDirectory = resolve(root, "release/npm");
  const evidencePath = join(outputDirectory, "release-packages.json");
  let evidence;
  try {
    const metadata = await lstat(evidencePath);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > RELEASE_EVIDENCE_MAX_BYTES
    ) {
      return { entries: [], issues: ["prepared package evidence is invalid"] };
    }
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    return { entries: [], issues: ["prepared package evidence is invalid"] };
  }
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.version !== version ||
    !Array.isArray(evidence.packages)
  ) {
    return { entries: [], issues: ["prepared package evidence is invalid"] };
  }
  const expected = [...publicPackages].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  if (evidence.packages.length !== expected.length) {
    return { entries: [], issues: ["prepared package evidence closure does not match"] };
  }

  const issues = [];
  const entries = [];
  const filenames = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const packageDefinition = expected[index];
    const item = evidence.packages[index];
    const relativePath = packageDefinition.relativePath;
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      item.name !== packageDefinition.manifest.name ||
      item.version !== version ||
      !canonicalPackagePath(item.filename) ||
      dirname(item.filename) !== "." ||
      !item.filename.endsWith(".tgz") ||
      filenames.has(item.filename) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > PREPARED_TARBALL_MAX_BYTES ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(item.sha256) ||
      !canonicalSha512Integrity(item.integrity)
    ) {
      issues.push(`${relativePath} prepared package evidence is invalid`);
      continue;
    }
    filenames.add(item.filename);
    const archivePath = resolve(outputDirectory, item.filename);
    if (dirname(archivePath) !== outputDirectory) {
      issues.push(`${relativePath} prepared tarball escaped output directory`);
      continue;
    }
    try {
      const before = await lstat(archivePath);
      if (
        !before.isFile() ||
        before.size !== item.bytes ||
        before.size > PREPARED_TARBALL_MAX_BYTES
      ) {
        issues.push(`${relativePath} prepared tarball does not match evidence`);
        continue;
      }
      const archive = await hashPreparedTarball(
        archivePath,
        before,
        PREPARED_TARBALL_MAX_BYTES,
      );
      if (
        archive.bytes !== item.bytes ||
        archive.sha256 !== item.sha256 ||
        archive.integrity !== item.integrity
      ) {
        issues.push(`${relativePath} prepared tarball does not match evidence`);
        continue;
      }
      entries.push(item);
    } catch {
      issues.push(`${relativePath} prepared tarball could not be verified`);
    }
  }
  return { entries, issues };
}

function publicationTopology(packages, publicPackages) {
  const publicNames = new Set(publicPackages.map(({ manifest }) => manifest.name));
  const internalNames = new Set(packages.map(({ manifest }) => manifest.name));
  const byName = new Map(publicPackages.map((item) => [item.manifest.name, item]));
  const dependents = new Map([...publicNames].map((name) => [name, new Set()]));
  const indegree = new Map([...publicNames].map((name) => [name, 0]));
  const issues = [];
  for (const { relativePath, manifest } of publicPackages) {
    const dependencies = new Set();
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (internalNames.has(name) && !publicNames.has(name)) {
          issues.push(`${relativePath} has a nonpublic runtime dependency`);
        } else if (publicNames.has(name)) {
          dependencies.add(name);
        }
      }
    }
    for (const dependency of dependencies) {
      dependents.get(dependency).add(manifest.name);
      indegree.set(manifest.name, indegree.get(manifest.name) + 1);
    }
  }
  if (issues.length > 0) return { order: [], issues };

  const ready = [...publicNames].filter((name) => indegree.get(name) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const name = ready.shift();
    order.push(name);
    for (const dependent of [...dependents.get(name)].sort()) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== byName.size) {
    return { order: [], issues: ["public package dependency graph contains a cycle"] };
  }
  return { order, issues: [] };
}

async function registryPackageState({ registryBase, name, version, fetchImpl }) {
  const endpoint = new URL(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    registryBase,
  );
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: "application/json" },
    });
  } catch {
    return { kind: "indeterminate" };
  }
  if (response.status === 404) return { kind: "absent" };
  if (response.status !== 200) return { kind: "indeterminate" };
  let body;
  try {
    body = await readBoundedRegistryBody(response);
  } catch {
    return { kind: "indeterminate" };
  }
  try {
    const metadata = JSON.parse(body);
    const integrity = metadata?.dist?.integrity;
    return canonicalSha512Integrity(integrity)
      ? { kind: "present", integrity }
      : { kind: "indeterminate" };
  } catch {
    return { kind: "indeterminate" };
  }
}

async function registryTagState({ registryBase, name, npmTag, fetchImpl }) {
  const endpoint = new URL(`-/package/${encodeURIComponent(name)}/dist-tags`, registryBase);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: "application/json" },
    });
  } catch {
    return { kind: "indeterminate" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "indeterminate" };
  try {
    const tags = JSON.parse(await readBoundedRegistryBody(response));
    if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
      return { kind: "indeterminate" };
    }
    const version = tags[npmTag];
    if (version === undefined) return { kind: "missing" };
    return typeof version === "string"
      ? { kind: "present", version }
      : { kind: "indeterminate" };
  } catch {
    return { kind: "indeterminate" };
  }
}

async function readBoundedRegistryBody(response) {
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^(0|[1-9]\d*)$/u.test(declared) || Number(declared) > REGISTRY_METADATA_MAX_BYTES)
  ) {
    throw new Error("registry metadata size invalid");
  }
  if (response.body?.getReader !== undefined) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > REGISTRY_METADATA_MAX_BYTES) {
          await reader.cancel();
          throw new Error("registry metadata too large");
        }
        chunks.push(Buffer.from(result.value));
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > REGISTRY_METADATA_MAX_BYTES) {
    throw new Error("registry metadata too large");
  }
  return text;
}

function canonicalSha512Integrity(value) {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(value);
}

async function writePublicationJournal(root, journal) {
  const outputDirectory = resolve(root, "release/npm");
  const path = join(outputDirectory, "publication-result.json");
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    await rename(temporary, path);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

async function preparePublicPackages({
  root,
  publicPackages,
  version,
  packImpl,
  maxTarballBytes,
}) {
  if (
    typeof packImpl !== "function" ||
    !Number.isSafeInteger(maxTarballBytes) ||
    maxTarballBytes < 1
  ) {
    return ["package preparation is unavailable"];
  }
  const outputDirectory = resolve(root, "release/npm");
  try {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return ["package preparation output could not be initialized"];
  }

  const issues = [];
  const evidence = [];
  const preparedFilenames = new Set();
  for (const { relativePath, manifest } of publicPackages) {
    let output;
    try {
      output = await packImpl({
        packageDirectory: join(root, dirname(relativePath)),
        outputDirectory,
        relativePath,
        manifest,
      });
    } catch {
      issues.push(`${relativePath} pack command failed`);
      continue;
    }
    const inventoryIssues = validatePackOutput(relativePath, manifest, output);
    if (inventoryIssues.length > 0) {
      issues.push(...inventoryIssues);
      continue;
    }
    const result = singlePackResult(output);
    const reportedFilename = result?.filename;
    if (
      typeof reportedFilename !== "string" ||
      reportedFilename.length < 1 ||
      reportedFilename.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(reportedFilename)
    ) {
      issues.push(`${relativePath} prepared tarball filename is unsafe`);
      continue;
    }
    const archivePath = resolve(outputDirectory, reportedFilename);
    if (dirname(archivePath) !== outputDirectory) {
      issues.push(`${relativePath} prepared tarball escaped output directory`);
      continue;
    }
    const filename = basename(archivePath);
    if (!canonicalPackagePath(filename) || !filename.endsWith(".tgz")) {
      issues.push(`${relativePath} prepared tarball filename is unsafe`);
      continue;
    }
    if (preparedFilenames.has(filename)) {
      issues.push(`${relativePath} prepared tarball filename is duplicate`);
      continue;
    }
    preparedFilenames.add(filename);
    let archive;
    try {
      const before = await lstat(archivePath);
      if (!before.isFile()) {
        issues.push(`${relativePath} prepared tarball is not a regular file`);
        continue;
      }
      if (before.size < 1 || before.size > maxTarballBytes) {
        issues.push(`${relativePath} prepared tarball size is invalid`);
        continue;
      }
      const outputRealPath = await realpath(outputDirectory);
      const archiveRealPath = await realpath(archivePath);
      if (dirname(archiveRealPath) !== outputRealPath) {
        issues.push(`${relativePath} prepared tarball escaped output directory`);
        continue;
      }
      archive = await hashPreparedTarball(archivePath, before, maxTarballBytes);
    } catch {
      issues.push(`${relativePath} prepared tarball could not be verified`);
      continue;
    }
    evidence.push({
      name: manifest.name,
      version: manifest.version,
      filename,
      bytes: archive.bytes,
      sha256: archive.sha256,
      integrity: archive.integrity,
    });
  }

  if (issues.length > 0) {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    return issues;
  }
  evidence.sort((left, right) => left.name.localeCompare(right.name));
  const evidencePath = join(outputDirectory, "release-packages.json");
  const temporaryPath = `${evidencePath}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ schemaVersion: 1, version, packages: evidence }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(temporaryPath, evidencePath);
  } catch {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    return ["package preparation evidence could not be written"];
  }
  return [];
}

async function hashPreparedTarball(path, before, maxTarballBytes) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxTarballBytes) throw new Error("tarball grew beyond limit");
    sha256.update(chunk);
    sha512.update(chunk);
  }
  const after = await lstat(path);
  if (
    !after.isFile() ||
    bytes !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error("tarball changed while hashing");
  }
  return {
    bytes,
    sha256: sha256.digest("hex"),
    integrity: `sha512-${sha512.digest("base64")}`,
  };
}

function singlePackResult(output) {
  try {
    const parsed = JSON.parse(output);
    const results = Array.isArray(parsed) ? parsed : [parsed];
    return results.length === 1 &&
      typeof results[0] === "object" &&
      results[0] !== null &&
      !Array.isArray(results[0])
      ? results[0]
      : undefined;
  } catch {
    return undefined;
  }
}

async function verifyPublicPackages(root, publicPackages, packImpl) {
  if (typeof packImpl !== "function") return ["package verification is unavailable"];
  const issues = [];
  for (const { relativePath, manifest } of publicPackages) {
    let output;
    try {
      output = await packImpl({
        packageDirectory: join(root, dirname(relativePath)),
        relativePath,
        manifest,
      });
    } catch {
      issues.push(`${relativePath} pack command failed`);
      continue;
    }
    issues.push(...validatePackOutput(relativePath, manifest, output));
  }
  return issues;
}

function validatePackOutput(relativePath, manifest, output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [`${relativePath} pack output is invalid JSON`];
  }
  const results = Array.isArray(parsed) ? parsed : [parsed];
  if (
    results.length !== 1 ||
    typeof results[0] !== "object" ||
    results[0] === null ||
    Array.isArray(results[0])
  ) {
    return [`${relativePath} pack output must contain exactly one result`];
  }
  const result = results[0];
  if (result.name !== manifest.name || result.version !== manifest.version) {
    return [`${relativePath} packed identity does not match manifest`];
  }
  if (!Array.isArray(result.files)) {
    return [`${relativePath} pack output has no file inventory`];
  }

  const issues = [];
  const paths = new Set();
  for (let index = 0; index < result.files.length; index += 1) {
    const entry = result.files[index];
    const path =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? entry.path
        : undefined;
    if (!canonicalPackagePath(path)) {
      issues.push(
        `${relativePath} pack output has unsafe file path at index ${String(index)}`,
      );
      continue;
    }
    if (paths.has(path)) {
      issues.push(
        `${relativePath} pack output has duplicate file path at index ${String(index)}`,
      );
      continue;
    }
    paths.add(path);
  }

  for (const required of ["package.json", "LICENSE", "NOTICE"]) {
    if (!paths.has(required)) issues.push(`${relativePath} pack output omits ${required}`);
  }
  for (const target of declaredPackageTargets(manifest)) {
    if (!canonicalPackagePath(target.path)) {
      issues.push(`${relativePath} declares invalid ${target.label} target`);
    } else if (!paths.has(target.path)) {
      issues.push(`${relativePath} pack output omits declared ${target.label} target`);
    }
  }
  return issues;
}

function declaredPackageTargets(manifest) {
  const targets = [];
  for (const field of ["main", "module", "types"]) {
    if (manifest[field] !== undefined) {
      targets.push({ label: field, path: packageTarget(manifest[field]) });
    }
  }
  if (typeof manifest.bin === "string") {
    targets.push({ label: "bin", path: packageTarget(manifest.bin) });
  } else if (
    typeof manifest.bin === "object" &&
    manifest.bin !== null &&
    !Array.isArray(manifest.bin)
  ) {
    for (const value of Object.values(manifest.bin)) {
      targets.push({ label: "bin", path: packageTarget(value) });
    }
  } else if (manifest.bin !== undefined) {
    targets.push({ label: "bin", path: undefined });
  }
  collectExportTargets(manifest.exports, targets);
  return targets;
}

function collectExportTargets(value, targets) {
  if (typeof value === "string") {
    targets.push({ label: "exports", path: packageTarget(value) });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectExportTargets(item, targets);
  }
}

function packageTarget(value) {
  if (typeof value !== "string") return undefined;
  return value.startsWith("./") ? value.slice(2) : value;
}

function canonicalPackagePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function defaultPack({ packageDirectory }) {
  return runPnpmPack(packageDirectory, ["pack", "--dry-run", "--json"]);
}

function defaultActualPack({ packageDirectory, outputDirectory }) {
  return runPnpmPack(packageDirectory, [
    "pack",
    "--json",
    "--pack-destination",
    outputDirectory,
  ]);
}

function runPnpmPack(packageDirectory, args) {
  return new Promise((complete, reject) => {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath === undefined) {
      reject(new Error("pnpm execution path unavailable"));
      return;
    }
    const child = spawn(process.execPath, [npmExecPath, ...args], {
      cwd: packageDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        oversized = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (oversized || code !== 0) {
        reject(new Error("pack failed"));
        return;
      }
      complete(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function defaultPublishTarball({ root, tarballPath, npmTag }) {
  return new Promise((complete, reject) => {
    const child = spawn(
      "npm",
      ["publish", tarballPath, "--access", "public", "--provenance", "--tag", npmTag],
      {
        cwd: root,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) complete();
      else reject(new Error("npm publish failed"));
    });
  });
}

function readManifest(path, issues) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    issues.push(`${relativeManifestPath(path)} cannot be read`);
    return undefined;
  }
  try {
    const manifest = JSON.parse(source);
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      issues.push(`${relativeManifestPath(path)} must contain a JSON object`);
      return undefined;
    }
    return manifest;
  } catch {
    issues.push(`${relativeManifestPath(path)} contains invalid JSON`);
    return undefined;
  }
}

function relativeManifestPath(path) {
  return path === join(repositoryRoot, "package.json") ? "package.json" : path;
}

function validVersion(value) {
  const identifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
  const buildIdentifier = String.raw`[0-9A-Za-z-]+`;
  return new RegExp(
    String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
      String.raw`(?:-${identifier}(?:\.${identifier})*)?` +
      String.raw`(?:\+${buildIdentifier}(?:\.${buildIdentifier})*)?$`,
    "u",
  ).test(value);
}

function canonicalInternalPackageName(value) {
  if (typeof value !== "string") return false;
  const prefix = "@prismengine/";
  if (!value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  return (
    suffix.length >= 1 &&
    suffix.length <= NPM_PACKAGE_SUFFIX_MAX_LENGTH &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(suffix)
  );
}

function canonicalNpmTag(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value) &&
    !validVersion(value)
  );
}

function canonicalSourceSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (
      ![
        "--mode",
        "--root",
        "--npm-tag",
        "--ref",
        "--registry",
        "--ref-protected",
        "--source-sha",
        "--worker-digest",
        "--host-digest",
      ].includes(name)
    ) {
      throw new ReleasePreflightError([`unknown argument ${String(name)}`]);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new ReleasePreflightError([`${name} requires a value`]);
    }
    index += 1;
    if (name === "--mode") options.mode = value;
    if (name === "--root") options.root = resolve(value);
    if (name === "--npm-tag") options.npmTag = value;
    if (name === "--ref") options.ref = value;
    if (name === "--ref-protected") options.refProtected = value;
    if (name === "--source-sha") options.sourceSha = value;
    if (name === "--registry") options.registry = value;
    if (name === "--worker-digest") options.workerDigest = value;
    if (name === "--host-digest") options.hostDigest = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReleasePreflight(parseArguments(process.argv.slice(2)));
    console.log(
      `RELEASE PREFLIGHT PASS mode=${result.mode} version=${result.version} ` +
        `publicPackages=${String(result.publicPackageCount)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release preflight failed.");
    process.exitCode = 1;
  }
}
