import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import {
  ProjectBuildCapabilityToken,
  ProjectRuntimeCapabilityToken,
} from "@prismengine/contracts-project";
import { createEngine, type Engine } from "@prismengine/kernel";
import { localArtifactStorePlugin } from "@prismengine/plugin-artifact-store-local";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import { projectBuildPlugin } from "@prismengine/plugin-project-build";
import { projectRuntimePlugin } from "@prismengine/plugin-project-runtime";
import {
  createPostgresMigrationJournal,
  storagePostgresPlugin,
  type PostgresMigrationJournal,
} from "@prismengine/plugin-storage-postgres";
import {
  createScratchDatabase,
  probePostgres,
} from "@prismengine/testing";

const probe = await probePostgres();
const describePostgres = probe.url === undefined ? describe.skip : describe;
const context = systemCallContext({ correlationId: "project-runtime-postgres" });

describePostgres("Project Runtime PostgreSQL recovery", () => {
  it("restores Active Release and Runs, then lazily restarts its Worker", async () => {
    if (probe.url === undefined) throw new Error("PostgreSQL unavailable");
    const scratch = await createScratchDatabase(probe.url, "project_runtime");
    const artifacts = await mkdtemp(join(tmpdir(), "prism-runtime-pg-"));
    const running: Array<{ engine: Engine; journal: PostgresMigrationJournal }> = [];
    const boot = async () => {
      const journal = createPostgresMigrationJournal({ connectionString: scratch.url });
      const engine = createEngine({
        plugins: [
          storagePostgresPlugin({ connectionString: scratch.url }),
          localArtifactStorePlugin({ root: artifacts }),
          codeProjectPlugin,
          projectBuildPlugin(),
          projectRuntimePlugin(),
        ],
        migrationJournal: journal,
      });
      await engine.start();
      const value = { engine, journal };
      running.push(value);
      return value;
    };
    try {
      let host = await boot();
      const projects = host.engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "runtime-pg",
        slug: "runtime-pg",
        name: "Runtime PG",
      });
      const files = created.draft.files.map((file) => file.path === "src/server/index.ts"
        ? {
            ...file,
            content: "export const actions = { ping: async () => ({ pong: true }) };\n",
          }
        : file);
      const draft = await projects.saveDraft(context, created.project.id, 1, files);
      const source = await projects.publishDraft(context, created.project.id, draft.draftVersion);
      const builds = host.engine.capability(ProjectBuildCapabilityToken);
      expect((await builds.build(context, created.project.id, source.revision)).status).toBe("SUCCESS");
      const runtime = host.engine.capability(ProjectRuntimeCapabilityToken);
      const active = await runtime.activate(context, created.project.id, 1, null);
      const first = await runtime.invoke(
        context,
        created.project.id,
        active.release,
        "ping",
        null,
      );
      expect(first).toMatchObject({ status: "SUCCESS", result: { pong: true } });
      await host.engine.stop();
      await host.journal.dispose();
      running.splice(running.indexOf(host), 1);

      host = await boot();
      const restored = host.engine.capability(ProjectRuntimeCapabilityToken);
      expect(await restored.active(context, created.project.id)).toEqual(active);
      expect(await restored.getRun(context, first.id)).toEqual(first);
      const second = await restored.invoke(
        context,
        created.project.id,
        active.release,
        "ping",
        null,
      );
      expect(second).toMatchObject({ status: "SUCCESS", release: active.release, result: { pong: true } });
    } finally {
      for (const host of running) {
        await host.engine.stop();
        await host.journal.dispose();
      }
      await scratch.drop();
      await rm(artifacts, { recursive: true, force: true });
    }
  }, 120_000);
});
