import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReleasePreflightError,
  runReleasePreflight,
  validateDockerBuildContext,
  validateDockerBuildInputs,
  validateNodeToolchain,
  validatePnpmToolchain,
  validateReleaseWorkflow,
} from "../scripts/release-preflight.mjs";

const fixtures: string[] = [];

function writeManifest(path: string, manifest: Readonly<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, "utf8");
}

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "prism-release-preflight-"));
  fixtures.push(root);
  writeManifest(join(root, "package.json"), {
    name: "fixture",
    version: "0.1.20",
    private: true,
  });
  writeManifest(join(root, "packages/a/package.json"), {
    name: "@prismengine/a",
    version: "0.1.20",
    dependencies: { "@prismengine/b": "workspace:0.1.20" },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
  });
  writeManifest(join(root, "packages/b/package.json"), {
    name: "@prismengine/b",
    version: "0.1.20",
    devDependencies: { "@prismengine/private": "workspace:0.1.20" },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
  });
  writeManifest(join(root, "packages/private/package.json"), {
    name: "@prismengine/private",
    version: "9.9.9",
    private: true,
  });
  return root;
}

function packOutput(
  manifest: Readonly<Record<string, unknown>>,
  paths: readonly string[] = [
    "package.json",
    "LICENSE",
    "NOTICE",
    "dist/index.js",
    "dist/index.d.ts",
  ],
): string {
  return JSON.stringify([
    {
      name: manifest.name,
      version: manifest.version,
      files: paths.map((path) => ({ path })),
    },
  ]);
}

function actualPackOutput(
  manifest: Readonly<Record<string, unknown>>,
  filename: string,
): string {
  const [result] = JSON.parse(packOutput(manifest)) as [Readonly<Record<string, unknown>>];
  return JSON.stringify({ ...result, filename });
}

async function preparePublicationFixture(root: string): Promise<Map<string, string>> {
  await runReleasePreflight({
    root,
    mode: "prepare",
    preparePackImpl: async ({ outputDirectory, manifest }) => {
      const suffix = String(manifest.name).split("/").at(-1);
      const filename = `${suffix}.tgz`;
      writeFileSync(
        join(outputDirectory, filename),
        Buffer.from(`archive:${String(manifest.name)}`, "utf8"),
      );
      return actualPackOutput(manifest, filename);
    },
  });
  const evidence = JSON.parse(
    readFileSync(join(root, "release/npm/release-packages.json"), "utf8"),
  ) as {
    readonly packages: readonly {
      readonly name: string;
      readonly integrity: string;
    }[];
  };
  return new Map(evidence.packages.map((entry) => [entry.name, entry.integrity]));
}

function registryPackageName(input: URL): string {
  const path = decodeURIComponent(input.pathname).slice(1);
  if (path.startsWith("-/package/") && path.endsWith("/dist-tags")) {
    return path.slice("-/package/".length, -"/dist-tags".length);
  }
  return path.slice(0, path.lastIndexOf("/"));
}

function isRegistryTagRequest(input: URL): boolean {
  return decodeURIComponent(input.pathname).endsWith("/dist-tags");
}

function registryVersion(integrity: string): Response {
  return new Response(JSON.stringify({ dist: { integrity } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function registryTags(npmTag: string, version: string): Response {
  return new Response(JSON.stringify({ [npmTag]: version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("release preflight", () => {
  it("accepts aligned public versions and canonical workspace dependency specs", async () => {
    const result = await runReleasePreflight({ root: createFixture() });

    expect(result).toEqual({
      mode: "manifest",
      version: "0.1.20",
      publicPackageCount: 2,
    });
  });

  it("rejects noncanonical semantic versions", async () => {
    const root = createFixture();
    writeManifest(join(root, "package.json"), {
      name: "fixture",
      version: "01.1.0",
      private: true,
    });

    await expect(runReleasePreflight({ root })).rejects.toMatchObject({
      issues: expect.arrayContaining(["package.json has an invalid version"]),
    });
  });

  it.each([
    "--registry",
    "@prismengine/Private",
    "@prismengine/private\nname",
    "@other/private",
    `@prismengine/${"a".repeat(129)}`,
  ])("rejects unsafe internal package identity before registry access", async (name) => {
    const root = createFixture();
    writeManifest(join(root, "packages/a/package.json"), {
      name,
      version: "0.1.20",
      dependencies: { "@prismengine/b": "workspace:0.1.20" },
    });
    let fetchCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "release",
        refProtected: "true",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: 404 };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(fetchCalls).toBe(0);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "packages/a/package.json has an invalid internal package name",
    ]);
    expect(JSON.stringify(failure)).not.toContain(name);
  });

  it("rejects duplicate internal identities with path-only diagnostics", async () => {
    const root = createFixture();
    writeManifest(join(root, "packages/b/package.json"), {
      name: "@prismengine/a",
      version: "0.1.20",
    });

    let failure: unknown;
    try {
      await runReleasePreflight({ root });
    } catch (error) {
      failure = error;
    }
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "packages/b/package.json duplicates an internal package name",
    ]);
  });

  it("accepts the exact internal package suffix boundary", async () => {
    const root = createFixture();
    writeManifest(join(root, "packages/a/package.json"), {
      name: `@prismengine/${"a".repeat(128)}`,
      version: "0.1.20",
      dependencies: { "@prismengine/b": "workspace:0.1.20" },
    });

    await expect(runReleasePreflight({ root })).resolves.toMatchObject({
      mode: "manifest",
      publicPackageCount: 2,
    });
  });

  it("rejects public version drift and noncanonical internal dependency specs", async () => {
    const root = createFixture();
    writeManifest(join(root, "packages/a/package.json"), {
      name: "@prismengine/a",
      version: "0.1.21",
      dependencies: { "@prismengine/b": "workspace:*" },
    });

    let failure: unknown;
    try {
      await runReleasePreflight({ root });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReleasePreflightError);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "packages/a/package.json version must equal root version 0.1.20",
      "packages/a/package.json dependencies.@prismengine/b must be workspace:0.1.20",
    ]);
  });

  it("requires the exact release tag before any registry lookup", async () => {
    let fetchCalls = 0;

    await expect(
      runReleasePreflight({
        root: createFixture(),
        mode: "release",
        refProtected: "true",
        npmTag: "latest",
        ref: "refs/heads/main",
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: 404 };
        },
      }),
    ).rejects.toMatchObject({
      issues: ["release ref must be refs/tags/v0.1.20; received refs/heads/main"],
    });
    expect(fetchCalls).toBe(0);
  });

  it.each([undefined, "false", "TRUE"])(
    "requires canonical protected-ref proof before registry access",
    async (refProtected) => {
      let fetchCalls = 0;
      await expect(
        runReleasePreflight({
          root: createFixture(),
          mode: "release",
          refProtected,
          npmTag: "latest",
          ref: "refs/tags/v0.1.20",
          fetchImpl: async () => {
            fetchCalls += 1;
            return { status: 404 };
          },
        }),
      ).rejects.toMatchObject({
        issues: ["release ref must be protected"],
      });
      expect(fetchCalls).toBe(0);
    },
  );

  it("queries every public package and accepts only definite 404 absence", async () => {
    const endpoints: string[] = [];
    const result = await runReleasePreflight({
      root: createFixture(),
      mode: "release",
      refProtected: "true",
      npmTag: "latest",
      ref: "refs/tags/v0.1.20",
      fetchImpl: async (input: URL) => {
        endpoints.push(input.href);
        return { status: 404 };
      },
    });

    expect(result.publicPackageCount).toBe(2);
    expect(endpoints).toHaveLength(2);
    expect(endpoints.join("\n")).toContain("%40prismengine%2Fa/0.1.20");
    expect(endpoints.join("\n")).toContain("%40prismengine%2Fb/0.1.20");
  });

  it("fails after all registry lookups when a version exists or status is indeterminate", async () => {
    let fetchCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "release",
        refProtected: "true",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: fetchCalls === 1 ? 200 : 503 };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(fetchCalls).toBe(2);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "@prismengine/a@0.1.20 already exists in the registry",
      "@prismengine/b@0.1.20 registry lookup was indeterminate (HTTP 503)",
    ]);
  });

  it.each(["latest", "next-1"])("accepts canonical npm dist-tag %s", async (npmTag) => {
    let fetchCalls = 0;
    await runReleasePreflight({
      root: createFixture(),
      mode: "release",
      refProtected: "true",
      npmTag,
      ref: "refs/tags/v0.1.20",
      fetchImpl: async () => {
        fetchCalls += 1;
        return { status: 404 };
      },
    });
    expect(fetchCalls).toBe(2);
  });

  it.each([
    "latest' --tag compromised; $(private-command)",
    "$(private-command)",
    "0.1.20",
  ])("rejects unsafe npm dist-tag before registry access", async (npmTag) => {
    let fetchCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "release",
        refProtected: "true",
        npmTag,
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: 404 };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(fetchCalls).toBe(0);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "npm dist-tag is invalid",
    ]);
    expect(JSON.stringify(failure)).not.toContain(npmTag);
    expect(JSON.stringify(failure)).not.toContain("private-command");
  });
  it("allows finalization only after every package is visible with canonical digests", async () => {
    let fetchCalls = 0;
    const result = await runReleasePreflight({
      root: createFixture(),
      mode: "finalize",
      refProtected: "true",
      ref: "refs/tags/v0.1.20",
      workerDigest: `sha256:${"a".repeat(64)}`,
      hostDigest: `sha256:${"b".repeat(64)}`,
      fetchImpl: async () => {
        fetchCalls += 1;
        return { status: 200 };
      },
    });

    expect(fetchCalls).toBe(2);
    expect(result).toEqual({
      mode: "finalize",
      version: "0.1.20",
      publicPackageCount: 2,
    });
  });

  it("rejects noncanonical recovery digests before registry access without echoing them", async () => {
    let fetchCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "finalize",
        refProtected: "true",
        ref: "refs/tags/v0.1.20",
        workerDigest: "sha256:private-digest",
        hostDigest: `sha256:${"b".repeat(64)}`,
        fetchImpl: async () => {
          fetchCalls += 1;
          return { status: 200 };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(fetchCalls).toBe(0);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "worker image digest must be canonical SHA-256",
    ]);
    expect(JSON.stringify(failure)).not.toContain("private-digest");
  });

  it("checks every package and fails closed when finalization visibility is absent or indeterminate", async () => {
    let fetchCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "finalize",
        refProtected: "true",
        ref: "refs/tags/v0.1.20",
        workerDigest: `sha256:${"a".repeat(64)}`,
        hostDigest: `sha256:${"b".repeat(64)}`,
        fetchImpl: async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) return { status: 404 };
          throw new Error("private registry transport");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(fetchCalls).toBe(2);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "@prismengine/a@0.1.20 is not available in the registry",
      "@prismengine/b@0.1.20 registry lookup was indeterminate",
    ]);
    expect(JSON.stringify(failure)).not.toContain("private registry transport");
  });

  it("verifies every public package tarball inventory", async () => {
    const packed: string[] = [];
    const result = await runReleasePreflight({
      root: createFixture(),
      mode: "packages",
      packImpl: async ({ relativePath, manifest }) => {
        packed.push(relativePath);
        return packOutput(manifest);
      },
    });

    expect(result).toEqual({
      mode: "packages",
      version: "0.1.20",
      publicPackageCount: 2,
    });
    expect(packed).toEqual(["packages/a/package.json", "packages/b/package.json"]);
  });

  it("prepares deterministic actual tarballs and sorted integrity evidence", async () => {
    const root = createFixture();
    const preparePackImpl = async ({ outputDirectory, manifest }) => {
      const suffix = String(manifest.name).split("/").at(-1);
      const filename = `${suffix}.tgz`;
      const bytes = Buffer.from(`archive:${String(manifest.name)}`, "utf8");
      writeFileSync(join(outputDirectory, filename), bytes);
      return actualPackOutput(manifest, filename);
    };

    const first = await runReleasePreflight({
      root,
      mode: "prepare",
      preparePackImpl,
    });
    const evidencePath = join(root, "release/npm/release-packages.json");
    const firstEvidence = readFileSync(evidencePath, "utf8");
    const second = await runReleasePreflight({
      root,
      mode: "prepare",
      preparePackImpl,
    });
    const secondEvidence = readFileSync(evidencePath, "utf8");
    const parsed = JSON.parse(firstEvidence) as {
      readonly schemaVersion: number;
      readonly version: string;
      readonly packages: readonly {
        readonly name: string;
        readonly filename: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly integrity: string;
      }[];
    };

    expect(first).toMatchObject({ mode: "prepare", publicPackageCount: 2 });
    expect(second).toMatchObject({ mode: "prepare", publicPackageCount: 2 });
    expect(secondEvidence).toBe(firstEvidence);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.version).toBe("0.1.20");
    expect(parsed.packages.map((entry) => entry.name)).toEqual([
      "@prismengine/a",
      "@prismengine/b",
    ]);
    for (const entry of parsed.packages) {
      const bytes = Buffer.from(`archive:${entry.name}`, "utf8");
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(entry.integrity).toBe(
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      );
      expect(existsSync(join(root, "release/npm", entry.filename))).toBe(true);
    }
  });

  it("rejects prepared tarball output-directory escape without leaking the filename", async () => {
    const root = createFixture();
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "prepare",
        preparePackImpl: async ({ manifest }) =>
          actualPackOutput(manifest, "../private-password.tgz"),
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toContain(
      "packages/a/package.json prepared tarball escaped output directory",
    );
    expect(JSON.stringify(failure)).not.toContain("private-password");
    expect(existsSync(join(root, "release/npm"))).toBe(false);
  });

  it("rejects missing prepared tarballs and emits no evidence", async () => {
    const root = createFixture();
    await expect(
      runReleasePreflight({
        root,
        mode: "prepare",
        preparePackImpl: async ({ manifest }) =>
          actualPackOutput(manifest, `${String(manifest.name).split("/").at(-1)}.tgz`),
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        "packages/a/package.json prepared tarball could not be verified",
      ]),
    });
    expect(existsSync(join(root, "release/npm/release-packages.json"))).toBe(false);
  });

  it("rejects oversized prepared tarballs before hashing", async () => {
    const root = createFixture();
    await expect(
      runReleasePreflight({
        root,
        mode: "prepare",
        prepareMaxBytes: 4,
        preparePackImpl: async ({ outputDirectory, manifest }) => {
          const filename = `${String(manifest.name).split("/").at(-1)}.tgz`;
          writeFileSync(join(outputDirectory, filename), Buffer.alloc(5));
          return actualPackOutput(manifest, filename);
        },
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        "packages/a/package.json prepared tarball size is invalid",
      ]),
    });
    expect(existsSync(join(root, "release/npm/release-packages.json"))).toBe(false);
  });

  it("sanitizes actual pack failure, checks remaining packages, and removes partial output", async () => {
    const root = createFixture();
    let calls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "prepare",
        preparePackImpl: async ({ outputDirectory, manifest }) => {
          calls += 1;
          if (calls === 1) throw new Error("private actual pack stderr");
          const filename = "b.tgz";
          writeFileSync(join(outputDirectory, filename), Buffer.from("valid"));
          return actualPackOutput(manifest, filename);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(2);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "packages/a/package.json pack command failed",
    ]);
    expect(JSON.stringify(failure)).not.toContain("private actual pack stderr");
    expect(existsSync(join(root, "release/npm"))).toBe(false);
  });

  it("rejects a tarball missing a declared export target", async () => {
    await expect(
      runReleasePreflight({
        root: createFixture(),
        mode: "packages",
        packImpl: async ({ manifest }) =>
          packOutput(manifest, ["package.json", "LICENSE", "NOTICE", "dist/index.d.ts"]),
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        "packages/a/package.json pack output omits declared main target",
        "packages/a/package.json pack output omits declared exports target",
      ]),
    });
  });

  it("rejects unsafe tarball paths without echoing their content", async () => {
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "packages",
        packImpl: async ({ manifest }) =>
          packOutput(manifest, [
            "package.json",
            "LICENSE",
            "NOTICE",
            "dist/index.js",
            "dist/index.d.ts",
            "../private-password",
          ]),
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toContain(
      "packages/a/package.json pack output has unsafe file path at index 5",
    );
    expect(JSON.stringify(failure)).not.toContain("private-password");
  });

  it("rejects packed identity mismatch without echoing the packed identity", async () => {
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "packages",
        packImpl: async ({ manifest }) =>
          packOutput({ ...manifest, name: "private-packed-name" }),
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toContain(
      "packages/a/package.json packed identity does not match manifest",
    );
    expect(JSON.stringify(failure)).not.toContain("private-packed-name");
  });

  it("sanitizes pack command failures and continues checking public packages", async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root: createFixture(),
        mode: "packages",
        packImpl: async ({ manifest }) => {
          calls += 1;
          if (calls === 1) throw new Error("private pack stderr");
          return packOutput(manifest);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(2);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "packages/a/package.json pack command failed",
    ]);
    expect(JSON.stringify(failure)).not.toContain("private pack stderr");
  });

  it("allows explicit partial-publication preflight only for mixed 200/404 state", async () => {
    let calls = 0;
    await runReleasePreflight({
      root: createFixture(),
      mode: "resume",
      refProtected: "true",
      npmTag: "latest",
      ref: "refs/tags/v0.1.20",
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: calls === 1 ? 200 : 404 });
      },
    });
    expect(calls).toBe(2);

    await expect(
      runReleasePreflight({
        root: createFixture(),
        mode: "resume",
        refProtected: "true",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toMatchObject({
      issues: [
        "@prismengine/a@0.1.20 registry lookup was indeterminate (HTTP 503)",
        "@prismengine/b@0.1.20 registry lookup was indeterminate (HTTP 503)",
      ],
    });
  });

  it("publishes missing prepared tarballs in deterministic dependency order", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    const published = new Set<string>();
    const publishOrder: string[] = [];

    const result = await runReleasePreflight({
      root,
      mode: "publish",
      refProtected: "true",
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      npmTag: "latest",
      ref: "refs/tags/v0.1.20",
      publishPollAttempts: 1,
      fetchImpl: async (input: URL) => {
        const name = registryPackageName(input);
        if (isRegistryTagRequest(input)) return registryTags("latest", "0.1.20");
        return published.has(name)
          ? registryVersion(integrities.get(name)!)
          : new Response(null, { status: 404 });
      },
      publisherImpl: async ({ packageName, tarballPath }) => {
        publishOrder.push(packageName);
        expect(tarballPath).toBe(`./release/npm/${packageName.split("/").at(-1)}.tgz`);
        published.add(packageName);
      },
    });

    expect(result).toMatchObject({ mode: "publish", publicPackageCount: 2 });
    expect(publishOrder).toEqual(["@prismengine/b", "@prismengine/a"]);
    const journal = JSON.parse(
      readFileSync(join(root, "release/npm/publication-result.json"), "utf8"),
    ) as {
      readonly status: string;
      readonly ref: string;
      readonly sourceSha: string;
      readonly integrityStatus: string;
      readonly tagStatus: string;
      readonly packages: readonly {
        readonly name: string;
        readonly state: string;
        readonly tagState: string;
      }[];
    };
    expect(journal.status).toBe("VERIFIED");
    expect(journal.integrityStatus).toBe("VERIFIED");
    expect(journal.tagStatus).toBe("VERIFIED");
    expect(journal.ref).toBe("refs/tags/v0.1.20");
    expect(journal.sourceSha).toBe("a".repeat(40));
    expect(journal.packages).toEqual([
      {
        name: "@prismengine/b",
        filename: "b.tgz",
        integrity: integrities.get("@prismengine/b"),
        state: "VERIFIED",
        tagState: "VERIFIED",
      },
      {
        name: "@prismengine/a",
        filename: "a.tgz",
        integrity: integrities.get("@prismengine/a"),
        state: "VERIFIED",
        tagState: "VERIFIED",
      },
    ]);
  });

  it("rejects unprotected exact publication before registry or publisher access", async () => {
    const root = createFixture();
    await preparePublicationFixture(root);
    let fetchCalls = 0;
    let publishCalls = 0;

    await expect(
      runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "false",
        sourceSha: "a".repeat(40),
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 404 });
        },
        publisherImpl: async () => {
          publishCalls += 1;
        },
      }),
    ).rejects.toMatchObject({
      issues: ["release ref must be protected"],
    });

    expect(fetchCalls).toBe(0);
    expect(publishCalls).toBe(0);
  });

  it("rejects noncanonical publication source SHA before registry access", async () => {
    const root = createFixture();
    await preparePublicationFixture(root);
    let fetchCalls = 0;
    await expect(
      runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "true",
        sourceSha: "private-source-sha",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 404 });
        },
        publisherImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({
      issues: ["release source SHA is invalid"],
    });
    expect(fetchCalls).toBe(0);
  });
  it("skips exact existing packages and resumes a verified mixed registry state", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    const existing = new Set(["@prismengine/b"]);
    const published: string[] = [];

    await runReleasePreflight({
      root,
      mode: "publish",
      refProtected: "true",
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      npmTag: "next-1",
      ref: "refs/tags/v0.1.20",
      publishPollAttempts: 1,
      fetchImpl: async (input: URL) => {
        const name = registryPackageName(input);
        if (isRegistryTagRequest(input)) return registryTags("next-1", "0.1.20");
        return existing.has(name)
          ? registryVersion(integrities.get(name)!)
          : new Response(null, { status: 404 });
      },
      publisherImpl: async ({ packageName }) => {
        published.push(packageName);
        existing.add(packageName);
      },
    });

    expect(published).toEqual(["@prismengine/a"]);
  });

  it("publishes nothing when any existing registry integrity mismatches", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    let publishCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "true",
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async (input: URL) => {
          const name = registryPackageName(input);
          return registryVersion(
            name === "@prismengine/a"
              ? `sha512-${"A".repeat(86)}==`
              : integrities.get(name)!,
          );
        },
        publisherImpl: async () => {
          publishCalls += 1;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(publishCalls).toBe(0);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "@prismengine/a@0.1.20 registry integrity does not match",
    ]);
  });

  it.each(["http", "malformed", "oversized"])(
    "fails closed on %s registry metadata before publication",
    async (kind) => {
      const root = createFixture();
      await preparePublicationFixture(root);
      let publishCalls = 0;
      let failure: unknown;
      try {
        await runReleasePreflight({
          root,
          mode: "publish",
          refProtected: "true",
          sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          npmTag: "latest",
          ref: "refs/tags/v0.1.20",
          fetchImpl: async () => {
            if (kind === "http") return new Response(null, { status: 503 });
            if (kind === "malformed") {
              return new Response("private malformed metadata", { status: 200 });
            }
            return new Response("x".repeat(65 * 1024), { status: 200 });
          },
          publisherImpl: async () => {
            publishCalls += 1;
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(publishCalls).toBe(0);
      expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
        "@prismengine/b@0.1.20 registry metadata is indeterminate",
        "@prismengine/a@0.1.20 registry metadata is indeterminate",
      ]);
      expect(JSON.stringify(failure)).not.toContain("private malformed metadata");
    },
  );

  it("journals a sanitized exact topology position when npm publication fails", async () => {
    const root = createFixture();
    await preparePublicationFixture(root);
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "true",
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => new Response(null, { status: 404 }),
        publisherImpl: async () => {
          throw new Error("private npm token and stderr");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "package publication failed at topology index 0",
    ]);
    expect(JSON.stringify(failure)).not.toContain("private npm token");
    const journal = JSON.parse(
      readFileSync(join(root, "release/npm/publication-result.json"), "utf8"),
    ) as {
      readonly status: string;
      readonly packages: readonly { readonly state: string }[];
    };
    expect(journal.status).toBe("FAILED");
    expect(journal.packages[0]?.state).toBe("PUBLISH_FAILED");
  });

  it("bounded-polls every published integrity to eventual exact visibility", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    const published = new Set<string>();
    let verificationCalls = 0;
    let sleepCalls = 0;

    await runReleasePreflight({
      root,
      mode: "publish",
      refProtected: "true",
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      npmTag: "latest",
      ref: "refs/tags/v0.1.20",
      publishPollAttempts: 2,
      publishPollDelayMs: 1,
      sleepImpl: async () => {
        sleepCalls += 1;
      },
      fetchImpl: async (input: URL) => {
        const name = registryPackageName(input);
        if (isRegistryTagRequest(input)) return registryTags("latest", "0.1.20");
        if (!published.has(name)) return new Response(null, { status: 404 });
        verificationCalls += 1;
        return verificationCalls <= 2
          ? new Response(null, { status: 404 })
          : registryVersion(integrities.get(name)!);
      },
      publisherImpl: async ({ packageName }) => {
        published.add(packageName);
      },
    });

    expect(verificationCalls).toBe(4);
    expect(sleepCalls).toBe(1);
  });

  it("fails immediately when the validated npm dist-tag maps to another version", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    let publishCalls = 0;
    let failure: unknown;
    try {
      await runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "true",
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        publishPollAttempts: 1,
        fetchImpl: async (input: URL) => {
          const name = registryPackageName(input);
          if (isRegistryTagRequest(input)) {
            return registryTags("latest", "0.1.19");
          }
          return name === "@prismengine/a"
            ? new Response(null, { status: 404 })
            : registryVersion(integrities.get(name)!);
        },
        publisherImpl: async () => {
          publishCalls += 1;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(publishCalls).toBe(0);
    expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
      "@prismengine/b npm dist-tag mapping does not match release version",
    ]);
    expect(existsSync(join(root, "release/npm/publication-result.json"))).toBe(false);
  });

  it.each(["missing", "malformed", "oversized"])(
    "bounded-fails on %s npm dist-tag metadata without mutation or leakage",
    async (kind) => {
      const root = createFixture();
      const integrities = await preparePublicationFixture(root);
      let publishCalls = 0;
      let sleepCalls = 0;
      let failure: unknown;
      try {
        await runReleasePreflight({
          root,
          mode: "publish",
          refProtected: "true",
          sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          npmTag: "latest",
          ref: "refs/tags/v0.1.20",
          publishPollAttempts: 2,
          publishPollDelayMs: 1,
          sleepImpl: async () => {
            sleepCalls += 1;
          },
          fetchImpl: async (input: URL) => {
            const name = registryPackageName(input);
            if (!isRegistryTagRequest(input)) {
              return registryVersion(integrities.get(name)!);
            }
            if (kind === "missing") return registryTags("next", "0.1.20");
            if (kind === "malformed") {
              return new Response("private malformed tag metadata", { status: 200 });
            }
            return new Response("x".repeat(65 * 1024), { status: 200 });
          },
          publisherImpl: async () => {
            publishCalls += 1;
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(publishCalls).toBe(0);
      expect(sleepCalls).toBe(1);
      expect((failure as InstanceType<typeof ReleasePreflightError>).issues).toEqual([
        "existing package npm dist-tag verification did not converge",
      ]);
      expect(JSON.stringify(failure)).not.toContain("private malformed tag metadata");
    },
  );

  it("bounded-polls npm dist-tags to eventual exact mapping", async () => {
    const root = createFixture();
    const integrities = await preparePublicationFixture(root);
    let tagCalls = 0;
    let sleepCalls = 0;

    await runReleasePreflight({
      root,
      mode: "publish",
      refProtected: "true",
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      npmTag: "latest",
      ref: "refs/tags/v0.1.20",
      publishPollAttempts: 2,
      publishPollDelayMs: 1,
      sleepImpl: async () => {
        sleepCalls += 1;
      },
      fetchImpl: async (input: URL) => {
        const name = registryPackageName(input);
        if (!isRegistryTagRequest(input)) {
          return registryVersion(integrities.get(name)!);
        }
        tagCalls += 1;
        return tagCalls <= 2
          ? registryTags("next", "0.1.20")
          : registryTags("latest", "0.1.20");
      },
      publisherImpl: async () => undefined,
    });

    expect(tagCalls).toBe(6);
    expect(sleepCalls).toBe(1);
  });

  it("rejects prepared byte drift before any registry or publication call", async () => {
    const root = createFixture();
    await preparePublicationFixture(root);
    writeFileSync(join(root, "release/npm/a.tgz"), Buffer.from("tampered prepared bytes"));
    let fetchCalls = 0;
    let publishCalls = 0;

    await expect(
      runReleasePreflight({
        root,
        mode: "publish",
        refProtected: "true",
        sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        npmTag: "latest",
        ref: "refs/tags/v0.1.20",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 404 });
        },
        publisherImpl: async () => {
          publishCalls += 1;
        },
      }),
    ).rejects.toMatchObject({
      issues: ["packages/a/package.json prepared tarball does not match evidence"],
    });
    expect(fetchCalls).toBe(0);
    expect(publishCalls).toBe(0);
  });

  it("pins Dockerfile frontend and Node base inputs without workflow overrides", () => {
    const repository = join(import.meta.dirname, "..");
    const worker = readFileSync(join(repository, "docker/worker.Dockerfile"), "utf8");
    const host = readFileSync(join(repository, "docker/host.Dockerfile"), "utf8");
    const workflow = readFileSync(
      join(repository, ".github/workflows/release.yml"),
      "utf8",
    );
    const dockerIgnore = readFileSync(join(repository, ".dockerignore"), "utf8");
    const rootManifest = readFileSync(join(repository, "package.json"), "utf8");
    expect(validateDockerBuildInputs(worker, host, workflow)).toEqual([]);
    expect(validateDockerBuildContext(dockerIgnore, worker, host, workflow)).toEqual([]);
    expect(validatePnpmToolchain(rootManifest, worker, host, workflow)).toEqual([]);
    expect(validateNodeToolchain(rootManifest, worker, host, workflow)).toEqual([]);

    const mutableFrontend = worker.replace(
      /# syntax=[^\n]+/u,
      "# syntax=docker/dockerfile:1.7",
    );
    expect(validateDockerBuildInputs(mutableFrontend, host, workflow)).toContain(
      "worker Dockerfile frontend digest does not match",
    );

    const mutableNode = worker.replace(
      /node:24-bookworm-slim@sha256:[0-9a-f]{64}/u,
      "node:24-bookworm-slim",
    );
    expect(validateDockerBuildInputs(mutableNode, host, workflow)).toContain(
      "worker Dockerfile Node image digest does not match",
    );

    const extraBase = `${host}\nFROM alpine:latest AS unexpected\n`;
    expect(validateDockerBuildInputs(worker, extraBase, workflow)).toContain(
      "host Dockerfile stages must use only the pinned Node image",
    );

    const overriddenWorkflow = `${workflow}\n# NODE_IMAGE=node:latest\n`;
    expect(validateDockerBuildInputs(worker, host, overriddenWorkflow)).toContain(
      "release workflow must not override the pinned Node image",
    );

    const releaseIncluded = dockerIgnore.replace(/^release\n/mu, "");
    expect(validateDockerBuildContext(releaseIncluded, worker, host, workflow)).toContain(
      "Docker build context exclusions do not match the allowlist",
    );

    const npmrcIncluded = dockerIgnore.replace(/^\.npmrc\n/mu, "");
    expect(validateDockerBuildContext(npmrcIncluded, worker, host, workflow)).toContain(
      "Docker build context exclusions do not match the allowlist",
    );

    const reIncluded = `${dockerIgnore}!release/npm/release-packages.json\n`;
    expect(validateDockerBuildContext(reIncluded, worker, host, workflow)).toContain(
      "Docker build context exclusions must not re-include files",
    );

    const alternateContext = workflow.replace(
      "          context: .",
      "          context: https://example.invalid/source.git",
    );
    expect(
      validateDockerBuildContext(dockerIgnore, worker, host, alternateContext),
    ).toContain("release image builds must use only the filtered root context");

    const duplicateCopy = `${worker}\nCOPY . .\n`;
    expect(
      validateDockerBuildContext(dockerIgnore, duplicateCopy, host, workflow),
    ).toContain("worker Dockerfile must copy the filtered source context once");

    const versionOnlyManifest = rootManifest.replace(
      /pnpm@11\.21\.0\+sha512\.[0-9a-f]{128}/u,
      "pnpm@11.21.0",
    );
    expect(validatePnpmToolchain(versionOnlyManifest, worker, host, workflow)).toContain(
      "root packageManager does not match the pnpm integrity pin",
    );

    const alteredPnpmHash = worker.replace(
      /PNPM_INTEGRITY=sha512\.[0-9a-f]{128}/u,
      `PNPM_INTEGRITY=sha512.${"0".repeat(128)}`,
    );
    expect(validatePnpmToolchain(rootManifest, alteredPnpmHash, host, workflow)).toContain(
      "worker Dockerfile pnpm arguments do not match the integrity pin",
    );

    const versionOnlyCorepack = worker.replace(
      "pnpm@${PNPM_VERSION}+${PNPM_INTEGRITY}",
      "pnpm@${PNPM_VERSION}",
    );
    expect(
      validatePnpmToolchain(rootManifest, versionOnlyCorepack, host, workflow),
    ).toContain("worker Dockerfile Corepack preparation is not integrity-pinned");

    const mismatchedSetup = workflow.replace(
      "          version: 11.21.0",
      "          version: 11.20.0",
    );
    expect(validatePnpmToolchain(rootManifest, worker, host, mismatchedSetup)).toContain(
      "release pnpm setup version does not match the integrity pin",
    );

    const overriddenPnpm = `${workflow}\n# PNPM_INTEGRITY=sha512.private\n`;
    expect(validatePnpmToolchain(rootManifest, worker, host, overriddenPnpm)).toContain(
      "release workflow must not override the pnpm integrity pin",
    );

    const broadNodeEngine = rootManifest.replace('"node": "24.20.0"', '"node": ">=24"');
    expect(validateNodeToolchain(broadNodeEngine, worker, host, workflow)).toContain(
      "root Node engine does not match the exact release version",
    );

    const alteredNodeVersion = worker.replace(
      "ARG NODE_VERSION=24.20.0",
      "ARG NODE_VERSION=24.19.0",
    );
    expect(
      validateNodeToolchain(rootManifest, alteredNodeVersion, host, workflow),
    ).toContain("worker Dockerfile Node version checks do not match the pinned image");

    const missingNodeCheck = worker.replace(
      'RUN test "$(node --version)" = "v${NODE_VERSION}" \\\n    && ',
      "RUN ",
    );
    expect(validateNodeToolchain(rootManifest, missingNodeCheck, host, workflow)).toContain(
      "worker Dockerfile Node version checks do not match the pinned image",
    );

    const broadSetupNode = workflow.replace(
      "          node-version: 24.20.0",
      "          node-version: 24",
    );
    expect(validateNodeToolchain(rootManifest, worker, host, broadSetupNode)).toContain(
      "release setup-node version does not match the exact Node version",
    );

    const overriddenNode = `${workflow}\n# NODE_VERSION=24.19.0\n`;
    expect(validateNodeToolchain(rootManifest, worker, host, overriddenNode)).toContain(
      "release workflow must not override the exact Node version",
    );
  });

  it("enforces digest-only builds and signed post-smoke normal or recovery tags", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8",
    );
    expect(validateReleaseWorkflow(workflow)).toEqual([]);

    const mutableWorker = workflow.replace(
      "outputs: type=image,name=ghcr.io/${{ github.repository }}/worker,push-by-digest=true,name-canonical=true,push=true",
      "tags: ghcr.io/${{ github.repository }}/worker:mutable",
    );
    expect(validateReleaseWorkflow(mutableWorker)).toContain(
      "worker image build must be normal-only and push by digest without tags",
    );

    const earlyFinalize = workflow.replace(
      "      - name: Smoke-install public distribution from a clean directory",
      "      - name: Finalize Worker and Host release tags\n      - name: Smoke-install public distribution from a clean directory",
    );
    expect(validateReleaseWorkflow(earlyFinalize)).toContain(
      "signature verification, registry smoke, and final tags must be ordered",
    );

    const wrongIdentity = workflow.replace(
      "https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF",
      "https://github.com/untrusted/workflow",
    );
    expect(validateReleaseWorkflow(wrongIdentity)).toContain(
      "finalization recovery must verify both exact digest signatures",
    );

    const interpolatedTag = workflow.replace(
      '--mode publish\n          --ref "$GITHUB_REF"\n          --ref-protected "$RELEASE_REF_PROTECTED"\n          --source-sha "$GITHUB_SHA"\n          --npm-tag "$RELEASE_NPM_TAG"',
      '--mode publish\n          --ref "$GITHUB_REF"\n          --ref-protected "$RELEASE_REF_PROTECTED"\n          --source-sha "$GITHUB_SHA"\n          --npm-tag "${{ inputs[\'npm-tag\'] }}"',
    );
    expect(validateReleaseWorkflow(interpolatedTag)).toContain(
      "npm publication must use exact prepared tarballs with an isolated tag",
    );

    const privateSmoke = workflow.replace(
      "if (manifest.private !== true) console.log(manifest.name);",
      "console.log(manifest.name);",
    );
    expect(validateReleaseWorkflow(privateSmoke)).toContain(
      "registry smoke must discover public packages only",
    );

    const dryRunOnly = workflow.replace(
      "run: pnpm release:prepare-packages",
      "run: pnpm release:verify-packages",
    );
    expect(validateReleaseWorkflow(dryRunOnly)).toContain(
      "normal release must prepare actual package tarballs before SBOM",
    );

    const recursivePublish = workflow.replace(
      "node scripts/release-preflight.mjs\n          --mode publish",
      "pnpm --recursive publish",
    );
    expect(validateReleaseWorkflow(recursivePublish)).toContain(
      "npm publication must use exact prepared tarballs with an isolated tag",
    );

    const missingPublicationJournal = workflow.replaceAll(
      "release/npm/publication-result.json",
      "release/npm/missing.json",
    );
    expect(validateReleaseWorkflow(missingPublicationJournal)).toContain(
      "npm publication journal must upload after success or failure",
    );

    const mutableAction = workflow.replace(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/checkout@v4",
    );
    expect(validateReleaseWorkflow(mutableAction)).toContain(
      "actions/checkout action pin does not match the allowlist",
    );

    const changedActionSha = workflow.replace(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677263",
    );
    expect(validateReleaseWorkflow(changedActionSha)).toContain(
      "actions/checkout action pin does not match the allowlist",
    );

    const unknownAction = workflow.replace(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "untrusted/checkout@11d5960a326750d5838078e36cf38b85af677262",
    );
    expect(validateReleaseWorkflow(unknownAction)).toContain(
      "release workflow uses an unapproved action repository",
    );

    const missingAction = workflow.replace(/^\s*- uses: actions\/checkout@[^\n]+\n/mu, "");
    expect(validateReleaseWorkflow(missingAction)).toContain(
      "actions/checkout action use count does not match the allowlist",
    );

    const jobScopedSecrets = workflow.replace(
      "\n    steps:",
      "\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n      PRISM_TEST_DATABASE_URL: postgres://private\n    steps:",
    );
    expect(validateReleaseWorkflow(jobScopedSecrets)).toContain(
      "release workflow exposes sensitive environment at job scope",
    );

    const missingPublishToken = workflow.replace(
      "      - name: Publish exact Apache-2.0 package tarballs\n        if: ${{ !inputs['finalize-only'] }}\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n          RELEASE_NPM_TAG:",
      "      - name: Publish exact Apache-2.0 package tarballs\n        if: ${{ !inputs['finalize-only'] }}\n        env:\n          RELEASE_NPM_TAG:",
    );
    expect(validateReleaseWorkflow(missingPublishToken)).toContain(
      "npm token must be scoped to identity verification and publication only",
    );

    const missingPostgresScope = workflow.replace(
      '          PRISM_REQUIRE_POSTGRES_TESTS: "1"\n',
      "",
    );
    expect(validateReleaseWorkflow(missingPostgresScope)).toContain(
      "PostgreSQL test environment must be scoped to the required test step",
    );

    const authenticatedSmoke = workflow.replace(
      '          NODE_AUTH_TOKEN: ""',
      "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
    );
    expect(validateReleaseWorkflow(authenticatedSmoke)).toContain(
      "registry smoke must explicitly clear the npm token",
    );

    const persistedCheckout = workflow.replace(
      "persist-credentials: false",
      "persist-credentials: true",
    );
    expect(validateReleaseWorkflow(persistedCheckout)).toContain(
      "checkout must not persist GitHub credentials",
    );

    const missingLogout = workflow.replace(
      "run: docker logout ghcr.io",
      "run: echo logout omitted",
    );
    expect(validateReleaseWorkflow(missingLogout)).toContain(
      "GHCR credential login, logout, smoke, and final login order is invalid",
    );

    const loginDuringNpm = workflow.replace(
      "      - name: Verify npm token and @prismengine scope access",
      "      - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9\n      - name: Verify npm token and @prismengine scope access",
    );
    expect(validateReleaseWorkflow(loginDuringNpm)).toContain(
      "GHCR credentials must remain absent during npm operations and smoke",
    );

    const delayedFinalLogin = workflow.replace(
      "      - name: Finalize Worker and Host release tags",
      "      - run: echo unrelated step\n      - name: Finalize Worker and Host release tags",
    );
    expect(validateReleaseWorkflow(delayedFinalLogin)).toContain(
      "final GHCR login must occur immediately before tag finalization",
    );

    const unprotectedProjection = workflow.replace(
      "RELEASE_REF_PROTECTED: ${{ github.ref_protected }}",
      'RELEASE_REF_PROTECTED: "false"',
    );
    expect(validateReleaseWorkflow(unprotectedProjection)).toContain(
      "release mutation paths must receive an isolated protected-ref value",
    );

    const directProtectedExpression = workflow.replace(
      '--ref-protected "$RELEASE_REF_PROTECTED"',
      '--ref-protected "${{ github.ref_protected }}"',
    );
    expect(validateReleaseWorkflow(directProtectedExpression)).toContain(
      "release mutation paths must receive an isolated protected-ref value",
    );

    const unboundImageRef = workflow.replace(
      "ref: process.env.RELEASE_REF",
      "ref: undefined",
    );
    expect(validateReleaseWorkflow(unboundImageRef)).toContain(
      "release image evidence must bind exact ref and source SHA",
    );

    const unsignedPackageEvidence = workflow.replace(
      "--bundle release/npm/release-packages.json.sigstore.json",
      "--bundle release/npm/missing.sigstore.json",
    );
    expect(validateReleaseWorkflow(unsignedPackageEvidence)).toContain(
      "prepared package evidence must be keyless-signed",
    );

    const untrustedEvidenceIdentity = workflow.replaceAll(
      "https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF",
      "https://github.com/untrusted/workflow",
    );
    expect(validateReleaseWorkflow(untrustedEvidenceIdentity)).toContain(
      "custom release evidence signatures must verify workflow identity",
    );

    const nonAlwaysPublicationSign = workflow.replace(
      "if: ${{ always() && !inputs['finalize-only'] && hashFiles('release/npm/publication-result.json') != '' }}",
      "if: ${{ !inputs['finalize-only'] }}",
    );
    expect(validateReleaseWorkflow(nonAlwaysPublicationSign)).toContain(
      "npm publication result must be always-run signed and verified",
    );

    const missingPublicationBundle = workflow.replace(
      "            release/npm/publication-result.json.sigstore.json",
      "            release/npm/missing.sigstore.json",
    );
    expect(validateReleaseWorkflow(missingPublicationBundle)).toContain(
      "npm publication result and bundle must upload on failure",
    );

    const pushTriggered = workflow.replace(
      "on:\n  workflow_dispatch:",
      "on:\n  push:\n  workflow_dispatch:",
    );
    expect(validateReleaseWorkflow(pushTriggered)).toContain(
      "release workflow trigger must be workflow_dispatch only",
    );

    const broadContents = workflow.replace("contents: read", "contents: write");
    expect(validateReleaseWorkflow(broadContents)).toContain(
      "release workflow permissions must match the exact minimal set",
    );

    const extraPermission = workflow.replace(
      "contents: read",
      "contents: read\n  actions: read",
    );
    expect(validateReleaseWorkflow(extraPermission)).toContain(
      "release workflow permissions must match the exact minimal set",
    );

    const missingOidc = workflow.replace("  id-token: write\n", "");
    expect(validateReleaseWorkflow(missingOidc)).toContain(
      "release workflow permissions must match the exact minimal set",
    );

    const increasedTimeout = workflow.replace(
      "timeout-minutes: 90",
      "timeout-minutes: 360",
    );
    expect(validateReleaseWorkflow(increasedTimeout)).toContain(
      "release publish job must use ubuntu-latest with a 90-minute timeout",
    );

    const missingTimeout = workflow.replace("    timeout-minutes: 90\n", "");
    expect(validateReleaseWorkflow(missingTimeout)).toContain(
      "release publish job must use ubuntu-latest with a 90-minute timeout",
    );

    const cancellingRelease = workflow.replace(
      "cancel-in-progress: false",
      "cancel-in-progress: true",
    );
    expect(validateReleaseWorkflow(cancellingRelease)).toContain(
      "release concurrency envelope is invalid",
    );

    const secondPrivilegedJob = `${workflow}\n  second:\n    runs-on: ubuntu-latest\n`;
    expect(validateReleaseWorkflow(secondPrivilegedJob)).toContain(
      "release workflow must contain exactly one publish job",
    );

    const weakDatabaseHealth = workflow.replace(
      "--health-retries 10",
      "--health-retries 1",
    );
    expect(validateReleaseWorkflow(weakDatabaseHealth)).toContain(
      "release PostgreSQL service health envelope is invalid",
    );
  });
});
