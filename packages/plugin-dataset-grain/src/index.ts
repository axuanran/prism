import {
  PlanAnalysisExtensionPoint,
  type AnalysisResult,
  type PlanAnalysisExtension,
  type PlanConstraint,
  type PlanNodeAnalysisRequest,
  type PlanNodeAnalysisValue,
  type PlanRef,
  type SemanticPlanNode,
} from "@prismengine/contracts-calculation";
import {
  canonicalSemanticAnnotations,
  defineSemanticAnnotationContract,
  diagnostic,
  findSemanticAnnotation,
  semanticAnnotation,
  PrismError,
  type JsonObject,
  type TableType,
} from "@prismengine/contracts-data";
import { defineCapability, definePlugin } from "@prismengine/kernel";

export const GRAIN_ANNOTATION_VERSION = "1.0.0";
export const GRAIN_CONSTRAINT_VERSION = "1.0.0";
export const GRAIN_ANALYZER_SEMANTIC_VERSION = "1.0.0";
export const GRAIN_PLUGIN_VERSION = "0.1.0";

export interface GrainSpec extends JsonObject {
  readonly dimensions: readonly string[];
  readonly uniqueBy: readonly string[];
}

export interface GrainUniqueConstraintSpec extends JsonObject {
  readonly input: "source" | "left" | "right" | "table";
  readonly keys: readonly string[];
}

export const GrainAnnotation = defineSemanticAnnotationContract<GrainSpec>({
  id: "dataset.grain",
  version: GRAIN_ANNOTATION_VERSION,
});

export interface GrainCapability {
  annotate(schema: TableType, grain: GrainSpec): TableType;
  read(schema: TableType): GrainSpec | undefined;
  normalize(grain: GrainSpec): GrainSpec;
}

export const GrainCapabilityToken = defineCapability<GrainCapability>({
  id: "dataset.grain",
  version: "1.0.0",
});

export const GrainDiagnosticCode = {
  INVALID: "GRAIN_INVALID",
  MISSING_COLUMN: "GRAIN_MISSING_COLUMN",
  FAN_OUT: "GRAIN_FAN_OUT_REQUIRES_EXPLICIT",
  LOOKUP_POLICY: "GRAIN_LOOKUP_REQUIRES_AMBIGUITY_ERROR",
} as const;

const capability: GrainCapability = {
  annotate(schema, grain) {
    const normalized = normalize(grain);
    assertColumns(schema, normalized);
    const existing = (schema.semanticAnnotations ?? []).filter(
      (annotation) => annotation.contract !== GrainAnnotation.id,
    );
    return {
      ...schema,
      semanticAnnotations: canonicalSemanticAnnotations([
        ...existing,
        semanticAnnotation(GrainAnnotation, normalized),
      ]),
    };
  },
  read(schema) {
    return findSemanticAnnotation(schema.semanticAnnotations, GrainAnnotation)?.spec;
  },
  normalize,
};

export const grainPlanAnalyzer: PlanAnalysisExtension = {
  id: "dataset.grain",
  semanticVersion: GRAIN_ANALYZER_SEMANTIC_VERSION,
  analyzeNode: analyzeNode,
};

export const grainPlugin = definePlugin({
  id: "dataset.grain",
  version: GRAIN_PLUGIN_VERSION,
  engineRange: "^0.1.20",
  provides: [GrainCapabilityToken],
  register(context) {
    context.extensions.contribute(PlanAnalysisExtensionPoint, grainPlanAnalyzer);
    context.provide(GrainCapabilityToken, capability);
  },
});

function analyzeNode(
  request: PlanNodeAnalysisRequest,
): AnalysisResult<PlanNodeAnalysisValue> {
  const node = request.node;
  if (node.kind === "input") {
    const grain = capability.read(node.outputType);
    return grain === undefined ? notApplicable() : handled(grain);
  }

  if (node.kind === "aggregate") {
    const source = grainAt(request, node.source);
    if (source === undefined) return notApplicable();
    const grain = normalize({
      dimensions: node.groupBy,
      uniqueBy: node.groupBy,
    });
    return handled(grain);
  }

  if (node.kind === "lookup") {
    const source = grainAt(request, node.source);
    if (source === undefined) return notApplicable();
    if (node.multiplePolicy !== "error") {
      return invalid(
        GrainDiagnosticCode.LOOKUP_POLICY,
        "A grain-safe Lookup must fail when the lookup key is ambiguous.",
      );
    }
    return handled(source, [
      uniqueConstraint(
        "table",
        node.keys.map((key) => key.right),
      ),
    ]);
  }

  if (node.kind === "join") {
    const left = grainAt(request, node.left);
    if (left === undefined) return notApplicable();
    if (
      node.expectedCardinality === "one-to-many" ||
      node.expectedCardinality === "many-to-many"
    ) {
      return invalid(
        GrainDiagnosticCode.FAN_OUT,
        `Join cardinality ${node.expectedCardinality} changes grain and requires an explicit grain definition.`,
      );
    }
    const constraints: PlanConstraint[] = [
      uniqueConstraint(
        "right",
        node.keys.map((key) => key.right),
      ),
    ];
    if (node.expectedCardinality === "one-to-one") {
      constraints.push(
        uniqueConstraint(
          "left",
          node.keys.map((key) => key.left),
        ),
      );
    }
    return handled(left, constraints);
  }

  const source = sourceRef(node);
  if (source === undefined) return notApplicable();
  const grain = grainAt(request, source);
  if (grain === undefined) return notApplicable();

  if (node.kind === "project") {
    const outputColumns = new Set(node.outputType.columns.map((column) => column.name));
    const missing = [...new Set([...grain.dimensions, ...grain.uniqueBy])].filter(
      (column) => !outputColumns.has(column),
    );
    if (missing.length > 0) {
      return invalid(
        GrainDiagnosticCode.MISSING_COLUMN,
        `Projection removes grain columns: ${missing.join(", ")}.`,
      );
    }
  }

  return handled(grain);
}

function sourceRef(node: SemanticPlanNode): PlanRef | undefined {
  switch (node.kind) {
    case "filter":
    case "formula":
    case "project":
    case "decision":
    case "aggregate":
    case "allocate":
    case "validate":
    case "output":
      return node.source;
    case "input":
    case "join":
    case "lookup":
      return undefined;
  }
}

function grainAt(
  request: PlanNodeAnalysisRequest,
  reference: PlanRef,
): GrainSpec | undefined {
  const upstream = request.upstream.get(reference.node);
  const annotation = findSemanticAnnotation(upstream?.analysis, GrainAnnotation);
  return annotation === undefined ? undefined : normalize(annotation.spec);
}

function handled(
  grain: GrainSpec,
  constraints: readonly PlanConstraint[] = [],
): AnalysisResult<PlanNodeAnalysisValue> {
  return {
    kind: "handled",
    value: {
      annotations: [semanticAnnotation(GrainAnnotation, normalize(grain))],
      ...(constraints.length === 0 ? {} : { constraints }),
    },
    diagnostics: [],
  };
}

function invalid(code: string, message: string): AnalysisResult<PlanNodeAnalysisValue> {
  return {
    kind: "invalid",
    diagnostics: [diagnostic(code, message)],
  };
}

function notApplicable(): AnalysisResult<PlanNodeAnalysisValue> {
  return { kind: "not-applicable" };
}

function uniqueConstraint(
  input: GrainUniqueConstraintSpec["input"],
  keys: readonly string[],
): PlanConstraint<GrainUniqueConstraintSpec> {
  return {
    contract: "dataset.grain.unique",
    contractVersion: GRAIN_CONSTRAINT_VERSION,
    enforcement: "runtime",
    spec: { input, keys: [...keys].sort() },
  };
}

function normalize(grain: GrainSpec): GrainSpec {
  return {
    dimensions: sortedUnique(grain.dimensions),
    uniqueBy: sortedUnique(grain.uniqueBy),
  };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value === "")) {
    throw PrismError.of(
      GrainDiagnosticCode.INVALID,
      "Grain dimensions and keys must be non-empty.",
    );
  }
  return [...new Set(normalized)].sort();
}

function assertColumns(schema: TableType, grain: GrainSpec): void {
  const columns = new Set(schema.columns.map((column) => column.name));
  const missing = [...new Set([...grain.dimensions, ...grain.uniqueBy])].filter(
    (column) => !columns.has(column),
  );
  if (missing.length > 0) {
    throw PrismError.of(
      GrainDiagnosticCode.MISSING_COLUMN,
      `Grain references missing columns: ${missing.join(", ")}.`,
      { missing },
    );
  }
}
