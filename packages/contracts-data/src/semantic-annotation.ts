import { DataDiagnosticCode, PrismError } from "./diagnostics.js";
import { assertJsonValue } from "./json.js";
import type { JsonValue } from "./json.js";

/**
 * Typed, versioned, serializable meaning contributed by an optional plugin.
 *
 * `contractVersion` versions the annotation's stored shape. It is deliberately
 * not an npm package version and not an analyzer semantic version: README/UI
 * changes must not alter plan identity.
 */
export interface SemanticAnnotation<TSpec extends JsonValue = JsonValue> {
  readonly contract: string;
  readonly contractVersion: string;
  readonly spec: TSpec;
}

declare const ANNOTATION_SPEC: unique symbol;

/** Authoring token that restores a concrete spec type at plugin boundaries. */
export interface SemanticAnnotationContract<TSpec extends JsonValue> {
  readonly id: string;
  readonly version: string;
  readonly [ANNOTATION_SPEC]?: (spec: TSpec) => TSpec;
}

export function defineSemanticAnnotationContract<TSpec extends JsonValue>(definition: {
  readonly id: string;
  readonly version: string;
}): SemanticAnnotationContract<TSpec> {
  if (definition.id.trim() === "") {
    throw PrismError.of(DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID, "Semantic annotation contract id is required.");
  }
  if (definition.version.trim() === "") {
    throw PrismError.of(DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID, "Semantic annotation contract version is required.");
  }
  return definition;
}

export function semanticAnnotation<TSpec extends JsonValue>(
  contract: SemanticAnnotationContract<TSpec>,
  spec: TSpec,
): SemanticAnnotation<TSpec> {
  assertJsonValue(spec, `/semanticAnnotations/${contract.id}/spec`);
  return {
    contract: contract.id,
    contractVersion: contract.version,
    spec,
  };
}

/**
 * Canonicalizes annotations for deterministic serialization and hashing.
 * Duplicate contracts are rejected: two meanings under one key are ambiguous.
 */
export function canonicalSemanticAnnotations(
  annotations: readonly SemanticAnnotation[],
): readonly SemanticAnnotation[] {
  const sorted = [...annotations].sort((left, right) =>
    left.contract.localeCompare(right.contract),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.contract === sorted[index]?.contract) {
      throw PrismError.of(
        DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID,
        `Duplicate semantic annotation contract "${sorted[index]?.contract}".`,
      );
    }
  }
  for (const annotation of sorted) {
    assertJsonValue(annotation.spec, `/semanticAnnotations/${annotation.contract}/spec`);
  }
  return sorted;
}

export function findSemanticAnnotation<TSpec extends JsonValue>(
  annotations: readonly SemanticAnnotation[] | undefined,
  contract: SemanticAnnotationContract<TSpec>,
): SemanticAnnotation<TSpec> | undefined {
  const found = annotations?.find((annotation) => annotation.contract === contract.id);
  if (found === undefined) return undefined;
  if (found.contractVersion !== contract.version) {
    throw PrismError.of(
      DataDiagnosticCode.SEMANTIC_ANNOTATION_VERSION_MISMATCH,
      `Semantic annotation "${contract.id}" version mismatch: stored ${found.contractVersion}, requested ${contract.version}.`,
      { contract: contract.id, storedVersion: found.contractVersion, requestedVersion: contract.version },
    );
  }
  return found as SemanticAnnotation<TSpec>;
}

export function parseSemanticAnnotations(
  serialized: string,
  path = "/semanticAnnotations",
): readonly SemanticAnnotation[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw PrismError.of(
      DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID,
      "Semantic annotations must be valid JSON.",
      { path },
    );
  }
  if (!Array.isArray(value)) {
    throw PrismError.of(
      DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID,
      "Semantic annotations must be an array.",
      { path },
    );
  }
  const annotations = value.map((item, index): SemanticAnnotation => {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      throw PrismError.of(
        DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID,
        "Semantic annotation must be an object.",
        { path: `${path}/${index}` },
      );
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.contract !== "string" ||
      candidate.contract.trim() === "" ||
      typeof candidate.contractVersion !== "string" ||
      candidate.contractVersion.trim() === ""
    ) {
      throw PrismError.of(
        DataDiagnosticCode.SEMANTIC_ANNOTATION_INVALID,
        "Semantic annotation requires contract and contractVersion.",
        { path: `${path}/${index}` },
      );
    }
    assertJsonValue(candidate.spec, `${path}/${index}/spec`);
    return {
      contract: candidate.contract,
      contractVersion: candidate.contractVersion,
      spec: candidate.spec,
    };
  });
  return canonicalSemanticAnnotations(annotations);
}
