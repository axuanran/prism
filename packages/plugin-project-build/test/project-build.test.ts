import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismError, systemCallContext } from "@prismengine/contracts-data";
import { ArtifactStoreCapabilityToken } from "@prismengine/contracts-artifact";
import { ProjectBuildCapabilityToken } from "@prismengine/contracts-project";
import {
  WORKER_STDERR_MAX_BYTES,
  WORKER_STDERR_TRUNCATION_MARKER,
  WorkerLauncherCapabilityToken,
  type WorkerProcessHandle,
} from "@prismengine/contracts-worker";
import { createEngine, definePlugin } from "@prismengine/kernel";
import {
  LocalArtifactStore,
  localArtifactStorePlugin,
} from "@prismengine/plugin-artifact-store-local";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import { projectBuildPlugin } from "@prismengine/plugin-project-build";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { workerLocalPlugin } from "@prismengine/plugin-worker-local";
import { HttpCapabilityToken, createHttpPlugin } from "@prismengine/plugin-http-fastify";

const context = systemCallContext({ correlationId: "project-build-test" });
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
interface VisualDraftHttpBody {
  readonly resource: {
    readonly revision: number;
    readonly updatedAt: string;
    readonly spec: { readonly fingerprint: string };
  };
  readonly validation: { readonly valid: boolean };
}

function assertVisualDraftHttpBody(value: unknown): asserts value is VisualDraftHttpBody {
  if (
    typeof value !== "object" ||
    value === null ||
    !("resource" in value) ||
    typeof value.resource !== "object" ||
    value.resource === null ||
    !("revision" in value.resource) ||
    typeof value.resource.revision !== "number" ||
    !("updatedAt" in value.resource) ||
    typeof value.resource.updatedAt !== "string" ||
    !("spec" in value.resource) ||
    typeof value.resource.spec !== "object" ||
    value.resource.spec === null ||
    !("fingerprint" in value.resource.spec) ||
    typeof value.resource.spec.fingerprint !== "string" ||
    !("validation" in value) ||
    typeof value.validation !== "object" ||
    value.validation === null ||
    !("valid" in value.validation) ||
    typeof value.validation.valid !== "boolean"
  ) {
    throw new Error("Visual Draft HTTP response is malformed");
  }
}

class FakeBuildWorkerHandle implements WorkerProcessHandle {
  readonly pid = 42;
  private connectedState = true;
  private killedState = false;
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly exits = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  constructor(private readonly mode: "zero-exit" | "send-error" | "oversized-response") {}
  killCount = 0;
  disconnectCount = 0;

  get connected(): boolean {
    return this.connectedState;
  }

  get killed(): boolean {
    return this.killedState;
  }

  send(): void {
    if (this.mode === "send-error") {
      throw new Error("private worker transport credential failure");
    }
    if (this.mode === "oversized-response") {
      const response = {
        type: "success",
        clientArtifact: {
          contentType: "application/test",
          files: [
            {
              path: "oversized.bin",
              content: new Uint8Array(16 * 1_024 * 1_024 + 1),
            },
          ],
        },
        serverArtifact: { contentType: "application/test", files: [] },
        testReportArtifact: { contentType: "application/json", files: [] },
        testSummary: { passed: true, total: 1, failed: 0 },
        packageJsonHash: "a".repeat(64),
        dependencyLockHash: "b".repeat(64),
        pnpmVersion: "1.0.0",
        materials: [],
        logs: [],
        actionIds: [],
      };
      queueMicrotask(() => {
        for (const listener of this.messages) listener(response);
      });
      return;
    }
    const stderr = new TextEncoder().encode(
      `${"x".repeat(WORKER_STDERR_MAX_BYTES)}private-tail-credential`,
    );
    for (const listener of this.stderrListeners) listener(stderr);
    queueMicrotask(() => {
      this.connectedState = false;
      for (const listener of this.exits) listener(0, null);
    });
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connectedState = false;
  }

  kill(): void {
    this.killCount += 1;
    this.killedState = true;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }
}

describe("Project Build Worker", () => {
  it("installs, typechecks, tests, builds, verifies exports, and publishes Release", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-artifacts-test-"));
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({
      port: 0,
      inspection: () => engine.inspect(),
      devPrincipal: { id: "project-build-test", roles: ["system"] },
    });
    engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin(),
        http,
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "build-project",
        slug: "build-project",
        name: "Build Project",
      });
      const materialEntry = {
        path: "src/materials/coefficient.ts",
        mediaType: "text/typescript",
        content:
          "export default function coefficient(value: number): number { return value * 1.1; }\n",
      };
      const manifest = {
        path: "prism.materials.json",
        mediaType: "application/json",
        content: `${JSON.stringify(
          {
            schemaVersion: "1.0.0",
            materials: [
              {
                id: "performance.coefficient",
                version: "1.0.0",
                kind: "operator",
                authoringMode: "CODE",
                displayName: "系数调整",
                category: "绩效",
                runtimeTarget: "pipeline",
                entry: materialEntry.path,
                exportName: "default",
                visualOperator: {
                  inputSchema: { type: "number" },
                  outputSchema: { type: "number" },
                  configurationSchema: {
                    type: "object",
                    properties: { coefficient: { type: "string" } },
                    required: ["coefficient"],
                  },
                  executionModel: "ROW_MAP",
                  cardinality: "ONE_TO_ONE",
                  grainEffect: "PRESERVE",
                  supportedBackends: ["calculation.memory"],
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
      };
      const saved = await projects.saveDraft(context, created.project.id, 1, [
        ...created.draft.files.filter((file) => file.path !== manifest.path),
        materialEntry,
        manifest,
      ]);
      const source = await projects.publishDraft(
        context,
        created.project.id,
        saved.draftVersion,
      );
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const build = await builds.build(context, created.project.id, source.revision);
      const logs = await builds.buildLog(context, build.id);
      expect(
        build.status,
        JSON.stringify({ diagnostics: build.diagnostics, logs }, null, 2),
      ).toBe("SUCCESS");
      expect(build.releaseId).toBeUndefined();
      expect(await builds.releases(context, created.project.id)).toEqual([]);
      const artifactSet = await builds.artifactSet(context, build.id);
      expect(artifactSet).toMatchObject({
        id: build.id,
        buildId: build.id,
        projectId: created.project.id,
        runtimeProfile: { profileId: "prism-default" },
        artifactSetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const release = await builds.composeRelease(
        context,
        created.project.id,
        build.id,
        [],
        artifactSet!.runtimeProfile,
      );
      expect(release).toMatchObject({
        status: "published",
        revision: 1,
        spec: {
          sourceRevision: 1,
          sourceFingerprint: source.spec.fingerprint,
          builderVersion: expect.any(String),
          testResult: { passed: true, failed: 0 },
          runtimeAbiVersion: "1.0.0",
          clientEntryExport: "mount",
          serverEntryExport: "actions",
          buildReproducibility: "DETERMINISTIC",
          runtimeReproducibility: "UNKNOWN",
          materials: [
            {
              materialId: "performance.coefficient",
              materialVersion: "1.0.0",
              source: {
                authoringMode: "CODE",
                module: {
                  artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                  dependencyLockHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                },
              },
            },
          ],
        },
      });
      const artifactStore = engine.capability(ArtifactStoreCapabilityToken);
      for (const descriptor of [
        release!.spec.clientArtifact,
        release!.spec.serverArtifact,
        release!.spec.buildManifestArtifact,
      ]) {
        await expect(artifactStore.verify(context, descriptor)).resolves.toBe(true);
      }
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Vite client build PASS"),
          expect.stringContaining("esbuild server build PASS"),
        ]),
      );
      const manifestBytes = await artifactStore.read(
        context,
        release!.spec.buildManifestArtifact,
        "build-manifest.json",
      );
      expect(JSON.parse(new TextDecoder().decode(manifestBytes))).toMatchObject({
        sourceFingerprint: source.spec.fingerprint,
      });
      const visualCatalog = await builds.visualMaterialCatalog(context, build.id);
      expect(visualCatalog).toEqual([
        expect.objectContaining({
          manifest: expect.objectContaining({
            id: "performance.coefficient",
            displayName: "系数调整",
          }),
          exactRef: expect.objectContaining({
            projectId: created.project.id,
            buildId: build.id,
            buildFingerprint: artifactSet!.buildFingerprint,
            artifactHash: artifactSet!.materialArtifacts[0]!.hash,
            manifestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
          visualPropertyFields: [
            expect.objectContaining({
              path: "/coefficient",
              control: "string",
              required: true,
            }),
          ],
        }),
      ]);
      const visualMaterial = artifactSet!.materialManifests[0]!;
      const validation = await builds.validateVisualPipeline(context, build.id, {
        schemaVersion: "1.0.0",
        code: "invalid-configuration",
        name: "Invalid Configuration",
        inputs: [],
        nodes: [
          {
            nodeId: "coefficient",
            material: {
              projectId: artifactSet!.projectId,
              buildId: artifactSet!.buildId,
              buildFingerprint: artifactSet!.buildFingerprint,
              sourceRevision: artifactSet!.sourceRevision,
              sourceFingerprint: artifactSet!.sourceFingerprint,
              dependencyLockHash: artifactSet!.dependencyLockHash,
              materialId: visualMaterial.id,
              materialVersion: visualMaterial.version,
              artifactHash: artifactSet!.materialArtifacts[0]!.hash,
              manifestFingerprint: fingerprint(visualMaterial),
            },
            configuration: { coefficient: 1.1 },
            inputBindings: {},
          },
        ],
        outputs: [],
      });
      expect(validation.valid).toBe(false);
      expect(validation.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "VISUAL_PIPELINE_CONFIGURATION_INVALID" }),
        ]),
      );
      const visualResources = [
        {
          kind: source.kind,
          resourceId: source.id,
          revision: source.revision,
          fingerprint: source.spec.fingerprint,
        },
      ];
      const release2 = await builds.composeRelease(
        context,
        created.project.id,
        build.id,
        visualResources,
        artifactSet!.runtimeProfile,
      );
      expect(release2.revision).toBe(2);
      expect(release2.spec.buildArtifactSet.id).toBe(release!.spec.buildArtifactSet.id);
      expect(release2.spec.serverArtifact.hash).toBe(release!.spec.serverArtifact.hash);
      expect(release2.spec.releaseFingerprint).not.toBe(release!.spec.releaseFingerprint);
      const duplicate = await builds.composeRelease(
        context,
        created.project.id,
        build.id,
        visualResources,
        artifactSet!.runtimeProfile,
      );
      expect(duplicate.revision).toBe(release2.revision);
      await expect(
        builds.composeRelease(context, created.project.id, build.id, [], {
          ...artifactSet!.runtimeProfile,
          profileFingerprint: "c".repeat(64),
        }),
      ).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "PROJECT_BUILD_RUNTIME_PROFILE_MISMATCH" }),
        ]),
      });
      const exactMaterial = visualCatalog[0]!;
      const pipeline = {
        schemaVersion: "1.0.0" as const,
        code: "browser-coefficient",
        name: "Browser Coefficient",
        inputs: [],
        nodes: [
          {
            nodeId: "coefficient",
            material: exactMaterial.exactRef,
            configuration: { coefficient: "1.1" },
            inputBindings: {},
          },
        ],
        outputs: [],
      };
      const address = engine.capability(HttpCapabilityToken).address();
      if (address === null) throw new Error("HTTP server did not bind");
      const draftResponse = await fetch(
        `${address}/api/code-projects/${created.project.id}/visual-pipeline/draft`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buildId: build.id,
            spec: pipeline,
            expectedUpdatedAt: null,
          }),
        },
      );
      expect(draftResponse.status).toBe(201);
      const draftBody: unknown = await draftResponse.json();
      assertVisualDraftHttpBody(draftBody);
      expect(draftBody.validation.valid).toBe(true);

      const staleResponse = await fetch(
        `${address}/api/code-projects/${created.project.id}/visual-pipeline/draft`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buildId: build.id,
            spec: { ...pipeline, name: "Stale edit" },
            expectedUpdatedAt: null,
          }),
        },
      );
      expect(staleResponse.status).toBe(409);

      const diffResponse = await fetch(
        `${address}/api/code-projects/${created.project.id}/visual-pipeline/diff`,
      );
      expect(diffResponse.status).toBe(200);
      expect(await diffResponse.json()).toMatchObject({
        draftRevision: draftBody.resource.revision,
        publishedRevision: null,
        changedSections: ["code", "name", "inputs", "nodes", "outputs"],
      });

      const publishResponse = await fetch(
        `${address}/api/code-projects/${created.project.id}/visual-pipeline/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            buildId: build.id,
            revision: draftBody.resource.revision,
            expectedUpdatedAt: draftBody.resource.updatedAt,
            expectedPipelineFingerprint: draftBody.resource.spec.fingerprint,
          }),
        },
      );
      expect(publishResponse.status).toBe(201);
      expect(await publishResponse.json()).toMatchObject({
        pipeline: {
          status: "published",
          spec: { fingerprint: draftBody.resource.spec.fingerprint },
        },
        release: {
          revision: 3,
          spec: {
            visualResources: [
              {
                kind: "project.visual-pipeline",
                fingerprint: draftBody.resource.spec.fingerprint,
              },
            ],
          },
        },
      });
      expect(await builds.listBuilds(context, created.project.id)).toHaveLength(1);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("does not create a Project Release when tests fail", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-artifacts-failure-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "failed-build",
        slug: "failed-build",
        name: "Failed Build",
      });
      const files = created.draft.files.map((file) =>
        file.path === "tests/project.test.ts"
          ? { ...file, content: "export default async () => ({ passed: false });\n" }
          : file,
      );
      const saved = await projects.saveDraft(context, created.project.id, 1, files);
      const source = await projects.publishDraft(
        context,
        created.project.id,
        saved.draftVersion,
      );
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const build = await builds.build(context, created.project.id, source.revision);
      expect(build.status).toBe("FAILED");
      expect(build.diagnostics[0]?.code).toBe("PROJECT_BUILD_FAILED");
      expect(await builds.releases(context, created.project.id)).toEqual([]);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an SDK Types fingerprint that differs from the Build environment", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-sdk-types-mismatch-"));
    const runtimeProfile = {
      profileId: "test-profile",
      contractVersion: "1.0.0",
      semanticVersion: "1.0.0",
      pluginIdentities: [],
      sdkTypesFingerprint: "f".repeat(64),
      profileFingerprint: "e".repeat(64),
    };
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin({ runtimeProfile, sdkTypes: "" }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "sdk-types-mismatch",
        slug: "sdk-types-mismatch",
        name: "SDK Types Mismatch",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const build = await builds.build(context, created.project.id, source.revision);
      expect(build.status).toBe("FAILED");
      expect(build.diagnostics[0]?.code).toBe("PROJECT_SDK_TYPES_MISMATCH");
      expect(await builds.artifactSet(context, build.id)).toBeNull();
      expect(await builds.releases(context, created.project.id)).toEqual([]);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("terminalizes Worker lifecycle and oversized protocol responses", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-build-worker-lifecycle-"));
    let mode: "zero-exit" | "send-error" | "oversized-response" = "zero-exit";
    const handles: FakeBuildWorkerHandle[] = [];
    const fakeLauncher = definePlugin({
      id: "test.project-build-worker-lifecycle",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [WorkerLauncherCapabilityToken],
      register(pluginContext) {
        pluginContext.provide(WorkerLauncherCapabilityToken, {
          profile: () => ({
            providerId: "test.project-build-worker-lifecycle",
            isolation: "process",
            external: false,
          }),
          productionReadiness: async () => ({
            id: "worker-container-isolation",
            passed: false,
          }),
          launch: async () => {
            const handle = new FakeBuildWorkerHandle(mode);
            handles.push(handle);
            return handle;
          },
        });
      },
    });
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        fakeLauncher,
        projectBuildPlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const created = await projects.create(context, {
        id: "worker-lifecycle-build",
        slug: "worker-lifecycle-build",
        name: "Worker Lifecycle Build",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );

      const zeroExit = await builds.build(context, created.project.id, source.revision);
      expect(zeroExit).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_FAILED",
            message: "Build Worker exited before returning a response.",
          },
        ],
      });
      expect(handles[0]).toMatchObject({
        killCount: 0,
        disconnectCount: 1,
      });
      const zeroExitLogs = await builds.buildLog(context, zeroExit.id);
      expect(zeroExitLogs.at(-1)).toBe(WORKER_STDERR_TRUNCATION_MARKER);
      expect(JSON.stringify(zeroExitLogs)).not.toContain("private-tail-credential");
      expect(
        new TextEncoder().encode(zeroExitLogs[0] ?? "").byteLength,
      ).toBeLessThanOrEqual(WORKER_STDERR_MAX_BYTES);

      mode = "send-error";
      const sendFailure = await builds.build(context, created.project.id, source.revision);
      expect(sendFailure).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_FAILED",
            message: "Build Worker could not accept the request.",
          },
        ],
      });
      expect(JSON.stringify(sendFailure.diagnostics)).not.toContain("credential");
      expect(handles[1]).toMatchObject({
        killed: true,
        killCount: 1,
        disconnectCount: 1,
      });

      mode = "oversized-response";
      const oversized = await builds.build(context, created.project.id, source.revision);
      expect(oversized).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_OUTPUT_TOO_LARGE",
            message:
              "PROJECT_BUILD_OUTPUT_TOO_LARGE: Build Worker output exceeds protocol limits.",
          },
        ],
      });
      expect(handles[2]).toMatchObject({
        killed: false,
        disconnectCount: 1,
      });
      await expect(builds.artifactSet(context, oversized.id)).resolves.toBeNull();
      await expect(builds.artifactSet(context, zeroExit.id)).resolves.toBeNull();
      await expect(builds.artifactSet(context, sendFailure.id)).resolves.toBeNull();
      await expect(builds.releases(context, created.project.id)).resolves.toEqual([]);
      const persisted = await builds.listBuilds(context, created.project.id);
      expect(persisted).toHaveLength(3);
      expect(persisted.every((build) => build.status === "FAILED")).toBe(true);
      expect(persisted.some((build) => build.status === "RUNNING")).toBe(false);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  });

  it("terminalizes Artifact finalization failure without exposing an Artifact Set", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-build-finalization-"));
    const delegate = new LocalArtifactStore(artifacts);
    let putCount = 0;
    const failingArtifactStore = definePlugin({
      id: "test.project-build-artifact-failure",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [ArtifactStoreCapabilityToken],
      register(pluginContext) {
        pluginContext.provide(ArtifactStoreCapabilityToken, {
          profile: () => delegate.profile(),
          productionReadiness: (call) => delegate.productionReadiness(call),
          exists: (call, ref) => delegate.exists(call, ref),
          stat: (call, ref) => delegate.stat(call, ref),
          read: (call, ref, path) => delegate.read(call, ref, path),
          verify: (call, ref) => delegate.verify(call, ref),
          putImmutable: async (call, input) => {
            putCount += 1;
            if (putCount === 2) {
              throw new Error("private artifact endpoint credential failure");
            }
            return delegate.putImmutable(call, input);
          },
        });
      },
    });
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        failingArtifactStore,
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const created = await projects.create(context, {
        id: "finalization-failure-build",
        slug: "finalization-failure-build",
        name: "Finalization Failure Build",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );

      const build = await builds.build(context, created.project.id, source.revision);

      expect(build).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_FINALIZATION_FAILED",
            message: "Project Build finalization failed.",
          },
        ],
      });
      expect(JSON.stringify(build.diagnostics)).not.toContain("credential");
      expect(putCount).toBe(4);
      expect(await builds.buildLog(context, build.id)).not.toEqual([]);
      await expect(builds.artifactSet(context, build.id)).resolves.toBeNull();
      await expect(builds.releases(context, created.project.id)).resolves.toEqual([]);
      const persisted = await builds.listBuilds(context, created.project.id);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ id: build.id, status: "FAILED" });
      expect(persisted.some((item) => item.status === "RUNNING")).toBe(false);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("terminalizes Worker launch cancellation and failure without leaving RUNNING", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-build-launch-failure-"));
    let mode: "cancel" | "error" = "cancel";
    let launchController: AbortController | undefined;
    let launchCount = 0;
    const fakeLauncher = definePlugin({
      id: "test.project-build-launcher",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [WorkerLauncherCapabilityToken],
      register(pluginContext) {
        pluginContext.provide(WorkerLauncherCapabilityToken, {
          profile: () => ({
            providerId: "test.project-build-launcher",
            isolation: "process",
            external: false,
          }),
          productionReadiness: async () => ({
            id: "worker-container-isolation",
            passed: false,
          }),
          launch: async () => {
            launchCount += 1;
            if (mode === "cancel") {
              launchController?.abort();
              throw PrismError.of(
                "WORKER_LAUNCH_CANCELLED",
                "Worker launch was cancelled.",
              );
            }
            throw new Error("private launcher credential failure");
          },
        });
      },
    });
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        fakeLauncher,
        projectBuildPlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const created = await projects.create(context, {
        id: "launch-failure-build",
        slug: "launch-failure-build",
        name: "Launch Failure Build",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );

      const preCancelled = new AbortController();
      preCancelled.abort();
      await expect(
        builds.build(
          systemCallContext({
            correlationId: "project-build-pre-cancelled",
            signal: preCancelled.signal,
          }),
          created.project.id,
          source.revision,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(builds.listBuilds(context, created.project.id)).resolves.toEqual([]);
      expect(launchCount).toBe(0);

      launchController = new AbortController();
      const cancelled = await builds.build(
        systemCallContext({
          correlationId: "project-build-launch-cancelled",
          signal: launchController.signal,
        }),
        created.project.id,
        source.revision,
      );
      expect(cancelled).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_CANCELLED",
            message: "Project Build was cancelled.",
          },
        ],
      });
      await expect(builds.artifactSet(context, cancelled.id)).resolves.toBeNull();
      await expect(builds.releases(context, created.project.id)).resolves.toEqual([]);

      mode = "error";
      const failed = await builds.build(context, created.project.id, source.revision);
      expect(failed).toMatchObject({
        status: "FAILED",
        diagnostics: [
          {
            code: "PROJECT_BUILD_FAILED",
            message: "Project Build Worker could not be started.",
          },
        ],
      });
      expect(JSON.stringify(failed.diagnostics)).not.toContain("credential");
      await expect(builds.artifactSet(context, failed.id)).resolves.toBeNull();
      await expect(builds.releases(context, created.project.id)).resolves.toEqual([]);
      const persisted = await builds.listBuilds(context, created.project.id);
      expect(persisted).toHaveLength(2);
      expect(persisted.every((build) => build.status === "FAILED")).toBe(true);
      expect(persisted.some((build) => build.status === "RUNNING")).toBe(false);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
