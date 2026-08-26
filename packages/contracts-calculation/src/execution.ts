import type {
  Dataset,
  Diagnostic,
  Decimal,
  InputSnapshot,
  Row,
  VersionStamp,
} from "@prismengine/contracts-data";

/**
 * Execution and trace.
 *
 * Trace is the mechanism behind "why is this number what it is?". Storing a
 * full trace for 10k subjects x 50 metrics is neither affordable nor useful,
 * so the default is summary-level, and a per-subject full trace is produced by
 * deterministic re-execution against the run's pin.
 */

export type TraceLevel = "none" | "errors" | "summary" | "full";

export interface ExecutionOptions {
  readonly traceLevel?: TraceLevel;
  /** Cap on rows materialized for previews. Ignored for real runs. */
  readonly previewRowLimit?: number;
  /** Hard wall-clock budget; the runtime aborts and reports partial trace. */
  readonly timeoutMs?: number;
}

/** A scalar bound at run time. Decimal, never a JS number, for money. */
export type ParameterValue = string | number | boolean | Decimal;

export type ParameterBindings = Readonly<Record<string, ParameterValue>>;

export interface CalculationInput {
  /** Keyed by `PipelineInput.name`. */
  readonly datasets: Readonly<Record<string, Dataset>>;
  /** Scalar parameters, e.g. period start, point value. */
  readonly parameters?: ParameterBindings;
}

export type NodeTracePhase = "ok" | "skipped" | "error";

/** Operation-specific trace detail. Discriminated so the UI can render it. */
export type NodeTraceDetail =
  | { readonly kind: "join"; readonly expected: string; readonly actual: string; readonly unmatchedLeft: number; readonly unmatchedRight: number }
  | { readonly kind: "lookup"; readonly matched: number; readonly missing: number; readonly ambiguous: number }
  | { readonly kind: "decision"; readonly matchedRules: Readonly<Record<string, number>>; readonly unmatched: number }
  | { readonly kind: "aggregate"; readonly groups: number }
  | { readonly kind: "allocate"; readonly inputTotal: string; readonly outputTotal: string; readonly remainder: string }
  | { readonly kind: "validate"; readonly failures: number }
  | { readonly kind: "generic" };

export interface NodeTrace {
  readonly nodeId: string;
  readonly operation: string;
  readonly label?: string;
  readonly phase: NodeTracePhase;
  readonly inputRows: number;
  readonly outputRows: number;
  readonly durationMs: number;
  readonly detail: NodeTraceDetail;
  readonly diagnostics: readonly Diagnostic[];
  /** Populated only at `full` trace level. */
  readonly sampleRows?: readonly Row[];
}

export interface ExecutionTrace {
  readonly level: TraceLevel;
  readonly nodes: readonly NodeTrace[];
  readonly totalDurationMs: number;
}

export type ExecutionStatus = "success" | "failed";

export interface ExecutionResult {
  readonly status: ExecutionStatus;
  /** Keyed by `PipelineOutput.name`. */
  readonly outputs: Readonly<Record<string, Dataset>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly trace: ExecutionTrace;
  /** Fingerprints of the data actually consumed. Feeds `RunPin.input`. */
  readonly input: InputSnapshot;
  readonly versions: VersionStamp;
  readonly planHash: string;
}

/**
 * Per-node execution services are deliberately NOT part of this contract.
 * Operations no longer execute: they lower to `SemanticPlanNode`, and each
 * `CalculationBackend` owns its own internal executor shape. A shared
 * execution-context interface here would quietly re-couple every backend to
 * the JS one's runtime model.
 */
