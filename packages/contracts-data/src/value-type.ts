import type { Decimal } from "./decimal.js";
import type { SemanticAnnotation } from "./semantic-annotation.js";

/**
 * The data type model shared by the calculation runtime, resource schemas and
 * the studio renderer. Deliberately small: nine kinds, plus annotations that
 * carry business meaning without inventing a type lattice.
 */

export type ValueKind =
  | "null"
  | "boolean"
  | "int"
  | "decimal"
  | "string"
  | "date"
  | "datetime"
  | "object"
  | "table";

/**
 * Business annotations. V0.1 propagates them and checks only what is cheap
 * (`grain` on aggregation, `key` on join). It never silently drops them.
 */
export interface TypeAnnotations {
  /** ISO 4217-ish currency tag, e.g. "CNY". */
  readonly currency?: string;
  /** Free unit label, e.g. "人次", "点". */
  readonly unit?: string;
  /** Row granularity, e.g. "person-month". Aggregations change it. */
  readonly grain?: string;
  /** Marks a column as an identity/join key. */
  readonly key?: boolean;
  /** Semantic hint driving studio editor selection, e.g. "prism.expression". */
  readonly semantic?: string;
}

export interface ValueTypeBase {
  readonly kind: ValueKind;
  readonly nullable?: boolean;
  readonly annotations?: TypeAnnotations;
  /** Typed, versioned meanings supplied by optional analysis plugins. */
  readonly semanticAnnotations?: readonly SemanticAnnotation[];
}

export interface ScalarType extends ValueTypeBase {
  readonly kind: "null" | "boolean" | "int" | "string" | "date" | "datetime";
}

/**
 * Decimal is a COLUMN-level type: precision and scale are fixed by the schema,
 * not carried per value.
 *
 * Both are required. Arrow and DataFusion model decimals as `Decimal128(p, s)`
 * at the column level, so a scale that is only known once a row arrives cannot
 * be represented at the native boundary at all - the column would degrade to
 * strings. Requiring them here makes that class of surprise a compile error
 * instead of a boundary bug.
 */
export interface DecimalType extends ValueTypeBase {
  readonly kind: "decimal";
  /** Total significant digits. Must fit Decimal128: 1..38. */
  readonly precision: number;
  /** Digits after the point. 0 <= scale <= precision. */
  readonly scale: number;
}

/** Money at 2 decimal places - the default for CNY amounts. */
export const MONEY_TYPE: DecimalType = Object.freeze({
  kind: "decimal",
  precision: 28,
  scale: 2,
});

/** Ratios and coefficients, where more fractional digits are normal. */
export const RATIO_TYPE: DecimalType = Object.freeze({
  kind: "decimal",
  precision: 28,
  scale: 6,
});

export const MAX_DECIMAL_PRECISION = 38;

export function decimalType(precision: number, scale: number): DecimalType {
  return { kind: "decimal", precision, scale };
}

/** Structural check used by schema validation and dataset writes. */
export function isValidDecimalType(type: DecimalType): boolean {
  return (
    Number.isInteger(type.precision) &&
    Number.isInteger(type.scale) &&
    type.precision >= 1 &&
    type.precision <= MAX_DECIMAL_PRECISION &&
    type.scale >= 0 &&
    type.scale <= type.precision
  );
}

export interface ObjectType extends ValueTypeBase {
  readonly kind: "object";
  readonly fields: readonly FieldType[];
}

export interface TableType extends ValueTypeBase {
  readonly kind: "table";
  readonly columns: readonly FieldType[];
}

export type ValueType = ScalarType | DecimalType | ObjectType | TableType;

export interface FieldType {
  readonly name: string;
  readonly type: ValueType;
}

/** Runtime values carried between pipeline nodes. */
export type ScalarValue = null | boolean | number | string | Decimal | Date;

export type RowValue = ScalarValue | Row;

export interface Row {
  readonly [column: string]: RowValue;
}

/**
 * Explicit materialized escape-hatch table shape. Capability and execution
 * boundaries use Arrow-backed `Dataset`; this shape is only for callers that
 * knowingly pay the row-object allocation cost.
 */
export interface Table {
  readonly type: TableType;
  readonly rows: readonly Row[];
}

export function tableType(columns: readonly FieldType[]): TableType {
  return { kind: "table", columns };
}

export function findColumn(
  type: TableType,
  name: string,
): FieldType | undefined {
  return type.columns.find((c) => c.name === name);
}

export function formatValueType(type: ValueType): string {
  switch (type.kind) {
    case "decimal":
      return `decimal(${type.precision},${type.scale})`;
    case "object":
      return `object{${type.fields.map((f) => f.name).join(",")}}`;
    case "table":
      return `table{${type.columns
        .map((c) => `${c.name}:${formatValueType(c.type)}`)
        .join(",")}}`;
    default:
      return type.kind;
  }
}
