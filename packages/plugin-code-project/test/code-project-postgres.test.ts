import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { createEngine, type Engine } from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  codeProjectPlugin,
} from "@prismengine/plugin-code-project";
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
const context = systemCallContext({ correlationId: "code-project-postgres" });

describePostgres("Code Project PostgreSQL recovery", () => {
  it("restores Draft CAS state and immutable Source revisions in fresh Engines", async () => {
    if (probe.url === undefined) throw new Error("PostgreSQL unavailable");
    const scratch = await createScratchDatabase(probe.url, "code_project");
    const running: Array<{ engine: Engine; journal: PostgresMigrationJournal }> = [];
    const boot = async () => {
      const journal = createPostgresMigrationJournal({ connectionString: scratch.url });
      const engine = createEngine({
        plugins: [storagePostgresPlugin({ connectionString: scratch.url }), codeProjectPlugin],
        migrationJournal: journal,
      });
      await engine.start();
      const value = { engine, journal };
      running.push(value);
      return value;
    };
    try {
      let host = await boot();
      let projects = host.engine.capability(CodeProjectCapabilityToken);
      const created = await projects.create(context, {
        id: "persistent-project",
        slug: "persistent-project",
        name: "Persistent Project",
      });
      const firstEdit = await projects.saveDraft(context, created.project.id, 1, [
        ...created.draft.files,
        {
          path: "src/shared/value.ts",
          mediaType: "text/typescript",
          content: "export const value = 1.1;\r\n",
        },
      ]);
      await host.engine.stop();
      await host.journal.dispose();
      running.splice(running.indexOf(host), 1);

      host = await boot();
      projects = host.engine.capability(CodeProjectCapabilityToken);
      const restoredDraft = await projects.draft(context, created.project.id);
      expect(restoredDraft.draftVersion).toBe(firstEdit.draftVersion);
      expect(restoredDraft.files.find((file) => file.path === "src/shared/value.ts")?.content)
        .toBe("export const value = 1.1;\n");
      const source1 = await projects.publishDraft(
        context,
        created.project.id,
        restoredDraft.draftVersion,
      );
      const afterFirst = await projects.draft(context, created.project.id);
      const secondEdit = await projects.saveDraft(context, created.project.id, afterFirst.draftVersion, [
        ...afterFirst.files.filter((file) => file.path !== "src/shared/value.ts"),
        {
          path: "src/shared/value.ts",
          mediaType: "text/typescript",
          content: "export const value = 1.2;\n",
        },
      ]);
      const source2 = await projects.publishDraft(
        context,
        created.project.id,
        secondEdit.draftVersion,
      );
      expect(source2.spec.fingerprint).not.toBe(source1.spec.fingerprint);

      await host.engine.stop();
      await host.journal.dispose();
      running.splice(running.indexOf(host), 1);
      host = await boot();
      projects = host.engine.capability(CodeProjectCapabilityToken);
      const revisions = await projects.sourceRevisions(context, created.project.id);
      expect(revisions.map((revision) => [revision.revision, revision.status])).toEqual([
        [1, "published"],
        [2, "published"],
      ]);
      expect(revisions[0]?.spec.fingerprint).toBe(source1.spec.fingerprint);
      expect(revisions[1]?.spec.fingerprint).toBe(source2.spec.fingerprint);
    } finally {
      for (const host of running) {
        await host.engine.stop();
        await host.journal.dispose();
      }
      await scratch.drop();
    }
  });
});
