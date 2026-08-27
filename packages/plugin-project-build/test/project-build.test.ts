import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { ProjectBuildCapabilityToken } from "@prismengine/contracts-project";
import { createEngine } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import { projectBuildPlugin } from "@prismengine/plugin-project-build";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";

const context = systemCallContext({ correlationId: "project-build-test" });

describe("Project Build Worker", () => {
  it("installs, typechecks, tests, builds, verifies exports, and publishes Release", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-artifacts-test-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        codeProjectPlugin,
        projectBuildPlugin({ artifactRoot: artifacts }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "build-project",
        slug: "build-project",
        name: "Build Project",
      });
      const materialEntry = {
        path: "src/materials/coefficient.ts",
        mediaType: "text/typescript",
        content: "export default function coefficient(value: number): number { return value * 1.1; }\n",
      };
      const manifest = {
        path: "prism.materials.json",
        mediaType: "application/json",
        content: `${JSON.stringify({
          schemaVersion: "1.0.0",
          materials: [{
            id: "performance.coefficient",
            version: "1.0.0",
            kind: "operator",
            authoringMode: "CODE",
            displayName: "系数调整",
            category: "绩效",
            runtimeTarget: "pipeline",
            entry: materialEntry.path,
            exportName: "default",
          }],
        }, null, 2)}\n`,
      };
      const saved = await projects.saveDraft(context, created.project.id, 1, [
        ...created.draft.files.filter((file) => file.path !== manifest.path),
        materialEntry,
        manifest,
      ]);
      const source = await projects.publishDraft(
        context,
        created.project.id,
        saved.draftVersion,
      );
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const build = await builds.build(context, created.project.id, source.revision);
      const logs = await builds.buildLog(context, build.id);
      expect(
        build.status,
        JSON.stringify({ diagnostics: build.diagnostics, logs }, null, 2),
      ).toBe("SUCCESS");
      expect(build.releaseId).toMatch(/^build-project:release@1$/);
      const release = await builds.release(context, created.project.id, 1);
      expect(release).toMatchObject({
        status: "published",
        revision: 1,
        spec: {
          sourceRevision: 1,
          sourceFingerprint: source.spec.fingerprint,
          builderVersion: expect.any(String),
          testResult: { passed: true, failed: 0 },
          reproducibility: "DETERMINISTIC",
          materials: [{
            materialId: "performance.coefficient",
            materialVersion: "1.0.0",
            source: {
              authoringMode: "CODE",
              module: {
                artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                dependencyLockHash: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
            },
          }],
        },
      });
      for (const descriptor of [
        release!.spec.clientArtifact,
        release!.spec.serverArtifact,
        release!.spec.buildManifestArtifact,
      ]) {
        await expect(stat(join(artifacts, descriptor.storageKey))).resolves.toBeDefined();
      }
      expect(logs).toEqual(expect.arrayContaining([
        expect.stringContaining("Vite client build PASS"),
        expect.stringContaining("esbuild server build PASS"),
      ]));
      const manifestBytes = await readFile(
        join(artifacts, release!.spec.buildManifestArtifact.storageKey),
      );
      expect(JSON.parse(manifestBytes.toString("utf8"))).toMatchObject({
        sourceFingerprint: source.spec.fingerprint,
      });
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("does not create a Project Release when tests fail", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-artifacts-failure-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        codeProjectPlugin,
        projectBuildPlugin({ artifactRoot: artifacts }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "failed-build",
        slug: "failed-build",
        name: "Failed Build",
      });
      const files = created.draft.files.map((file) => file.path === "tests/project.test.ts"
        ? { ...file, content: "export default async () => ({ passed: false });\n" }
        : file);
      const saved = await projects.saveDraft(context, created.project.id, 1, files);
      const source = await projects.publishDraft(context, created.project.id, saved.draftVersion);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const build = await builds.build(context, created.project.id, source.revision);
      expect(build.status).toBe("FAILED");
      expect(build.diagnostics[0]?.code).toBe("PROJECT_BUILD_FAILED");
      expect(await builds.releases(context, created.project.id)).toEqual([]);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);
});
