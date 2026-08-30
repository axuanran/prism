import { PassThrough } from "node:stream";
import { systemCallContext } from "@prismengine/contracts-data";
import {
  ContainerWorkerLauncher,
  WorkerFrameDecoder,
  encodeWorkerFrame,
  prismWorkerContainerOptions,
  type ContainerRuntime,
  type ContainerRuntimeLaunch,
  type ContainerRuntimeSession,
} from "@prismengine/plugin-worker-container";
import { describe, expect, it } from "vitest";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class FakeContainerRuntime implements ContainerRuntime {
  launchRequest: ContainerRuntimeLaunch | undefined;
  readonly exit = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  killCount = 0;
  removeCount = 0;
  onLaunch: (() => void) | undefined;

  async launch(request: ContainerRuntimeLaunch): Promise<ContainerRuntimeSession> {
    this.launchRequest = request;
    this.onLaunch?.();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => stdout.write(chunk));
    return {
      pid: 42,
      stdin,
      stdout,
      stderr,
      wait: () => this.exit.promise,
      kill: async () => {
        this.killCount += 1;
        this.exit.resolve({ code: 137, signal: null });
      },
      remove: async () => {
        this.removeCount += 1;
      },
    };
  }

  async probe() {
    return {
      available: true,
      runtimeVersion: "fake-1.0",
      imageDigest: "sha256:image",
    };
  }
}

const context = systemCallContext({ correlationId: "worker-container-test" });

function testLauncher(runtime: ContainerRuntime): ContainerWorkerLauncher {
  return new ContainerWorkerLauncher({
    image: "prism-worker@sha256:image",
    bridgePath: "/opt/prism/bridge.js",
    entryPaths: {
      "project-build": "/opt/prism/builder-worker.js",
      "project-runtime": "/opt/prism/runtime-worker.js",
    },
    user: "10001:10001",
    runtime,
  });
}

const launchRequest = {
  kind: "project-runtime" as const,
  entryPath: "C:/host/runtime-worker.js",
  environment: { NODE_ENV: "production" },
  execArgv: [],
  serialization: "advanced" as const,
};

describe("Container Worker launcher", () => {
  it("frames Worker messages and enforces hardened container launch settings", async () => {
    const runtime = new FakeContainerRuntime();
    const launcher = new ContainerWorkerLauncher({
      image: "prism-worker@sha256:image",
      bridgePath: "/opt/prism/bridge.js",
      entryPaths: {
        "project-build": "/opt/prism/builder-worker.js",
        "project-runtime": "/opt/prism/runtime-worker.js",
      },
      user: "10001:10001",
      runtime,
      staticMounts: [
        {
          source: "/host/pnpm-store",
          target: "/pnpm-store",
          readOnly: true,
        },
      ],
      environmentByKind: {
        "project-runtime": { PRISM_CONTAINER: "1" },
      },
    });
    await expect(launcher.productionReadiness(context)).resolves.toMatchObject({
      id: "worker-container-isolation",
      passed: true,
      evidence: expect.stringContaining('"networkMode":"none"'),
    });
    const worker = await launcher.launch(context, {
      kind: "project-runtime",
      entryPath: "C:/host/runtime-worker.js",
      environment: { NODE_ENV: "production" },
      execArgv: ["--max-old-space-size=512"],
      serialization: "advanced",
      mounts: [{ source: "/host/run", target: "/host/run", readOnly: true }],
    });
    expect(runtime.launchRequest).toMatchObject({
      image: "prism-worker@sha256:image",
      command: [
        "node",
        "--max-old-space-size=512",
        "/opt/prism/bridge.js",
        "/opt/prism/runtime-worker.js",
      ],
      user: "10001:10001",
      networkMode: "none",
      readOnlyRootfs: true,
      environment: { NODE_ENV: "production", PRISM_CONTAINER: "1" },
      mounts: [
        { source: "/host/pnpm-store", target: "/pnpm-store", readOnly: true },
        { source: "/host/run", target: "/host/run", readOnly: true },
      ],
    });
    const received = deferred<unknown>();
    worker.onMessage(received.resolve);
    worker.send({ type: "probe", bytes: Uint8Array.from([1, 2, 3]) });
    await expect(received.promise).resolves.toEqual({
      type: "probe",
      bytes: Uint8Array.from([1, 2, 3]),
    });
    worker.kill();
  });

  it("kills a Container Worker when its launch context is aborted", async () => {
    const runtime = new FakeContainerRuntime();
    const controller = new AbortController();
    const worker = await testLauncher(runtime).launch(
      systemCallContext({
        correlationId: "worker-container-post-launch-abort",
        signal: controller.signal,
      }),
      launchRequest,
    );
    const exited = deferred<void>();
    worker.onExit(() => exited.resolve(undefined));

    controller.abort();

    await exited.promise;
    expect(worker.killed).toBe(true);
    expect(runtime.killCount).toBe(1);
  });

  it("detaches Container Worker cancellation on exit and disconnect", async () => {
    const exitedRuntime = new FakeContainerRuntime();
    const exitedController = new AbortController();
    const exitedWorker = await testLauncher(exitedRuntime).launch(
      systemCallContext({
        correlationId: "worker-container-normal-exit",
        signal: exitedController.signal,
      }),
      launchRequest,
    );
    const exited = deferred<void>();
    exitedWorker.onExit(() => exited.resolve(undefined));
    exitedRuntime.exit.resolve({ code: 0, signal: null });
    await exited.promise;

    exitedController.abort();
    expect(exitedRuntime.killCount).toBe(0);

    const disconnectedRuntime = new FakeContainerRuntime();
    const disconnectedController = new AbortController();
    const disconnectedWorker = await testLauncher(disconnectedRuntime).launch(
      systemCallContext({
        correlationId: "worker-container-disconnect",
        signal: disconnectedController.signal,
      }),
      launchRequest,
    );
    disconnectedWorker.disconnect();
    disconnectedController.abort();
    expect(disconnectedRuntime.killCount).toBe(0);
  });

  it("kills and rejects when cancellation races Container launch completion", async () => {
    const runtime = new FakeContainerRuntime();
    const controller = new AbortController();
    runtime.onLaunch = () => controller.abort();

    await expect(
      testLauncher(runtime).launch(
        systemCallContext({
          correlationId: "worker-container-launch-race",
          signal: controller.signal,
        }),
        launchRequest,
      ),
    ).rejects.toThrow("WORKER_LAUNCH_CANCELLED");
    expect(runtime.killCount).toBe(1);
  });

  it("rejects root containers and exposes the standard image layout", () => {
    expect(
      () =>
        new ContainerWorkerLauncher({
          image: "worker",
          bridgePath: "/bridge.js",
          entryPaths: {
            "project-build": "/build.js",
            "project-runtime": "/runtime.js",
          },
          user: "root",
          runtime: new FakeContainerRuntime(),
        }),
    ).toThrow("WORKER_CONTAINER_USER_INVALID");
    expect(
      prismWorkerContainerOptions({
        image: "worker@sha256:digest",
      }),
    ).toMatchObject({
      user: "10001:10001",
      bridgePath:
        "/opt/prism/node_modules/@prismengine/plugin-worker-container/dist/bridge.js",
      entryPaths: {
        "project-build":
          "/opt/prism/node_modules/@prismengine/plugin-project-build/dist/builder-worker.js",
        "project-runtime":
          "/opt/prism/node_modules/@prismengine/plugin-project-runtime/dist/runtime-worker.js",
      },
      environmentByKind: {
        "project-build": {
          PNPM_STORE_DIR: "/opt/pnpm-store",
          NPM_CONFIG_OFFLINE: "true",
        },
      },
    });

    const decoder = new WorkerFrameDecoder();
    const frame = encodeWorkerFrame({ ok: true });
    expect(decoder.push(frame)).toEqual([{ ok: true }]);
  });
});
