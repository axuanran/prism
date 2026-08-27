import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import type {
  ProjectArtifactDescriptor,
  ProjectSourceFile,
} from "@prismengine/contracts-project";
import type {
  BuildWorkerRequest,
  BuildWorkerResponse,
  BuiltMaterialArtifact,
} from "./protocol.js";

const require = createRequire(import.meta.url);

process.on("message", (message: BuildWorkerRequest) => {
  if (message.type !== "build") return;
  void execute(message).then(
    (response) => process.send?.(response),
    (error: unknown) => process.send?.({
      type: "failure",
      message: error instanceof Error ? error.message : String(error),
      logs: [],
    } satisfies BuildWorkerResponse),
  );
});

async function execute(request: BuildWorkerRequest): Promise<BuildWorkerResponse> {
  const logs: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "prism-build-"));
  try {
    await materialize(root, request.files);
    const packageJson = await readFile(join(root, "package.json"));
    const lockfile = await readFile(join(root, "pnpm-lock.yaml"));
    const packageJsonHash = sha(packageJson);
    const dependencyLockHash = sha(lockfile);
    const pnpmVersion = (await run(pnpmCommand(), ["--version"], root, logs)).trim();
    await run(pnpmCommand(), ["install", "--frozen-lockfile"], root, logs);

    const tsconfig = join(root, ".prism-tsconfig.json");
    await writeFile(tsconfig, JSON.stringify({
      compilerOptions: {
        allowJs: true,
        jsx: "react-jsx",
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      include: ["src/**/*", "tests/**/*"],
    }, null, 2));
    const tscPackage = require.resolve("@typescript/native/package.json");
    const tscBin = join(dirname(tscPackage), "bin", "tsc");
    await run(process.execPath, [tscBin, "--project", tsconfig], root, logs);

    const generatedTest = join(root, ".prism", "project.generated.test.ts");
    await mkdir(dirname(generatedTest), { recursive: true });
    await writeFile(generatedTest, [
      "import projectTest from '../tests/project.test';",
      "test('project test contract', async () => {",
      "  const result = await projectTest();",
      "  expect(result).toMatchObject({ passed: true });",
      "});",
      "",
    ].join("\n"));
    const reportPath = join(root, ".prism", "test-report.json");
    const vitestBin = require.resolve("vitest/vitest.mjs");
    await run(process.execPath, [
      vitestBin,
      "run",
      generatedTest,
      "--globals",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ], root, logs);
    const reportBytes = await readFile(reportPath);
    const report = JSON.parse(reportBytes.toString("utf8")) as {
      readonly numTotalTests?: number;
      readonly numFailedTests?: number;
      readonly success?: boolean;
    };
    const testReportArtifact = await persistBytes(
      request.artifactRoot,
      reportBytes,
      "application/json",
      "test-report.json",
    );
    const testResult = {
      passed: report.success === true || (report.numFailedTests ?? 0) === 0,
      total: report.numTotalTests ?? 0,
      failed: report.numFailedTests ?? 0,
      reportHash: testReportArtifact.hash,
    };
    if (!testResult.passed) throw new Error("Project tests failed.");

    const output = join(root, ".prism-output");
    const clientOutput = join(output, "client");
    await viteBuild({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        emptyOutDir: true,
        outDir: clientOutput,
        sourcemap: true,
        lib: {
          entry: join(root, "src", "client", "index.tsx"),
          formats: ["es"],
          fileName: () => "client.js",
        },
      },
    });
    logs.push("Vite client build PASS");

    const serverOutput = join(output, "server");
    await mkdir(serverOutput, { recursive: true });
    await esbuild({
      entryPoints: [join(root, "src", "server", "index.ts")],
      outfile: join(serverOutput, "server.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: "external",
      target: "node24",
    });
    logs.push("esbuild server build PASS");

    const materialArtifacts: BuiltMaterialArtifact[] = [];
    for (const manifest of request.materials) {
      const safeName = `${manifest.id}@${manifest.version}`.replace(/[^a-zA-Z0-9._@-]/g, "_");
      const materialFile = join(output, "materials", `${safeName}.js`);
      await mkdir(dirname(materialFile), { recursive: true });
      await esbuild({
        entryPoints: [join(root, ...manifest.entry.split("/"))],
        outfile: materialFile,
        bundle: true,
        format: "esm",
        platform: manifest.runtimeTarget === "client" ? "browser" : "node",
        target: manifest.runtimeTarget === "client" ? "es2022" : "node24",
      });
      await verifyExport(materialFile, manifest.exportName, root, logs);
      materialArtifacts.push({
        manifest,
        artifact: await persistBytes(
          request.artifactRoot,
          await readFile(materialFile),
          "text/javascript",
          `${safeName}.js`,
        ),
      });
    }

    const clientArtifact = await persistDirectory(
      request.artifactRoot,
      clientOutput,
      "application/vnd.prism.client",
    );
    const serverArtifact = await persistDirectory(
      request.artifactRoot,
      serverOutput,
      "application/vnd.prism.server",
    );
    const manifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: "1.0.0",
      buildId: request.buildId,
      projectId: request.projectId,
      sourceRevision: request.sourceRevision,
      sourceFingerprint: request.sourceFingerprint,
      packageJsonHash,
      dependencyLockHash,
      builderVersion: request.builderVersion,
      nodeVersion: process.version,
      pnpmVersion,
      clientArtifact,
      serverArtifact,
      testResult,
      materials: materialArtifacts,
    }, null, 2));
    const buildManifestArtifact = await persistBytes(
      request.artifactRoot,
      manifestBytes,
      "application/json",
      "build-manifest.json",
    );
    logs.push(`Build artifact ${buildManifestArtifact.hash}`);
    return {
      type: "success",
      clientArtifact,
      serverArtifact,
      buildManifestArtifact,
      testReportArtifact,
      testResult,
      packageJsonHash,
      dependencyLockHash,
      pnpmVersion,
      materials: materialArtifacts,
      logs,
    };
  } catch (error) {
    return {
      type: "failure",
      message: error instanceof Error ? error.message : String(error),
      logs,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function materialize(
  root: string,
  files: readonly ProjectSourceFile[],
): Promise<void> {
  for (const file of files) {
    const target = join(root, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  logs: string[],
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, CI: "1" },
    shell: command.toLowerCase().endsWith(".cmd"),
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    logs.push(...text.split(/\r?\n/).filter(Boolean));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    logs.push(...text.split(/\r?\n/).filter(Boolean));
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolve(output);
    else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "without code"}.`));
  });
  return promise;
}

async function verifyExport(
  file: string,
  exportName: string,
  cwd: string,
  logs: string[],
): Promise<void> {
  const script = [
    "import { pathToFileURL } from 'node:url';",
    `const module = await import(pathToFileURL(${JSON.stringify(file)}));`,
    `if (!Object.prototype.hasOwnProperty.call(module, ${JSON.stringify(exportName)})) {`,
    `  throw new Error('Missing export ${exportName}');`,
    "}",
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "-e", script], cwd, logs);
}

async function persistDirectory(
  artifactRoot: string,
  directory: string,
  contentType: string,
): Promise<ProjectArtifactDescriptor> {
  const entries = await walk(directory);
  const hash = createHash("sha256");
  let size = 0;
  for (const entry of entries) {
    const bytes = await readFile(join(directory, ...entry.split("/")));
    hash.update(entry);
    hash.update("\u0000");
    hash.update(bytes);
    size += bytes.length;
  }
  const identity = hash.digest("hex");
  const storageKey = join("sha256", identity.slice(0, 2), identity);
  const target = join(artifactRoot, storageKey);
  await mkdir(dirname(target), { recursive: true });
  try {
    await stat(target);
  } catch {
    await cp(directory, target, { recursive: true });
  }
  return { hash: identity, size, contentType, storageKey: storageKey.replace(/\\/g, "/") };
}

async function persistBytes(
  artifactRoot: string,
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
): Promise<ProjectArtifactDescriptor> {
  const hash = sha(bytes);
  const storageKey = join("sha256", hash.slice(0, 2), hash, fileName);
  const target = join(artifactRoot, storageKey);
  await mkdir(dirname(target), { recursive: true });
  try {
    await stat(target);
  } catch {
    await writeFile(target, bytes);
  }
  return {
    hash,
    size: bytes.byteLength,
    contentType,
    storageKey: storageKey.replace(/\\/g, "/"),
  };
}

async function walk(root: string, relative = ""): Promise<readonly string[]> {
  const values: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) values.push(...await walk(root, path));
    else values.push(path);
  }
  return values.sort();
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
