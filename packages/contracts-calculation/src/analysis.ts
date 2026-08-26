import type {
  Diagnostic,
  JsonValue,
  SemanticAnnotation,
  ValueType,
} from "@prism/contracts-data";
import { defineExtensionPoint } from "@prism/kernel";
import type { BinaryOperator, UnaryOperator } from "./expression.js";
import type { SemanticPlanNode } from "./semantic-plan.js";

/** Explicit three-state protocol: absence, ownership, and invalidity differ. */
export type AnalysisResult<T> =
  | { readonly kind: "not-applicable" }
  | {
      readonly kind: "handled";
      readonly value: T;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly Diagnostic[];
    };

export const NOT_APPLICABLE: AnalysisResult<never> = Object.freeze({
  kind: "not-applicable",
});

export interface UnaryTypeAnalysisRequest {
  readonly operator: UnaryOperator;
  readonly operand: ValueType;
}

export interface BinaryTypeAnalysisRequest {
  readonly operator: BinaryOperator;
  readonly left: ValueType;
  readonly right: ValueType;
}

export interface FunctionTypeAnalysisRequest {
  readonly name: string;
  readonly arguments: readonly ValueType[];
}

/**
 * One optional type-semantic analyzer.
 *
 * `semanticVersion` changes only when inference semantics change. It is not
 * the npm package version and not the extension-point contract version.
 */
export interface TypeAnalysisExtension {
  readonly id: string;
  readonly semanticVersion: string;
  inferUnary?(request: UnaryTypeAnalysisRequest): AnalysisResult<ValueType>;
  inferBinary?(request: BinaryTypeAnalysisRequest): AnalysisResult<ValueType>;
  inferFunction?(request: FunctionTypeAnalysisRequest): AnalysisResult<ValueType>;
}

/** Service passed to operation inference by the compiler frontend. */
export interface TypeAnalysisService {
  inferUnary(request: UnaryTypeAnalysisRequest): AnalysisResult<ValueType>;
  inferBinary(request: BinaryTypeAnalysisRequest): AnalysisResult<ValueType>;
  inferFunction(request: FunctionTypeAnalysisRequest): AnalysisResult<ValueType>;
}

export interface PlanNodeAnalysisRequest {
  readonly node: SemanticPlanNode;
  /** Already analyzed upstream nodes, keyed by SemanticPlan node id. */
  readonly upstream: ReadonlyMap<string, SemanticPlanNode>;
}

/**
 * A static analyzer may emit a requirement about actual data. The compiler
 * records it; snapshot sealing or Runtime validates it. Runtime never
 * re-infers Grain from the plan.
 */
export interface PlanConstraint<TSpec extends JsonValue = JsonValue> {
  readonly contract: string;
  readonly contractVersion: string;
  readonly enforcement: "snapshot" | "runtime";
  readonly spec: TSpec;
}

export interface PlanNodeAnalysisValue {
  /** Typed/versioned data attached to the node and persisted in the plan. */
  readonly annotations: readonly SemanticAnnotation[];
  readonly constraints?: readonly PlanConstraint[];
}

export interface PlanAnalysisExtension {
  readonly id: string;
  readonly semanticVersion: string;
  analyzeNode(
    request: PlanNodeAnalysisRequest,
  ): AnalysisResult<PlanNodeAnalysisValue>;
}

/**
 * Contract versions belong to the extension points, not analyzers or npm
 * packages. Step 0A deliberately requires exact version equality.
 */
export const TypeAnalysisExtensionPoint =
  defineExtensionPoint<TypeAnalysisExtension>({
    id: "calculation.type-analysis",
    version: "1.0.0",
  });

export const PlanAnalysisExtensionPoint =
  defineExtensionPoint<PlanAnalysisExtension>({
    id: "calculation.plan-analysis",
    version: "1.0.0",
  });

export type AnalyzerKind = "type" | "plan";

/** A Pipeline may refuse compilation when a safety analyzer is absent. */
export interface AnalyzerRequirement {
  readonly id: string;
  readonly kind: AnalyzerKind;
  /** Exact extension-point contract version required by the authored pipeline. */
  readonly contractVersion: string;
}

/** Actual semantic implementation identity persisted into SemanticPlan. */
export interface AnalysisExtensionIdentity {
  readonly extensionPoint: string;
  readonly contractVersion: string;
  readonly semanticVersion: string;
}

export interface SemanticPlanAnalysisIdentity {
  readonly extensions: Readonly<Record<string, AnalysisExtensionIdentity>>;
}
