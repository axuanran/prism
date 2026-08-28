import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { createEngine } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
  fingerprintVisualConfiguration,
  fingerprintVisualPipeline,
} from "@prismengine/plugin-code-project";
import type {
  ProjectSourceFile,
  VisualPipelineSpec,
} from "@prismengine/contracts-project";
import {
  HttpCapabilityToken,
  createHttpPlugin,
} from "@prismengine/plugin-http-fastify";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";

const context = systemCallContext({ correlationId: "code-project-test" });

function replaceFile(
  files: readonly ProjectSourceFile[],
  path: string,
  content: string,
  mediaType = "text/typescript",
): readonly ProjectSourceFile[] {
  return [
    ...files.filter((file) => file.path !== path),
    { path, content, mediaType },
  ];
}

function percentileFiles(
  files: readonly ProjectSourceFile[],
  coefficient: "1.1" | "1.2",
): readonly ProjectSourceFile[] {
  const source = `export default function adjust(value: number): number { return value * ${coefficient}; }\n`;
  const manifest = JSON.stringify({
    schemaVersion: "1.0.0",
    materials: [{
      id: "statistics.percentile",
      version: coefficient === "1.1" ? "1.0.0" : "2.0.0",
      kind: "operator",
      authoringMode: "CODE",
      displayName: "百分位",
      category: "统计",
      runtimeTarget: "pipeline",
      entry: "src/materials/percentile.ts",
      exportName: "default",
    }],
  }, null, 2);
  return replaceFile(
    replaceFile(files, "src/materials/percentile.ts", source),
    "prism.materials.json",
    manifest,
    "application/json",
  );
}

describe("Code Project Source lifecycle", () => {
  it("CAS-saves Draft, discovers declared Materials, and publishes immutable trees", async () => {
    const engine = createEngine({
      plugins: [storageMemoryPlugin, codeProjectPlugin],
    });
    await engine.start();
    const projects = engine.capability(CodeProjectCapabilityToken);
    const created = await projects.create(context, {
      id: "hospital-performance",
      slug: "hospital-performance",
      name: "医院绩效示例",
    });
    expect(created.project).toMatchObject({ status: "published", revision: 1 });
    expect(created.draft).toMatchObject({ draftVersion: 1, baseSourceRevision: null });
    expect(created.draft.files.map((file) => file.path)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "prism.materials.json",
      "prism.project.json",
      "src/client/index.tsx",
      "src/server/index.ts",
      "tests/project.test.ts",
    ]);

    const saved1 = await projects.saveDraft(
      context,
      created.project.id,
      1,
      percentileFiles(created.draft.files, "1.1"),
    );
    expect(saved1.draftVersion).toBe(2);
    await expect(projects.saveDraft(
      context,
      created.project.id,
      1,
      saved1.files,
    )).rejects.toThrow("PROJECT_SOURCE_DRAFT_CONFLICT");
    expect(await projects.draftMaterials(context, created.project.id)).toMatchObject([{
      status: "DECLARED",
      buildStatus: "NOT_BUILT",
      manifest: { id: "statistics.percentile", version: "1.0.0" },
    }]);

    const published1 = await projects.publishDraft(context, created.project.id, 2);
    expect(published1).toMatchObject({ revision: 1, status: "published" });
    expect(published1.spec.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const draftAfterPublish = await projects.draft(context, created.project.id);
    expect(draftAfterPublish).toMatchObject({ draftVersion: 3, baseSourceRevision: 1 });

    const saved2 = await projects.saveDraft(
      context,
      created.project.id,
      3,
      percentileFiles(draftAfterPublish.files, "1.2"),
    );
    expect(await projects.diff(context, created.project.id, 1, "draft")).toMatchObject({
      changed: expect.arrayContaining([
        "prism.materials.json",
        "src/materials/percentile.ts",
      ]),
      materialChanges: {
        added: ["statistics.percentile@2.0.0"],
        removed: ["statistics.percentile@1.0.0"],
        changed: [],
      },
    });
    const published2 = await projects.publishDraft(
      context,
      created.project.id,
      saved2.draftVersion,
    );
    expect(published2.spec.fingerprint).not.toBe(published1.spec.fingerprint);
    expect((await projects.source(context, created.project.id, 1))?.spec).toEqual(
      published1.spec,
    );
    expect((await projects.sourceRevisions(context, created.project.id)).map((item) => [
      item.revision,
      item.status,
    ])).toEqual([[1, "published"], [2, "published"]]);
    await engine.stop();
  });

  it("rejects invalid/case-conflicting paths and missing Material entries", async () => {
    const engine = createEngine({ plugins: [storageMemoryPlugin, codeProjectPlugin] });
    await engine.start();
    const projects = engine.capability(CodeProjectCapabilityToken);
    const created = await projects.create(context, {
      id: "invalid-project",
      slug: "invalid-project",
      name: "Invalid Project",
    });
    await expect(projects.saveDraft(context, created.project.id, 1, [
      ...created.draft.files,
      { path: "../escape.ts", mediaType: "text/typescript", content: "" },
    ])).rejects.toThrow("PROJECT_SOURCE_PATH_INVALID");
    await expect(projects.saveDraft(context, created.project.id, 1, [
      ...created.draft.files,
      { path: "src/App.tsx", mediaType: "text/typescript-jsx", content: "" },
      { path: "src/app.tsx", mediaType: "text/typescript-jsx", content: "" },
    ])).rejects.toThrow("PROJECT_SOURCE_PATH_CONFLICT");
    const missingEntry = replaceFile(
      created.draft.files,
      "prism.materials.json",
      JSON.stringify({
        schemaVersion: "1.0.0",
        materials: [{
          id: "missing.entry",
          version: "1.0.0",
          kind: "operator",
          authoringMode: "CODE",
          displayName: "Missing",
          category: "Test",
          runtimeTarget: "pipeline",
          entry: "src/materials/missing.ts",
          exportName: "default",
        }],
      }),
      "application/json",
    );
    const saved = await projects.saveDraft(context, created.project.id, 1, missingEntry);
    await expect(projects.publishDraft(context, created.project.id, saved.draftVersion))
      .rejects.toThrow("PROJECT_MATERIAL_ENTRY_NOT_FOUND");
    await engine.stop();
  });

  it("requires BUILDER for HTTP mutations and accepts the role header", async () => {
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({ port: 0, inspection: () => engine.inspect() });
    engine = createEngine({
      plugins: [storageMemoryPlugin, codeProjectPlugin, http],
    });
    await engine.start();
    const address = engine.capability(HttpCapabilityToken).address();
    if (address === null) throw new Error("HTTP server did not bind");
    const payload = JSON.stringify({ slug: "browser-project", name: "Browser Project" });
    const rejected = await fetch(`${address}/api/code-projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      diagnostics: [{ code: "PROJECT_BUILDER_REQUIRED" }],
    });
    const accepted = await fetch(`${address}/api/code-projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-principal-id": "builder-1",
        "x-principal-roles": "BUILDER,USER",
      },
      body: payload,
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      project: { status: "published", spec: { slug: "browser-project" } },
      draft: { draftVersion: 1, baseSourceRevision: null },
    });
    await engine.stop();
  });

  it("separates configuration identity from full Visual Pipeline identity", () => {
    const pipeline: VisualPipelineSpec = {
      schemaVersion: "1.0.0",
      code: "coefficient",
      name: "Coefficient",
      inputs: [],
      nodes: [],
      outputs: [],
    };
    const renamed = { ...pipeline, name: "Renamed display label" };
    expect(fingerprintVisualConfiguration(renamed))
      .toBe(fingerprintVisualConfiguration(pipeline));
    expect(fingerprintVisualPipeline(renamed)).toBe(fingerprintVisualPipeline(pipeline));
    expect(fingerprintVisualPipeline({ ...pipeline, code: "other" }))
      .not.toBe(fingerprintVisualPipeline(pipeline));
  });
});
