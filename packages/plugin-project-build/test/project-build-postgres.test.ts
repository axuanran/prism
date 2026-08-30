import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { ArtifactStoreCapabilityToken } from "@prismengine/contracts-artifact";
import { ProjectBuildCapabilityToken } from "@prismengine/contracts-project";
import { createEngine, type Engine } from "@prismengine/kernel";
import { localArtifactStorePlugin } from "@prismengine/plugin-artifact-store-local";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
import { projectBuildPlugin } from "@prismengine/plugin-project-build";
import {
  createPostgresMigrationJournal,
  storagePostgresPlugin,
  type PostgresMigrationJournal,
} from "@prismengine/plugin-storage-postgres";
import { workerLocalPlugin } from "@prismengine/plugin-worker-local";
import { createScratchDatabase, probePostgres } from "@prismengine/testing";

const probe = await probePostgres();
const describePostgres = probe.url === undefined ? describe.skip : describe;
const context = systemCallContext({ correlationId: "project-build-postgres" });

describePostgres("Project Build PostgreSQL recovery", () => {
  it("restores Build, logs and immutable Release in a fresh Engine", async () => {
    if (probe.url === undefined) throw new Error("PostgreSQL unavailable");
    const scratch = await createScratchDatabase(probe.url, "project_build");
    const artifacts = await mkdtemp(join(tmpdir(), "prism-pg-artifacts-"));
    const running: Array<{ engine: Engine; journal: PostgresMigrationJournal }> = [];
    const boot = async () => {
      const journal = createPostgresMigrationJournal({ connectionString: scratch.url });
      const engine = createEngine({
        plugins: [
          storagePostgresPlugin({ connectionString: scratch.url }),
          localArtifactStorePlugin({ root: artifacts }),
          codeProjectPlugin,
          workerLocalPlugin,
          projectBuildPlugin(),
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
        id: "pg-build-project",
        slug: "pg-build-project",
        name: "PG Build Project",
      });
      const source = await projects.publishDraft(
        context,
        created.project.id,
        created.draft.draftVersion,
      );
      const builds = host.engine.capability(ProjectBuildCapabilityToken);
      const completed = await builds.build(context, created.project.id, source.revision);
      expect(completed.status).toBe("SUCCESS");
      const artifactSet = await builds.artifactSet(context, completed.id);
      if (artifactSet === null) throw new Error("Build Artifact Set was not created");
      await builds.composeRelease(
        context,
        created.project.id,
        completed.id,
        [],
        artifactSet.runtimeProfile,
      );
      await host.engine.stop();
      await host.journal.dispose();
      running.splice(running.indexOf(host), 1);

      host = await boot();
      const restored = host.engine.capability(ProjectBuildCapabilityToken);
      expect(await restored.getBuild(context, completed.id)).toEqual(completed);
      const release = await restored.release(context, created.project.id, 1);
      expect(release).toMatchObject({ status: "published", revision: 1 });
      expect(await restored.buildLog(context, completed.id)).toEqual(
        expect.arrayContaining([expect.stringContaining("Vite client build PASS")]),
      );
      await expect(
        host.engine
          .capability(ArtifactStoreCapabilityToken)
          .verify(context, release!.spec.clientArtifact),
      ).resolves.toBe(true);
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
