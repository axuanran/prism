import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemCallContext } from "@prismengine/contracts-data";
import {
  workerIsolationReadiness,
  type WorkerProcessHandle,
} from "@prismengine/contracts-worker";
import { LocalWorkerLauncher } from "@prismengine/plugin-worker-local";
import { describe, expect, it } from "vitest";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function workerFixture(): Promise<{
  readonly directory: string;
  readonly entry: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prism-local-worker-"));
  const entry = join(directory, "worker.mjs");
  await writeFile(
    entry,
    [
      "process.on('message', (message) => {",
      "  if (message?.type === 'start') process.send?.({ type: 'ready' });",
      "});",
      "setInterval(() => undefined, 1_000);",
      "",
    ].join("\n"),
  );
  return { directory, entry };
}

function launchRequest(entryPath: string) {
  return {
    kind: "project-runtime" as const,
    entryPath,
    environment: { ...process.env },
    execArgv: [],
    serialization: "advanced" as const,
  };
}

describe("Local Worker launcher", () => {
  it("is explicitly development-only and cannot satisfy container isolation", async () => {
    const launcher = new LocalWorkerLauncher();
    expect(launcher.profile()).toEqual({
      providerId: "worker.launcher.local",
      isolation: "process",
      external: false,
    });
    await expect(
      workerIsolationReadiness(
        systemCallContext({ correlationId: "worker-local-test" }),
        launcher,
      ),
    ).resolves.toEqual({
      id: "worker-container-isolation",
      passed: false,
      evidence: JSON.stringify(launcher.profile()),
    });
  });

  it("rejects a pre-aborted launch before creating a child process", async () => {
    const fixture = await workerFixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        new LocalWorkerLauncher().launch(
          systemCallContext({
            correlationId: "worker-local-pre-aborted",
            signal: controller.signal,
          }),
          launchRequest(fixture.entry),
        ),
      ).rejects.toThrow("WORKER_LAUNCH_CANCELLED");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("kills a real child when its launch context is aborted", async () => {
    const fixture = await workerFixture();
    const controller = new AbortController();
    const launcher = new LocalWorkerLauncher();
    let worker: WorkerProcessHandle | undefined;
    try {
      worker = await launcher.launch(
        systemCallContext({
          correlationId: "worker-local-post-launch-abort",
          signal: controller.signal,
        }),
        launchRequest(fixture.entry),
      );
      const ready = deferred<unknown>();
      const exited = deferred<{
        readonly code: number | null;
        readonly signal: string | null;
      }>();
      worker.onMessage(ready.resolve);
      worker.onExit((code, signal) => exited.resolve({ code, signal }));
      worker.send({ type: "start" });
      await expect(ready.promise).resolves.toEqual({ type: "ready" });

      controller.abort();

      await exited.promise;
      expect(worker.killed).toBe(true);
      expect(worker.connected).toBe(false);
    } finally {
      worker?.kill();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
