import {
  DataDiagnosticCode,
  PrismError,
  assertJsonValue,
  systemCallContext,
} from "@prism/contracts-data";
import type { StorageCapability } from "@prism/contracts-storage";
import { StorageDiagnosticCode } from "@prism/contracts-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface StorageContractFixture {
  readonly storage: StorageCapability;
  dispose(): Promise<void>;
}

interface TestDocument {
  readonly id: string;
  readonly team: string;
  readonly score: number;
  readonly active: boolean;
  readonly note?: string;
}

const context = systemCallContext({ correlationId: "storage-contract" });

function diagnostic(error: unknown): {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  expect(error).toBeInstanceOf(PrismError);
  const [first] = (error as PrismError).diagnostics;
  expect(first).toBeDefined();
  return first!;
}

/** Registers identical Storage expectations for every provider. */
export function describeStorageContract(
  name: string,
  factory: () => Promise<StorageContractFixture>,
): void {
  describe(`${name} storage contract`, () => {
    let fixture: StorageContractFixture;

    beforeEach(async () => {
      fixture = await factory();
    });

    afterEach(async () => {
      if (fixture !== undefined) await fixture.dispose();
    });

    it("implements draft PUT, publish, edit, and immutable ordered history", async () => {
      const { resources } = fixture.storage;
      const draft = await resources.saveDraft(context, {
        kind: "contract.scheme",
        id: "chosen-id",
        name: "Initial scheme",
        spec: { rate: "0.10", nested: { enabled: true } },
      });

      expect(draft).toMatchObject({
        id: "chosen-id",
        kind: "contract.scheme",
        revision: 1,
        status: "draft",
      });
      expect(Date.parse(draft.createdAt)).not.toBeNaN();
      expect(draft.updatedAt).toBe(draft.createdAt);

      const replaced = await resources.saveDraft(context, {
        kind: "contract.scheme",
        id: "chosen-id",
        name: "Replaced draft",
        spec: { rate: "0.20" },
      });
      expect(replaced).toMatchObject({
        revision: 1,
        status: "draft",
        spec: { rate: "0.20" },
      });
      expect(replaced.createdAt).toBe(draft.createdAt);
      expect(Date.parse(replaced.updatedAt)).toBeGreaterThan(Date.parse(draft.updatedAt));

      const published = await resources.publish(
        context,
        "contract.scheme",
        "chosen-id",
        1,
      );
      expect(published).toMatchObject({ revision: 1, status: "published" });

      const edited = await resources.saveDraft(context, {
        kind: "contract.scheme",
        id: "chosen-id",
        name: "Next revision",
        spec: { rate: "0.30" },
      });
      expect(edited).toMatchObject({
        revision: 2,
        status: "draft",
        spec: { rate: "0.30" },
      });
      expect(edited.createdAt).not.toBe(published.createdAt);

      expect(await resources.getPublished(context, "contract.scheme", "chosen-id")).toEqual(
        published,
      );
      expect(await resources.get(context, "contract.scheme", "chosen-id")).toEqual(edited);
      expect(await resources.get(context, "contract.scheme", "chosen-id", 1)).toEqual(
        published,
      );
      expect(await resources.listRevisions(context, "contract.scheme", "chosen-id")).toEqual([
        published,
        edited,
      ]);

      let error: unknown;
      try {
        await resources.publish(context, "contract.scheme", "chosen-id", 1);
      } catch (caught) {
        error = caught;
      }
      expect(diagnostic(error).code).toBe(StorageDiagnosticCode.RESOURCE_PUBLISHED_IMMUTABLE);
      expect(await resources.get(context, "contract.scheme", "chosen-id", 1)).toEqual(
        published,
      );
    });

    it("clones revisions and archives every revision without thawing content", async () => {
      const { resources } = fixture.storage;
      const draft = await resources.saveDraft(context, {
        kind: "contract.plan",
        id: "archive-me",
        name: "Plan",
        spec: { amount: "123.45" },
      });
      const published = await resources.publish(
        context,
        draft.kind,
        draft.id,
        draft.revision,
      );
      const clone = await resources.clone(context, draft.kind, draft.id, published.revision);
      expect(clone).toMatchObject({
        revision: 2,
        status: "draft",
        spec: published.spec,
      });

      await resources.archive(context, draft.kind, draft.id);
      const archived = await resources.listRevisions(context, draft.kind, draft.id);
      expect(archived.map((item) => [item.revision, item.status])).toEqual([
        [1, "archived"],
        [2, "archived"],
      ]);
      expect(archived[0]?.spec).toEqual(published.spec);
      expect(await resources.getPublished(context, draft.kind, draft.id)).toBeNull();

      let editError: unknown;
      try {
        await resources.saveDraft(context, {
          kind: draft.kind,
          id: draft.id,
          name: "Illegal edit",
          spec: { amount: "0" },
        });
      } catch (caught) {
        editError = caught;
      }
      expect(diagnostic(editError).code).toBe(
        StorageDiagnosticCode.RESOURCE_VALIDATION_FAILED,
      );

      let publishError: unknown;
      try {
        await resources.publish(context, draft.kind, draft.id, 1);
      } catch (caught) {
        publishError = caught;
      }
      expect(diagnostic(publishError).code).toBe(
        StorageDiagnosticCode.RESOURCE_PUBLISHED_IMMUTABLE,
      );

      const revived = await resources.clone(context, draft.kind, draft.id, 1);
      expect(revived).toMatchObject({
        revision: 3,
        status: "draft",
        name: published.name,
        spec: published.spec,
      });
      expect(await resources.get(context, draft.kind, draft.id, 1)).toEqual(archived[0]);
    });

    it("returns null for reads and structured diagnostics for invalid mutations", async () => {
      const { resources } = fixture.storage;
      expect(await resources.get(context, "contract.missing", "none")).toBeNull();
      expect(
        await resources.getPublished(context, "contract.missing", "none"),
      ).toBeNull();
      expect(
        await resources.listRevisions(context, "contract.missing", "none"),
      ).toEqual([]);

      let missingError: unknown;
      try {
        await resources.clone(context, "contract.missing", "none");
      } catch (caught) {
        missingError = caught;
      }
      expect(diagnostic(missingError).code).toBe(
        StorageDiagnosticCode.RESOURCE_NOT_FOUND,
      );

      await resources.saveDraft(context, {
        kind: "contract.revision",
        id: "known",
        name: "Known",
        spec: {},
      });
      let revisionError: unknown;
      try {
        await resources.publish(context, "contract.revision", "known", 99);
      } catch (caught) {
        revisionError = caught;
      }
      expect(diagnostic(revisionError).code).toBe(
        StorageDiagnosticCode.RESOURCE_REVISION_NOT_FOUND,
      );
    });

    it("lists current resources with kind, status, and name filters", async () => {
      const { resources } = fixture.storage;
      await resources.saveDraft(context, {
        kind: "contract.alpha",
        id: "alpha-draft",
        name: "North draft",
        spec: {},
      });
      const publishedDraft = await resources.saveDraft(context, {
        kind: "contract.alpha",
        id: "alpha-published",
        name: "North published",
        spec: {},
      });
      await resources.publish(
        context,
        publishedDraft.kind,
        publishedDraft.id,
        publishedDraft.revision,
      );
      await resources.saveDraft(context, {
        kind: "contract.beta",
        id: "beta-draft",
        name: "South draft",
        spec: {},
      });

      const alphaIds = (await resources.list(context, { kind: "contract.alpha" })).map(
        (item) => item.id,
      );
      expect(alphaIds).toEqual(expect.arrayContaining(["alpha-draft", "alpha-published"]));
      expect(alphaIds).toHaveLength(2);
      expect(
        (await resources.list(context, { status: "published" })).map((item) => item.id),
      ).toEqual(["alpha-published"]);
      expect(
        (await resources.list(context, { nameContains: "South" })).map((item) => item.id),
      ).toEqual(["beta-draft"]);
    });

    it("isolates collections and implements query, paging, count, and delete", async () => {
      const people = fixture.storage.collection<TestDocument>("contract.people");
      const other = fixture.storage.collection<TestDocument>("contract.other");
      const documents: readonly TestDocument[] = [
        { id: "a", team: "red", score: 10, active: true, note: "first" },
        { id: "b", team: "blue", score: 30, active: true },
        { id: "c", team: "red", score: 30, active: false },
        { id: "d", team: "red", score: 20, active: true },
      ];

      expect(await people.put(context, documents[0]!)).toEqual(documents[0]);
      await people.putMany(context, documents.slice(1));
      await other.put(context, { ...documents[0]!, score: 999 });

      expect(await people.get(context, "a")).toEqual(documents[0]);
      expect(await people.get(context, "missing")).toBeNull();
      expect(await people.getMany(context, ["c", "missing", "a"])).toEqual([
        documents[2],
        documents[0],
      ]);
      expect(await other.get(context, "a")).toMatchObject({ score: 999 });

      await people.put(context, { ...documents[0]!, score: 40 });
      expect(await people.get(context, "a")).toMatchObject({ score: 40 });
      expect(
        await people.find(context, {
          where: { team: "red" },
          orderBy: [
            { field: "score", direction: "desc" },
            { field: "id", direction: "asc" },
          ],
          offset: 1,
          limit: 2,
        }),
      ).toEqual([documents[2], documents[3]]);
      expect(
        await people.count(context, { where: { team: "red" }, offset: 99, limit: 0 }),
      ).toBe(3);

      await people.delete(context, "c");
      expect(await people.get(context, "c")).toBeNull();
      expect(await people.count(context)).toBe(3);
    });

    it("rejects non-JSON documents before a single batch item is written", async () => {
      const documents = fixture.storage.collection<TestDocument>("contract.invalid-docs");
      const invalid = {
        id: "invalid",
        team: "red",
        score: 1,
        active: true,
        bad: new Date("2026-01-01T00:00:00.000Z"),
      };

      let putError: unknown;
      try {
        await documents.put(context, invalid);
      } catch (caught) {
        putError = caught;
      }
      expect(diagnostic(putError)).toMatchObject({
        code: DataDiagnosticCode.NOT_JSON_STORABLE,
        details: { path: "/document/bad" },
      });

      let batchError: unknown;
      try {
        await documents.putMany(context, [
          { id: "valid", team: "blue", score: 2, active: true },
          invalid,
        ]);
      } catch (caught) {
        batchError = caught;
      }
      expect(diagnostic(batchError)).toMatchObject({
        code: DataDiagnosticCode.NOT_JSON_STORABLE,
        details: { path: "/documents/1/bad" },
      });
      expect(await documents.count(context)).toBe(0);
    });

    it("rejects non-JSON specs with the shared diagnostic and offending path", async () => {
      const spec = { nested: { bad: new Date("2026-01-01T00:00:00.000Z") } };
      let boundaryError: unknown;
      try {
        assertJsonValue(spec, "/spec");
      } catch (caught) {
        boundaryError = caught;
      }
      const expected = diagnostic(boundaryError);
      expect(expected.code).toBe(DataDiagnosticCode.NOT_JSON_STORABLE);

      let providerError: unknown;
      try {
        await fixture.storage.resources.saveDraft(context, {
          kind: "contract.invalid",
          id: "invalid",
          name: "Invalid",
          spec,
        });
      } catch (caught) {
        providerError = caught;
      }
      const actual = diagnostic(providerError);
      expect(actual.code).toBe(expected.code);
      expect(actual.details?.path).toBe("/spec/nested/bad");
    });
  });
}
