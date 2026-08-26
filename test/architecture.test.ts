import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// TypeScript 7 intentionally ships no programmatic Compiler API. Architecture
// import analysis still needs an AST, so tooling uses the official TS6 API
// compatibility package. Prism code itself is compiled by TS7; Runtime has no
// TS6 dependency.
import ts from "typescript";
import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const kernelManifest = join(root, "packages/kernel/package.json");
const kernelSource = join(root, "packages/kernel/src");
const contractsDataSource = join(root, "packages/contracts-data/src");
const packagesSource = join(root, "packages");
const appsSource = join(root, "apps");
const postgresStorageSource = join(root, "packages/plugin-storage-postgres/src");
const testingSource = join(root, "packages/testing/src");
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

interface PackageManifest {
  dependencies?: Record<string, string>;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
  });
}

function importedPackages(path: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const packages: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      packages.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        packages.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      packages.push(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return packages;
}

function forbiddenImports(
  directory: string,
  isForbidden: (packageName: string) => boolean,
): string[] {
  return sourceFiles(directory).flatMap((path) =>
    importedPackages(path)
      .filter(isForbidden)
      .map((packageName) => `${relative(root, path)} -> ${packageName}`),
  );
}

describe("package architecture", () => {
  test.skipIf(!existsSync(kernelManifest))(
    "kernel has no plugin or implementation dependencies",
    () => {
      const manifest = JSON.parse(readFileSync(kernelManifest, "utf8")) as PackageManifest;
      const dependencyNames = Object.keys(manifest.dependencies ?? {});
      const forbiddenName =
        /(?:^|[/_-])plugin-|organization|calculation|performance|http|postgres|fastify/i;

      expect(dependencyNames.filter((name) => forbiddenName.test(name)).sort()).toEqual([]);
    },
  );

  test.skipIf(!existsSync(kernelSource))(
    "kernel source does not import plugins or specialized contracts",
    () => {
      const forbiddenPackage =
        /^@prismengine\/(?:plugin-|contracts-(?:calculation|organization|performance))/;

      expect(forbiddenImports(kernelSource, (name) => forbiddenPackage.test(name))).toEqual(
        [],
      );
    },
  );

  test.skipIf(!existsSync(contractsDataSource))(
    "data contracts do not import the kernel",
    () => {
      expect(
        forbiddenImports(
          contractsDataSource,
          (name) => name === "@prismengine/kernel" || name.startsWith("@prismengine/kernel/"),
        ),
      ).toEqual([]);
    },
  );

  test("runtime database drivers stay isolated in the PostgreSQL storage plugin", () => {
    const allowedRoots = [postgresStorageSource, testingSource].map(
      (directory) => `${directory}${sep}`,
    );
    const sourceRoots = [packagesSource, appsSource].filter((directory) =>
      existsSync(directory),
    );
    const violations = sourceRoots.flatMap((directory) =>
      sourceFiles(directory)
        .filter((path) => path.includes(`${sep}src${sep}`))
        .filter((path) => !allowedRoots.some((allowed) => path.startsWith(allowed)))
        .flatMap((path) =>
          importedPackages(path)
            .filter(
              (packageName) =>
                packageName === "pg" ||
                packageName.startsWith("pg/") ||
                packageName === "kysely" ||
                packageName.startsWith("kysely/"),
            )
            .map((packageName) => `${relative(root, path)} -> ${packageName}`),
        ),
    );

    // packages/testing is the explicit real-database test harness; production
    // providers other than storage.postgres never receive a driver exception.
    expect(violations).toEqual([]);
  });

  test("the open-source workspace declares and packages Apache-2.0 consistently", () => {
    const rootLicense = join(root, "LICENSE");
    const rootNotice = join(root, "NOTICE");
    expect(existsSync(rootLicense)).toBe(true);
    expect(existsSync(rootNotice)).toBe(true);
    const expectedLicense = readFileSync(rootLicense, "utf8");
    const expectedNotice = readFileSync(rootNotice, "utf8");

    const manifests = [
      join(root, "package.json"),
      ...readdirSync(packagesSource, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesSource, entry.name, "package.json"))
        .filter(existsSync),
    ];

    const violations = manifests.flatMap((path) => {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        readonly name?: string;
        readonly license?: string;
        readonly files?: readonly string[];
      };
      const packageRoot = join(path, "..");
      const isRoot = path === join(root, "package.json");
      const problems: string[] = [];
      if (manifest.license !== "Apache-2.0") {
        problems.push(`${relative(root, path)} -> license ${manifest.license ?? "missing"}`);
      }
      if (!isRoot) {
        for (const file of ["LICENSE", "NOTICE"] as const) {
          const packagedPath = join(packageRoot, file);
          if (!manifest.files?.includes(file)) {
            problems.push(`${relative(root, path)} -> files omits ${file}`);
          } else if (!existsSync(packagedPath)) {
            problems.push(`${relative(root, path)} -> missing ${file}`);
          } else {
            const actual = readFileSync(packagedPath, "utf8");
            const expected = file === "LICENSE" ? expectedLicense : expectedNotice;
            if (actual !== expected) problems.push(`${relative(root, path)} -> stale ${file}`);
          }
        }
      }
      return problems;
    });

    expect(violations).toEqual([]);
  });

  test("private Solution packages never return to the open Core workspace", () => {
    const forbiddenPaths = [
      join(root, "packages", "contracts-performance"),
      join(root, "packages", "plugin-performance-basic"),
      join(root, "apps", "performance-server"),
    ];
    expect(forbiddenPaths.filter(existsSync)).toEqual([]);

    const forbiddenDependencies: string[] = [];
    for (const directory of [packagesSource, appsSource]) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(directory, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          readonly dependencies?: Readonly<Record<string, string>>;
        };
        for (const name of Object.keys(manifest.dependencies ?? {})) {
          if (name.startsWith("@prism-hos-perf/")) {
            forbiddenDependencies.push(`${relative(root, manifestPath)} -> ${name}`);
          }
        }
      }
    }
    expect(forbiddenDependencies).toEqual([]);
  });

  test("official plugins consume only public Prism package entry points", () => {
    const violations = sourceFiles(packagesSource).flatMap((path) =>
      importedPackages(path)
        .filter((name) => /^@prismengine\/.+\/(?:src|internal)(?:\/|$)/.test(name))
        .map((name) => `${relative(root, path)} -> ${name}`),
    );
    expect(violations).toEqual([]);
  });
});
