import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import {
  WorkerLauncherCapabilityToken,
  type WorkerProcessHandle,
} from "@prismengine/contracts-worker";
import {
  ProjectBuildCapabilityToken,
  type ProjectBuildCapability,
  ProjectRuntimeCapabilityToken,
  type ProjectReleaseDefinition,
  type ProjectSourceFile,
  type ProjectRuntimeInstance,
} from "@prismengine/contracts-project";
import { localArtifactStorePlugin } from "@prismengine/plugin-artifact-store-local";
import { createEngine, definePlugin } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import { HttpCapabilityToken, createHttpPlugin } from "@prismengine/plugin-http-fastify";
import {
  ProjectReleaseResource,
  projectBuildPlugin,
} from "@prismengine/plugin-project-build";
import { projectRuntimePlugin } from "@prismengine/plugin-project-runtime";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { LocalWorkerLauncher, workerLocalPlugin } from "@prismengine/plugin-worker-local";

async function buildRelease(
  builds: ProjectBuildCapability,
  projectId: string,
  sourceRevision: number,
) {
  const build = await builds.build(context, projectId, sourceRevision);
  expect(build.status).toBe("SUCCESS");
  const artifactSet = await builds.artifactSet(context, build.id);
  if (artifactSet === null) throw new Error("Build Artifact Set was not created");
  return builds.composeRelease(
    context,
    projectId,
    build.id,
    [],
    artifactSet.runtimeProfile,
  );
}

const context = systemCallContext({ correlationId: "project-runtime-test" });
const TEST_PROFILE = {
  profileId: "runtime-test",
  contractVersion: "1.0.0",
  semanticVersion: "1.0.0",
  pluginIdentities: [],
  sdkTypesFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  profileFingerprint: "a".repeat(64),
};

function releaseFiles(
  files: readonly ProjectSourceFile[],
  coefficient: "1.1" | "1.2",
): readonly ProjectSourceFile[] {
  const value = coefficient === "1.1" ? "1320" : "1440";
  const materialVersion = coefficient === "1.1" ? "1.0.0" : "2.0.0";
  const mapped = files
    .filter(
      (file) =>
        file.path !== "src/materials/coefficient.ts" &&
        file.path !== "prism.materials.json",
    )
    .map((file) => {
      if (file.path === "src/client/index.tsx") {
        return {
          ...file,
          content: `export async function mount(context: { root: HTMLElement }): Promise<void> { context.root.textContent = '${value}'; }\n`,
        };
      }
      if (file.path === "src/server/index.ts") {
        return {
          ...file,
          content: [
            "export const actions = {",
            "  async calculate(input: { base: number }, context: { logger: { info(value: unknown): void }, materials: { execute(id: string, version: string, input: number): Promise<unknown> } }) {",
            `    const value = Number(await context.materials.execute('performance.coefficient', '${materialVersion}', input.base));`,
            `    context.logger.info('coefficient ${coefficient}');`,
            `    return { value, coefficient: ${coefficient} };`,
            "  },",
            "  async slow() { await new Promise<void>(() => undefined); return { slow: false }; },",
            "  async crash() { (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1); },",
            "  async ping() { return { pong: true }; },",
            "  async pid() { return { pid: (globalThis as unknown as { process: { pid: number } }).process.pid }; },",
            "  async noisy(_input: null, context: { logger: { info(value: unknown): void } }) { for (let index = 0; index < 200; index += 1) context.logger.info('L'.repeat(2_000)); return { logged: true }; },",
            "  async largeResult() { return { value: 'x'.repeat(1_100_000) }; },",
            "  async invalidResult() { const value: { self?: unknown } = {}; value.self = value; return value; },",
            "  async longError() { throw new Error('E'.repeat(10_000)); },",
            "  async capabilities(_input: null, context: { engine: { inspect(): { capabilities: unknown[] } } }) { return { count: context.engine.inspect().capabilities.length }; },",
            "};",
            "",
          ].join("\n"),
        };
      }
      return file;
    });
  return [
    ...mapped,
    {
      path: "src/materials/coefficient.ts",
      mediaType: "text/typescript",
      content: `export default async function coefficient(input: number): Promise<number> { if (input === -1) await new Promise<void>(() => undefined); return input * ${coefficient}; }\n`,
    },
    {
      path: "prism.materials.json",
      mediaType: "application/json",
      content: `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          materials: [
            {
              id: "performance.coefficient",
              version: materialVersion,
              kind: "operator",
              authoringMode: "CODE",
              displayName: "系数调整",
              category: "绩效",
              runtimeTarget: "pipeline",
              entry: "src/materials/coefficient.ts",
              exportName: "default",
            },
          ],
        },
        null,
        2,
      )}\n`,
    },
  ];
}

class FakeRuntimeWorkerHandle implements WorkerProcessHandle {
  readonly pid = 84;
  private connectedState = true;
  private killedState = false;
  private exited = false;
  private initialized = false;
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly exits = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  killCount = 0;
  disconnectCount = 0;

  constructor(
    private readonly mode: "zero-exit" | "send-error" | "ready-then-send-error",
  ) {}

  get connected(): boolean {
    return this.connectedState;
  }

  get killed(): boolean {
    return this.killedState;
  }
  get stderrListenerCount(): number {
    return this.stderrListeners.size;
  }

  send(message: unknown): void {
    if (this.mode === "send-error") {
      throw new Error("private runtime transport credential failure");
    }
    if (this.mode === "ready-then-send-error") {
      if (this.initialized) {
        throw new Error("private action transport credential failure");
      }
      this.initialized = true;
      const init = message as {
        readonly projectId: string;
        readonly release: { readonly revision: number; readonly fingerprint: string };
        readonly runtimeAbiVersion: string;
        readonly runtimeProfile: { readonly profileFingerprint: string };
        readonly serverArtifactHash: string;
        readonly actionIds: readonly string[];
        readonly materials: readonly {
          readonly manifest: { readonly id: string; readonly version: string };
        }[];
      };
      queueMicrotask(() => {
        const ready = {
          type: "ready",
          projectId: init.projectId,
          releaseRevision: init.release.revision,
          releaseFingerprint: init.release.fingerprint,
          runtimeAbiVersion: init.runtimeAbiVersion,
          runtimeProfile: init.runtimeProfile,
          runtimeProfileFingerprint: init.runtimeProfile.profileFingerprint,
          serverArtifactHash: init.serverArtifactHash,
          actions: [...init.actionIds].sort(),
          materialIdentities: init.materials
            .map((item) => `${item.manifest.id}@${item.manifest.version}`)
            .sort(),
        };
        for (const listener of this.messages) listener(ready);
      });
      return;
    }
    queueMicrotask(() => {
      if (this.exited) return;
      this.exited = true;
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
    this.connectedState = false;
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
describe("Project App Runtime", () => {
  it("health-checks, activates, invokes, rolls back, and preserves RunPins", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-artifacts-"));
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({
      port: 0,
      inspection: () => engine.inspect(),
      devPrincipal: { id: "runtime-test", roles: ["system"], permissions: ["*"] },
    });
    engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin({ runtimeProfile: TEST_PROFILE, sdkTypes: "" }),
        projectRuntimePlugin({ profileIdentity: TEST_PROFILE }),
        http,
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const storage = engine.capability(StorageCapabilityToken);
      const created = await projects.create(context, {
        id: "runtime-performance",
        slug: "runtime-performance",
        name: "Runtime Performance",
      });
      const draft1 = await projects.saveDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
        releaseFiles(created.draft.files, "1.1"),
      );
      const source1 = await projects.publishDraft(
        context,
        created.project.id,
        draft1.draftVersion,
      );
      await buildRelease(builds, created.project.id, source1.revision);
      const after1 = await projects.draft(context, created.project.id);
      const draft2 = await projects.saveDraft(
        context,
        created.project.id,
        after1.draftVersion,
        releaseFiles(after1.files, "1.2"),
      );
      const source2 = await projects.publishDraft(
        context,
        created.project.id,
        draft2.draftVersion,
      );
      await buildRelease(builds, created.project.id, source2.revision);
      expect(await runtime.releaseMaterials(context, created.project.id, 1)).toMatchObject([
        {
          status: "BUILT",
          manifest: { id: "performance.coefficient", version: "1.0.0" },
          artifact: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        },
      ]);
      expect(await runtime.releaseMaterials(context, created.project.id, 2)).toMatchObject([
        {
          status: "BUILT",
          manifest: { id: "performance.coefficient", version: "2.0.0" },
        },
      ]);

      const active1 = await runtime.activate(context, created.project.id, 1, null);
      expect(
        await runtime.executeMaterial(
          context,
          created.project.id,
          active1.release,
          "performance.coefficient",
          "1.0.0",
          1200,
        ),
      ).toBe(1320);
      expect(active1.release.revision).toBe(1);
      const run1 = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "calculate",
        { base: 1200 },
      );
      expect(run1).toMatchObject({
        status: "SUCCESS",
        release: active1.release,
        result: { value: 1320, coefficient: 1.1 },
        pin: {
          definition: { kind: "project.release", revision: 1 },
          definitionFingerprint: active1.release.fingerprint,
        },
        reproducibility: "BEST_EFFORT",
      });
      const capabilityRun = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "capabilities",
        null,
      );
      expect(capabilityRun.status).toBe("SUCCESS");
      expect(
        typeof capabilityRun.result === "object" &&
          capabilityRun.result !== null &&
          "count" in capabilityRun.result
          ? capabilityRun.result.count
          : 0,
      ).toBeGreaterThan(0);
      const logsBeforeNoisy = (await runtime.logs(context, created.project.id)).length;
      const noisy = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "noisy",
        null,
      );
      expect(noisy).toMatchObject({ status: "SUCCESS", result: { logged: true } });
      const logsAfterNoisy = await runtime.logs(context, created.project.id);
      const noisyLogs = logsAfterNoisy.slice(logsBeforeNoisy);
      expect(noisyLogs).toHaveLength(100);
      expect(noisyLogs.every((log) => log.message.length <= 1_024)).toBe(true);
      expect(noisyLogs.at(-1)?.message).toContain("[TRUNCATED]");

      const largeResult = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "largeResult",
        null,
      );
      expect(largeResult).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_OUTPUT_TOO_LARGE"),
      });
      expect(largeResult.result).toBeUndefined();

      const invalidResult = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "invalidResult",
        null,
      );
      expect(invalidResult).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_OUTPUT_INVALID"),
      });
      expect(invalidResult.result).toBeUndefined();

      const longError = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "longError",
        null,
      );
      expect(longError.status).toBe("FAILED");
      expect(longError.error?.length).toBeLessThanOrEqual(4_224);
      expect(longError.error?.endsWith("[TRUNCATED]")).toBe(true);
      await expect(
        runtime.invoke(context, created.project.id, active1.release, "ping", null),
      ).resolves.toMatchObject({ status: "SUCCESS", result: { pong: true } });
      await expect(runtime.activate(context, created.project.id, 2, null)).rejects.toThrow(
        "PROJECT_ACTIVE_RELEASE_CONFLICT",
      );

      const active2 = await runtime.activate(
        context,
        created.project.id,
        2,
        active1.release,
      );
      expect(
        await runtime.executeMaterial(
          context,
          created.project.id,
          active2.release,
          "performance.coefficient",
          "2.0.0",
          1200,
        ),
      ).toBe(1440);
      const run2 = await runtime.invoke(
        context,
        created.project.id,
        active2.release,
        "calculate",
        { base: 1200 },
      );
      expect(run2).toMatchObject({
        status: "SUCCESS",
        release: active2.release,
        result: { value: 1440, coefficient: 1.2 },
        pin: { definitionFingerprint: active2.release.fingerprint },
      });
      await expect(
        runtime.invoke(context, created.project.id, active1.release, "calculate", {
          base: 1200,
        }),
      ).rejects.toThrow("PROJECT_RELEASE_CHANGED");
      const missing = await runtime.invoke(
        context,
        created.project.id,
        active2.release,
        "missing-action",
        null,
      );
      expect(missing).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_NOT_FOUND"),
      });
      expect(run2.pin.definitionFingerprint).not.toBe(run1.pin.definitionFingerprint);
      const release2 = await builds.release(context, created.project.id, 2);
      const wrongProfile = {
        ...release2!.spec.runtimeProfile,
        profileFingerprint: "b".repeat(64),
      };
      const mismatchDraft = await storage.resources.saveDraft(context, {
        kind: ProjectReleaseResource.kind,
        id: release2!.id,
        name: "Runtime Profile Mismatch",
        spec: {
          ...release2!.spec,
          runtimeProfile: wrongProfile,
          buildArtifactSet: {
            ...release2!.spec.buildArtifactSet,
            runtimeProfile: wrongProfile,
          },
          releaseFingerprint: "c".repeat(64),
        },
      });
      const mismatchRelease = await storage.resources.publish(
        context,
        ProjectReleaseResource.kind,
        release2!.id,
        mismatchDraft.revision,
      );
      await expect(
        runtime.activate(
          context,
          created.project.id,
          mismatchRelease.revision,
          active2.release,
        ),
      ).rejects.toThrow("PROJECT_RUNTIME_PROFILE_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toEqual(active2);

      const rollback = await runtime.activate(
        context,
        created.project.id,
        1,
        active2.release,
      );
      const run3 = await runtime.invoke(
        context,
        created.project.id,
        rollback.release,
        "calculate",
        { base: 1200 },
      );
      expect(run3).toMatchObject({ release: rollback.release, result: { value: 1320 } });
      expect(await runtime.getRun(context, run1.id)).toEqual(run1);
      expect(
        (await runtime.listRuns(context, created.project.id)).map((run) => run.id),
      ).toEqual(expect.arrayContaining([run1.id, run2.id, run3.id]));
      expect(
        (await runtime.logs(context, created.project.id)).map((log) => log.message),
      ).toEqual(expect.arrayContaining(["coefficient 1.1", "coefficient 1.2"]));
      await expect(
        storage.collection("project.release-activations").count(context),
      ).resolves.toBe(3);
      await expect(
        storage.collection("project.runtime-instances").count(context),
      ).resolves.toBeGreaterThanOrEqual(3);

      const address = engine.capability(HttpCapabilityToken).address();
      if (address === null) throw new Error("HTTP server did not bind");
      const staleClient = await fetch(
        `${address}/api/runtime/${created.project.id}/actions/calculate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ release: active2.release, input: { base: 1200 } }),
        },
      );
      expect(staleClient.status).toBe(409);
      expect(await staleClient.json()).toMatchObject({
        diagnostics: [{ code: "PROJECT_RELEASE_CHANGED" }],
      });
      const app = await fetch(`${address}/apps/runtime-performance`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain("Release 1");
      const release1 = await builds.release(context, created.project.id, 1);
      const client = await fetch(
        `${address}/runtime/artifacts/${release1!.spec.clientArtifact.hash}/client.js?projectId=${created.project.id}&revision=1`,
      );
      expect(client.headers.get("cache-control")).toContain("immutable");
      expect(await client.text()).toContain("1320");
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects incompatible ABI, manifest mismatch, and corrupt Artifacts without switching Active", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-negative-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin(),
        projectRuntimePlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const storage = engine.capability(StorageCapabilityToken);
      const created = await projects.create(context, {
        id: "negative-runtime",
        slug: "negative-runtime",
        name: "Negative Runtime",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );
      const release1 = await buildRelease(builds, created.project.id, source.revision);

      const publishVariant = async (spec: ProjectReleaseDefinition) => {
        const draft = await storage.resources.saveDraft(context, {
          kind: ProjectReleaseResource.kind,
          id: release1.id,
          name: release1.name,
          spec,
        });
        return storage.resources.publish<ProjectReleaseDefinition>(
          context,
          ProjectReleaseResource.kind,
          release1.id,
          draft.revision,
        );
      };
      const abi = await publishVariant({ ...release1.spec, runtimeAbiVersion: "9.0.0" });
      await expect(
        runtime.activate(context, created.project.id, abi.revision, null),
      ).rejects.toThrow("PROJECT_RUNTIME_ABI_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      const manifest = await publishVariant({
        ...release1.spec,
        actionIds: ["not-exported"],
      });
      await expect(
        runtime.activate(context, created.project.id, manifest.revision, null),
      ).rejects.toThrow("PROJECT_RUNTIME_MANIFEST_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      const missing = await publishVariant({
        ...release1.spec,
        serverArtifact: {
          hash: "0".repeat(64),
          size: 1,
          contentType: "application/vnd.prism.server",
          fileCount: 1,
        },
      });
      await expect(
        runtime.activate(context, created.project.id, missing.revision, null),
      ).rejects.toThrow("PROJECT_ARTIFACT_HASH_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      await writeFile(
        join(
          artifacts,
          "sha256",
          release1.spec.serverArtifact.hash.slice(0, 2),
          release1.spec.serverArtifact.hash,
          "server.js",
        ),
        "tampered",
      );
      await expect(runtime.activate(context, created.project.id, 1, null)).rejects.toThrow(
        "PROJECT_ARTIFACT_HASH_MISMATCH",
      );
      expect(await runtime.active(context, created.project.id)).toBeNull();
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("times out or restarts a crashed Worker without changing Active Release", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-restart-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin(),
        // Integration contract: exercise the real cross-process timeout boundary.
        projectRuntimePlugin({ actionTimeoutMs: 50 }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const created = await projects.create(context, {
        id: "restart-runtime",
        slug: "restart-runtime",
        name: "Restart Runtime",
      });
      const draft = await projects.saveDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
        releaseFiles(created.draft.files, "1.1"),
      );
      const source = await projects.publishDraft(
        context,
        created.project.id,
        draft.draftVersion,
      );
      await buildRelease(builds, created.project.id, source.revision);
      const active = await runtime.activate(context, created.project.id, 1, null);
      const cancelled = new AbortController();
      cancelled.abort();
      const cancelledContext = systemCallContext({
        correlationId: "project-runtime-pre-cancelled",
        signal: cancelled.signal,
      });
      await expect(
        runtime.invoke(cancelledContext, created.project.id, active.release, "slow", null),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        runtime.executeMaterial(
          cancelledContext,
          created.project.id,
          active.release,
          "performance.coefficient",
          "1.0.0",
          1200,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(runtime.listRuns(context, created.project.id)).resolves.toEqual([]);

      const pidBefore = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "pid",
        null,
      );
      expect(pidBefore).toMatchObject({
        status: "SUCCESS",
        result: { pid: expect.any(Number) },
      });
      const instanceStore = engine
        .capability(StorageCapabilityToken)
        .collection<ProjectRuntimeInstance>("project.runtime-instances");
      const instancesBeforeRestart = await instanceStore.find(context, {
        where: { projectId: created.project.id },
      });
      await expect(
        runtime.executeMaterial(
          context,
          created.project.id,
          active.release,
          "performance.coefficient",
          "1.0.0",
          -1,
        ),
      ).rejects.toThrow("PROJECT_ACTION_TIMEOUT");
      const replacementRuns = await Promise.all(
        Array.from({ length: 8 }, () =>
          runtime.invoke(context, created.project.id, active.release, "pid", null),
        ),
      );
      expect(replacementRuns.every((run) => run.status === "SUCCESS")).toBe(true);
      const replacementPids = replacementRuns.map((run) =>
        typeof run.result === "object" &&
        run.result !== null &&
        "pid" in run.result &&
        typeof run.result.pid === "number"
          ? run.result.pid
          : null,
      );
      expect(new Set(replacementPids).size).toBe(1);
      const pidAfter = replacementPids[0];
      expect(pidAfter).not.toBeNull();
      expect(
        typeof pidBefore.result === "object" &&
          pidBefore.result !== null &&
          "pid" in pidBefore.result
          ? pidBefore.result.pid
          : null,
      ).not.toBe(pidAfter);
      const instancesAfterRestart = await instanceStore.find(context, {
        where: { projectId: created.project.id },
      });
      expect(instancesAfterRestart).toHaveLength(instancesBeforeRestart.length + 1);
      expect(
        await runtime.invoke(context, created.project.id, active.release, "ping", null),
      ).toMatchObject({ status: "SUCCESS", result: { pong: true } });
      const timeout = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "slow",
        null,
      );
      expect(timeout).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_TIMEOUT"),
      });
      expect(
        await runtime.invoke(context, created.project.id, active.release, "ping", null),
      ).toMatchObject({ status: "SUCCESS", result: { pong: true } });

      const crash = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "crash",
        null,
      );
      expect(crash).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_RUNTIME_DISCONNECTED"),
      });
      expect(
        await runtime.invoke(context, created.project.id, active.release, "ping", null),
      ).toMatchObject({ status: "SUCCESS", result: { pong: true } });
      expect((await runtime.active(context, created.project.id))?.release).toEqual(
        active.release,
      );
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("settles startup and request transport failures without switching Active", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-ready-failure-"));
    const local = new LocalWorkerLauncher();
    let mode:
      | "zero-exit"
      | "send-error"
      | "launch-error"
      | "ready-then-send-error"
      | "local-runtime" = "zero-exit";
    let failedLaunchDirectory: string | undefined;
    const handles: FakeRuntimeWorkerHandle[] = [];
    const delegatingLauncher = definePlugin({
      id: "test.project-runtime-ready-launcher",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [WorkerLauncherCapabilityToken],
      register(pluginContext) {
        pluginContext.provide(WorkerLauncherCapabilityToken, {
          profile: () => local.profile(),
          productionReadiness: (call) => local.productionReadiness(call),
          launch: async (call, request) => {
            if (request.kind === "project-build" || mode === "local-runtime") {
              return local.launch(call, request);
            }
            if (mode === "launch-error") {
              failedLaunchDirectory = request.mounts?.[0]?.source;
              throw new Error("private runtime launcher credential failure");
            }
            const handle = new FakeRuntimeWorkerHandle(mode);
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
        delegatingLauncher,
        projectBuildPlugin(),
        projectRuntimePlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const created = await projects.create(context, {
        id: "ready-failure-runtime",
        slug: "ready-failure-runtime",
        name: "READY Failure Runtime",
      });
      const draft = await projects.saveDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
        releaseFiles(created.draft.files, "1.1"),
      );
      const source = await projects.publishDraft(
        context,
        created.project.id,
        draft.draftVersion,
      );
      await buildRelease(builds, created.project.id, source.revision);

      await expect(
        runtime.activate(context, created.project.id, 1, null),
      ).rejects.toMatchObject({
        diagnostics: [
          {
            code: "PROJECT_RUNTIME_MANIFEST_MISMATCH",
            message: "Runtime Worker exited before READY.",
          },
        ],
      });
      expect(handles[0]).toMatchObject({
        killed: true,
        killCount: 1,
        disconnectCount: 1,
        stderrListenerCount: 0,
      });
      await expect(runtime.active(context, created.project.id)).resolves.toBeNull();

      mode = "send-error";
      let sendFailure: unknown;
      try {
        await runtime.activate(context, created.project.id, 1, null);
      } catch (error) {
        sendFailure = error;
      }
      expect(sendFailure).toMatchObject({
        diagnostics: [
          {
            code: "PROJECT_RUNTIME_MANIFEST_MISMATCH",
            message: "Runtime Worker could not accept initialization.",
          },
        ],
      });
      expect(JSON.stringify(sendFailure)).not.toContain("credential");
      expect(handles[1]).toMatchObject({
        killed: true,
        killCount: 1,
        disconnectCount: 1,
        stderrListenerCount: 0,
      });
      await expect(runtime.active(context, created.project.id)).resolves.toBeNull();

      mode = "launch-error";
      let launchFailure: unknown;
      try {
        await runtime.activate(context, created.project.id, 1, null);
      } catch (error) {
        launchFailure = error;
      }
      expect(launchFailure).toMatchObject({
        diagnostics: [
          {
            code: "PROJECT_RUNTIME_START_FAILED",
            message: "Project Runtime Worker could not be started.",
          },
        ],
      });
      expect(JSON.stringify(launchFailure)).not.toContain("credential");
      if (failedLaunchDirectory === undefined) {
        throw new Error("Runtime launcher did not receive a mounted directory.");
      }
      await expect(stat(failedLaunchDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(runtime.active(context, created.project.id)).resolves.toBeNull();

      const instances = await engine
        .capability(StorageCapabilityToken)
        .collection<ProjectRuntimeInstance>("project.runtime-instances")
        .find(context, { where: { projectId: created.project.id } });
      expect(instances).toHaveLength(3);
      expect(instances.every((instance) => instance.status === "FAILED")).toBe(true);
      expect(JSON.stringify(instances)).not.toContain("credential");

      mode = "ready-then-send-error";
      const active = await runtime.activate(context, created.project.id, 1, null);
      expect(handles[2]?.stderrListenerCount).toBe(1);
      const failedRun = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "ping",
        null,
      );
      expect(failedRun).toMatchObject({
        status: "FAILED",
        error: "PROJECT_RUNTIME_DISCONNECTED: Runtime Worker transport is unavailable.",
      });
      expect(JSON.stringify(failedRun)).not.toContain("credential");
      expect(handles[2]).toMatchObject({
        killed: true,
        killCount: 1,
        disconnectCount: 1,
        stderrListenerCount: 0,
      });
      expect((await runtime.active(context, created.project.id))?.release).toEqual(
        active.release,
      );

      mode = "local-runtime";
      await expect(
        runtime.invoke(context, created.project.id, active.release, "ping", null),
      ).resolves.toMatchObject({
        status: "SUCCESS",
        result: { pong: true },
      });
      expect((await runtime.active(context, created.project.id))?.release).toEqual(
        active.release,
      );
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an unavailable Runtime Profile module without changing Active", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-profile-unavailable-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        workerLocalPlugin,
        projectBuildPlugin({ runtimeProfile: TEST_PROFILE, sdkTypes: "" }),
        projectRuntimePlugin({
          profileIdentity: TEST_PROFILE,
          profileModule: join(artifacts, "missing-runtime-profile.js"),
        }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const created = await projects.create(context, {
        id: "profile-unavailable",
        slug: "profile-unavailable",
        name: "Profile Unavailable",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );
      await buildRelease(builds, created.project.id, source.revision);
      await expect(runtime.activate(context, created.project.id, 1, null)).rejects.toThrow(
        "PROJECT_RUNTIME_PROFILE_UNAVAILABLE",
      );
      expect(await runtime.active(context, created.project.id)).toBeNull();
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);
});
