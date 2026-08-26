import type {
  RoundingMode,
  SemanticAnnotation,
  TableType,
  ValueType,
} from "@prismengine/contracts-data";
import type { AllocationPolicy } from "./allocation.js";
import type { Expression } from "./expression.js";
import type {
  PlanConstraint,
  SemanticPlanAnalysisIdentity,
} from "./analysis.js";

/**
 * SemanticPlan: Prism's own calculation IR.
 *
 * Three layers, never conflated:
 *
 *   PipelineSpec    the low-code program a business user authored
 *        | infer / normalize / lower
 *   SemanticPlan    what the calculation *means*, owned by Prism
 *        | backend lowering
 *   ExecutablePlan  what one specific backend will actually run
 *
 * Invariants of this IR, all load-bearing:
 *   - serializable    plain JSON; no functions, no class instances, no refs
 *                     to runtime objects. A closure here would make the plan
 *                     opaque to any backend that is not the JS one, which is
 *                     precisely the failure this layer exists to prevent.
 *   - deterministic   the same spec and the same operation versions produce a
 *                     byte-identical plan
 *   - typed           every node carries its resolved output type
 *   - versioned       every node records the operation and version that
 *                     produced it, so a run's version stamp is derivable
 *   - hashable        planHash = hash(SemanticPlan + operation versions +
 *                     engine version)
 *   - inspectable     the studio can render it, and `explain` can describe it,
 *                     without executing anything
 *
 * A backend reads "this is a many-to-one join on personId", not "here is a
 * function, please call it".
 */

/** IR version. Bumped because analysis identity is a required v2 field. */
export const SEMANTIC_PLAN_VERSION = 2;

export type PlanNodeId = string;

/** A reference to one output port of another node. */
export interface PlanRef {
  readonly node: PlanNodeId;
  readonly port: string;
}

/** Which operation produced a node, and at which version. */
export interface PlanNodeOrigin {
  readonly operation: string;
  readonly version: string;
  /** Pipeline node id this came from. Ties trace and explain back to the editor. */
  readonly sourceNodeId: string;
  /** Business label from the editor, if the author set one. */
  readonly label?: string;
}

export interface PlanNodeBase {
  readonly id: PlanNodeId;
  readonly origin: PlanNodeOrigin;
  /** Resolved by type inference before lowering; never inferred at run time. */
  readonly outputType: TableType;
  /**
   * Static-analysis facts contributed by optional plugins. They are plain,
   * versioned JSON and therefore part of plan serialization/hash identity.
   */
  readonly analysis?: readonly SemanticAnnotation[];
  /**
   * Actual-data facts required by static analysis. A sealing/runtime validator
   * enforces these; Backend does not re-infer them.
   */
  readonly constraints?: readonly PlanConstraint[];
}

/** Reads a bound input dataset by name. */
export interface InputPlanNode extends PlanNodeBase {
  readonly kind: "input";
  readonly dataset: string;
}

export interface FilterPlanNode extends PlanNodeBase {
  readonly kind: "filter";
  readonly source: PlanRef;
  readonly predicate: Expression;
}

/** Column selection and renaming. No computation. */
export interface ProjectPlanNode extends PlanNodeBase {
  readonly kind: "project";
  readonly source: PlanRef;
  readonly columns: readonly {
    readonly name: string;
    readonly from: string;
  }[];
}

/** Derived columns. Computation, no row cardinality change. */
export interface FormulaPlanNode extends PlanNodeBase {
  readonly kind: "formula";
  readonly source: PlanRef;
  readonly columns: readonly {
    readonly name: string;
    readonly expression: Expression;
    readonly type: ValueType;
  }[];
}

export type JoinType = "inner" | "left";

export type JoinCardinality =
  | "one-to-one"
  | "many-to-one"
  | "one-to-many"
  | "many-to-many";

export interface JoinKey {
  readonly left: string;
  readonly right: string;
}

export interface JoinPlanNode extends PlanNodeBase {
  readonly kind: "join";
  readonly left: PlanRef;
  readonly right: PlanRef;
  readonly joinType: JoinType;
  readonly keys: readonly JoinKey[];
  /**
   * Declared, then enforced at run time. A violated declaration fans out rows
   * silently and doubles a payout; it must fail the run, not warn.
   */
  readonly expectedCardinality: JoinCardinality;
  /** Prefix applied to right-side columns on collision. */
  readonly rightPrefix?: string;
}

export type LookupMissingPolicy = "error" | "null" | "default";
export type LookupMultiplePolicy = "error" | "first";

/**
 * A first-class operation, not sugar over join: its missing/ambiguous
 * semantics are the entire point, and a join cannot express them.
 */
export interface LookupPlanNode extends PlanNodeBase {
  readonly kind: "lookup";
  readonly source: PlanRef;
  readonly table: PlanRef;
  readonly keys: readonly JoinKey[];
  readonly outputs: readonly {
    readonly name: string;
    readonly from: string;
    /** Used only when `missingPolicy` is "default". */
    readonly defaultValue?: Expression;
  }[];
  readonly missingPolicy: LookupMissingPolicy;
  readonly multiplePolicy: LookupMultiplePolicy;
}

export interface DecisionRule {
  readonly id: string;
  readonly when: Expression;
  /** Keyed by output column name. */
  readonly outputs: Readonly<Record<string, Expression>>;
}

export interface DecisionPlanNode extends PlanNodeBase {
  readonly kind: "decision";
  readonly source: PlanRef;
  /** Evaluated in order; first match wins. Order is semantics, not style. */
  readonly rules: readonly DecisionRule[];
  readonly outputs: readonly {
    readonly name: string;
    readonly type: ValueType;
  }[];
  /**
   * What happens to a row no rule matched:
   *   "null"    keep the row, decision outputs are null
   *   "drop"    remove the row - changes cardinality, so it must be visible
   *             in the IR rather than hidden inside a backend
   *   "default" keep the row, fill from `defaults`
   *   "error"   fail the run
   */
  readonly onNoMatch: "null" | "drop" | "default" | "error";
  readonly defaults?: Readonly<Record<string, Expression>>;
}

export type AggregateFunction = "sum" | "count" | "min" | "max" | "avg";

export interface AggregationSpec {
  readonly name: string;
  readonly fn: AggregateFunction;
  /** Absent only for `count`. */
  readonly column?: string;
  readonly type: ValueType;
}

export interface AggregatePlanNode extends PlanNodeBase {
  readonly kind: "aggregate";
  readonly source: PlanRef;
  readonly groupBy: readonly string[];
  readonly aggregations: readonly AggregationSpec[];
  /** `avg` is the only unbounded operation; its precision must be declared. */
  readonly division: {
    readonly precision: number;
    readonly rounding: RoundingMode;
  };
}

export type AllocationAmount =
  | { readonly kind: "column"; readonly column: string }
  | { readonly kind: "expression"; readonly expression: Expression };

export interface AllocatePlanNode extends PlanNodeBase {
  readonly kind: "allocate";
  readonly source: PlanRef;
  readonly amount: AllocationAmount;
  readonly weight: Expression;
  readonly partitionBy: readonly string[];
  readonly output: string;
  /** Deterministic tie-break order for the remainder step. Never optional. */
  readonly sortBy: readonly string[];
  readonly policy: AllocationPolicy;
}

export interface AssertionSpec {
  readonly id: string;
  readonly expression: Expression;
  readonly message: string;
  readonly severity: "warning" | "error";
}

export interface ValidatePlanNode extends PlanNodeBase {
  readonly kind: "validate";
  readonly source: PlanRef;
  readonly assertions: readonly AssertionSpec[];
}

export interface OutputPlanNode extends PlanNodeBase {
  readonly kind: "output";
  readonly source: PlanRef;
  readonly name: string;
}

export type SemanticPlanNode =
  | InputPlanNode
  | FilterPlanNode
  | ProjectPlanNode
  | FormulaPlanNode
  | JoinPlanNode
  | LookupPlanNode
  | DecisionPlanNode
  | AggregatePlanNode
  | AllocatePlanNode
  | ValidatePlanNode
  | OutputPlanNode;

export type SemanticPlanNodeKind = SemanticPlanNode["kind"];

export interface SemanticPlanInput {
  readonly name: string;
  readonly schema: TableType;
}

export interface SemanticPlanParameter {
  readonly name: string;
  readonly type: ValueType;
}

export interface SemanticPlanOutput {
  readonly name: string;
  readonly from: PlanRef;
}

export interface SemanticPlan {
  readonly irVersion: typeof SEMANTIC_PLAN_VERSION;
  readonly pipelineId: string;
  readonly inputs: readonly SemanticPlanInput[];
  /**
   * Parameters the plan reads, with their types. Declared here so a plan is
   * self-describing: a backend can bind and type-check them without guessing,
   * and the declaration participates in the plan hash.
   */
  readonly parameters: readonly SemanticPlanParameter[];
  /** Analyzer contract/semantic versions used to accept and annotate this plan. */
  readonly analysis: SemanticPlanAnalysisIdentity;
  /** Topologically ordered: a node never references a later one. */
  readonly nodes: readonly SemanticPlanNode[];
  readonly outputs: readonly SemanticPlanOutput[];
}

/** The single output port every V0.1 node produces. */
export const DEFAULT_PORT = "out";

export function planRef(node: PlanNodeId, port: string = DEFAULT_PORT): PlanRef {
  return { node, port };
}

/** Direct upstream references of a node. Used for ordering and explain. */
export function planNodeSources(node: SemanticPlanNode): readonly PlanRef[] {
  switch (node.kind) {
    case "input":
      return [];
    case "join":
      return [node.left, node.right];
    case "lookup":
      return [node.source, node.table];
    default:
      return [node.source];
  }
}
