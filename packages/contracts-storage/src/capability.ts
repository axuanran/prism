import type { CallContext } from "@prism/contracts-data";
import { defineCapability } from "@prism/kernel";
import type { Resource, ResourceQuery } from "@prism/kernel";

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
}

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
  readonly orderBy?: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
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

export interface StorageCapability {
  readonly resources: ResourceStore;

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
} as const;

export const ResourceEventType = {
  DraftSaved: "resource.draft.saved",
  Published: "resource.published",
  Archived: "resource.archived",
} as const;
