import type { CallContext, Diagnostic, ValueType } from "@prism/contracts-data";
import type { ConfigurationContract, ExposureDeclaration, PresentationSpec } from "@prism/kernel";
import { defineExtensionPoint } from "@prism/kernel";
import type { PortDefinition } from "./pipeline.js";
import type { PlanRef, SemanticPlanNode } from "./semantic-plan.js";
import type { TypeAnalysisService } from "./analysis.js";

/**
 * Operation contract.
 *
 *   Operation = the capability definition, a compiler frontend
 *   Node      = one configured instance of it inside a pipeline
 *
 * An operation answers two questions and no others: what types does this
 * configuration produce (`infer`), and what does it mean (`lower`). It never
 * executes anything. Execution belongs to a `CalculationBackend`, which reads
 * the lowered semantic node.
 */

export interface TypeInferenceRequest<TConfig = unknown> {
  readonly config: TConfig;
  /** Resolved types of connected input ports, keyed by port name. */
  readonly inputs: Readonly<Record<string, ValueType>>;
  /** Deterministic composition of installed type-analysis plugins. */
  readonly analysis: TypeAnalysisService;
}

export interface TypeInferenceResult {
  /** Output port types, keyed by port name. */
  readonly outputs: Readonly<Record<string, ValueType>>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Lowering request. Inputs are `PlanRef`s, not data: lowering is a pure
 * compile-time transformation and never touches a row.
 */
export interface LowerRequest<TConfig = unknown> {
  readonly call: CallContext;
  /** Pipeline node id. Becomes `PlanNodeOrigin.sourceNodeId`. */
  readonly nodeId: string;
  readonly label?: string;
  readonly config: TConfig;
  /** Upstream plan references, keyed by input port name. */
  readonly inputs: Readonly<Record<string, PlanRef>>;
  /** Resolved types of those inputs, from `infer`. */
  /** Same analyzer composition used during inference; lowering must not re-parse under weaker rules. */
  readonly analysis: TypeAnalysisService;
  readonly inputTypes: Readonly<Record<string, ValueType>>;
  /** Resolved output types of this node, from `infer`. */
  readonly outputTypes: Readonly<Record<string, ValueType>>;
}

export interface OperationDefinition<TConfig = unknown> {
  /** Plugin-namespaced, e.g. "calculation.lookup". */
  readonly id: string;
  /** Bumped whenever results can change. Recorded in every run's version stamp. */
  readonly version: string;
  /** Business-facing label for the editor palette, e.g. "查表". */
  readonly title: string;
  readonly description?: string;
  /** Palette grouping, e.g. "数据" / "计算" / "分配". */
  readonly category?: string;

  readonly inputs: readonly PortDefinition[];
  readonly outputs: readonly PortDefinition[];

  readonly config: ConfigurationContract<TConfig>;
  readonly presentation?: PresentationSpec;
  /**
   * Which surfaces may see this operation. `pipeline: true` is what puts it in
   * the editor palette; a runtime-only operation stays internal.
   */
  readonly exposure: ExposureDeclaration;

  /** Static type propagation. Runs during validate, before any data is read. */
  infer(request: TypeInferenceRequest<TConfig>): TypeInferenceResult;

  /** Semantic checks beyond types, e.g. a decision table with no rules. */
  validate?(request: TypeInferenceRequest<TConfig>): readonly Diagnostic[];

  /**
   * Lowers a configured node into semantic IR.
   *
   * An operation is a compiler frontend, not an executor: it owns
   * `low-code config -> semantic meaning`, and owns no execution whatsoever.
   * Returning a closure here would make the node opaque to every backend
   * except the JS one, which is exactly what this signature forbids.
   */
  lower(request: LowerRequest<TConfig>): SemanticPlanNode;
}

/**
 * Extension point through which plugins add operations. Declared here, not in
 * the kernel: the kernel must not know what a pipeline operation is.
 */
// The point collects operations with unrelated config types. Each one
// type-checks its own config internally, and the registry only ever reads the
// common surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OperationExtensionPoint = defineExtensionPoint<OperationDefinition<any>>({
  id: "calculation.operations",
  version: "1.0.0",
});

/** Studio-facing projection of an operation. No implementation details leak. */
export interface OperationDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly inputs: readonly PortDefinition[];
  readonly outputs: readonly PortDefinition[];
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly presentation?: PresentationSpec;
}
