import type { CallContext, JsonObject, JsonPrimitive } from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";
import type { Resource, ResourceQuery } from "@prismengine/kernel";

/**
 * Storage capability.
 *
 * Two deliberately different shapes:
 *   - `resources`: the engine-wide, revision-aware store behind every
 *     configurable resource. Its semantics (published revisions immutable,
 *     edit-clones-to-draft) are engine semantics, so they live here rather
 *     than being re-implemented per plugin.
 *   - `collection`: a plain document collection a plugin owns outright.
 *     No universal ORM meta-model, no shared table for everything.
 *
 * Only storage plugins touch a database client. Any other plugin importing
 * `pg` is an architecture violation, checked by the architecture tests.
 */

export interface SaveDraftCommand<TSpec = unknown> {
  readonly kind: string;
  /**
   * PUT semantics. Absent: the store assigns an id. Present and unknown: the
   * resource is created under that id - business-meaningful ids such as a
   * scheme code are referenced by run pins, so callers must be able to choose
   * them. Present and known: updates the draft revision, or clones the
   * published one into a new draft.
   */
  readonly id?: string;
  readonly name: string;
  readonly spec: TSpec;
  /**
   * Optimistic concurrency token. When supplied, the latest resource revision
   * must still have this exact updatedAt value. `null` asserts that the
   * resource does not exist yet.
   */
  readonly expectedUpdatedAt?: string | null;
}
export interface AuditRecord {
  readonly sequence: number;
  readonly id: string;
  readonly timestamp: string;
  readonly principalId: string;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly beforeFingerprint: string | null;
  readonly afterFingerprint: string | null;
  readonly reason?: string;
  readonly correlationId: string;
  readonly approvalId?: string;
  readonly previousHash: string | null;
  readonly entryHash: string;
}

export interface AuditQuery {
  readonly afterSequence?: number;
  readonly limit?: number;
  readonly targetKind?: string;
  readonly targetId?: string;
}

export interface AuditVerification {
  readonly valid: boolean;
  readonly checked: number;
  readonly brokenAtSequence?: number;
}

export interface AuditJournal {
  list(context: CallContext, query?: AuditQuery): Promise<readonly AuditRecord[]>;
  verify(context: CallContext): Promise<AuditVerification>;
}
export interface AuditExportResult {
  readonly exported: number;
  readonly verified: number;
  readonly lastSequence: number;
}

export interface AuditExportCapability {
  exportRange(
    context: CallContext,
    afterSequence?: number,
    limit?: number,
  ): Promise<AuditExportResult>;
  verifyRange(
    context: CallContext,
    afterSequence?: number,
    limit?: number,
  ): Promise<AuditExportResult>;
  productionReadiness(context: CallContext): Promise<{
    readonly id: "audit-worm-export";
    readonly passed: boolean;
    readonly evidence?: string;
  }>;
}

export const AuditExportCapabilityToken = defineCapability<AuditExportCapability>({
  id: "storage.audit-export",
  version: "1.0.0",
});

export interface ResourceStore {
  get<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec> | null>;

  /** Latest published revision, or null when only drafts exist. */
  getPublished<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
  ): Promise<Resource<TSpec> | null>;

  list(context: CallContext, query: ResourceQuery): Promise<readonly Resource[]>;

  listRevisions(
    context: CallContext,
    kind: string,
    id: string,
  ): Promise<readonly Resource[]>;

  saveDraft<TSpec>(
    context: CallContext,
    command: SaveDraftCommand<TSpec>,
  ): Promise<Resource<TSpec>>;

  /**
   * Publishing freezes the revision permanently.
   *
   * The lifecycle is a one-way state machine:
   *
   *   draft ----> published ----> archived      archived is terminal
   *     \                            ^
   *      \--------------------------/           an unpublished draft may be
   *                                             abandoned directly
   *
   * "Frozen" means frozen forever, not merely "while currently published".
   * A run pins the exact revision it executed, so if an archived revision
   * could be returned to draft and overwritten, every payout explained
   * against it would silently start lying. To revive an archived definition,
   * `clone` it into a NEW draft revision.
   *
   * There is deliberately no general `setStatus`: an arbitrary status setter
   * is precisely the hole through which that invariant escapes.
   */
  publish<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision: number,
    expectedUpdatedAt?: string,
  ): Promise<Resource<TSpec>>;

  /** Clones a revision into a new draft. The only way back from archived. */
  clone<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec>>;

  /**
   * Archives EVERY revision of the resource, drafts included: abandoning a
   * never-published draft is a normal act, and leaving one editable under an
   * archived resource would be the odd behaviour.
   *
   * Terminal. Content stays readable and unchanged, so runs pinned to an
   * archived revision remain explainable.
   */
  archive(context: CallContext, kind: string, id: string): Promise<void>;
}

export interface DocumentQuery {
  /** Equality filter on top-level fields. Deliberately minimal for V0.1. */
  readonly where?: Readonly<Record<string, string | number | boolean | null>>;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: readonly {
    readonly field: string;
    readonly direction: "asc" | "desc";
  }[];
}

export interface DocumentCollection<TDocument extends { readonly id: string }> {
  get(context: CallContext, id: string): Promise<TDocument | null>;
  getMany(context: CallContext, ids: readonly string[]): Promise<readonly TDocument[]>;
  find(context: CallContext, query?: DocumentQuery): Promise<readonly TDocument[]>;
  put(context: CallContext, document: TDocument): Promise<TDocument>;
  putMany(context: CallContext, documents: readonly TDocument[]): Promise<void>;
  delete(context: CallContext, id: string): Promise<void>;
  count(context: CallContext, query?: DocumentQuery): Promise<number>;
}

export interface AtomicDocument extends JsonObject {
  readonly id: string;
}

export type AtomicWritePrecondition =
  | {
      readonly kind: "document-absent";
      readonly collection: string;
      readonly id: string;
    }
  | {
      readonly kind: "document-present";
      readonly collection: string;
      readonly id: string;
      readonly fields?: Readonly<Record<string, JsonPrimitive>>;
    };

export type AtomicWriteOperation =
  | {
      readonly kind: "put-document";
      readonly collection: string;
      readonly document: AtomicDocument;
      readonly mode: "create" | "upsert" | "replace";
    }
  | {
      readonly kind: "delete-document";
      readonly collection: string;
      readonly id: string;
    };

export interface AtomicWriteRequest {
  readonly requestId: string;
  readonly preconditions: readonly AtomicWritePrecondition[];
  readonly operations: readonly AtomicWriteOperation[];
}

export interface AtomicWriteResult {
  readonly requestId: string;
  readonly operationCount: number;
}

/**
 * Declarative single-provider atomic write. The provider owns transaction
 * execution; callers cannot run code, I/O, or database-specific operations
 * inside the atomic boundary.
 */
export interface AtomicWriteCapability {
  execute(context: CallContext, request: AtomicWriteRequest): Promise<AtomicWriteResult>;
}

export const AtomicWriteCapabilityToken = defineCapability<AtomicWriteCapability>({
  id: "storage.atomic-write",
  version: "1.0.0",
});

export interface StorageReadinessEvidence {
  readonly id: "database.pitr" | "audit-journal.valid";
  readonly passed: boolean;
  readonly evidence: string;
}

export interface StorageCapability {
  readonly resources: ResourceStore;
  readonly audit: AuditJournal;
  productionReadiness(context: CallContext): Promise<readonly StorageReadinessEvidence[]>;

  /**
   * `name` is plugin-namespaced, e.g. "organization.people". The engine does
   * not interpret documents; the owning plugin does.
   */
  collection<TDocument extends { readonly id: string }>(
    name: string,
  ): DocumentCollection<TDocument>;
}

export const StorageCapabilityToken = defineCapability<StorageCapability>({
  id: "storage",
  version: "1.0.0",
});

export const StorageDiagnosticCode = {
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  RESOURCE_REVISION_NOT_FOUND: "RESOURCE_REVISION_NOT_FOUND",
  RESOURCE_PUBLISHED_IMMUTABLE: "RESOURCE_PUBLISHED_IMMUTABLE",
  RESOURCE_KIND_UNKNOWN: "RESOURCE_KIND_UNKNOWN",
  RESOURCE_VALIDATION_FAILED: "RESOURCE_VALIDATION_FAILED",
  RESOURCE_CONFLICT: "RESOURCE_CONFLICT",
  ATOMIC_WRITE_INVALID: "ATOMIC_WRITE_INVALID",
  ATOMIC_WRITE_PRECONDITION_FAILED: "ATOMIC_WRITE_PRECONDITION_FAILED",
  IDENTIFIER_INVALID: "STORAGE_IDENTIFIER_INVALID",
  AUDIT_CONTEXT_INVALID: "STORAGE_AUDIT_CONTEXT_INVALID",
  QUERY_INVALID: "STORAGE_QUERY_INVALID",
} as const;

export const ResourceEventType = {
  DraftSaved: "resource.draft.saved",
  Published: "resource.published",
  Archived: "resource.archived",
} as const;
