import {
  DataDiagnosticCode,
  PrismError,
  assertJsonValue,
  systemCallContext,
} from "@prismengine/contracts-data";
import {
  STORAGE_ENTITY_ID_MAX_LENGTH,
  STORAGE_AUDIT_QUERY_LIMIT_MAX,
  STORAGE_ATOMIC_OPERATIONS_MAX,
  STORAGE_DOCUMENT_BATCH_MAX,
  STORAGE_QUERY_LIMIT_MAX,
  STORAGE_QUERY_ORDER_TERMS_MAX,
  STORAGE_QUERY_WHERE_FIELDS_MAX,
  STORAGE_QUERY_STRING_MAX_BYTES,
  StorageDiagnosticCode,
  type AtomicWriteCapability,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface StorageContractFixture {
  readonly storage: StorageCapability;
  readonly atomicWrite: AtomicWriteCapability;
  injectAtomicFailure?(
    point: "after-operation" | "before-commit" | "after-commit",
    operationIndex?: number,
  ): void;
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

      const published = await resources.publish(context, "contract.scheme", "chosen-id", 1);
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
      expect(
        await resources.listRevisions(context, "contract.scheme", "chosen-id"),
      ).toEqual([published, edited]);

      let error: unknown;
      try {
        await resources.publish(context, "contract.scheme", "chosen-id", 1);
      } catch (caught) {
        error = caught;
      }
      expect(diagnostic(error).code).toBe(
        StorageDiagnosticCode.RESOURCE_PUBLISHED_IMMUTABLE,
      );
      expect(await resources.get(context, "contract.scheme", "chosen-id", 1)).toEqual(
        published,
      );
    });
    it("atomically rejects stale draft saves and publishes", async () => {
      const { resources } = fixture.storage;
      const draft = await resources.saveDraft(context, {
        kind: "contract.concurrent",
        id: "shared",
        name: "Concurrent",
        spec: { value: 1 },
        expectedUpdatedAt: null,
      });
      const replaced = await resources.saveDraft(context, {
        kind: draft.kind,
        id: draft.id,
        name: draft.name,
        spec: { value: 2 },
        expectedUpdatedAt: draft.updatedAt,
      });

      let saveError: unknown;
      try {
        await resources.saveDraft(context, {
          kind: draft.kind,
          id: draft.id,
          name: draft.name,
          spec: { value: 3 },
          expectedUpdatedAt: draft.updatedAt,
        });
      } catch (caught) {
        saveError = caught;
      }
      expect(diagnostic(saveError).code).toBe(StorageDiagnosticCode.RESOURCE_CONFLICT);

      let publishError: unknown;
      try {
        await resources.publish(
          context,
          replaced.kind,
          replaced.id,
          replaced.revision,
          draft.updatedAt,
        );
      } catch (caught) {
        publishError = caught;
      }
      expect(diagnostic(publishError).code).toBe(StorageDiagnosticCode.RESOURCE_CONFLICT);
      await expect(
        resources.publish(
          context,
          replaced.kind,
          replaced.id,
          replaced.revision,
          replaced.updatedAt,
        ),
      ).resolves.toMatchObject({ status: "published" });
    });

    it("writes a hash-chained audit record with actor, reason, and fingerprints", async () => {
      const contextWithReason = {
        ...context,
        changeReason: "contract audit verification",
        approvalId: "approval-contract",
      };
      await fixture.storage.resources.saveDraft(contextWithReason, {
        kind: "contract.audited",
        id: "audited",
        name: "Audited",
        spec: { secretLikeValue: "not-recorded-in-journal" },
        expectedUpdatedAt: null,
      });
      const records = await fixture.storage.audit.list(context, {
        targetKind: "contract.audited",
        targetId: "audited",
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        sequence: 1,
        principalId: context.principal.id,
        action: "resource.draft.save",
        targetKind: "contract.audited",
        targetId: "audited",
        beforeFingerprint: null,
        afterFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: "contract audit verification",
        correlationId: context.correlationId,
        approvalId: "approval-contract",
        previousHash: null,
        entryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(records)).not.toContain("not-recorded-in-journal");
      await expect(fixture.storage.audit.verify(context)).resolves.toEqual({
        valid: true,
        checked: 1,
      });
    });
    it("attributes every AtomicWrite operation to its document target", async () => {
      await fixture.atomicWrite.execute(context, {
        requestId: "audit-target-write",
        preconditions: [
          {
            kind: "document-absent",
            collection: "contract.audit-documents",
            id: "target",
          },
        ],
        operations: [
          {
            kind: "put-document",
            collection: "contract.audit-documents",
            document: { id: "target", value: "fingerprinted-only" },
            mode: "create",
          },
        ],
      });
      const records = await fixture.storage.audit.list(context, {
        targetKind: "contract.audit-documents",
        targetId: "target",
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        action: "document.put",
        targetKind: "contract.audit-documents",
        targetId: "target",
        beforeFingerprint: null,
        afterFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(records)).not.toContain("fingerprinted-only");
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
      const clone = await resources.clone(
        context,
        draft.kind,
        draft.id,
        published.revision,
      );
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
      expect(await resources.getPublished(context, "contract.missing", "none")).toBeNull();
      expect(await resources.listRevisions(context, "contract.missing", "none")).toEqual(
        [],
      );

      let missingError: unknown;
      try {
        await resources.clone(context, "contract.missing", "none");
      } catch (caught) {
        missingError = caught;
      }
      expect(diagnostic(missingError).code).toBe(StorageDiagnosticCode.RESOURCE_NOT_FOUND);

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

    it("rejects malformed identifiers before query, mutation, or audit", async () => {
      const auditBefore = await fixture.storage.audit.list(context);
      await expect(
        fixture.storage.resources.saveDraft(context, {
          kind: "invalid kind",
          id: "resource-id",
          name: "Invalid",
          spec: {},
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });
      await expect(
        fixture.storage.resources.saveDraft(context, {
          kind: "contract.valid",
          id: "resource-id",
          name: "Invalid\nName",
          spec: {},
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });
      await expect(
        fixture.storage.resources.get(context, "contract.valid", "bad\u0001id"),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });
      expect(() => fixture.storage.collection("invalid collection")).toThrow(
        StorageDiagnosticCode.IDENTIFIER_INVALID,
      );

      const documents = fixture.storage.collection<TestDocument>("contract.identifiers");
      await expect(
        documents.put(context, {
          id: "x".repeat(STORAGE_ENTITY_ID_MAX_LENGTH + 1),
          team: "red",
          score: 1,
          active: true,
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });
      await expect(
        fixture.atomicWrite.execute(context, {
          requestId: "invalid request",
          preconditions: [],
          operations: [
            {
              kind: "put-document",
              collection: "contract.identifiers",
              document: {
                id: "atomic-invalid",
                team: "red",
                score: 1,
                active: true,
              },
              mode: "create",
            },
          ],
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });

      await expect(documents.count(context)).resolves.toBe(0);
      await expect(
        fixture.storage.resources.list(context, { kind: "invalid kind" }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.IDENTIFIER_INVALID }],
      });
      expect(await fixture.storage.audit.list(context)).toEqual(auditBefore);
    });

    it("rejects invalid audit attribution before every mutation boundary", async () => {
      const auditBefore = await fixture.storage.audit.list(context);
      const resources = fixture.storage.resources;
      const documents = fixture.storage.collection<TestDocument>("contract.audit-context");
      const invalidPrincipal = {
        ...context,
        principal: { ...context.principal, id: "p".repeat(129) },
      };
      const invalidCorrelation = {
        ...context,
        correlationId: "invalid correlation",
      };
      const invalidReason = {
        ...context,
        changeReason: "r".repeat(501),
      };
      const invalidApproval = {
        ...context,
        approvalId: "invalid approval",
      };

      await expect(
        resources.saveDraft(invalidPrincipal, {
          kind: "contract.audit-context",
          id: "resource",
          name: "Resource",
          spec: {},
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.AUDIT_CONTEXT_INVALID }],
      });
      await expect(
        documents.put(invalidCorrelation, {
          id: "document",
          team: "red",
          score: 1,
          active: true,
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.AUDIT_CONTEXT_INVALID }],
      });
      await expect(
        fixture.atomicWrite.execute(invalidReason, {
          requestId: "invalid-audit-context",
          preconditions: [],
          operations: [
            {
              kind: "put-document",
              collection: "contract.audit-context",
              document: {
                id: "atomic",
                team: "blue",
                score: 2,
                active: true,
              },
              mode: "create",
            },
          ],
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.AUDIT_CONTEXT_INVALID }],
      });
      await expect(
        documents.putMany(invalidApproval, [
          {
            id: "batch",
            team: "blue",
            score: 3,
            active: true,
          },
        ]),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.AUDIT_CONTEXT_INVALID }],
      });

      await expect(documents.count(context)).resolves.toBe(0);
      await expect(
        resources.list(context, { kind: "contract.audit-context" }),
      ).resolves.toEqual([]);
      await expect(documents.get(invalidCorrelation, "missing")).resolves.toBeNull();
      await expect(
        resources.list(invalidPrincipal, { kind: "contract.audit-context" }),
      ).resolves.toEqual([]);
      expect(await fixture.storage.audit.list(context)).toEqual(auditBefore);
    });

    it("validates AuditJournal queries before provider work", async () => {
      const resources = fixture.storage.resources;
      await resources.saveDraft(context, {
        kind: "contract.audit-query",
        id: "one",
        name: "One",
        spec: {},
      });
      await resources.saveDraft(context, {
        kind: "contract.audit-query",
        id: "two",
        name: "Two",
        spec: {},
      });
      const verificationBefore = await fixture.storage.audit.verify(context);
      const invalidQueries = [
        { afterSequence: -1 },
        { afterSequence: Number.NaN },
        { limit: 0 },
        { limit: STORAGE_AUDIT_QUERY_LIMIT_MAX + 1 },
        { targetKind: "invalid kind" },
        { targetId: "invalid\u0001id" },
        { targetId: "x".repeat(STORAGE_ENTITY_ID_MAX_LENGTH + 1) },
      ];
      for (const query of invalidQueries) {
        await expect(fixture.storage.audit.list(context, query)).rejects.toMatchObject({
          diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
        });
      }

      await expect(
        fixture.storage.audit.list(context, {
          afterSequence: 0,
          limit: STORAGE_AUDIT_QUERY_LIMIT_MAX,
          targetKind: "contract.audit-query",
          targetId: "one",
        }),
      ).resolves.toHaveLength(1);
      await expect(fixture.storage.audit.list(context)).resolves.toHaveLength(2);
      await expect(fixture.storage.audit.verify(context)).resolves.toEqual(
        verificationBefore,
      );
    });

    it("bounds document queries, batches, and AtomicWrite cardinality", async () => {
      const auditBefore = await fixture.storage.audit.list(context);
      const documents = fixture.storage.collection<TestDocument>("contract.query-limits");

      await expect(
        documents.getMany(
          context,
          Array.from(
            { length: STORAGE_DOCUMENT_BATCH_MAX + 1 },
            (_, index) => `missing-${index}`,
          ),
        ),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
      });
      await expect(
        documents.putMany(
          context,
          Array.from({ length: STORAGE_DOCUMENT_BATCH_MAX + 1 }, (_, index) => ({
            id: `document-${index}`,
            team: "red",
            score: index,
            active: true,
          })),
        ),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
      });
      await expect(
        documents.find(context, {
          where: Object.fromEntries(
            Array.from({ length: STORAGE_QUERY_WHERE_FIELDS_MAX + 1 }, (_, index) => [
              `field-${index}`,
              index,
            ]),
          ),
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
      });
      await expect(
        documents.find(context, {
          orderBy: Array.from(
            { length: STORAGE_QUERY_ORDER_TERMS_MAX + 1 },
            (_, index) => ({ field: `field-${index}`, direction: "asc" as const }),
          ),
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
      });
      for (const query of [
        { limit: STORAGE_QUERY_LIMIT_MAX + 1 },
        { limit: Number.NaN },
        { offset: -1 },
        { where: { "bad\nfield": true } },
      ]) {
        await expect(documents.find(context, query)).rejects.toMatchObject({
          diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
        });
      }

      await expect(
        fixture.atomicWrite.execute(context, {
          requestId: "atomic-cardinality",
          preconditions: [],
          operations: Array.from(
            { length: STORAGE_ATOMIC_OPERATIONS_MAX + 1 },
            (_, index) => ({
              kind: "put-document" as const,
              collection: "contract.query-limits",
              document: {
                id: `atomic-${index}`,
                team: "blue",
                score: index,
                active: true,
              },
              mode: "create" as const,
            }),
          ),
        }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: StorageDiagnosticCode.ATOMIC_WRITE_INVALID }],
      });

      await expect(
        documents.getMany(
          context,
          Array.from({ length: STORAGE_DOCUMENT_BATCH_MAX }, (_, index) => `id-${index}`),
        ),
      ).resolves.toEqual([]);
      await expect(
        documents.find(context, {
          where: Object.fromEntries(
            Array.from({ length: STORAGE_QUERY_WHERE_FIELDS_MAX }, (_, index) => [
              `field-${index}`,
              index,
            ]),
          ),
          orderBy: Array.from({ length: STORAGE_QUERY_ORDER_TERMS_MAX }, (_, index) => ({
            field: `field-${index}`,
            direction: "asc" as const,
          })),
          limit: STORAGE_QUERY_LIMIT_MAX,
          offset: 0,
        }),
      ).resolves.toEqual([]);
      await expect(documents.count(context)).resolves.toBe(0);
      expect(await fixture.storage.audit.list(context)).toEqual(auditBefore);
    });

    it("accepts only bounded JSON primitive query scalars", async () => {
      const documents = fixture.storage.collection<{
        readonly id: string;
        readonly text: string;
        readonly count: number;
        readonly active: boolean;
        readonly optional: null;
      }>("contract.query-scalars");
      const boundary = `${"界".repeat(Math.floor(STORAGE_QUERY_STRING_MAX_BYTES / 3))}a`;
      expect(Buffer.byteLength(boundary, "utf8")).toBe(STORAGE_QUERY_STRING_MAX_BYTES);
      const document = {
        id: "scalar",
        text: boundary,
        count: 42,
        active: true,
        optional: null,
      } as const;
      await documents.put(context, document);
      await expect(documents.find(context, { where: { text: boundary } })).resolves.toEqual(
        [document],
      );
      await expect(documents.find(context, { where: { count: 42 } })).resolves.toEqual([
        document,
      ]);
      await expect(documents.find(context, { where: { active: true } })).resolves.toEqual([
        document,
      ]);
      await expect(documents.find(context, { where: { optional: null } })).resolves.toEqual(
        [document],
      );

      const auditBeforeInvalid = await fixture.storage.audit.list(context);
      const invalidValues: unknown[] = [
        undefined,
        BigInt(1),
        {},
        [],
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "界".repeat(Math.floor(STORAGE_QUERY_STRING_MAX_BYTES / 3) + 1),
      ];
      for (const value of invalidValues) {
        await expect(
          documents.find(context, {
            where: { text: value } as never,
          }),
        ).rejects.toMatchObject({
          diagnostics: [{ code: StorageDiagnosticCode.QUERY_INVALID }],
        });
      }
      await expect(documents.count(context)).resolves.toBe(1);
      expect(await fixture.storage.audit.list(context)).toEqual(auditBeforeInvalid);
    });

    it("validates Atomic document-present fields with shared scalar semantics", async () => {
      const documents = fixture.storage.collection<{
        readonly id: string;
        readonly [key: string]: string | number | boolean | null;
      }>("contract.atomic-fields");
      const boundary = `${"界".repeat(Math.floor(STORAGE_QUERY_STRING_MAX_BYTES / 3))}a`;
      const fields = Object.fromEntries(
        Array.from({ length: STORAGE_QUERY_WHERE_FIELDS_MAX }, (_, index) => [
          `field-${index}`,
          index === 0 ? boundary : index === 1 ? null : index === 2 ? true : index,
        ]),
      ) as Record<string, string | number | boolean | null>;
      const document = { id: "atomic-fields", ...fields };
      await documents.put(context, document);
      const auditBeforeInvalid = await fixture.storage.audit.list(context);
      const invalidFields: unknown[] = [
        Object.fromEntries(
          Array.from({ length: STORAGE_QUERY_WHERE_FIELDS_MAX + 1 }, (_, index) => [
            `field-${index}`,
            index,
          ]),
        ),
        { "bad\nfield": true },
        { field: undefined },
        { field: BigInt(1) },
        { field: {} },
        { field: [] },
        { field: Number.NaN },
        { field: Number.NEGATIVE_INFINITY },
        {
          field: "界".repeat(Math.floor(STORAGE_QUERY_STRING_MAX_BYTES / 3) + 1),
        },
      ];
      for (const [index, invalid] of invalidFields.entries()) {
        await expect(
          fixture.atomicWrite.execute(context, {
            requestId: `atomic-fields-invalid-${index}`,
            preconditions: [
              {
                kind: "document-present",
                collection: "contract.atomic-fields",
                id: document.id,
                fields: invalid as never,
              },
            ],
            operations: [
              {
                kind: "put-document",
                collection: "contract.atomic-fields",
                document: { ...document, mutated: true },
                mode: "replace",
              },
            ],
          }),
        ).rejects.toMatchObject({
          diagnostics: [{ code: StorageDiagnosticCode.ATOMIC_WRITE_INVALID }],
        });
      }
      await expect(documents.get(context, document.id)).resolves.toEqual(document);
      expect(await fixture.storage.audit.list(context)).toEqual(auditBeforeInvalid);

      await expect(
        fixture.atomicWrite.execute(context, {
          requestId: "atomic-fields-boundary",
          preconditions: [
            {
              kind: "document-present",
              collection: "contract.atomic-fields",
              id: document.id,
              fields,
            },
          ],
          operations: [
            {
              kind: "put-document",
              collection: "contract.atomic-fields",
              document: { ...document, accepted: true },
              mode: "replace",
            },
          ],
        }),
      ).resolves.toEqual({
        requestId: "atomic-fields-boundary",
        operationCount: 1,
      });
      await expect(documents.get(context, document.id)).resolves.toMatchObject({
        accepted: true,
      });
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
    it("atomically writes across collections and enforces document modes", async () => {
      const result = await fixture.atomicWrite.execute(context, {
        requestId: "atomic-create",
        preconditions: [
          { kind: "document-absent", collection: "contract.batches", id: "batch-1" },
        ],
        operations: [
          {
            kind: "put-document",
            collection: "contract.batches",
            document: { id: "batch-1", status: "SUCCESS" },
            mode: "create",
          },
          {
            kind: "put-document",
            collection: "contract.results",
            document: { id: "result-1", batchId: "batch-1", value: "10" },
            mode: "create",
          },
        ],
      });
      expect(result).toEqual({ requestId: "atomic-create", operationCount: 2 });
      expect(
        await fixture.storage.collection("contract.batches").get(context, "batch-1"),
      ).toEqual({ id: "batch-1", status: "SUCCESS" });
      expect(
        await fixture.storage.collection("contract.results").get(context, "result-1"),
      ).toEqual({ id: "result-1", batchId: "batch-1", value: "10" });

      await fixture.atomicWrite.execute(context, {
        requestId: "atomic-replace",
        preconditions: [
          {
            kind: "document-present",
            collection: "contract.batches",
            id: "batch-1",
            fields: { status: "SUCCESS" },
          },
        ],
        operations: [
          {
            kind: "put-document",
            collection: "contract.batches",
            document: { id: "batch-1", status: "ARCHIVED" },
            mode: "replace",
          },
        ],
      });
      expect(
        await fixture.storage.collection("contract.batches").get(context, "batch-1"),
      ).toEqual({ id: "batch-1", status: "ARCHIVED" });
    });

    it("rolls back every collection when a precondition fails", async () => {
      await fixture.storage
        .collection<TestDocument>("contract.atomic-existing")
        .put(context, { id: "known", team: "red", score: 1, active: true });
      let error: unknown;
      try {
        await fixture.atomicWrite.execute(context, {
          requestId: "atomic-conflict",
          preconditions: [
            {
              kind: "document-absent",
              collection: "contract.atomic-existing",
              id: "known",
            },
          ],
          operations: [
            {
              kind: "put-document",
              collection: "contract.atomic-a",
              document: { id: "a", value: 1 },
              mode: "create",
            },
            {
              kind: "put-document",
              collection: "contract.atomic-b",
              document: { id: "b", value: 2 },
              mode: "create",
            },
          ],
        });
      } catch (caught) {
        error = caught;
      }
      expect(diagnostic(error).code).toBe(
        StorageDiagnosticCode.ATOMIC_WRITE_PRECONDITION_FAILED,
      );
      expect(await fixture.storage.collection("contract.atomic-a").count(context)).toBe(0);
      expect(await fixture.storage.collection("contract.atomic-b").count(context)).toBe(0);
    });

    it("rolls back writes when a later operation conflicts", async () => {
      const blockers = fixture.storage.collection<{
        readonly id: string;
        readonly occupied: boolean;
      }>("contract.atomic-blockers");
      for (let failureIndex = 0; failureIndex < 4; failureIndex += 1) {
        const blockerId = `blocker-${failureIndex}`;
        await blockers.put(context, { id: blockerId, occupied: true });
        const operations = Array.from({ length: 4 }, (_, index) => ({
          kind: "put-document" as const,
          collection:
            index === failureIndex
              ? "contract.atomic-blockers"
              : `contract.atomic-position-${failureIndex}`,
          document: {
            id: index === failureIndex ? blockerId : `written-${index}`,
            index,
          },
          mode: "create" as const,
        }));
        let error: unknown;
        try {
          await fixture.atomicWrite.execute(context, {
            requestId: `operation-failure-${failureIndex}`,
            preconditions: [],
            operations,
          });
        } catch (caught) {
          error = caught;
        }
        expect(diagnostic(error).code).toBe(
          StorageDiagnosticCode.ATOMIC_WRITE_PRECONDITION_FAILED,
        );
        expect(
          await fixture.storage
            .collection(`contract.atomic-position-${failureIndex}`)
            .count(context),
        ).toBe(0);
      }
    });

    it("rolls back a provider failure before commit", async () => {
      if (fixture.injectAtomicFailure === undefined) return;
      fixture.injectAtomicFailure("before-commit");
      await expect(
        fixture.atomicWrite.execute(context, {
          requestId: "before-commit-failure",
          preconditions: [],
          operations: [
            {
              kind: "put-document",
              collection: "contract.commit-a",
              document: { id: "a", value: 1 },
              mode: "create",
            },
            {
              kind: "put-document",
              collection: "contract.commit-b",
              document: { id: "b", value: 2 },
              mode: "create",
            },
          ],
        }),
      ).rejects.toBeDefined();
      expect(await fixture.storage.collection("contract.commit-a").count(context)).toBe(0);
      expect(await fixture.storage.collection("contract.commit-b").count(context)).toBe(0);
    });

    it("keeps committed data when the response is lost after commit", async () => {
      if (fixture.injectAtomicFailure === undefined) return;
      const request = {
        requestId: "after-commit-failure",
        preconditions: [
          {
            kind: "document-absent" as const,
            collection: "contract.response-loss",
            id: "key",
          },
        ],
        operations: [
          {
            kind: "put-document" as const,
            collection: "contract.response-loss",
            document: { id: "key", batchId: "batch-1" },
            mode: "create" as const,
          },
        ],
      };
      fixture.injectAtomicFailure("after-commit");
      await expect(fixture.atomicWrite.execute(context, request)).rejects.toThrow(
        "Injected atomic write failure",
      );
      expect(
        await fixture.storage.collection("contract.response-loss").get(context, "key"),
      ).toEqual({ id: "key", batchId: "batch-1" });
      await expect(fixture.atomicWrite.execute(context, request)).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: StorageDiagnosticCode.ATOMIC_WRITE_PRECONDITION_FAILED,
          }),
        ]),
      });
      expect(
        await fixture.storage.collection("contract.response-loss").count(context),
      ).toBe(1);
    });

    it("allows exactly one concurrent create for one idempotency key", async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          fixture.atomicWrite.execute(context, {
            requestId: `concurrent-${index}`,
            preconditions: [
              {
                kind: "document-absent",
                collection: "contract.idempotency",
                id: "same-fingerprint",
              },
            ],
            operations: [
              {
                kind: "put-document",
                collection: "contract.idempotency",
                document: {
                  id: "same-fingerprint",
                  batchId: `batch-${index}`,
                },
                mode: "create",
              },
            ],
          }),
        ),
      );
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
      );
      expect(rejected).toHaveLength(19);
      expect(
        rejected.every(
          (attempt) =>
            diagnostic(attempt.reason).code ===
            StorageDiagnosticCode.ATOMIC_WRITE_PRECONDITION_FAILED,
        ),
      ).toBe(true);
      expect(await fixture.storage.collection("contract.idempotency").count(context)).toBe(
        1,
      );
    });
  });
}
