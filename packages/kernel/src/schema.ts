import type { Diagnostic } from "@prismengine/contracts-data";

/**
 * Configuration contracts are serializable JSON Schema 2020-12 documents.
 * Serializable is non-negotiable: the studio renders them in the browser and
 * they are persisted alongside resource revisions.
 *
 * Authoring happens with TypeBox inside plugins; the engine only ever sees the
 * plain schema object plus a validator function.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export const VALID: ValidationResult = Object.freeze({
  valid: true,
  diagnostics: Object.freeze([]),
});

/**
 * Semantic validation beyond the JSON Schema shape: cross-field rules,
 * referential checks, business invariants.
 */
export type Validator<TSpec = unknown> = (
  spec: TSpec,
  context: ValidationContext,
) => ValidationResult | Promise<ValidationResult>;

export interface ValidationContext {
  /** Resolve another resource by id, e.g. to check a reference target exists. */
  readonly resolveResource: (
    kind: string,
    id: string,
  ) => Promise<{ readonly id: string; readonly spec: unknown } | null>;
}

/**
 * A configuration contract: what business users are allowed to configure.
 * Never a mirror of a service signature.
 */
export interface ConfigurationContract<TSpec = unknown> {
  readonly schema: JsonSchema;
  readonly validate?: Validator<TSpec>;
  readonly defaults?: Partial<TSpec>;
}
