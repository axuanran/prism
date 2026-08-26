import type { TableType, ValueType } from "@prism/contracts-data";
import type { AnalyzerRequirement } from "./analysis.js";

/**
 * Pipeline specification: what a business user builds in the editor and what
 * gets stored as a resource revision. Pure data - no functions, no class
 * instances - so it round-trips through JSON, the database and the diff view.
 */

export interface PipelineInput {
  readonly name: string;
  /** Declared schema. Runtime input is checked against it, not inferred from it. */
  readonly schema: TableType;
  readonly description?: string;
}

export interface PipelineOutput {
  readonly name: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly description?: string;
}

/**
 * A scalar bound at run time rather than authored into the pipeline, e.g. the
 * period's point value or a budget total. Declared so validation can reject an
 * unknown reference before any data is read, and so the lowered plan can be
 * typed and hashed.
 */
export interface PipelineParameter {
  readonly name: string;
  readonly type: ValueType;
  readonly description?: string;
}

export interface PipelineNode {
  readonly id: string;
  /** Operation id from the registry, e.g. "calculation.join". */
  readonly operation: string;
  /** Operation-specific configuration, validated against the operation's schema. */
  readonly config: unknown;
  /** Business-facing label shown in the editor and the trace. */
  readonly label?: string;
  /** Editor canvas position. Semantically irrelevant; kept for round-tripping. */
  readonly position?: { readonly x: number; readonly y: number };
}

export interface PipelineEdge {
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

export interface PipelineSpec {
  readonly id: string;
  readonly inputs: readonly PipelineInput[];
  /**
   * Optional because a stored pipeline authored before parameters existed, or
   * one that simply uses none, is complete without the key. Absent means "no
   * parameters", which is unambiguous - there is no second representation.
   */
  readonly parameters?: readonly PipelineParameter[];
  /**
   * Safety analyzers whose absence makes compilation invalid. Requirements
   * identify analyzer semantics separately from package versions.
   */
  readonly requiredAnalyzers?: readonly AnalyzerRequirement[];
  readonly nodes: readonly PipelineNode[];
  readonly edges: readonly PipelineEdge[];
  readonly outputs: readonly PipelineOutput[];
}

/** Port kinds. A scalar port carries one value; a table port carries a dataset. */
export type PortKind = "table" | "scalar";

export interface PortDefinition {
  readonly name: string;
  readonly kind: PortKind;
  readonly required: boolean;
  readonly title?: string;
  readonly description?: string;
}

/** Resolved schema of every port after type inference. */
export interface PortSchema {
  readonly nodeId: string;
  readonly port: string;
  readonly type: ValueType;
}
