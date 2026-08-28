import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactStoreCapabilityToken,
  type ArtifactRef,
  type ArtifactStoreCapability,
} from "@prismengine/contracts-artifact";
import {
  PrismError,
  assertJsonValue,
  systemCallContext,
  type CallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  PROJECT_RUNTIME_ABI_VERSION,
  ProjectBuildCapabilityToken,
  ProjectRuntimeCapabilityToken,
  type ActiveProjectRelease,
  type DeclaredCodeMaterialManifest,
  type ProjectActionRun,
  type ProjectBuildCapability,
  type ProjectPrincipal,
  type ProjectReleaseActivation,
  type ProjectReleaseDefinition,
  type ProjectReleaseRef,
  type ProjectRuntimeProfileIdentity,
  type ProjectRuntimeCapability,
  type ProjectRuntimeInstance,
  type ProjectRuntimeLog,
} from "@prismengine/contracts-project";
import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
  type AtomicDocument,
  type AtomicWriteCapability,
  type AtomicWriteOperation,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import { ENGINE_VERSION, definePlugin, type Resource } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  type CodeProjectCapability,
} from "@prismengine/plugin-code-project";
import { HttpRouteExtensionPoint, type HttpRoute } from "@prismengine/plugin-http-fastify";
import { isRuntimeRecord } from "./guards.js";

const ACTIVE_COLLECTION = "project.active-releases";
const ACTIVATION_COLLECTION = "project.release-activations";
const INSTANCE_COLLECTION = "project.runtime-instances";
const RUN_COLLECTION = "project.action-runs";
const LOG_COLLECTION = "project.runtime-logs";
const RUNTIME_VERSION = "0.1.18";
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

interface WorkerLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

interface WorkerResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly logs: readonly WorkerLog[];
}

interface RuntimeMaterialModule {
  readonly manifest: DeclaredCodeMaterialManifest;
  readonly content: Uint8Array;
}

interface PendingInvocation {
  readonly promise: Promise<WorkerResult>;
  readonly resolve: (value: WorkerResult | PromiseLike<WorkerResult>) => void;
  readonly reject: (reason?: unknown) => void;
}

export interface ProjectRuntimePluginOptions {
  readonly actionTimeoutMs?: number;
  readonly profileModule?: string;
  readonly profileIdentity?: ProjectRuntimeProfileIdentity;
}

export function projectRuntimePlugin(options: ProjectRuntimePluginOptions = {}) {
  let runtime: DefaultProjectRuntime | undefined;
  return definePlugin({
    id: "project.runtime",
    version: RUNTIME_VERSION,
    requires: {
      storage: StorageCapabilityToken,
      atomicWrite: AtomicWriteCapabilityToken,
      artifacts: ArtifactStoreCapabilityToken,
      builds: ProjectBuildCapabilityToken,
      codeProjects: CodeProjectCapabilityToken,
    },
    provides: [ProjectRuntimeCapabilityToken],
    register(context) {
      runtime = new DefaultProjectRuntime(
        context.dependencies.storage,
        context.dependencies.atomicWrite,
        context.dependencies.artifacts,
        context.dependencies.builds,
        context.dependencies.codeProjects,
        options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
        options.profileModule,
        options.profileIdentity,
      );
      context.provide(ProjectRuntimeCapabilityToken, runtime);
      for (const route of runtimeRoutes(runtime, context.dependencies.codeProjects)) {
        context.extensions.contribute(HttpRouteExtensionPoint, route);
      }
    },
    async start() {
      await runtime?.recover();
    },
    async stop() {
      await runtime?.dispose();
      runtime = undefined;
    },
  });
}

class DefaultProjectRuntime implements ProjectRuntimeCapability {
  private readonly activeReleases;
  private readonly activations;
  private readonly instances;
  private readonly runs;
  private readonly runtimeLogs;
  private readonly workers = new Map<string, ReleaseWorker>();
  private readonly restartCounts = new Map<string, number>();
  private stopping = false;

  constructor(
    private readonly storage: StorageCapability,
    private readonly atomicWrite: AtomicWriteCapability,
    private readonly artifacts: ArtifactStoreCapability,
    private readonly builds: ProjectBuildCapability,
    private readonly codeProjects: CodeProjectCapability,
    private readonly actionTimeoutMs: number,
    private readonly profileModule?: string,
    private readonly profileIdentity?: ProjectRuntimeProfileIdentity,
  ) {
    this.activeReleases = storage.collection<ActiveProjectRelease>(ACTIVE_COLLECTION);
    this.activations = storage.collection<ProjectReleaseActivation>(ACTIVATION_COLLECTION);
    this.instances = storage.collection<ProjectRuntimeInstance>(INSTANCE_COLLECTION);
    this.runs = storage.collection<ProjectActionRun>(RUN_COLLECTION);
    this.runtimeLogs = storage.collection<ProjectRuntimeLog>(LOG_COLLECTION);
  }

  async recover(): Promise<void> {
    const context = systemCallContext({ correlationId: "project-runtime-recovery" });
    for (const active of await this.activeReleases.find(context)) {
      try {
        const release = await this.requiredRelease(context, active.projectId, active.release.revision);
        if (releaseRef(release).fingerprint !== active.release.fingerprint) throw abiMismatch(active.projectId);
        const worker = await this.startWorker(context, release, 0);
        this.workers.set(active.projectId, worker);
      } catch (error) {
        await this.recordFailedInstance(
          context,
          active.projectId,
          active.release,
          error instanceof Error ? error.message : String(error),
          0,
        );
      }
    }
  }

  async active(context: CallContext, projectId: string): Promise<ActiveProjectRelease | null> {
    return this.activeReleases.get(context, projectId);
  }

  async activate(
    context: CallContext,
    projectId: string,
    releaseRevision: number,
    expectedActiveRelease: ProjectReleaseRef | null,
    reason?: string,
  ): Promise<ActiveProjectRelease> {
    const current = await this.active(context, projectId);
    if (!sameRelease(current?.release ?? null, expectedActiveRelease)) {
      throw PrismError.of(
        "PROJECT_ACTIVE_RELEASE_CONFLICT",
        "Active Project Release changed before activation.",
        { projectId, expectedActiveRelease, actualActiveRelease: current?.release ?? null },
      );
    }
    const release = await this.requiredRelease(context, projectId, releaseRevision);
    const nextRef = releaseRef(release);
    const candidate = await this.startWorker(context, release, 0);
    const activatedAt = new Date().toISOString();
    const active: ActiveProjectRelease = {
      id: projectId,
      projectId,
      release: nextRef,
      releaseIdentity: releaseIdentity(nextRef),
      activatedAt,
      activatedBy: context.principal.id,
    };
    const activation: ProjectReleaseActivation = {
      id: crypto.randomUUID(),
      projectId,
      previousRelease: current?.release ?? null,
      nextRelease: nextRef,
      activatedBy: context.principal.id,
      activatedAt,
      ...(reason === undefined ? {} : { reason }),
    };
    const operations: AtomicWriteOperation[] = [
      put(ACTIVE_COLLECTION, active, current === null ? "create" : "replace"),
      put(ACTIVATION_COLLECTION, activation, "create"),
      put(INSTANCE_COLLECTION, candidate.instance, "replace"),
    ];
    const prior = this.workers.get(projectId);
    if (prior !== undefined) {
      operations.push(put(INSTANCE_COLLECTION, {
        ...prior.instance,
        status: "DRAINING",
        lastHeartbeatAt: activatedAt,
      }, "replace"));
    }
    try {
      await this.atomicWrite.execute(context, {
        requestId: `activate-project-release:${activation.id}`,
        preconditions: current === null
          ? [{ kind: "document-absent", collection: ACTIVE_COLLECTION, id: projectId }]
          : [{
              kind: "document-present",
              collection: ACTIVE_COLLECTION,
              id: projectId,
              fields: { releaseIdentity: releaseIdentity(current.release) },
            }],
        operations,
      });
    } catch (error) {
      await candidate.dispose();
      throw error;
    }
    this.workers.set(projectId, candidate);
    prior?.disposeWhenIdle();
    return active;
  }

  async invoke(
    context: CallContext,
    projectId: string,
    requestedRelease: ProjectReleaseRef,
    actionId: string,
    input: JsonValue,
  ): Promise<ProjectActionRun> {
    assertJsonValue(input, "/input");
    const active = await this.active(context, projectId);
    if (active === null) {
      throw PrismError.of("PROJECT_ACTIVE_RELEASE_NOT_FOUND", "Project has no Active Release.", { projectId });
    }
    if (!sameRelease(active.release, requestedRelease)) {
      throw PrismError.of(
        "PROJECT_RELEASE_CHANGED",
        "Client Release no longer matches the Active Release; reload the application.",
        { projectId, requestedRelease, activeRelease: active.release },
      );
    }
    const release = await this.requiredRelease(context, projectId, active.release.revision);
    const worker = await this.worker(context, projectId, release);
    const response = await worker.invoke(
      actionId,
      input,
      { id: context.principal.id, roles: context.principal.roles },
      context.signal,
    );
    const inputFingerprint = hash(input);
    const createdAt = new Date().toISOString();
    let result: JsonValue | undefined;
    if (response.ok) {
      const candidate = response.result ?? null;
      assertJsonValue(candidate, "/result");
      result = candidate;
    }
    const runtimeReproducibility = release.spec.runtimeReproducibility === "UNKNOWN"
      ? "BEST_EFFORT"
      : release.spec.runtimeReproducibility;
    const run: ProjectActionRun = {
      id: crypto.randomUUID(),
      projectId,
      release: active.release,
      actionId,
      runtimeProfileFingerprint: release.spec.runtimeProfile.profileFingerprint,
      status: response.ok ? "SUCCESS" : "FAILED",
      inputFingerprint,
      ...(result === undefined ? {} : { result }),
      ...(response.error === undefined ? {} : { error: `${response.code ?? "PROJECT_ACTION_FAILED"}: ${response.error}` }),
      pin: {
        definition: { kind: release.kind, id: release.id, revision: release.revision },
        definitionFingerprint: active.release.fingerprint,
        input: {
          ref: { fingerprint: inputFingerprint, capturedAt: createdAt },
          datasets: [],
          parameters: [{ name: "input", fingerprint: inputFingerprint }],
        },
        effective: context.asOf,
        versions: {
          engine: ENGINE_VERSION,
          operations: { [actionId]: release.spec.serverArtifact.hash },
          backend: { id: "project-runtime-worker", version: RUNTIME_VERSION },
          components: {
            "project.runtime-abi": release.spec.runtimeAbiVersion,
            "project.runtime-profile": release.spec.runtimeProfile.profileFingerprint,
          },
        },
        planHash: release.spec.buildManifestArtifact.hash,
      },
      reproducibility: runtimeReproducibility,
      createdAt,
    };
    const logs = response.logs.map((entry): ProjectRuntimeLog => ({
      id: crypto.randomUUID(),
      projectId,
      release: active.release,
      level: entry.level,
      message: entry.message,
      timestamp: createdAt,
    }));
    if (!response.ok && response.error !== undefined) {
      const location = sourceLocation(response.error);
      logs.push({
        id: crypto.randomUUID(),
        projectId,
        release: active.release,
        level: "error",
        message: response.error,
        ...(location === null ? {} : location),
        timestamp: createdAt,
      });
    }
    await this.atomicWrite.execute(context, {
      requestId: `persist-project-action-run:${run.id}`,
      preconditions: [{ kind: "document-absent", collection: RUN_COLLECTION, id: run.id }],
      operations: [
        put(RUN_COLLECTION, run, "create"),
        ...logs.map((entry) => put(LOG_COLLECTION, entry, "create")),
      ],
    });
    return run;
  }

  async executeMaterial(
    context: CallContext,
    projectId: string,
    requestedRelease: ProjectReleaseRef,
    materialId: string,
    materialVersion: string,
    input: JsonValue,
    configuration: JsonValue = null,
  ): Promise<JsonValue> {
    assertJsonValue(input, "/input");
    assertJsonValue(configuration, "/configuration");
    const active = await this.active(context, projectId);
    if (active === null || !sameRelease(active.release, requestedRelease)) {
      throw PrismError.of(
        "PROJECT_RELEASE_CHANGED",
        "Visual Material Release no longer matches Active Release.",
        { projectId, requestedRelease, activeRelease: active?.release ?? null },
      );
    }
    const release = await this.requiredRelease(context, projectId, active.release.revision);
    const worker = await this.worker(context, projectId, release);
    const response = await worker.executeMaterial(
      materialId,
      materialVersion,
      input,
      configuration,
      context.signal,
    );
    if (!response.ok) {
      throw PrismError.of(
        response.code ?? "PROJECT_MATERIAL_FAILED",
        response.error ?? "Code Material execution failed.",
        { projectId, materialId, materialVersion },
      );
    }
    const output = response.result ?? null;
    assertJsonValue(output, "/result");
    return output;
  }

  async getRun(context: CallContext, runId: string): Promise<ProjectActionRun | null> {
    return this.runs.get(context, runId);
  }

  async listRuns(context: CallContext, projectId: string): Promise<readonly ProjectActionRun[]> {
    return this.runs.find(context, { where: { projectId }, orderBy: [{ field: "createdAt", direction: "desc" }] });
  }

  async releaseMaterials(
    context: CallContext,
    projectId: string,
    revision: number,
  ) {
    const release = await this.requiredRelease(context, projectId, revision);
    return release.spec.materialManifests.flatMap((manifest, index) => {
      const artifact = release.spec.materialArtifacts[index];
      return artifact === undefined ? [] : [{ manifest, artifact, status: "BUILT" as const }];
    });
  }

  async logs(context: CallContext, projectId: string): Promise<readonly ProjectRuntimeLog[]> {
    return this.runtimeLogs.find(context, { where: { projectId }, orderBy: [{ field: "timestamp", direction: "asc" }] });
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    const context = systemCallContext({ correlationId: "project-runtime-stop" });
    await Promise.all([...this.workers.values()].map(async (worker) => {
      const now = new Date().toISOString();
      await this.instances.put(context, {
        ...worker.instance,
        status: "STOPPED",
        stoppedAt: now,
        lastHeartbeatAt: now,
      });
      await worker.dispose();
    }));
    this.workers.clear();
  }

  async releaseForShell(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    return this.requiredRelease(context, projectId, revision);
  }

  async clientArtifact(
    context: CallContext,
    projectId: string,
    revision: number,
    expectedHash: string,
  ): Promise<string> {
    const release = await this.requiredRelease(context, projectId, revision);
    if (release.spec.clientArtifact.hash !== expectedHash) throw artifactMismatch(projectId);
    if (!(await this.artifacts.verify(context, release.spec.clientArtifact))) throw artifactMismatch(projectId);
    return new TextDecoder().decode(
      await this.artifacts.read(context, release.spec.clientArtifact, "client.js"),
    );
  }

  private async worker(
    context: CallContext,
    projectId: string,
    release: Resource<ProjectReleaseDefinition>,
  ): Promise<ReleaseWorker> {
    const existing = this.workers.get(projectId);
    if (existing?.isAvailable && existing.release.revision === release.revision) return existing;
    const candidate = await this.startWorker(context, release, this.restartCounts.get(projectId) ?? 0);
    this.workers.set(projectId, candidate);
    existing?.disposeWhenIdle();
    return candidate;
  }

  private async startWorker(
    context: CallContext,
    release: Resource<ProjectReleaseDefinition>,
    restartCount: number,
  ): Promise<ReleaseWorker> {
    await this.verifyRelease(context, release);
    const ref = releaseRef(release);
    const instanceId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.instances.put(context, {
      id: instanceId,
      projectId: release.spec.projectId,
      release: ref,
      workerPid: 0,
      status: "STARTING",
      runtimeProfileFingerprint: release.spec.runtimeProfile.profileFingerprint,
      startedAt,
      lastHeartbeatAt: startedAt,
      restartCount,
    });
    try {
      const serverBytes = await this.artifacts.read(context, release.spec.serverArtifact, "server.js");
      const materialModules: RuntimeMaterialModule[] = await Promise.all(
        release.spec.materialManifests.map(async (manifest, index) => {
          const artifact = release.spec.materialArtifacts[index];
          if (artifact === undefined) throw artifactMismatch(release.spec.projectId);
          const metadata = await this.artifacts.stat(context, artifact);
          const file = metadata.files[0];
          if (metadata.files.length !== 1 || file === undefined) {
            throw PrismError.of(
              "PROJECT_RUNTIME_MANIFEST_MISMATCH",
              `Material ${manifest.id}@${manifest.version} must contain one module file.`,
            );
          }
          return {
            manifest,
            content: await this.artifacts.read(context, artifact, file.path),
          };
        }),
      );
      const worker = await ReleaseWorker.start(
        instanceId,
        release.spec.projectId,
        ref,
        release.spec.runtimeAbiVersion,
        release.spec.runtimeProfile,
        release.spec.serverArtifact.hash,
        release.spec.actionIds,
        materialModules,
        serverBytes,
        restartCount,
        (instance, unexpected) => void this.workerExited(instance, unexpected),
        this.actionTimeoutMs,
        this.profileModule,
      );
      await this.instances.put(context, worker.instance);
      return worker;
    } catch (error) {
      const now = new Date().toISOString();
      await this.instances.put(context, {
        id: instanceId,
        projectId: release.spec.projectId,
        release: ref,
        workerPid: 0,
        runtimeProfileFingerprint: release.spec.runtimeProfile.profileFingerprint,
        status: "FAILED",
        startedAt,
        lastHeartbeatAt: now,
        stoppedAt: now,
        restartCount,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async verifyRelease(
    context: CallContext,
    release: Resource<ProjectReleaseDefinition>,
  ): Promise<void> {
    if (
      !isRuntimeRecord(release.spec.runtimeProfile) ||
      typeof release.spec.runtimeProfile.profileFingerprint !== "string" ||
      !isRuntimeRecord(release.spec.buildArtifactSet)
    ) {
      throw PrismError.of(
        "PROJECT_RUNTIME_PROFILE_UNAVAILABLE",
        "Legacy Project Release has no resolved Runtime Profile or Build Artifact Set.",
        { projectId: release.spec.projectId, legacyStatus: "LEGACY_PROFILE_UNRESOLVED" },
      );
    }
    if (release.spec.runtimeAbiVersion !== PROJECT_RUNTIME_ABI_VERSION) {
      throw abiMismatch(release.spec.projectId);
    }
    const releaseProfile = release.spec.runtimeProfile;
    const buildProfile = release.spec.buildArtifactSet.runtimeProfile;
    if (releaseProfile.profileFingerprint !== buildProfile.profileFingerprint) {
      throw PrismError.of(
        "PROJECT_BUILD_RUNTIME_PROFILE_MISMATCH",
        "Project Release Runtime Profile does not match its Build Artifact Set.",
        { projectId: release.spec.projectId },
      );
    }
    if (this.profileModule !== undefined && this.profileIdentity === undefined) {
      throw PrismError.of(
        "PROJECT_RUNTIME_PROFILE_UNAVAILABLE",
        "Runtime Profile module requires an exact Profile identity.",
        { projectId: release.spec.projectId },
      );
    }
    if (
      this.profileIdentity !== undefined &&
      this.profileIdentity.profileFingerprint !== releaseProfile.profileFingerprint
    ) {
      throw PrismError.of(
        "PROJECT_RUNTIME_PROFILE_MISMATCH",
        "Configured Runtime Profile does not match the Project Release.",
        { projectId: release.spec.projectId },
      );
    }
    if (release.spec.materialManifests.length !== release.spec.materialArtifacts.length) {
      throw PrismError.of(
        "PROJECT_RUNTIME_MANIFEST_MISMATCH",
        "Project Release Material manifests and Artifacts are not aligned.",
      );
    }
    const refs: readonly ArtifactRef[] = [
      release.spec.clientArtifact,
      release.spec.serverArtifact,
      release.spec.buildManifestArtifact,
      ...release.spec.materialArtifacts,
    ];
    for (const ref of refs) {
      if (!(await this.artifacts.verify(context, ref))) throw artifactMismatch(release.spec.projectId);
    }
  }

  private async workerExited(instance: ProjectRuntimeInstance, unexpected: boolean): Promise<void> {
    if (this.stopping) return;
    const context = systemCallContext({ correlationId: `runtime-exit:${instance.id}` });
    await this.instances.put(context, {
      ...instance,
      status: unexpected ? "FAILED" : "STOPPED",
      stoppedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    if (!unexpected) return;
    this.workers.delete(instance.projectId);
    const count = (this.restartCounts.get(instance.projectId) ?? 0) + 1;
    this.restartCounts.set(instance.projectId, count);
    if (count > 3) return;
    const active = await this.active(context, instance.projectId);
    if (active === null || !sameRelease(active.release, instance.release)) return;
    try {
      const release = await this.requiredRelease(context, instance.projectId, instance.release.revision);
      const worker = await this.startWorker(context, release, count);
      this.workers.set(instance.projectId, worker);
      await this.instances.put(context, worker.instance);
    } catch (error) {
      await this.recordFailedInstance(
        context,
        instance.projectId,
        instance.release,
        error instanceof Error ? error.message : String(error),
        count,
      );
    }
  }

  private async recordFailedInstance(
    context: CallContext,
    projectId: string,
    release: ProjectReleaseRef,
    error: string,
    restartCount: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.instances.put(context, {
      id: crypto.randomUUID(),
      projectId,
      release,
      workerPid: 0,
      runtimeProfileFingerprint: "LEGACY_PROFILE_UNRESOLVED",
      status: "FAILED",
      startedAt: now,
      lastHeartbeatAt: now,
      stoppedAt: now,
      restartCount,
      lastError: error,
    });
  }

  private async requiredRelease(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    const release = await this.builds.release(context, projectId, revision);
    if (release === null || release.status !== "published") {
      throw PrismError.of("PROJECT_RELEASE_NOT_FOUND", "Published Project Release does not exist.", { projectId, revision });
    }
    return release;
  }
}

class ReleaseWorker {
  private readonly pending = new Map<string, PendingInvocation>();
  private inFlight = 0;
  private draining = false;
  private intentionalStop = false;
  isAvailable = true;

  private constructor(
    readonly release: ProjectReleaseRef,
    readonly instance: ProjectRuntimeInstance,
    private readonly child: ChildProcess,
    private readonly directory: string,
    private readonly onExit: (instance: ProjectRuntimeInstance, unexpected: boolean) => void,
    private readonly actionTimeoutMs: number,
  ) {
    child.on("message", (message: unknown) => this.onMessage(message));
    child.on("exit", () => {
      this.isAvailable = false;
      for (const pending of this.pending.values()) {
        pending.resolve({
          ok: false,
          code: "PROJECT_RUNTIME_DISCONNECTED",
          error: "Runtime Worker disconnected.",
          logs: [],
        });
      }
      this.pending.clear();
      this.onExit(this.instance, !this.intentionalStop);
      void rm(this.directory, { recursive: true, force: true });
    });
  }

  static async start(
    instanceId: string,
    projectId: string,
    release: ProjectReleaseRef,
    runtimeAbiVersion: string,
    runtimeProfile: ProjectRuntimeProfileIdentity,
    serverArtifactHash: string,
    actionIds: readonly string[],
    materialModules: readonly RuntimeMaterialModule[],
    serverBytes: Uint8Array,
    restartCount: number,
    onExit: (instance: ProjectRuntimeInstance, unexpected: boolean) => void,
    actionTimeoutMs: number,
    profileModule?: string,
  ): Promise<ReleaseWorker> {
    const directory = await mkdtemp(join(tmpdir(), "prism-runtime-"));
    const artifactPath = join(directory, "server.js");
    await mkdir(directory, { recursive: true });
    await writeFile(artifactPath, serverBytes);
    const materials = await Promise.all(materialModules.map(async (item, index) => {
      const path = join(directory, "materials", `${index}.js`);
      await mkdir(join(directory, "materials"), { recursive: true });
      await writeFile(path, item.content);
      return { manifest: item.manifest, artifactPath: path };
    }));
    const child = fork(fileURLToPath(new URL("./runtime-worker.js", import.meta.url)), [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
      serialization: "advanced",
    });
    const now = new Date().toISOString();
    const instance: ProjectRuntimeInstance = {
      id: instanceId,
      projectId,
      release,
      runtimeProfileFingerprint: runtimeProfile.profileFingerprint,
      workerPid: child.pid ?? 0,
      status: "READY",
      startedAt: now,
      lastHeartbeatAt: now,
      restartCount,
    };
    const worker = new ReleaseWorker(
      release,
      instance,
      child,
      directory,
      onExit,
      actionTimeoutMs,
    );
    const ready = Promise.withResolvers<Record<string, unknown>>();
    const listener = (message: unknown) => {
      if (!isRuntimeRecord(message) || (message.type !== "ready" && message.type !== "ready-failed")) return;
      child.off("message", listener);
      ready.resolve(message);
    };
    child.on("message", listener);
    child.send({
      type: "init",
      artifactPath,
      projectId: instance.projectId,
      release,
      runtimeAbiVersion,
      serverArtifactHash,
      runtimeProfile,
      actionIds,
      materials,
      ...(profileModule === undefined ? {} : { profileModule }),
    });
    const timeout = Promise.withResolvers<never>();
    setTimeout(() => timeout.reject(new Error("Runtime Worker health check timed out.")), 10_000);
    const handshake = await Promise.race([ready.promise, timeout.promise]);
    const expected = {
      projectId: instance.projectId,
      releaseRevision: release.revision,
      releaseFingerprint: release.fingerprint,
      runtimeAbiVersion,
      runtimeProfileFingerprint: runtimeProfile.profileFingerprint,
      serverArtifactHash,
      actions: [...actionIds].sort(),
      materialIdentities: materialModules
        .map((item) => `${item.manifest.id}@${item.manifest.version}`)
        .sort(),
    };
    if (
      handshake.type !== "ready" || handshake.projectId !== expected.projectId ||
      handshake.releaseRevision !== expected.releaseRevision ||
      handshake.releaseFingerprint !== expected.releaseFingerprint ||
      handshake.runtimeAbiVersion !== expected.runtimeAbiVersion ||
      handshake.runtimeProfileFingerprint !== expected.runtimeProfileFingerprint ||
      handshake.serverArtifactHash !== expected.serverArtifactHash ||
      JSON.stringify(handshake.actions) !== JSON.stringify(expected.actions) ||
      JSON.stringify(handshake.materialIdentities) !== JSON.stringify(expected.materialIdentities)
    ) {
      await worker.dispose();
      const handshakeError = typeof handshake.error === "string"
        ? handshake.error
        : "Candidate Worker handshake does not match Project Release.";
      const code = handshakeError.includes("PROJECT_RUNTIME_PROFILE_MISMATCH")
        ? "PROJECT_RUNTIME_PROFILE_MISMATCH"
        : handshake.type === "ready-failed" && profileModule !== undefined
        ? "PROJECT_RUNTIME_PROFILE_UNAVAILABLE"
        : "PROJECT_RUNTIME_MANIFEST_MISMATCH";
      throw PrismError.of(code, handshakeError);
    }
    return worker;
  }

  async invoke(
    actionId: string,
    input: JsonValue,
    principal: ProjectPrincipal,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (!this.isAvailable) {
      return { ok: false, code: "PROJECT_RUNTIME_DISCONNECTED", error: "Runtime Worker is unavailable.", logs: [] };
    }
    const requestId = crypto.randomUUID();
    const deferred = Promise.withResolvers<WorkerResult>();
    this.pending.set(requestId, deferred);
    this.inFlight += 1;
    this.child.send({ type: "invoke", requestId, actionId, input, principal });
    const abort = () => {
      const pending = this.pending.get(requestId);
      if (pending === undefined) return;
      this.pending.delete(requestId);
      if (this.child.connected) this.child.send({ type: "cancel", requestId });
      pending.resolve({
        ok: false,
        code: "PROJECT_ACTION_CANCELLED",
        error: `Action ${actionId} was cancelled.`,
        logs: [],
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (pending === undefined) return;
      this.pending.delete(requestId);
      pending.resolve({
        ok: false,
        code: "PROJECT_ACTION_TIMEOUT",
        error: `Action ${actionId} exceeded ${this.actionTimeoutMs}ms.`,
        logs: [],
      });
      this.isAvailable = false;
      void this.dispose();
    }, this.actionTimeoutMs);
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.inFlight -= 1;
      if (this.draining && this.inFlight === 0) await this.dispose();
    }
  }

  async executeMaterial(
    materialId: string,
    materialVersion: string,
    input: JsonValue,
    configuration: JsonValue,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (!this.isAvailable) {
      return { ok: false, code: "PROJECT_RUNTIME_DISCONNECTED", error: "Runtime Worker is unavailable.", logs: [] };
    }
    const requestId = crypto.randomUUID();
    const deferred = Promise.withResolvers<WorkerResult>();
    this.pending.set(requestId, deferred);
    this.inFlight += 1;
    this.child.send({
      type: "execute-material",
      requestId,
      materialId,
      materialVersion,
      input,
      configuration,
    });
    const abort = () => {
      const pending = this.pending.get(requestId);
      if (pending === undefined) return;
      this.pending.delete(requestId);
      if (this.child.connected) this.child.send({ type: "cancel", requestId });
      pending.resolve({ ok: false, code: "PROJECT_ACTION_CANCELLED", error: "Material execution cancelled.", logs: [] });
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (pending === undefined) return;
      this.pending.delete(requestId);
      pending.resolve({ ok: false, code: "PROJECT_ACTION_TIMEOUT", error: "Material execution timed out.", logs: [] });
    }, this.actionTimeoutMs);
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.inFlight -= 1;
      if (this.draining && this.inFlight === 0) await this.dispose();
    }
  }

  disposeWhenIdle(): void {
    this.draining = true;
    if (this.inFlight === 0) void this.dispose();
  }

  async dispose(): Promise<void> {
    this.intentionalStop = true;
    this.isAvailable = false;
    if (this.child.connected) this.child.send({ type: "dispose" });
    if (!this.child.killed) this.child.kill();
  }

  private onMessage(message: unknown): void {
    if (
      !isRuntimeRecord(message) ||
      (message.type !== "action-success" && message.type !== "action-failure") ||
      typeof message.requestId !== "string"
    ) return;
    const deferred = this.pending.get(message.requestId);
    if (deferred === undefined) return;
    this.pending.delete(message.requestId);
    deferred.resolve({
      ok: message.type === "action-success",
      ...(typeof message.code === "string" ? { code: message.code } : {}),
      ...(message.output === undefined ? {} : { result: message.output }),
      ...(typeof message.error === "string" ? { error: message.error } : {}),
      logs: Array.isArray(message.logs) ? message.logs as WorkerLog[] : [],
    });
  }
}

function runtimeRoutes(runtime: DefaultProjectRuntime, projects: CodeProjectCapability): readonly HttpRoute[] {
  return [
    {
      method: "POST",
      path: "/api/code-projects/:id/active-release",
      summary: "Health-check and CAS activate or rollback Project Release",
      handler: async (request) => {
        requireBuilder(request.call);
        const params = record(request.params);
        const body = record(request.body);
        return {
          status: 200,
          body: await runtime.activate(
            request.call,
            string(params.id),
            integer(body.releaseRevision),
            body.expectedActiveRelease === null
              ? null
              : projectReleaseRef(body.expectedActiveRelease),
            typeof body.reason === "string" ? body.reason : undefined,
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:projectId/releases/:revision/materials",
      summary: "List exact built Release Material catalog",
      handler: async (request) => {
        const params = record(request.params);
        return {
          status: 200,
          body: await runtime.releaseMaterials(
            request.call,
            string(params.projectId),
            integer(params.revision),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/active-release",
      summary: "Read Active Project Release pointer",
      handler: async (request) => ({
        status: 200,
        body: await runtime.active(request.call, string(record(request.params).id)),
      }),
    },
    {
      method: "POST",
      path: "/api/runtime/:projectId/materials/:materialId/:version/execute",
      summary: "Execute exact built Release Code Material",
      handler: async (request) => {
        const body = record(request.body);
        return {
          status: 200,
          body: await runtime.executeMaterial(
            request.call,
            string(record(request.params).projectId),
            projectReleaseRef(body.release),
            string(record(request.params).materialId),
            string(record(request.params).version),
            (body.input ?? null) as JsonValue,
            (body.configuration ?? null) as JsonValue,
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/runtime/:projectId/actions/:actionId",
      summary: "Invoke Active Release server Action",
      handler: async (request) => {
        const body = record(request.body);
        try {
          return {
            status: 200,
            body: await runtime.invoke(
              request.call,
              string(record(request.params).projectId),
              projectReleaseRef(body.release),
              string(record(request.params).actionId),
              (body.input ?? null) as JsonValue,
            ),
          };
        } catch (error) {
          if (
            error instanceof PrismError &&
            error.diagnostics.some((item) => item.code === "PROJECT_RELEASE_CHANGED")
          ) {
            return { status: 409, body: { diagnostics: error.diagnostics } };
          }
          throw error;
        }
      },
    },
    {
      method: "GET",
      path: "/api/runtime/:projectId/runs",
      summary: "List immutable Project Action Runs",
      handler: async (request) => ({ status: 200, body: await runtime.listRuns(request.call, string(record(request.params).projectId)) }),
    },
    {
      method: "GET",
      path: "/api/runtime/:projectId/logs",
      summary: "List Project Runtime logs",
      handler: async (request) => ({ status: 200, body: await runtime.logs(request.call, string(record(request.params).projectId)) }),
    },
    {
      method: "GET",
      path: "/runtime/artifacts/:hash/client.js",
      summary: "Serve verified immutable Client Artifact",
      handler: async (request) => {
        const params = record(request.params);
        const query = record(request.query);
        return {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=31536000, immutable",
          },
          body: await runtime.clientArtifact(
            request.call,
            string(query.projectId),
            integer(query.revision),
            string(params.hash),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/apps/:slug",
      summary: "Thin generic App Runtime Shell",
      handler: async (request) => {
        const slug = string(record(request.params).slug);
        const project = await projects.getBySlug(request.call, slug);
        if (project === null) return html(404, `<h1>Project ${escapeHtml(slug)} not found</h1>`);
        const active = await runtime.active(request.call, project.id);
        if (active === null) return html(404, `<h1>${escapeHtml(project.spec.name)} has no Active Release</h1>`);
        const release = await runtime.releaseForShell(
          request.call,
          project.id,
          active.release.revision,
        );
        return html(200, appShell(project.id, project.spec.name, active, release.spec.clientArtifact));
      },
    },
  ];
}

function appShell(
  projectId: string,
  name: string,
  active: ActiveProjectRelease,
  clientArtifact: ArtifactRef,
): string {
  const ref = active.release;
  const clientUrl = `/runtime/artifacts/${clientArtifact.hash}/client.js?projectId=${encodeURIComponent(projectId)}&revision=${ref.revision}`;
  const releaseJson = JSON.stringify(ref);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(name)}</title></head><body><header><strong>${escapeHtml(name)}</strong> <span>Release ${ref.revision}</span></header><main id="app"></main><pre id="runtime-error"></pre><script type="module">try{const release=${releaseJson};const project=await import(${JSON.stringify(clientUrl)});if(typeof project.mount!=='function')throw new Error('PROJECT_CLIENT_MOUNT_NOT_FOUND');const root=document.getElementById('app');await project.mount({root,projectId:${JSON.stringify(projectId)},release,actions:{call:async(id,input)=>{const response=await fetch('/api/runtime/${encodeURIComponent(projectId)}/actions/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({release,input})});if(response.status===409){location.reload();throw new Error('PROJECT_RELEASE_CHANGED');}const run=await response.json();if(run.status!=='SUCCESS')throw new Error(run.error||'PROJECT_ACTION_FAILED');return run.result;}},logger:console});}catch(error){document.getElementById('runtime-error').textContent=String(error?.stack||error);}</script></body></html>`;
}

function releaseRef(release: Resource<ProjectReleaseDefinition>): ProjectReleaseRef {
  return { resourceId: release.id, revision: release.revision, fingerprint: hash(release.spec) };
}

function releaseIdentity(release: ProjectReleaseRef): string {
  return `${release.resourceId}@${release.revision}:${release.fingerprint}`;
}

function sameRelease(left: ProjectReleaseRef | null, right: ProjectReleaseRef | null): boolean {
  return left === null || right === null
    ? left === right
    : releaseIdentity(left) === releaseIdentity(right);
}

function projectReleaseRef(value: unknown): ProjectReleaseRef {
  const object = record(value);
  return {
    resourceId: string(object.resourceId),
    revision: integer(object.revision),
    fingerprint: string(object.fingerprint),
  };
}

function put<T extends { readonly id: string }>(collection: string, document: T, mode: "create" | "replace"): AtomicWriteOperation {
  return { kind: "put-document", collection, document: document as unknown as AtomicDocument, mode };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function sourceLocation(error: string): Pick<ProjectRuntimeLog, "sourceFile" | "line" | "column"> | null {
  const match = /(?:file:\/\/\/)?([^\s()]+):(\d+):(\d+)/.exec(error);
  return match?.[1] && match[2] && match[3]
    ? { sourceFile: match[1], line: Number(match[2]), column: Number(match[3]) }
    : null;
}

function artifactMismatch(projectId: string): PrismError {
  return PrismError.of("PROJECT_ARTIFACT_HASH_MISMATCH", "Project Release Artifact is missing or corrupt.", { projectId });
}

function abiMismatch(projectId: string): PrismError {
  return PrismError.of("PROJECT_RUNTIME_ABI_MISMATCH", "Project Release Runtime ABI is incompatible.", { projectId });
}

function requireBuilder(context: CallContext): void {
  if (!context.principal.roles.includes("BUILDER") && !context.principal.roles.includes("system")) {
    throw PrismError.of("PROJECT_BUILDER_REQUIRED", "Release activation requires BUILDER role.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRuntimeRecord(value)) throw PrismError.of("PROJECT_RUNTIME_REQUEST_INVALID", "Expected object.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value === "") throw PrismError.of("PROJECT_RUNTIME_REQUEST_INVALID", "Expected string.");
  return value;
}

function integer(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw PrismError.of("PROJECT_RUNTIME_REQUEST_INVALID", "Expected positive integer.");
  }
  return parsed;
}

function html(status: number, body: string) {
  return { status, body, headers: { "content-type": "text/html; charset=utf-8" } };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
