/**
 * Structured diagnostics.
 *
 * Rule: no engine or plugin may surface an unstructured error string.
 * `code` is stable and machine-readable; `message` is a developer-facing
 * default. Localization happens in the presentation layer, keyed by `code`.
 */

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  /** Stable, screaming-snake-case identifier. Never localized. */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  /** Developer-facing default text. UI should prefer a `code` translation. */
  readonly message: string;
  /** Pipeline node that produced the diagnostic, when applicable. */
  readonly nodeId?: string;
  /** JSON pointer-ish path into the offending configuration or row. */
  readonly path?: string;
  /** Structured parameters for localization and debugging. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Engine-level diagnostic codes. Plugins own their own namespaces. */
export const EngineDiagnosticCode = {
  CAPABILITY_MISSING: "CAPABILITY_MISSING",
  CAPABILITY_VERSION_MISMATCH: "CAPABILITY_VERSION_MISMATCH",
  CAPABILITY_DUPLICATE_PROVIDER: "CAPABILITY_DUPLICATE_PROVIDER",
  CAPABILITY_UNDECLARED_ACCESS: "CAPABILITY_UNDECLARED_ACCESS",
  CAPABILITY_NOT_PROVIDED: "CAPABILITY_NOT_PROVIDED",
  PLUGIN_DEPENDENCY_CYCLE: "PLUGIN_DEPENDENCY_CYCLE",
  PLUGIN_DUPLICATE_ID: "PLUGIN_DUPLICATE_ID",
  PLUGIN_REGISTER_FAILED: "PLUGIN_REGISTER_FAILED",
  PLUGIN_START_FAILED: "PLUGIN_START_FAILED",
  PLUGIN_STOP_FAILED: "PLUGIN_STOP_FAILED",
  RESOURCE_TYPE_DUPLICATE: "RESOURCE_TYPE_DUPLICATE",
  RESOURCE_TYPE_UNKNOWN: "RESOURCE_TYPE_UNKNOWN",
  OPERATION_DUPLICATE: "OPERATION_DUPLICATE",
  OPERATION_UNKNOWN: "OPERATION_UNKNOWN",
  API_ROUTE_DUPLICATE: "API_ROUTE_DUPLICATE",
  LIFECYCLE_PHASE_VIOLATION: "LIFECYCLE_PHASE_VIOLATION",
  EXTENSION_POINT_VERSION_MISMATCH: "EXTENSION_POINT_VERSION_MISMATCH",
} as const;

export type EngineDiagnosticCode =
  (typeof EngineDiagnosticCode)[keyof typeof EngineDiagnosticCode];

/** Data-layer codes: malformed values crossing a serialization boundary. */
export const DataDiagnosticCode = {
  DECIMAL_MALFORMED: "DECIMAL_MALFORMED",
  DECIMAL_RESCALE_LOSS: "DECIMAL_RESCALE_LOSS",
  NOT_JSON_STORABLE: "NOT_JSON_STORABLE",
  SEMANTIC_ANNOTATION_INVALID: "SEMANTIC_ANNOTATION_INVALID",
  SEMANTIC_ANNOTATION_VERSION_MISMATCH: "SEMANTIC_ANNOTATION_VERSION_MISMATCH",
} as const;

export type DataDiagnosticCode =
  (typeof DataDiagnosticCode)[keyof typeof DataDiagnosticCode];

export function diagnostic(
  code: string,
  message: string,
  extra: Omit<Diagnostic, "code" | "message" | "severity"> & {
    severity?: DiagnosticSeverity;
  } = {},
): Diagnostic {
  const { severity = "error", ...rest } = extra;
  return { code, severity, message, ...rest };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/**
 * Error carrying structured diagnostics across a throw boundary.
 * Thrown only where a call cannot meaningfully return a diagnostic list.
 */
export class PrismError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[] | Diagnostic, message?: string) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics as Diagnostic];
    super(message ?? list.map((d) => `[${d.code}] ${d.message}`).join("; "));
    this.name = "PrismError";
    this.diagnostics = list;
  }

  static of(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PrismError {
    return new PrismError(diagnostic(code, message, { details }));
  }
}

/** Mutable accumulator used by validators. */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  add(item: Diagnostic): this {
    this.items.push(item);
    return this;
  }

  error(code: string, message: string, extra: Partial<Diagnostic> = {}): this {
    return this.add({ ...extra, code, message, severity: "error" });
  }

  warn(code: string, message: string, extra: Partial<Diagnostic> = {}): this {
    return this.add({ ...extra, code, message, severity: "warning" });
  }

  addAll(items: readonly Diagnostic[]): this {
    this.items.push(...items);
    return this;
  }

  get hasErrors(): boolean {
    return hasErrors(this.items);
  }

  get length(): number {
    return this.items.length;
  }

  toArray(): readonly Diagnostic[] {
    return [...this.items];
  }

  throwIfErrors(message?: string): void {
    if (this.hasErrors) throw new PrismError(this.toArray(), message);
  }
}
