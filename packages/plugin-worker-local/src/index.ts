import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import {
  WorkerLauncherCapabilityToken,
  type WorkerLaunchRequest,
  type WorkerLauncherCapability,
  type WorkerProcessHandle,
} from "@prismengine/contracts-worker";
import { definePlugin } from "@prismengine/kernel";

export const workerLocalPlugin = definePlugin({
  id: "worker.launcher.local",
  version: "0.1.20",
  engineRange: "^0.1.20",
  provides: [WorkerLauncherCapabilityToken],
  register(context) {
    context.provide(WorkerLauncherCapabilityToken, new LocalWorkerLauncher());
  },
});

export class LocalWorkerLauncher implements WorkerLauncherCapability {
  profile() {
    return Object.freeze({
      providerId: "worker.launcher.local",
      isolation: "process" as const,
      external: false,
    });
  }
  async productionReadiness(_context: CallContext) {
    return {
      id: "worker-container-isolation" as const,
      passed: false,
      evidence: JSON.stringify(this.profile()),
    };
  }

  async launch(
    context: CallContext,
    request: WorkerLaunchRequest,
  ): Promise<WorkerProcessHandle> {
    assertLaunchActive(context.signal);
    const child = fork(request.entryPath, [], {
      serialization: request.serialization,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [...request.execArgv],
      env: { ...request.environment },
    });
    const handle = new LocalWorkerProcess(child, context.signal);
    if (context.signal?.aborted === true) {
      handle.kill();
      throw launchCancelled();
    }
    return handle;
  }
}

class LocalWorkerProcess implements WorkerProcessHandle {
  private cancellationDetached = false;
  private readonly abort = () => this.kill();
  private readonly terminal = () => this.detachCancellation();

  constructor(
    private readonly child: ChildProcess,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", this.abort, { once: true });
    child.once("exit", this.terminal);
    child.once("error", this.terminal);
    child.once("disconnect", this.terminal);
    if (signal?.aborted === true) this.kill();
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  get connected(): boolean {
    return this.child.connected;
  }

  get killed(): boolean {
    return this.child.killed;
  }

  send(message: unknown): void {
    // The launcher boundary accepts protocol-owned structured-clone values.
    const serializable = message as Serializable;
    this.child.send(serializable);
  }

  disconnect(): void {
    this.detachCancellation();
    if (this.child.connected) this.child.disconnect();
  }

  kill(): void {
    this.detachCancellation();
    this.child.kill();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.child.on("message", listener);
    return () => this.child.off("message", listener);
  }

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void {
    this.child.on("exit", listener);
    return () => this.child.off("exit", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.child.on("error", listener);
    return () => this.child.off("error", listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    const stderr = this.child.stderr;
    if (stderr === null) return () => {};
    stderr.on("data", listener);
    return () => stderr.off("data", listener);
  }
  private detachCancellation(): void {
    if (this.cancellationDetached) return;
    this.cancellationDetached = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.child.off("exit", this.terminal);
    this.child.off("error", this.terminal);
    this.child.off("disconnect", this.terminal);
  }
}

function assertLaunchActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw launchCancelled();
}

function launchCancelled(): PrismError {
  return PrismError.of("WORKER_LAUNCH_CANCELLED", "Worker launch was cancelled.");
}
