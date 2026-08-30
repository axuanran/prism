import { fork, type Serializable } from "node:child_process";
import { WorkerFrameDecoder, encodeWorkerFrame } from "./framing.js";

const entryPath = process.argv[2];
if (!entryPath) {
  process.stderr.write("Worker bridge requires an entry path.\n");
  process.exit(64);
}

const child = fork(entryPath, [], {
  serialization: "advanced",
  stdio: ["ignore", "ignore", "pipe", "ipc"],
  env: process.env,
});
const decoder = new WorkerFrameDecoder();

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const message of decoder.push(chunk)) {
      const serializable = message as Serializable;
      child.send(serializable);
    }
  } catch (error) {
    process.stderr.write(
      `Worker bridge frame error: ${error instanceof Error ? error.name : "Error"}.\n`,
    );
    child.kill();
    process.exitCode = 65;
  }
});
process.stdin.on("end", () => {
  if (child.connected) child.disconnect();
});
child.on("message", (message) => {
  process.stdout.write(encodeWorkerFrame(message));
});
child.stderr?.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`Worker bridge child error: ${error.name}.\n`);
  process.exitCode = 70;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
