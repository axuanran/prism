import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import type { ProjectSourceFile } from "@prismengine/contracts-project";
import type {
  BuildArtifactPayload,
  BuildWorkerRequest,
  BuildWorkerResponse,
  BuiltMaterialPayload,
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
    await run(
      process.execPath,
      [join(dirname(tscPackage), "bin", "tsc"), "--project", tsconfig],
      root,
      logs,
    );

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
    await run(process.execPath, [
      require.resolve("vitest/vitest.mjs"),
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
    const testSummary = {
      passed: report.success === true || (report.numFailedTests ?? 0) === 0,
      total: report.numTotalTests ?? 0,
      failed: report.numFailedTests ?? 0,
    };
    if (!testSummary.passed) throw new Error("Project tests failed.");

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
    await verifyExport(join(clientOutput, "client.js"), "mount", root, logs);
    logs.push("Vite client build PASS; mount export verified");

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
    const actionIds = await inspectActions(join(serverOutput, "server.js"), root, logs);
    logs.push(`esbuild server build PASS; actions export verified (${actionIds.join(", ")})`);

    const materials: BuiltMaterialPayload[] = [];
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
      materials.push({
        manifest,
        artifact: {
          contentType: "text/javascript",
          files: [{ path: `${safeName}.js`, content: await readFile(materialFile) }],
        },
      });
    }

    return {
      type: "success",
      clientArtifact: await directoryPayload(clientOutput, "application/vnd.prism.client"),
      serverArtifact: await directoryPayload(serverOutput, "application/vnd.prism.server"),
      testReportArtifact: {
        contentType: "application/json",
        files: [{ path: "test-report.json", content: reportBytes }],
      },
      testSummary,
      packageJsonHash,
      dependencyLockHash,
      pnpmVersion,
      materials,
      actionIds,
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

async function materialize(root: string, files: readonly ProjectSourceFile[]): Promise<void> {
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

async function inspectActions(
  file: string,
  cwd: string,
  logs: string[],
): Promise<readonly string[]> {
  const outputFile = join(cwd, ".prism", "server-actions.json");
  const script = [
    "import { pathToFileURL } from 'node:url';",
    "import { writeFile } from 'node:fs/promises';",
    `const module = await import(pathToFileURL(${JSON.stringify(file)}));`,
    "if (!module.actions || typeof module.actions !== 'object') throw new Error('Missing actions export');",
    `await writeFile(${JSON.stringify(outputFile)}, JSON.stringify(Object.keys(module.actions).sort()));`,
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "-e", script], cwd, logs);
  return JSON.parse(await readFile(outputFile, "utf8")) as string[];
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

async function directoryPayload(
  directory: string,
  contentType: string,
): Promise<BuildArtifactPayload> {
  const paths = await walk(directory);
  return {
    contentType,
    files: await Promise.all(paths.map(async (path) => ({
      path,
      content: await readFile(join(directory, ...path.split("/"))),
    }))),
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
