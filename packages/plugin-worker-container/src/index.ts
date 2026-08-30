import { PassThrough, type Readable, type Writable } from "node:stream";
import Docker from "dockerode";
import type { CallContext } from "@prismengine/contracts-data";
import { PrismError } from "@prismengine/contracts-data";
import {
  WorkerLauncherCapabilityToken,
  type WorkerKind,
  type WorkerLaunchRequest,
  type WorkerMount,
  type WorkerLauncherCapability,
  type WorkerProcessHandle,
} from "@prismengine/contracts-worker";
import { definePlugin } from "@prismengine/kernel";
import { WorkerFrameDecoder, encodeWorkerFrame } from "./framing.js";

export interface ContainerRuntimeSession {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(): Promise<void>;
  remove(): Promise<void>;
}

export interface ContainerRuntimeLaunch {
  readonly image: string;
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly mounts: readonly {
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  }[];
  readonly user: string;
  readonly networkMode: "none";
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly readOnlyRootfs: true;
  readonly tmpfsBytes: number;
  readonly signal?: AbortSignal;
}

export interface ContainerRuntimeProbe {
  readonly available: boolean;
  readonly runtimeVersion: string;
  readonly imageDigest: string;
}

export interface ContainerRuntime {
  launch(request: ContainerRuntimeLaunch): Promise<ContainerRuntimeSession>;
  probe(image: string, signal?: AbortSignal): Promise<ContainerRuntimeProbe>;
}
export const PRISM_WORKER_IMAGE_PATHS = Object.freeze({
  bridgePath: "/opt/prism/node_modules/@prismengine/plugin-worker-container/dist/bridge.js",
  entryPaths: Object.freeze({
    "project-build":
      "/opt/prism/node_modules/@prismengine/plugin-project-build/dist/builder-worker.js",
    "project-runtime":
      "/opt/prism/node_modules/@prismengine/plugin-project-runtime/dist/runtime-worker.js",
  }),
});

export interface ContainerWorkerLauncherOptions {
  readonly image: string;
  readonly bridgePath: string;
  readonly entryPaths: Readonly<Record<WorkerKind, string>>;
  readonly user: string;
  readonly memoryBytes?: number;
  readonly nanoCpus?: number;
  readonly pidsLimit?: number;
  readonly tmpfsBytes?: number;
  readonly staticMounts?: readonly WorkerMount[];
  readonly environmentByKind?: Partial<
    Readonly<Record<WorkerKind, Readonly<Record<string, string>>>>
  >;
  readonly runtime?: ContainerRuntime;
  readonly docker?: Docker;
}
export function prismWorkerContainerOptions(
  options: Omit<ContainerWorkerLauncherOptions, "bridgePath" | "entryPaths" | "user"> & {
    readonly user?: string;
  },
): ContainerWorkerLauncherOptions {
  return {
    ...options,
    ...PRISM_WORKER_IMAGE_PATHS,
    user: options.user ?? "10001:10001",
    environmentByKind: {
      ...options.environmentByKind,
      "project-build": {
        PNPM_STORE_DIR: "/opt/pnpm-store",
        NPM_CONFIG_OFFLINE: "true",
        ...(options.environmentByKind?.["project-build"] ?? {}),
      },
    },
  };
}

export function workerContainerPlugin(options: ContainerWorkerLauncherOptions) {
  return definePlugin({
    id: "worker.launcher.container",
    version: "0.1.20",
    engineRange: "^0.1.20",
    provides: [WorkerLauncherCapabilityToken],
    register(context) {
      context.provide(WorkerLauncherCapabilityToken, new ContainerWorkerLauncher(options));
    },
  });
}

export class ContainerWorkerLauncher implements WorkerLauncherCapability {
  private readonly runtime: ContainerRuntime;
  private readonly memoryBytes: number;
  private readonly nanoCpus: number;
  private readonly pidsLimit: number;
  private readonly tmpfsBytes: number;

  constructor(private readonly options: ContainerWorkerLauncherOptions) {
    if (!options.image.trim() || !options.bridgePath.startsWith("/")) {
      throw PrismError.of(
        "WORKER_CONTAINER_CONFIGURATION_INVALID",
        "Container image and absolute bridgePath are required.",
      );
    }
    if (!options.user.trim() || options.user === "root" || options.user === "0") {
      throw PrismError.of(
        "WORKER_CONTAINER_USER_INVALID",
        "Container Worker must use an explicit non-root user.",
      );
    }
    for (const kind of ["project-build", "project-runtime"] as const) {
      if (!options.entryPaths[kind]?.startsWith("/")) {
        throw PrismError.of(
          "WORKER_CONTAINER_ENTRY_INVALID",
          `Container entry for ${kind} must be absolute.`,
        );
      }
    }
    this.memoryBytes = positive(options.memoryBytes ?? 1_073_741_824, "memoryBytes");
    this.nanoCpus = positive(options.nanoCpus ?? 1_000_000_000, "nanoCpus");
    this.pidsLimit = positive(options.pidsLimit ?? 128, "pidsLimit");
    this.tmpfsBytes = positive(options.tmpfsBytes ?? 67_108_864, "tmpfsBytes");
    this.runtime =
      options.runtime ?? new DockerContainerRuntime(options.docker ?? new Docker());
  }

  profile() {
    return Object.freeze({
      providerId: "worker.launcher.container",
      isolation: "container" as const,
      external: true,
    });
  }

  async productionReadiness(context: CallContext) {
    try {
      const probe = await this.runtime.probe(this.options.image, context.signal);
      const passed = probe.available && Boolean(probe.imageDigest);
      return {
        id: "worker-container-isolation" as const,
        passed,
        evidence: JSON.stringify({
          ...this.profile(),
          runtimeVersion: probe.runtimeVersion,
          imageDigest: probe.imageDigest,
          networkMode: "none",
          readOnlyRootfs: true,
          nonRootUser: this.options.user,
          memoryBytes: this.memoryBytes,
          nanoCpus: this.nanoCpus,
          pidsLimit: this.pidsLimit,
          staticMountTargets: (this.options.staticMounts ?? []).map(
            (mount) => mount.target,
          ),
        }),
      };
    } catch (error) {
      return {
        id: "worker-container-isolation" as const,
        passed: false,
        evidence: JSON.stringify({
          ...this.profile(),
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      };
    }
  }

  async launch(
    context: CallContext,
    request: WorkerLaunchRequest,
  ): Promise<WorkerProcessHandle> {
    assertNotAborted(context.signal, "Worker launch was cancelled.");
    const session = await this.runtime.launch({
      image: this.options.image,
      command: [
        "node",
        ...request.execArgv,
        this.options.bridgePath,
        this.options.entryPaths[request.kind],
      ],
      environment: {
        ...request.environment,
        ...(this.options.environmentByKind?.[request.kind] ?? {}),
      },
      mounts: mergeMounts(this.options.staticMounts ?? [], request.mounts ?? []),
      user: this.options.user,
      networkMode: "none",
      memoryBytes: this.memoryBytes,
      nanoCpus: this.nanoCpus,
      pidsLimit: this.pidsLimit,
      readOnlyRootfs: true,
      tmpfsBytes: this.tmpfsBytes,
      signal: context.signal,
    });
    const handle = new ContainerWorkerProcess(session, context.signal);
    if (context.signal?.aborted === true) {
      handle.kill();
      throw PrismError.of("WORKER_LAUNCH_CANCELLED", "Worker launch was cancelled.");
    }
    return handle;
  }
}

export class DockerContainerRuntime implements ContainerRuntime {
  constructor(private readonly docker: Docker) {}

  async launch(request: ContainerRuntimeLaunch): Promise<ContainerRuntimeSession> {
    const container = await this.docker.createContainer({
      Image: request.image,
      Entrypoint: ["node"],
      Cmd: request.command.slice(1),
      Env: Object.entries(request.environment)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      User: request.user,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Labels: { "prism.worker": "true" },
      HostConfig: {
        NetworkMode: request.networkMode,
        ReadonlyRootfs: request.readOnlyRootfs,
        Memory: request.memoryBytes,
        NanoCpus: request.nanoCpus,
        PidsLimit: request.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Binds: request.mounts.map(
          (mount) => `${mount.source}:${mount.target}:${mount.readOnly ? "ro" : "rw"}`,
        ),
        Tmpfs: {
          "/tmp": `rw,noexec,nosuid,nodev,size=${request.tmpfsBytes}`,
        },
      },
    });
    const attached = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
    });
    const stdin = new PassThrough();
    stdin.pipe(attached);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(attached, stdout, stderr);
    await container.start();
    const inspection = await container.inspect();
    if (request.signal?.aborted === true) {
      await container.kill().catch(() => undefined);
      await container.remove({ force: true }).catch(() => undefined);
      throw PrismError.of("WORKER_LAUNCH_CANCELLED", "Worker launch was cancelled.");
    }
    return {
      pid: inspection.State.Pid,
      stdin,
      stdout,
      stderr,
      wait: async () => {
        const result = await container.wait();
        return { code: result.StatusCode, signal: null };
      },
      kill: async () => {
        await container.kill().catch((error: unknown) => {
          if (!dockerNotRunning(error)) throw error;
        });
      },
      remove: async () => {
        await container.remove({ force: true }).catch((error: unknown) => {
          if (!dockerNotFound(error)) throw error;
        });
      },
    };
  }

  async probe(image: string, signal?: AbortSignal): Promise<ContainerRuntimeProbe> {
    assertNotAborted(signal, "Worker readiness was cancelled.");
    await this.docker.ping();
    const [version, inspection] = await Promise.all([
      this.docker.version(),
      this.docker.getImage(image).inspect(),
    ]);
    assertNotAborted(signal, "Worker readiness was cancelled.");
    return {
      available: true,
      runtimeVersion: version.Version,
      imageDigest: inspection.RepoDigests?.[0] ?? inspection.Id,
    };
  }
}

class ContainerWorkerProcess implements WorkerProcessHandle {
  private readonly messages = new Set<(message: unknown) => void>();
  private readonly exits = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
  private connectedState = true;
  private killedState = false;
  private cancellationDetached = false;
  private readonly abort = () => this.kill();

  constructor(
    private readonly session: ContainerRuntimeSession,
    private readonly signal?: AbortSignal,
  ) {
    const decoder = new WorkerFrameDecoder();
    session.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          for (const listener of this.messages) listener(message);
        }
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error("Worker frame failed."));
        this.kill();
      }
    });
    session.stderr.on("data", (chunk: Buffer) => {
      const value = Uint8Array.from(chunk);
      for (const listener of this.stderrListeners) listener(value);
    });
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted === true) this.kill();
    void session.wait().then(
      async ({ code, signal: exitSignal }) => {
        this.detachCancellation();
        this.connectedState = false;
        for (const listener of this.exits) listener(code, exitSignal);
        await session.remove();
      },
      (error: unknown) => {
        this.detachCancellation();
        this.connectedState = false;
        this.emitError(
          error instanceof Error ? error : new Error("Container wait failed."),
        );
      },
    );
  }

  get pid(): number {
    return this.session.pid;
  }

  get connected(): boolean {
    return this.connectedState;
  }

  get killed(): boolean {
    return this.killedState;
  }

  send(message: unknown): void {
    if (!this.connectedState) throw new Error("Container Worker is disconnected.");
    this.session.stdin.write(encodeWorkerFrame(message));
  }

  disconnect(): void {
    this.detachCancellation();
    if (!this.connectedState) return;
    this.connectedState = false;
    this.session.stdin.end();
  }

  kill(): void {
    this.detachCancellation();
    if (this.killedState) return;
    this.killedState = true;
    void this.session.kill().catch((error: unknown) => {
      this.emitError(error instanceof Error ? error : new Error("Container kill failed."));
    });
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

  private detachCancellation(): void {
    if (this.cancellationDetached) return;
    this.cancellationDetached = true;
    this.signal?.removeEventListener("abort", this.abort);
  }

  private emitError(error: Error): void {
    for (const listener of this.errors) listener(error);
  }
}

function assertNotAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) {
    throw PrismError.of("WORKER_LAUNCH_CANCELLED", message);
  }
}

function mergeMounts(
  staticMounts: readonly WorkerMount[],
  requestMounts: readonly WorkerMount[],
): readonly WorkerMount[] {
  const targets = new Set<string>();
  return [...staticMounts, ...requestMounts].map((mount) => {
    if (
      !mount.source.trim() ||
      !mount.target.startsWith("/") ||
      mount.target.includes("\u0000") ||
      targets.has(mount.target)
    ) {
      throw PrismError.of(
        "WORKER_CONTAINER_MOUNT_INVALID",
        "Container Worker mounts require unique absolute targets.",
        { target: mount.target },
      );
    }
    targets.add(mount.target);
    return Object.freeze({ ...mount });
  });
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw PrismError.of(
      "WORKER_CONTAINER_CONFIGURATION_INVALID",
      `Container Worker ${field} must be a positive integer.`,
    );
  }
  return value;
}

function dockerNotRunning(error: unknown): boolean {
  return dockerStatus(error) === 304 || dockerStatus(error) === 409;
}

function dockerNotFound(error: unknown): boolean {
  return dockerStatus(error) === 404;
}

function dockerStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return undefined;
}

export { WorkerFrameDecoder, encodeWorkerFrame } from "./framing.js";
