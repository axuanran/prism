import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "prism-embedded-postgres-"));
const port = await availablePort();
let runtime;
try {
  runtime = await postgresRuntime(directory, port);
  await runtime.initialise();
  const serverProcess = await runtime.start();
  try {
    const command =
      process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
    const prefix = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm"] : [];
    const code = await run(
      command,
      [
        ...prefix,
        "exec",
        "vitest",
        "run",
        "packages/plugin-storage-postgres/test/postgres-storage.test.ts",
        "packages/plugin-code-project/test/code-project-postgres.test.ts",
        "packages/plugin-project-build/test/project-build-postgres.test.ts",
        "packages/plugin-project-runtime/test/project-runtime-postgres.test.ts",
      ],
      {
        ...process.env,
        PRISM_TEST_DATABASE_URL: runtime.connectionString,
      },
    );
    if (code !== 0) process.exitCode = code;
  } finally {
    await runtime.stop(serverProcess);
  }
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}

async function postgresRuntime(directory, port) {
  if (process.platform === "win32" && (await wslAvailable())) {
    return wslRuntime(port);
  }
  return nativeRuntime(directory, port);
}

async function nativeRuntime(directory, port) {
  const user = "prism";
  const password = `prism-test-${randomBytes(12).toString("hex")}`;
  const packageRoot = await binaryPackageRoot(postgresBinaryPackage());
  const bin = join(packageRoot, "native", "bin");
  const executable = (name) =>
    join(bin, process.platform === "win32" ? `${name}.exe` : name);
  const environment = {
    ...process.env,
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    LC_MESSAGES: "C",
  };
  const passwordFile = join(directory, "password.txt");
  const dataDirectory = join(directory, "data");
  return {
    connectionString: `postgres://${user}:${password}@127.0.0.1:${port}/postgres`,
    async initialise() {
      await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
      await checked(
        executable("initdb"),
        [
          `--pgdata=${dataDirectory}`,
          "--auth=scram-sha-256",
          `--username=${user}`,
          `--pwfile=${passwordFile}`,
          "--lc-messages=C",
          "--no-sync",
        ],
        environment,
      );
    },
    start: () =>
      startPostgres(
        executable("postgres"),
        ["-D", dataDirectory, "-h", "127.0.0.1", "-p", String(port)],
        environment,
      ),
    async stop(serverProcess) {
      await checked(
        executable("pg_ctl"),
        ["stop", "-D", dataDirectory, "-m", "fast", "-w"],
        environment,
      ).catch(() => serverProcess.kill());
    },
    async dispose() {},
  };
}

async function wslRuntime(port) {
  const distro = process.env.PRISM_TEST_WSL_DISTRO?.trim() || "Ubuntu";
  const packageRoot = await binaryPackageRoot("@embedded-postgres/linux-x64");
  const windowsBin = join(packageRoot, "native", "bin");
  const bin = await capture("wsl.exe", [
    "-d",
    distro,
    "--",
    "wslpath",
    "-a",
    windowsBin.replaceAll("\\", "/"),
  ]);
  const dataDirectory = await capture("wsl.exe", [
    "-d",
    distro,
    "--",
    "mktemp",
    "-d",
    "/tmp/prism-postgres-XXXXXXXX",
  ]);
  const executable = (name) => `${bin}/${name}`;
  const wsl = (program, args) => ["-d", distro, "--", program, ...args];
  return {
    connectionString: `postgres://prism@127.0.0.1:${port}/postgres`,
    initialise: () =>
      checked(
        "wsl.exe",
        wsl(executable("initdb"), [
          `--pgdata=${dataDirectory}`,
          "--auth=trust",
          "--username=prism",
          "--lc-messages=C",
          "--no-sync",
        ]),
        process.env,
      ),
    start: () =>
      startPostgres(
        "wsl.exe",
        wsl(executable("postgres"), [
          "-D",
          dataDirectory,
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
        ]),
        process.env,
      ),
    async stop(serverProcess) {
      await checked(
        "wsl.exe",
        wsl(executable("pg_ctl"), ["stop", "-D", dataDirectory, "-m", "fast", "-w"]),
        process.env,
      ).catch(() => serverProcess.kill());
    },
    dispose: () =>
      checked("wsl.exe", wsl("rm", ["-rf", dataDirectory]), process.env).catch(
        () => undefined,
      ),
  };
}

async function binaryPackageRoot(platformPackage) {
  const embeddedEntry = await realpath(
    fileURLToPath(import.meta.resolve("embedded-postgres")),
  );
  return realpath(resolve(dirname(embeddedEntry), "..", "..", platformPackage));
}

function postgresBinaryPackage() {
  const key = `${process.platform}-${process.arch}`;
  const names = {
    "win32-x64": "@embedded-postgres/windows-x64",
    "linux-x64": "@embedded-postgres/linux-x64",
    "linux-arm64": "@embedded-postgres/linux-arm64",
    "darwin-x64": "@embedded-postgres/darwin-x64",
    "darwin-arm64": "@embedded-postgres/darwin-arm64",
  };
  const name = names[key];
  if (!name) throw new Error(`Embedded PostgreSQL does not support ${key}.`);
  return name;
}

async function wslAvailable() {
  const distro = process.env.PRISM_TEST_WSL_DISTRO?.trim() || "Ubuntu";
  return (await run("wsl.exe", ["-d", distro, "--", "true"], process.env, true)) === 0;
}

async function availablePort() {
  const server = createServer();
  const listening = Promise.withResolvers();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate an Embedded PostgreSQL port.");
  }
  const closed = Promise.withResolvers();
  server.close(() => closed.resolve());
  await closed.promise;
  return address.port;
}

async function startPostgres(program, args, environment) {
  const ready = Promise.withResolvers();
  const child = spawn(program, args, {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (errorOutput.length < 16_384) errorOutput += text;
    if (text.includes("database system is ready to accept connections"))
      ready.resolve(child);
  });
  child.once("error", ready.reject);
  child.once("exit", (code) => {
    ready.reject(
      new Error(`Embedded PostgreSQL exited before readiness: ${code}; ${errorOutput}`),
    );
  });
  return ready.promise;
}

async function checked(command, args, environment) {
  const code = await run(command, args, environment);
  if (code !== 0) throw new Error(`${command} exited ${code}.`);
}

async function capture(command, args) {
  const completion = Promise.withResolvers();
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  child.once("error", completion.reject);
  child.once("exit", (code) => {
    if (code === 0) completion.resolve(stdout.trim());
    else completion.reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
  });
  return completion.promise;
}

async function run(command, args, environment, quiet = false) {
  const completion = Promise.withResolvers();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
  child.once("error", completion.reject);
  child.once("exit", (code) => completion.resolve(code ?? 1));
  return completion.promise;
}
