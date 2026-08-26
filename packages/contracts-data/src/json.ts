import { D, Decimal, decimalString, isDecimalString } from "./decimal.js";
import type { DecimalString } from "./decimal.js";
import { DataDiagnosticCode, PrismError } from "./diagnostics.js";

/**
 * The JSON boundary.
 *
 * Everything a resource spec contains must be representable as JSON, because
 * that is literally what a resource is: a document in a JSONB column or a
 * request body. A `Decimal`, a `Date`, a `bigint` or a bespoke value object
 * that slips into a spec survives in-memory storage and dies at the first real
 * database - which is exactly the bug that shipped in this codebase once
 * already, and the reason this module exists.
 *
 * Memory storage and PostgreSQL storage MUST agree on what a legal spec value
 * is. `assertJsonValue` is that shared definition, and both call it.
 */

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Encodes a domain value into its stored form and back.
 *
 * Explicit on both sides: an encoder without a decoder produces data nobody
 * can read back, and a decoder without an encoder invites two writers with
 * different opinions.
 */
export interface Codec<TDomain, TStored extends JsonValue = JsonValue> {
  readonly name: string;
  encode(value: TDomain): TStored;
  decode(value: TStored, path?: string): TDomain;
}

/** Canonical decimal codec. Every persisted decimal must go through this one. */
export const decimalCodec: Codec<Decimal, DecimalString> = {
  name: "decimal",
  encode(value) {
    if (!value.isFinite()) {
      throw PrismError.of(
        DataDiagnosticCode.DECIMAL_MALFORMED,
        `Cannot persist a non-finite decimal (${value.toString()}).`,
        { value: value.toString() },
      );
    }
    return decimalString(value);
  },
  decode(value, path) {
    if (!isDecimalString(value)) {
      throw PrismError.of(
        DataDiagnosticCode.DECIMAL_MALFORMED,
        `"${String(value)}" is not a valid decimal.`,
        path === undefined ? { value } : { value, path },
      );
    }
    return new D(value);
  },
};

const JSON_DEPTH_LIMIT = 64;

/**
 * Rejects anything that is not plain JSON, naming the offending path.
 *
 * Deliberately strict about the cases that look harmless and are not:
 *   - `undefined` disappears silently through `JSON.stringify`;
 *   - `NaN` and `Infinity` become `null`;
 *   - a `Decimal` or `Date` serializes to something that will not decode back
 *     into the type the domain claims it is.
 */
export function assertJsonValue(value: unknown, path = ""): asserts value is JsonValue {
  assertJsonValueAtDepth(value, path, 0);
}

function assertJsonValueAtDepth(value: unknown, path: string, depth: number): void {
  const at = path === "" ? "/" : path;
  if (depth > JSON_DEPTH_LIMIT) {
    throw invalid(`Value nests deeper than ${JSON_DEPTH_LIMIT} levels.`, at, value);
  }

  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalid(
          "Only finite numbers are storable; NaN and Infinity become null in JSON.",
          at,
          value,
        );
      }
      return;
    case "undefined":
      throw invalid(
        "`undefined` is not storable; JSON drops the key silently. Use null or omit it.",
        at,
        value,
      );
    case "bigint":
      throw invalid("`bigint` is not storable; encode it as a string.", at, value);
    case "function":
    case "symbol":
      throw invalid(`A ${typeof value} is not storable.`, at, value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValueAtDepth(item, `${path}/${index}`, depth + 1));
    return;
  }

  if (Decimal.isDecimal(value)) {
    throw invalid(
      "A Decimal is not storable directly; encode it with `decimalCodec` first.",
      at,
      String(value),
    );
  }
  if (value instanceof Date) {
    throw invalid(
      "A Date is not storable directly; encode it as an ISO string.",
      at,
      value.toISOString(),
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(
      `A ${(value as object).constructor?.name ?? "class"} instance is not storable; encode it explicitly.`,
      at,
      undefined,
    );
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertJsonValueAtDepth(item, `${path}/${key}`, depth + 1);
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

function invalid(message: string, path: string, value: unknown): PrismError {
  return PrismError.of(DataDiagnosticCode.NOT_JSON_STORABLE, message, { path, value });
}
