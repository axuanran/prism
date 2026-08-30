import { PrismError } from "@prismengine/contracts-data";
import type { AtomicWriteRequest, DocumentQuery } from "./capability.js";

export const STORAGE_DOCUMENT_BATCH_MAX = 1_000;
export const STORAGE_ATOMIC_PRECONDITIONS_MAX = 1_000;
export const STORAGE_ATOMIC_OPERATIONS_MAX = 1_000;
export const STORAGE_QUERY_WHERE_FIELDS_MAX = 32;
export const STORAGE_QUERY_ORDER_TERMS_MAX = 8;
export const STORAGE_QUERY_LIMIT_MAX = 10_000;
export const STORAGE_QUERY_FIELD_MAX_LENGTH = 128;
export const STORAGE_QUERY_STRING_MAX_BYTES = 1_024;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function assertDocumentBatchSize(length: number, field: string): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > STORAGE_DOCUMENT_BATCH_MAX) {
    throw queryInvalid(field);
  }
}

export function assertDocumentQuery(query: DocumentQuery): void {
  if (query.where !== undefined) {
    if (
      typeof query.where !== "object" ||
      query.where === null ||
      Array.isArray(query.where)
    ) {
      throw queryInvalid("where");
    }
    const entries = Object.entries(query.where);
    if (entries.length > STORAGE_QUERY_WHERE_FIELDS_MAX) {
      throw queryInvalid("where");
    }
    for (const [field, value] of entries) {
      if (!validQueryField(field) || !validQueryScalar(value)) {
        throw queryInvalid("where");
      }
    }
  }
  if (query.orderBy !== undefined) {
    if (
      !Array.isArray(query.orderBy) ||
      query.orderBy.length > STORAGE_QUERY_ORDER_TERMS_MAX
    ) {
      throw queryInvalid("orderBy");
    }
    for (const term of query.orderBy) {
      if (
        typeof term !== "object" ||
        term === null ||
        !assertableField(term.field) ||
        (term.direction !== "asc" && term.direction !== "desc")
      ) {
        throw queryInvalid("orderBy");
      }
      if (!validQueryField(term.field)) throw queryInvalid("orderBy");
    }
  }
  if (query.limit !== undefined) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 0 ||
      query.limit > STORAGE_QUERY_LIMIT_MAX
    ) {
      throw queryInvalid("limit");
    }
  }
  if (query.offset !== undefined) {
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
      throw queryInvalid("offset");
    }
  }
}

export function assertAtomicWriteCardinality(request: AtomicWriteRequest): void {
  if (request.preconditions.length > STORAGE_ATOMIC_PRECONDITIONS_MAX) {
    throw atomicInvalid("preconditions");
  }
  if (
    request.operations.length < 1 ||
    request.operations.length > STORAGE_ATOMIC_OPERATIONS_MAX
  ) {
    throw atomicInvalid("operations");
  }
  for (const precondition of request.preconditions) {
    if (precondition.kind !== "document-present" || precondition.fields === undefined) {
      continue;
    }
    if (
      typeof precondition.fields !== "object" ||
      precondition.fields === null ||
      Array.isArray(precondition.fields)
    ) {
      throw atomicInvalid("fields");
    }
    const entries = Object.entries(precondition.fields);
    if (entries.length > STORAGE_QUERY_WHERE_FIELDS_MAX) {
      throw atomicInvalid("fields");
    }
    for (const [field, value] of entries) {
      if (!validQueryField(field) || !validQueryScalar(value)) {
        throw atomicInvalid("fields");
      }
    }
  }
}

function validQueryField(field: string): boolean {
  return (
    field.length > 0 &&
    field.length <= STORAGE_QUERY_FIELD_MAX_LENGTH &&
    !CONTROL.test(field)
  );
}

function validQueryScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= STORAGE_QUERY_STRING_MAX_BYTES)
  );
}

function assertableField(value: unknown): value is string {
  return typeof value === "string";
}

function queryInvalid(field: string): PrismError {
  return PrismError.of("STORAGE_QUERY_INVALID", "Storage query is invalid.", {
    field,
  });
}

function atomicInvalid(field: string): PrismError {
  return PrismError.of("ATOMIC_WRITE_INVALID", "Atomic write is invalid.", {
    field,
  });
}
