import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import {
  ProjectBuildCapabilityToken,
  ProjectRuntimeCapabilityToken,
  type ProjectReleaseDefinition,
  type ProjectSourceFile,
} from "@prismengine/contracts-project";
import { localArtifactStorePlugin } from "@prismengine/plugin-artifact-store-local";
import { createEngine } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import {
  HttpCapabilityToken,
  createHttpPlugin,
} from "@prismengine/plugin-http-fastify";
import {
  ProjectReleaseResource,
  projectBuildPlugin,
} from "@prismengine/plugin-project-build";
import { projectRuntimePlugin } from "@prismengine/plugin-project-runtime";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";

const context = systemCallContext({ correlationId: "project-runtime-test" });

function releaseFiles(
  files: readonly ProjectSourceFile[],
  coefficient: "1.1" | "1.2",
): readonly ProjectSourceFile[] {
  const value = coefficient === "1.1" ? "1320" : "1440";
  const materialVersion = coefficient === "1.1" ? "1.0.0" : "2.0.0";
  const mapped = files
    .filter((file) =>
      file.path !== "src/materials/coefficient.ts" &&
      file.path !== "prism.materials.json")
    .map((file) => {
      if (file.path === "src/client/index.tsx") {
        return {
          ...file,
          content: `export async function mount(context: { root: HTMLElement }): Promise<void> { context.root.textContent = '${value}'; }\n`,
        };
      }
      if (file.path === "src/server/index.ts") {
        return {
          ...file,
          content: [
            "export const actions = {",
            "  async calculate(input: { base: number }, context: { logger: { info(value: unknown): void }, materials: { execute(id: string, version: string, input: number): Promise<unknown> } }) {",
            `    const value = Number(await context.materials.execute('performance.coefficient', '${materialVersion}', input.base));`,
            `    context.logger.info('coefficient ${coefficient}');`,
            `    return { value, coefficient: ${coefficient} };`,
            "  },",
            "  async slow() { await new Promise<void>(() => undefined); return { slow: false }; },",
            "  async crash() { (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1); },",
            "  async ping() { return { pong: true }; },",
            "  async capabilities(_input: null, context: { engine: { inspect(): { capabilities: unknown[] } } }) { return { count: context.engine.inspect().capabilities.length }; },",
            "};",
            "",
          ].join("\n"),
        };
      }
      return file;
    });
  return [
    ...mapped,
    {
      path: "src/materials/coefficient.ts",
      mediaType: "text/typescript",
      content: `export default function coefficient(input: number): number { return input * ${coefficient}; }\n`,
    },
    {
      path: "prism.materials.json",
      mediaType: "application/json",
      content: `${JSON.stringify({
        schemaVersion: "1.0.0",
        materials: [{
          id: "performance.coefficient",
          version: materialVersion,
          kind: "operator",
          authoringMode: "CODE",
          displayName: "系数调整",
          category: "绩效",
          runtimeTarget: "pipeline",
          entry: "src/materials/coefficient.ts",
          exportName: "default",
        }],
      }, null, 2)}\n`,
    },
  ];
}

describe("Project App Runtime", () => {
  it("health-checks, activates, invokes, rolls back, and preserves RunPins", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-artifacts-"));
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({ port: 0, inspection: () => engine.inspect() });
    engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        projectBuildPlugin(),
        projectRuntimePlugin(),
        http,
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const created = await projects.create(context, {
        id: "runtime-performance",
        slug: "runtime-performance",
        name: "Runtime Performance",
      });
      const draft1 = await projects.saveDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
        releaseFiles(created.draft.files, "1.1"),
      );
      const source1 = await projects.publishDraft(context, created.project.id, draft1.draftVersion);
      expect((await builds.build(context, created.project.id, source1.revision)).status).toBe("SUCCESS");
      const after1 = await projects.draft(context, created.project.id);
      const draft2 = await projects.saveDraft(
        context,
        created.project.id,
        after1.draftVersion,
        releaseFiles(after1.files, "1.2"),
      );
      const source2 = await projects.publishDraft(context, created.project.id, draft2.draftVersion);
      expect((await builds.build(context, created.project.id, source2.revision)).status).toBe("SUCCESS");
      expect(await runtime.releaseMaterials(context, created.project.id, 1)).toMatchObject([{
        status: "BUILT",
        manifest: { id: "performance.coefficient", version: "1.0.0" },
        artifact: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      }]);
      expect(await runtime.releaseMaterials(context, created.project.id, 2)).toMatchObject([{
        status: "BUILT",
        manifest: { id: "performance.coefficient", version: "2.0.0" },
      }]);

      const active1 = await runtime.activate(context, created.project.id, 1, null);
      expect(await runtime.executeMaterial(
        context,
        created.project.id,
        active1.release,
        "performance.coefficient",
        "1.0.0",
        1200,
      )).toBe(1320);
      expect(active1.release.revision).toBe(1);
      const run1 = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "calculate",
        { base: 1200 },
      );
      expect(run1).toMatchObject({
        status: "SUCCESS",
        release: active1.release,
        result: { value: 1320, coefficient: 1.1 },
        pin: {
          definition: { kind: "project.release", revision: 1 },
          definitionFingerprint: active1.release.fingerprint,
        },
        reproducibility: "BEST_EFFORT",
      });
      const capabilityRun = await runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "capabilities",
        null,
      );
      expect(capabilityRun.status).toBe("SUCCESS");
      expect(
        typeof capabilityRun.result === "object" &&
        capabilityRun.result !== null &&
        "count" in capabilityRun.result
          ? capabilityRun.result.count
          : 0,
      ).toBeGreaterThan(0);
      await expect(runtime.activate(context, created.project.id, 2, null))
        .rejects.toThrow("PROJECT_ACTIVE_RELEASE_CONFLICT");

      const active2 = await runtime.activate(context, created.project.id, 2, active1.release);
      expect(await runtime.executeMaterial(
        context,
        created.project.id,
        active2.release,
        "performance.coefficient",
        "2.0.0",
        1200,
      )).toBe(1440);
      const run2 = await runtime.invoke(
        context,
        created.project.id,
        active2.release,
        "calculate",
        { base: 1200 },
      );
      expect(run2).toMatchObject({
        status: "SUCCESS",
        release: active2.release,
        result: { value: 1440, coefficient: 1.2 },
        pin: { definitionFingerprint: active2.release.fingerprint },
      });
      await expect(runtime.invoke(
        context,
        created.project.id,
        active1.release,
        "calculate",
        { base: 1200 },
      )).rejects.toThrow("PROJECT_RELEASE_CHANGED");
      const missing = await runtime.invoke(
        context,
        created.project.id,
        active2.release,
        "missing-action",
        null,
      );
      expect(missing).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_NOT_FOUND"),
      });
      expect(run2.pin.definitionFingerprint).not.toBe(run1.pin.definitionFingerprint);

      const rollback = await runtime.activate(
        context,
        created.project.id,
        1,
        active2.release,
      );
      const run3 = await runtime.invoke(
        context,
        created.project.id,
        rollback.release,
        "calculate",
        { base: 1200 },
      );
      expect(run3).toMatchObject({ release: rollback.release, result: { value: 1320 } });
      expect(await runtime.getRun(context, run1.id)).toEqual(run1);
      expect((await runtime.listRuns(context, created.project.id)).map((run) => run.id))
        .toEqual(expect.arrayContaining([run1.id, run2.id, run3.id]));
      expect((await runtime.logs(context, created.project.id)).map((log) => log.message))
        .toEqual(expect.arrayContaining(["coefficient 1.1", "coefficient 1.2"]));
      const storage = engine.capability(StorageCapabilityToken);
      await expect(storage.collection("project.release-activations").count(context))
        .resolves.toBe(3);
      await expect(storage.collection("project.runtime-instances").count(context))
        .resolves.toBeGreaterThanOrEqual(3);

      const address = engine.capability(HttpCapabilityToken).address();
      if (address === null) throw new Error("HTTP server did not bind");
      const staleClient = await fetch(
        `${address}/api/runtime/${created.project.id}/actions/calculate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ release: active2.release, input: { base: 1200 } }),
        },
      );
      expect(staleClient.status).toBe(409);
      expect(await staleClient.json()).toMatchObject({
        diagnostics: [{ code: "PROJECT_RELEASE_CHANGED" }],
      });
      const app = await fetch(`${address}/apps/runtime-performance`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain("Release 1");
      const release1 = await builds.release(context, created.project.id, 1);
      const client = await fetch(
        `${address}/runtime/artifacts/${release1!.spec.clientArtifact.hash}/client.js?projectId=${created.project.id}&revision=1`,
      );
      expect(client.headers.get("cache-control")).toContain("immutable");
      expect(await client.text()).toContain("1320");
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects incompatible ABI, manifest mismatch, and corrupt Artifacts without switching Active", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-negative-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        projectBuildPlugin(),
        projectRuntimePlugin(),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const storage = engine.capability(StorageCapabilityToken);
      const created = await projects.create(context, {
        id: "negative-runtime",
        slug: "negative-runtime",
        name: "Negative Runtime",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );
      expect((await builds.build(context, created.project.id, source.revision)).status)
        .toBe("SUCCESS");
      const release1 = (await builds.release(context, created.project.id, 1))!;

      const publishVariant = async (spec: ProjectReleaseDefinition) => {
        const draft = await storage.resources.saveDraft(context, {
          kind: ProjectReleaseResource.kind,
          id: release1.id,
          name: release1.name,
          spec,
        });
        return storage.resources.publish<ProjectReleaseDefinition>(
          context,
          ProjectReleaseResource.kind,
          release1.id,
          draft.revision,
        );
      };
      const abi = await publishVariant({ ...release1.spec, runtimeAbiVersion: "9.0.0" });
      await expect(runtime.activate(context, created.project.id, abi.revision, null))
        .rejects.toThrow("PROJECT_RUNTIME_ABI_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      const manifest = await publishVariant({
        ...release1.spec,
        actionIds: ["not-exported"],
      });
      await expect(runtime.activate(context, created.project.id, manifest.revision, null))
        .rejects.toThrow("PROJECT_RUNTIME_MANIFEST_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      const missing = await publishVariant({
        ...release1.spec,
        serverArtifact: {
          hash: "0".repeat(64),
          size: 1,
          contentType: "application/vnd.prism.server",
          fileCount: 1,
        },
      });
      await expect(runtime.activate(context, created.project.id, missing.revision, null))
        .rejects.toThrow("PROJECT_ARTIFACT_HASH_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();

      await writeFile(
        join(
          artifacts,
          "sha256",
          release1.spec.serverArtifact.hash.slice(0, 2),
          release1.spec.serverArtifact.hash,
          "server.js",
        ),
        "tampered",
      );
      await expect(runtime.activate(context, created.project.id, 1, null))
        .rejects.toThrow("PROJECT_ARTIFACT_HASH_MISMATCH");
      expect(await runtime.active(context, created.project.id)).toBeNull();
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);

  it("times out or restarts a crashed Worker without changing Active Release", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-restart-"));
    const engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        localArtifactStorePlugin({ root: artifacts }),
        codeProjectPlugin,
        projectBuildPlugin(),
        // Integration contract: exercise the real cross-process timeout boundary.
        projectRuntimePlugin({ actionTimeoutMs: 50 }),
      ],
    });
    try {
      await engine.start();
      const projects = engine.capability(CodeProjectCapabilityToken);
      const builds = engine.capability(ProjectBuildCapabilityToken);
      const runtime = engine.capability(ProjectRuntimeCapabilityToken);
      const created = await projects.create(context, {
        id: "restart-runtime",
        slug: "restart-runtime",
        name: "Restart Runtime",
      });
      const draft = await projects.saveDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
        releaseFiles(created.draft.files, "1.1"),
      );
      const source = await projects.publishDraft(context, created.project.id, draft.draftVersion);
      expect((await builds.build(context, created.project.id, source.revision)).status)
        .toBe("SUCCESS");
      const active = await runtime.activate(context, created.project.id, 1, null);
      const timeout = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "slow",
        null,
      );
      expect(timeout).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_ACTION_TIMEOUT"),
      });
      expect(await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "ping",
        null,
      )).toMatchObject({ status: "SUCCESS", result: { pong: true } });

      const crash = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "crash",
        null,
      );
      expect(crash).toMatchObject({
        status: "FAILED",
        error: expect.stringContaining("PROJECT_RUNTIME_DISCONNECTED"),
      });
      expect(await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "ping",
        null,
      )).toMatchObject({ status: "SUCCESS", result: { pong: true } });
      expect((await runtime.active(context, created.project.id))?.release).toEqual(active.release);
    } finally {
      await engine.stop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);
});
