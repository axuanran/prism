import { PrismError, type CallContext } from "@prismengine/contracts-data";
import type { Resource, ResourceQuery } from "@prismengine/kernel";
import type {
  AtomicWriteRequest,
  AuditJournal,
  AuditQuery,
  DocumentCollection,
  DocumentQuery,
  ResourceStore,
  SaveDraftCommand,
} from "./capability.js";
import {
  assertAtomicWriteCardinality,
  assertDocumentBatchSize,
  assertDocumentQuery,
} from "./query-validation.js";

export const STORAGE_NAMESPACE_MAX_LENGTH = 128;
export const STORAGE_REQUEST_ID_MAX_LENGTH = 256;
export const STORAGE_ENTITY_ID_MAX_LENGTH = 256;
export const STORAGE_AUDIT_QUERY_LIMIT_MAX = 1_000;
export const STORAGE_RESOURCE_NAME_MAX_LENGTH = 512;
export const STORAGE_AUDIT_PRINCIPAL_ID_MAX_LENGTH = 128;
export const STORAGE_AUDIT_CORRELATION_ID_MAX_LENGTH = 128;
export const STORAGE_AUDIT_CHANGE_REASON_MAX_LENGTH = 500;
export const STORAGE_AUDIT_APPROVAL_ID_MAX_LENGTH = 128;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NAMESPACE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const APPROVAL_ID = /^[A-Za-z0-9_-]+$/u;

export function assertStorageAuditContext(context: CallContext): void {
  if (!boundedAuditText(context.principal.id, STORAGE_AUDIT_PRINCIPAL_ID_MAX_LENGTH)) {
    throw invalidAuditContext("principal.id");
  }
  if (
    context.correlationId.length < 1 ||
    context.correlationId.length > STORAGE_AUDIT_CORRELATION_ID_MAX_LENGTH ||
    !CORRELATION_ID.test(context.correlationId)
  ) {
    throw invalidAuditContext("correlationId");
  }
  if (
    context.changeReason !== undefined &&
    !boundedAuditText(context.changeReason, STORAGE_AUDIT_CHANGE_REASON_MAX_LENGTH)
  ) {
    throw invalidAuditContext("changeReason");
  }
  if (
    context.approvalId !== undefined &&
    (context.approvalId.length < 1 ||
      context.approvalId.length > STORAGE_AUDIT_APPROVAL_ID_MAX_LENGTH ||
      !APPROVAL_ID.test(context.approvalId))
  ) {
    throw invalidAuditContext("approvalId");
  }
}

export function assertStorageNamespace(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > STORAGE_NAMESPACE_MAX_LENGTH ||
    !NAMESPACE.test(value)
  ) {
    throw invalidIdentifier(field);
  }
}

export function assertStorageRequestId(value: string): void {
  if (
    value.length < 1 ||
    value.length > STORAGE_REQUEST_ID_MAX_LENGTH ||
    !REQUEST_ID.test(value)
  ) {
    throw invalidIdentifier("requestId");
  }
}

export function assertStorageEntityId(value: string, field = "id"): void {
  assertBoundedText(value, STORAGE_ENTITY_ID_MAX_LENGTH, field, false);
}

export function assertStorageResourceName(value: string, field = "name"): void {
  assertBoundedText(value, STORAGE_RESOURCE_NAME_MAX_LENGTH, field, false);
}
export function validatingAuditJournal(delegate: AuditJournal): AuditJournal {
  return {
    async list(context: CallContext, query: AuditQuery = {}) {
      if (typeof query !== "object" || query === null || Array.isArray(query)) {
        throw invalidQuery("audit");
      }
      if (
        query.afterSequence !== undefined &&
        (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0)
      ) {
        throw invalidQuery("afterSequence");
      }
      if (
        query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) ||
          query.limit < 1 ||
          query.limit > STORAGE_AUDIT_QUERY_LIMIT_MAX)
      ) {
        throw invalidQuery("limit");
      }
      if (query.targetKind !== undefined) {
        if (typeof query.targetKind !== "string") throw invalidQuery("targetKind");
        try {
          assertStorageNamespace(query.targetKind, "targetKind");
        } catch {
          throw invalidQuery("targetKind");
        }
      }
      if (query.targetId !== undefined) {
        if (typeof query.targetId !== "string") throw invalidQuery("targetId");
        try {
          assertStorageEntityId(query.targetId, "targetId");
        } catch {
          throw invalidQuery("targetId");
        }
      }
      return delegate.list(context, query);
    },
    verify(context: CallContext) {
      return delegate.verify(context);
    },
  };
}

export function assertStorageQueryText(value: string, field: string): void {
  assertBoundedText(value, STORAGE_RESOURCE_NAME_MAX_LENGTH, field, true);
}

export function validatingResourceStore(delegate: ResourceStore): ResourceStore {
  return {
    async get<TSpec>(context: CallContext, kind: string, id: string, revision?: number) {
      assertResourceTarget(kind, id);
      return delegate.get<TSpec>(context, kind, id, revision);
    },
    async getPublished<TSpec>(context: CallContext, kind: string, id: string) {
      assertResourceTarget(kind, id);
      return delegate.getPublished<TSpec>(context, kind, id);
    },
    async list(context: CallContext, query: ResourceQuery): Promise<readonly Resource[]> {
      if (query.kind !== undefined) assertStorageNamespace(query.kind, "kind");
      if (query.nameContains !== undefined) {
        assertStorageQueryText(query.nameContains, "nameContains");
      }
      return delegate.list(context, query);
    },
    async listRevisions(context: CallContext, kind: string, id: string) {
      assertResourceTarget(kind, id);
      return delegate.listRevisions(context, kind, id);
    },
    async saveDraft<TSpec>(context: CallContext, command: SaveDraftCommand<TSpec>) {
      assertStorageAuditContext(context);
      assertStorageNamespace(command.kind, "kind");
      if (command.id !== undefined) assertStorageEntityId(command.id);
      assertStorageResourceName(command.name);
      return delegate.saveDraft(context, command);
    },
    async publish<TSpec>(
      context: CallContext,
      kind: string,
      id: string,
      revision: number,
      expectedUpdatedAt?: string,
    ) {
      assertStorageAuditContext(context);
      assertResourceTarget(kind, id);
      return delegate.publish<TSpec>(context, kind, id, revision, expectedUpdatedAt);
    },
    async clone<TSpec>(context: CallContext, kind: string, id: string, revision?: number) {
      assertStorageAuditContext(context);
      assertResourceTarget(kind, id);
      return delegate.clone<TSpec>(context, kind, id, revision);
    },
    async archive(context: CallContext, kind: string, id: string) {
      assertStorageAuditContext(context);
      assertResourceTarget(kind, id);
      return delegate.archive(context, kind, id);
    },
  };
}

export function validatingDocumentCollection<TDocument extends { readonly id: string }>(
  delegate: DocumentCollection<TDocument>,
): DocumentCollection<TDocument> {
  return {
    async get(context, id) {
      assertStorageEntityId(id);
      return delegate.get(context, id);
    },
    async getMany(context, ids) {
      assertDocumentBatchSize(ids.length, "ids");
      for (const id of ids) assertStorageEntityId(id);
      return delegate.getMany(context, ids);
    },
    async find(context, query: DocumentQuery = {}) {
      assertDocumentQuery(query);
      return delegate.find(context, query);
    },
    async put(context, document) {
      assertStorageAuditContext(context);
      assertStorageEntityId(document.id);
      return delegate.put(context, document);
    },
    async putMany(context, documents) {
      assertStorageAuditContext(context);
      assertDocumentBatchSize(documents.length, "documents");
      for (const document of documents) assertStorageEntityId(document.id);
      return delegate.putMany(context, documents);
    },
    async delete(context, id) {
      assertStorageAuditContext(context);
      assertStorageEntityId(id);
      return delegate.delete(context, id);
    },
    async count(context, query: DocumentQuery = {}) {
      assertDocumentQuery(query);
      return delegate.count(context, query);
    },
  };
}

export function assertAtomicWriteIdentifiers(request: AtomicWriteRequest): void {
  assertAtomicWriteCardinality(request);
  assertStorageRequestId(request.requestId);
  for (const precondition of request.preconditions) {
    assertStorageNamespace(precondition.collection, "collection");
    assertStorageEntityId(precondition.id);
  }
  for (const operation of request.operations) {
    assertStorageNamespace(operation.collection, "collection");
    assertStorageEntityId(
      operation.kind === "put-document" ? operation.document.id : operation.id,
    );
  }
}

function assertResourceTarget(kind: string, id: string): void {
  assertStorageNamespace(kind, "kind");
  assertStorageEntityId(id);
}

function assertBoundedText(
  value: string,
  maximum: number,
  field: string,
  allowEmpty: boolean,
): void {
  if (
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    CONTROL.test(value)
  ) {
    throw invalidIdentifier(field);
  }
}

function boundedAuditText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}

function invalidAuditContext(field: string): PrismError {
  return PrismError.of(
    "STORAGE_AUDIT_CONTEXT_INVALID",
    "Storage audit context is invalid.",
    { field },
  );
}

function invalidQuery(field: string): PrismError {
  return PrismError.of("STORAGE_QUERY_INVALID", "Storage query is invalid.", {
    field,
  });
}

function invalidIdentifier(field: string): PrismError {
  return PrismError.of("STORAGE_IDENTIFIER_INVALID", "Storage identifier is invalid.", {
    field,
  });
}
