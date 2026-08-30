export * from "./stderr.js";

import type { CallContext } from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";

export type WorkerKind = "project-build" | "project-runtime";

export interface WorkerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface WorkerLaunchRequest {
  readonly kind: WorkerKind;
  /** Local launcher entry. External launchers may select a packaged image by kind. */
  readonly entryPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly serialization: "json" | "advanced";
  readonly mounts?: readonly WorkerMount[];
}

export interface WorkerProcessHandle {
  readonly pid: number;
  readonly connected: boolean;
  readonly killed: boolean;
  send(message: unknown): void;
  disconnect(): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void;
  onError(listener: (error: Error) => void): () => void;
  onStderr(listener: (chunk: Uint8Array) => void): () => void;
}
export interface WorkerIsolationReadiness {
  readonly id: "worker-container-isolation";
  readonly passed: boolean;
  readonly evidence?: string;
}

export interface WorkerLauncherCapability {
  profile(): {
    readonly providerId: string;
    readonly isolation: "process" | "container" | "vm";
    readonly external: boolean;
  };
  productionReadiness(context: CallContext): Promise<WorkerIsolationReadiness>;
  /**
   * Cancellation ownership is provider-independent. A pre-aborted context
   * rejects before launch. After launch, abort kills the returned handle until
   * exit, error, disconnect, or explicit kill detaches the signal listener.
   */
  launch(context: CallContext, request: WorkerLaunchRequest): Promise<WorkerProcessHandle>;
}

export const WorkerLauncherCapabilityToken = defineCapability<WorkerLauncherCapability>({
  id: "worker.launcher",
  version: "1.0.0",
});

export function workerIsolationReadiness(
  context: CallContext,
  launcher: WorkerLauncherCapability,
): Promise<WorkerIsolationReadiness> {
  return launcher.productionReadiness(context);
}
