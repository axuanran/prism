import type {
  CallContext,
  Diagnostic,
  ValueType,
  VersionStamp,
} from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";
import type { ValidationResult } from "@prismengine/kernel";
import type { PortSchema, PipelineSpec } from "./pipeline.js";
import type { SemanticPlan } from "./semantic-plan.js";
import type { CalculationInput, ExecutionOptions, ExecutionResult } from "./execution.js";
import type { OperationDescriptor } from "./operation.js";
import type { CompiledExpression, ExpressionSpec, FunctionSignature } from "./expression.js";

/**
 * The calculation capability: the generic technical capability every vertical
 * business plugin composes with.
 *
 * validate -> compile -> execute is a hard sequence. `compile` produces a plan
 * with a stable hash; the hash plus the input fingerprint plus the version
 * stamp is what makes a run replayable.
 */

export interface CompiledPipeline {
  readonly pipelineId: string;
  /**
   * The semantic IR. Carried on the compiled pipeline because everything
   * downstream - explain, preview, replay, a future backend swap - must read
   * the same plan the run executed, not re-derive one from the spec.
   */
  readonly plan: SemanticPlan;
  /** hash(SemanticPlan + operation versions + engine version). */
  readonly planHash: string;
  readonly versions: VersionStamp;
  /** Which backend was selected for the whole plan. */
  readonly backendId: string;
  /** Inferred schema of every port; drives editor previews and downstream checks. */
  readonly schemas: readonly PortSchema[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface PlanStepExplanation {
  readonly nodeId: string;
  readonly operation: string;
  readonly label?: string;
  readonly dependsOn: readonly string[];
  /** Human-readable summary of what the step does, in business terms. */
  readonly summary: string;
}

export interface PlanExplanation {
  readonly planHash: string;
  readonly steps: readonly PlanStepExplanation[];
}

export interface CalculationCapability {
  /** Static validation: schema, types, ports, cycles. Reads no data. */
  validatePipeline(
    context: CallContext,
    spec: PipelineSpec,
  ): Promise<ValidationResult>;

  compilePipeline(
    context: CallContext,
    spec: PipelineSpec,
  ): Promise<CompiledPipeline>;

  executePipeline(
    context: CallContext,
    plan: CompiledPipeline,
    input: CalculationInput,
    options?: ExecutionOptions,
  ): Promise<ExecutionResult>;

  explainPlan(context: CallContext, plan: CompiledPipeline): Promise<PlanExplanation>;

  /** Editor palette and studio rendering. Never exposes operation internals. */
  listOperations(context: CallContext): readonly OperationDescriptor[];

  /** Standalone expression support, used by config editors for live feedback. */
  compileExpression(
    context: CallContext,
    spec: ExpressionSpec,
    scope: Readonly<Record<string, ValueType>>,
  ): CompiledExpression | { readonly diagnostics: readonly Diagnostic[] };

  listFunctions(context: CallContext): readonly FunctionSignature[];
}

export const CalculationCapabilityToken = defineCapability<CalculationCapability>({
  id: "calculation",
  version: "1.0.0",
});
