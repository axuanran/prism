import type {
  CallContext,
  Dataset,
  Diagnostic,
  VersionStamp,
} from "@prismengine/contracts-data";
import { defineExtensionPoint } from "@prismengine/kernel";
import type { SemanticPlan, SemanticPlanNode } from "./semantic-plan.js";
import type { ExecutionOptions, ExecutionResult, ParameterBindings } from "./execution.js";

/**
 * Execution backends.
 *
 * The backend is the only thing that knows how a plan physically runs.
 * V0.1 ships a TypeScript in-memory backend; a Rust/Arrow/DataFusion backend
 * plugs in here later without a single operation being rewritten.
 *
 * V0.1 selects ONE backend for the whole plan. `supports()` is a capability
 * question, not an invitation to hop backends per node: partitioning a plan
 * across backends drags in boundary materialization, Arrow ownership, trace
 * merging and error attribution all at once. That is a later, deliberate
 * feature - `BackendPlanPartitioner` - not a side effect of this interface.
 */

export interface CompileContext {
  readonly call: CallContext;
  /** Hash of the semantic plan plus operation and engine versions. */
  readonly planHash: string;
  readonly versions: VersionStamp;
}

/**
 * A backend's compiled artifact. Opaque to everyone but its own backend; the
 * `backendId` is what stops a plan compiled by one backend being executed by
 * another.
 */
export interface ExecutablePlan {
  readonly backendId: string;
  readonly planHash: string;
}

/**
 * Everything a plan is executed against. Bindings are inputs, not execution
 * options, so they travel beside the plan rather than inside the context.
 */
export interface PlanBindings {
  /** Keyed by `SemanticPlanInput.name`. */
  readonly datasets: Readonly<Record<string, Dataset>>;
  /** Keyed by `SemanticPlanParameter.name`. */
  readonly parameters: ParameterBindings;
}

export interface BackendExecutionContext {
  readonly call: CallContext;
  readonly options: ExecutionOptions;
}

export interface CalculationBackend {
  readonly id: string;
  /**
   * Bumped whenever this backend's results can change. Recorded in every
   * run's version stamp, because a backend swap or upgrade is exactly the
   * kind of change a replay must be able to detect.
   */
  readonly version: string;

  /**
   * Whether this backend can execute the node itself. A backend that cannot
   * run every node of a plan is simply not selected for that plan in V0.1.
   */
  supports(node: SemanticPlanNode): boolean;

  compile(plan: SemanticPlan, context: CompileContext): Promise<ExecutablePlan>;

  execute(
    plan: ExecutablePlan,
    bindings: PlanBindings,
    context: BackendExecutionContext,
  ): Promise<ExecutionResult>;
}

/** Backends are contributed by plugins; the kernel knows nothing about them. */
export const BackendExtensionPoint = defineExtensionPoint<CalculationBackend>({
  id: "calculation.backends",
  version: "1.0.0",
});

/** True when the backend can run every node of the plan. */
export function backendSupportsPlan(
  backend: CalculationBackend,
  plan: SemanticPlan,
): boolean {
  return plan.nodes.every((node) => backend.supports(node));
}

export interface BackendSelection {
  readonly backend: CalculationBackend;
  readonly diagnostics: readonly Diagnostic[];
}
