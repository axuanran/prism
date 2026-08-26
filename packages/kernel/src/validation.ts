import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { VALID } from "./schema.js";
import type { ValidationContext, ValidationResult } from "./schema.js";
import type { ResourceTypeDefinition } from "./resource.js";
import type { Diagnostic } from "@prism/contracts-data";

/**
 * TypeBox validates `format` only for formats that were registered, and
 * treats an unregistered one as a failure rather than ignoring it. Without
 * this, every schema using `format: "date"` - which is most configuration
 * contracts in this repo - rejects all input with "Unknown format".
 *
 * Registered centrally so a plugin authoring a schema never has to know.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Calendar-exact: `Date.parse("2026-02-30")` succeeds by rolling over to
 * March 2nd, so a parse check alone accepts dates that do not exist. The
 * round trip is what rejects them.
 */
function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;

  const [, year, month, day] = match;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}

const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  date: isCalendarDate,
  "date-time": (value) => !Number.isNaN(Date.parse(value)),
  time: (value) => ISO_TIME.test(value),
  uuid: (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
};

for (const [name, check] of Object.entries(FORMATS)) {
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, check);
}

/**
 * Resource validation lives here, not in each transport handler.
 *
 * A resource spec must be validated identically whether it arrives over HTTP,
 * from a seed script, from a CLI or from another plugin. Duplicating the check
 * per entry point guarantees the entry points eventually disagree, and the one
 * that skips validation is the one that corrupts stored configuration.
 *
 * Two layers, in order:
 *   1. shape - the JSON Schema of the configuration contract;
 *   2. semantics - the contract's own `validate`, which may hit references.
 * Semantic validation is skipped when the shape is already wrong: a validator
 * handed a malformed spec produces noise, not information.
 */

export const ResourceValidationCode = {
  SCHEMA_VIOLATION: "RESOURCE_SCHEMA_VIOLATION",
} as const;

export function validateAgainstSchema(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): readonly Diagnostic[] {
  const errors = [...Value.Errors(schema as TSchema, value)];
  return errors.map((error) => ({
    code: ResourceValidationCode.SCHEMA_VIOLATION,
    severity: "error" as const,
    message: error.message,
    path: error.path === "" ? "/" : error.path,
    details: { value: error.value, schemaPath: error.schema.$id ?? undefined },
  }));
}

/**
 * Generic in the spec type: `Validator<TSpec>` is contravariant in `TSpec`, so
 * a `ResourceTypeDefinition<PerformanceScheme>` is not assignable to
 * `ResourceTypeDefinition<unknown>`. Erasing it at the parameter would force
 * every caller to cast at the boundary that is supposed to be doing the
 * checking.
 */
export async function validateResourceSpec<TSpec>(
  definition: ResourceTypeDefinition<TSpec>,
  spec: unknown,
  context: ValidationContext,
): Promise<ValidationResult> {
  const shape = validateAgainstSchema(definition.config.schema, spec);
  if (shape.length > 0) return { valid: false, diagnostics: shape };

  const semantic = definition.config.validate;
  if (!semantic) return VALID;

  // The schema check above is exactly what earns this cast: the shape has
  // been verified against the contract that declares `TSpec`.
  return semantic(spec as TSpec, context);
}
