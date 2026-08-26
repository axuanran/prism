import { Decimal } from "decimal.js";
import { DataDiagnosticCode, PrismError } from "./diagnostics.js";

/**
 * Money and coefficient semantics.
 *
 * Rule: amounts, point values, coefficients and allocations are NEVER JS
 * numbers. Floating point loses cents, and a lost cent in a financial allocation
 * is a reconciliation failure, not a rounding curiosity.
 */

export { Decimal };

/** Configured clone: high precision intermediate, explicit rounding at the edges. */
export const D = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});

export type DecimalValue = Decimal;

export type RoundingMode =
  | "half-up"
  | "half-even"
  | "half-down"
  | "up"
  | "down"
  | "ceiling"
  | "floor";

const ROUNDING_MODES: Record<RoundingMode, Decimal.Rounding> = {
  "half-up": Decimal.ROUND_HALF_UP,
  "half-even": Decimal.ROUND_HALF_EVEN,
  "half-down": Decimal.ROUND_HALF_DOWN,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
  ceiling: Decimal.ROUND_CEIL,
  floor: Decimal.ROUND_FLOOR,
};

/** How a value is reduced to a storable/reportable precision. */
export interface RoundingPolicy {
  /** Digits after the decimal point. */
  readonly scale: number;
  readonly mode: RoundingMode;
}

export const DEFAULT_ROUNDING: RoundingPolicy = { scale: 2, mode: "half-up" };

/** Division needs its own working precision; it is the only unbounded op. */
export interface DivisionPolicy {
  readonly precision: number;
  readonly mode: RoundingMode;
  /** Division by zero: fail loudly by default. */
  readonly onDivideByZero: "error" | "null";
}

export const DEFAULT_DIVISION: DivisionPolicy = {
  precision: 28,
  mode: "half-up",
  onDivideByZero: "error",
};

export function toDecimal(value: Decimal.Value): Decimal {
  return new D(value);
}

export function roundDecimal(value: Decimal, policy: RoundingPolicy): Decimal {
  return value.toDecimalPlaces(policy.scale, ROUNDING_MODES[policy.mode]);
}

export function decimalRounding(mode: RoundingMode): Decimal.Rounding {
  return ROUNDING_MODES[mode];
}

/** Canonical serialization: plain decimal string, never exponent notation. */
export function decimalToJson(value: Decimal): string {
  return value.toFixed();
}

/**
 * A decimal held in its serialized form.
 *
 * Stored configuration is JSON. A type that claims `Decimal` for a field that
 * will be `JSON.parse`d is a lie the compiler cannot catch, and it surfaces at
 * the first `value.toFixed(...)` after a round trip - which is precisely how
 * this type came to exist. Persisted and wire-facing decimals are
 * `DecimalString`; only in-memory computation uses `Decimal`.
 *
 * Branded so the conversion must be written down rather than assumed.
 */
export type DecimalString = string & { readonly __brand: "DecimalString" };

export function decimalString(value: Decimal | string | number): DecimalString {
  const decimal = value instanceof Decimal ? value : new D(value);
  return decimal.toFixed() as DecimalString;
}

export function isDecimalString(value: unknown): value is DecimalString {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    // `isFinite` rather than `!isNaN`: decimal.js parses "Infinity" happily,
    // and an infinite point value would propagate through an entire payout
    // before anyone noticed.
    return new D(value).isFinite();
  } catch {
    return false;
  }
}

/**
 * Parses a stored decimal. Fails loudly: a malformed stored value must not
 * become NaN and silently poison an aggregate.
 */
export function parseDecimalString(
  value: DecimalString | string,
  path?: string,
): Decimal {
  const parsed = isDecimalString(value) ? new D(value) : undefined;
  if (parsed === undefined) {
    throw PrismError.of(
      DataDiagnosticCode.DECIMAL_MALFORMED,
      `"${value}" is not a valid decimal.`,
      path === undefined ? { value } : { value, path },
    );
  }
  return parsed;
}
