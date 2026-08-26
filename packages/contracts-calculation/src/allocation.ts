import type { RoundingMode } from "@prismengine/contracts-data";

/**
 * Allocation policy.
 *
 * Distributing 1,000,000 across 37 departments by weight leaves a remainder
 * after rounding. Leaving that undefined produces non-reproducible payouts and
 * a reconciliation failure that only surfaces in production. The policy is
 * therefore part of the contract, and conservation is a property test, not a
 * comment.
 *
 * Invariant, enforced by the runtime:
 *   sum(allocated parts) === total, exactly, at the configured scale.
 */

export type RemainderPolicy =
  /**
   * Give the leftover minor units to the rows with the largest truncated
   * fraction, one unit each, in descending order. Ties break by the row's
   * position in a deterministic sort - never by hash iteration order.
   */
  | { readonly kind: "largest-remainder" }
  /** Push the whole remainder onto one designated row. */
  | { readonly kind: "to-row"; readonly rowKey: string }
  /** Refuse to allocate. Correct when a silent adjustment is unacceptable. */
  | { readonly kind: "reject" };

export interface AllocationPolicy {
  /** Scale of the produced amounts, e.g. 2 for CNY. */
  readonly scale: number;
  readonly rounding: RoundingMode;
  readonly remainder: RemainderPolicy;
  /**
   * What to do when every weight in a partition is zero or the weights sum to
   * zero. `equal` splits evenly; `zero` allocates nothing and reports the
   * unallocated total; `error` fails the run.
   */
  readonly onZeroWeight: "equal" | "zero" | "error";
  /** Negative weights are a data error far more often than an intent. */
  readonly allowNegativeWeights?: boolean;
}

export const DEFAULT_ALLOCATION_POLICY: AllocationPolicy = Object.freeze({
  scale: 2,
  rounding: "half-up",
  remainder: { kind: "largest-remainder" as const },
  onZeroWeight: "error",
  allowNegativeWeights: false,
});

export const CalculationDiagnosticCode = {
  EXPRESSION_PARSE_ERROR: "EXPRESSION_PARSE_ERROR",
  EXPRESSION_TYPE_ERROR: "EXPRESSION_TYPE_ERROR",
  EXPRESSION_UNKNOWN_FIELD: "EXPRESSION_UNKNOWN_FIELD",
  EXPRESSION_UNKNOWN_FUNCTION: "EXPRESSION_UNKNOWN_FUNCTION",
  DIVISION_BY_ZERO: "DIVISION_BY_ZERO",
  PIPELINE_CYCLE: "PIPELINE_CYCLE",
  PIPELINE_PORT_UNCONNECTED: "PIPELINE_PORT_UNCONNECTED",
  PIPELINE_PORT_UNKNOWN: "PIPELINE_PORT_UNKNOWN",
  PIPELINE_DUPLICATE_NODE: "PIPELINE_DUPLICATE_NODE",
  PIPELINE_SCHEMA_MISMATCH: "PIPELINE_SCHEMA_MISMATCH",
  OPERATION_UNKNOWN: "OPERATION_UNKNOWN",
  OPERATION_CONFIG_INVALID: "OPERATION_CONFIG_INVALID",
  JOIN_CARDINALITY_VIOLATION: "JOIN_CARDINALITY_VIOLATION",
  JOIN_KEY_TYPE_MISMATCH: "JOIN_KEY_TYPE_MISMATCH",
  LOOKUP_MISSING: "LOOKUP_MISSING",
  LOOKUP_AMBIGUOUS: "LOOKUP_AMBIGUOUS",
  DECISION_NO_MATCH: "DECISION_NO_MATCH",
  AGGREGATE_GRAIN_CONFLICT: "AGGREGATE_GRAIN_CONFLICT",
  ALLOCATION_CONSERVATION_VIOLATION: "ALLOCATION_CONSERVATION_VIOLATION",
  ALLOCATION_ZERO_WEIGHT: "ALLOCATION_ZERO_WEIGHT",
  ALLOCATION_NEGATIVE_WEIGHT: "ALLOCATION_NEGATIVE_WEIGHT",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  EXECUTION_CANCELLED: "EXECUTION_CANCELLED",
  ANALYSIS_EXTENSION_CONFLICT: "ANALYSIS_EXTENSION_CONFLICT",
  REQUIRED_ANALYZER_MISSING: "REQUIRED_ANALYZER_MISSING",
  ANALYZER_ID_DUPLICATE: "ANALYZER_ID_DUPLICATE",
  ANALYSIS_CONSTRAINT_INVALID: "ANALYSIS_CONSTRAINT_INVALID",
} as const;

export type CalculationDiagnosticCode =
  (typeof CalculationDiagnosticCode)[keyof typeof CalculationDiagnosticCode];
