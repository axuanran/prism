import * as arrow from "apache-arrow";
import { D, Decimal } from "./decimal.js";
import { diagnostic, PrismError } from "./diagnostics.js";
import {
  canonicalSemanticAnnotations,
  parseSemanticAnnotations,
} from "./semantic-annotation.js";
import {
  isValidDecimalType,
  type FieldType,
  type RowValue,
  type TableType,
  type TypeAnnotations,
  type ValueType,
} from "./value-type.js";

export const ArrowDiagnosticCode = {
  TYPE_NOT_REPRESENTABLE: "DATA_ARROW_TYPE_NOT_REPRESENTABLE",
  TYPE_UNSUPPORTED: "DATA_ARROW_TYPE_UNSUPPORTED",
  DECIMAL_TYPE_INVALID: "DATA_ARROW_DECIMAL_TYPE_INVALID",
  DECIMAL_RESCALE_LOSS: "DATA_ARROW_DECIMAL_RESCALE_LOSS",
  DECIMAL_PRECISION_EXCEEDED: "DATA_ARROW_DECIMAL_PRECISION_EXCEEDED",
  VALUE_INVALID: "DATA_ARROW_VALUE_INVALID",
  SCHEMA_INVALID: "DATA_ARROW_SCHEMA_INVALID",
  BATCH_BUILD_FAILED: "DATA_ARROW_BATCH_BUILD_FAILED",
} as const;

const METADATA_PREFIX = "prism.type.";
const NULLABLE_METADATA = `${METADATA_PREFIX}nullable`;
const ANNOTATIONS_PRESENT_METADATA = `${METADATA_PREFIX}annotations.present`;
const SEMANTIC_ANNOTATIONS_METADATA = `${METADATA_PREFIX}semantic-annotations`;
const ANNOTATION_METADATA = {
  currency: `${METADATA_PREFIX}annotations.currency`,
  unit: `${METADATA_PREFIX}annotations.unit`,
  grain: `${METADATA_PREFIX}annotations.grain`,
  key: `${METADATA_PREFIX}annotations.key`,
  semantic: `${METADATA_PREFIX}annotations.semantic`,
} as const;

function arrowFailure(
  code: (typeof ArrowDiagnosticCode)[keyof typeof ArrowDiagnosticCode],
  message: string,
  path: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new PrismError(
    diagnostic(code, message, {
      path,
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function metadataForType(type: ValueType | TableType): Map<string, string> {
  const metadata = new Map<string, string>();
  if (Object.prototype.hasOwnProperty.call(type, "nullable")) {
    metadata.set(NULLABLE_METADATA, String(type.nullable === true));
  }
  if (type.annotations !== undefined) {
    metadata.set(ANNOTATIONS_PRESENT_METADATA, "true");
    if (type.annotations.currency !== undefined) {
      metadata.set(ANNOTATION_METADATA.currency, type.annotations.currency);
    }
    if (type.annotations.unit !== undefined) {
      metadata.set(ANNOTATION_METADATA.unit, type.annotations.unit);
    }
    if (type.annotations.grain !== undefined) {
      metadata.set(ANNOTATION_METADATA.grain, type.annotations.grain);
    }
    if (type.annotations.key !== undefined) {
      metadata.set(ANNOTATION_METADATA.key, String(type.annotations.key));
    }
    if (type.annotations.semantic !== undefined) {
      metadata.set(ANNOTATION_METADATA.semantic, type.annotations.semantic);
    }
  }
  if (type.semanticAnnotations !== undefined) {
    metadata.set(
      SEMANTIC_ANNOTATIONS_METADATA,
      JSON.stringify(canonicalSemanticAnnotations(type.semanticAnnotations)),
    );
  }
  return metadata;
}

function metadataBoolean(value: string, path: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return arrowFailure(
    ArrowDiagnosticCode.SCHEMA_INVALID,
    `Arrow metadata at "${path}" must be "true" or "false".`,
    path,
    { value },
  );
}

function annotationsFromMetadata(
  metadata: ReadonlyMap<string, string>,
  path: string,
): TypeAnnotations | undefined {
  const present =
    metadata.get(ANNOTATIONS_PRESENT_METADATA) === "true" ||
    Object.values(ANNOTATION_METADATA).some((key) => metadata.has(key));
  if (!present) return undefined;

  const currency = metadata.get(ANNOTATION_METADATA.currency);
  const unit = metadata.get(ANNOTATION_METADATA.unit);
  const grain = metadata.get(ANNOTATION_METADATA.grain);
  const rawKey = metadata.get(ANNOTATION_METADATA.key);
  const semantic = metadata.get(ANNOTATION_METADATA.semantic);
  return {
    ...(currency === undefined ? {} : { currency }),
    ...(unit === undefined ? {} : { unit }),
    ...(grain === undefined ? {} : { grain }),
    ...(rawKey === undefined
      ? {}
      : { key: metadataBoolean(rawKey, `${path}/annotations/key`) }),
    ...(semantic === undefined ? {} : { semantic }),
  };
}

function typePropertiesFromMetadata(
  metadata: ReadonlyMap<string, string>,
  arrowNullable: boolean | undefined,
  path: string,
): Pick<ValueType, "nullable" | "annotations" | "semanticAnnotations"> {
  const rawNullable = metadata.get(NULLABLE_METADATA);
  const annotations = annotationsFromMetadata(metadata, path);
  const rawSemanticAnnotations = metadata.get(SEMANTIC_ANNOTATIONS_METADATA);
  const semanticAnnotations =
    rawSemanticAnnotations === undefined
      ? undefined
      : parseSemanticAnnotations(rawSemanticAnnotations, `${path}/semanticAnnotations`);
  return {
    ...(rawNullable === undefined
      ? arrowNullable === true
        ? { nullable: true }
        : {}
      : { nullable: metadataBoolean(rawNullable, `${path}/nullable`) }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(semanticAnnotations === undefined ? {} : { semanticAnnotations }),
  };
}

function toArrowType(type: ValueType, path: string): arrow.DataType {
  switch (type.kind) {
    case "null":
      return new arrow.Null();
    case "boolean":
      return new arrow.Bool();
    case "int":
      // Prism integers are safe JS integers with no 32-bit restriction. Int64
      // preserves that logical range; row materialization converts only safe values.
      return new arrow.Int64();
    case "decimal":
      if (!isValidDecimalType(type)) {
        return arrowFailure(
          ArrowDiagnosticCode.DECIMAL_TYPE_INVALID,
          `Decimal type decimal(${type.precision},${type.scale}) is not representable as Decimal128.`,
          path,
          { precision: type.precision, scale: type.scale },
        );
      }
      // Arrow JS orders these constructor arguments as (scale, precision, bitWidth),
      // opposite the conventional Decimal128(precision, scale) notation.
      return new arrow.Decimal(type.scale, type.precision, 128);
    case "string":
      return new arrow.Utf8();
    case "date":
      return new arrow.DateDay();
    case "datetime":
      return new arrow.TimestampMillisecond("UTC");
    case "object":
    case "table":
      return arrowFailure(
        ArrowDiagnosticCode.TYPE_NOT_REPRESENTABLE,
        `Prism ${type.kind} values cannot be represented as Arrow batch columns.`,
        path,
        { kind: type.kind },
      );
  }
}

/** Converts a Prism table schema to the physical Arrow batch schema. */
export function toArrowSchema(type: TableType): arrow.Schema {
  const seen = new Set<string>();
  const fields = type.columns.map((field, index) => {
    const path = `/columns/${index}`;
    if (seen.has(field.name)) {
      return arrowFailure(
        ArrowDiagnosticCode.SCHEMA_INVALID,
        `Dataset schema contains duplicate column "${field.name}".`,
        `${path}/name`,
        { column: field.name },
      );
    }
    seen.add(field.name);
    return new arrow.Field(
      field.name,
      toArrowType(field.type, `${path}/type`),
      field.type.nullable === true,
      metadataForType(field.type),
    );
  });
  return new arrow.Schema(fields, metadataForType(type));
}

function fromArrowType(field: arrow.Field, path: string): ValueType {
  const dataType = field.type;
  const properties = typePropertiesFromMetadata(field.metadata, field.nullable, path);

  if (arrow.DataType.isNull(dataType)) return { kind: "null", ...properties };
  if (arrow.DataType.isBool(dataType)) return { kind: "boolean", ...properties };
  if (arrow.DataType.isInt(dataType) && dataType.isSigned && dataType.bitWidth === 64) {
    return { kind: "int", ...properties };
  }
  if (arrow.DataType.isDecimal(dataType)) {
    if (dataType.bitWidth !== 128) {
      return arrowFailure(
        ArrowDiagnosticCode.TYPE_UNSUPPORTED,
        `Arrow decimal column "${field.name}" must use 128-bit storage.`,
        path,
        { bitWidth: dataType.bitWidth },
      );
    }
    const decimalType = {
      kind: "decimal" as const,
      precision: dataType.precision,
      scale: dataType.scale,
      ...properties,
    };
    if (!isValidDecimalType(decimalType)) {
      return arrowFailure(
        ArrowDiagnosticCode.DECIMAL_TYPE_INVALID,
        `Arrow decimal column "${field.name}" has invalid precision or scale.`,
        path,
        { precision: dataType.precision, scale: dataType.scale },
      );
    }
    return decimalType;
  }
  if (arrow.DataType.isUtf8(dataType)) return { kind: "string", ...properties };
  if (arrow.DataType.isDate(dataType) && dataType.unit === arrow.DateUnit.DAY) {
    return { kind: "date", ...properties };
  }
  if (
    arrow.DataType.isTimestamp(dataType) &&
    dataType.unit === arrow.TimeUnit.MILLISECOND &&
    dataType.timezone === "UTC"
  ) {
    return { kind: "datetime", ...properties };
  }

  return arrowFailure(
    ArrowDiagnosticCode.TYPE_UNSUPPORTED,
    `Arrow type "${dataType.toString()}" is not supported by the Prism dataset boundary.`,
    path,
    { arrowType: dataType.toString() },
  );
}

/** Converts a supported physical Arrow schema back to its Prism logical type. */
export function fromArrowSchema(schema: arrow.Schema): TableType {
  const columns: FieldType[] = schema.fields.map((field, index) => ({
    name: field.name,
    type: fromArrowType(field, `/fields/${index}`),
  }));
  const properties = typePropertiesFromMetadata(schema.metadata, undefined, "/schema");
  return { kind: "table", columns, ...properties };
}

function invalidCell(
  field: FieldType,
  rowIndex: number,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  return arrowFailure(
    ArrowDiagnosticCode.VALUE_INVALID,
    message,
    `/rows/${rowIndex}/${field.name}`,
    details,
  );
}

function dateValue(value: RowValue | undefined, field: FieldType, rowIndex: number): Date {
  const path = `/rows/${rowIndex}/${field.name}`;
  let parsed: Date;
  if (value instanceof Date) {
    parsed = new Date(value.getTime());
  } else if (typeof value === "string") {
    if (field.type.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return invalidCell(
        field,
        rowIndex,
        `Date column "${field.name}" requires an ISO calendar date.`,
        { value },
      );
    }
    parsed = new Date(field.type.kind === "date" ? `${value}T00:00:00.000Z` : value);
  } else {
    return invalidCell(
      field,
      rowIndex,
      `Column "${field.name}" requires a Date or ISO string.`,
    );
  }

  if (!Number.isFinite(parsed.getTime())) {
    return invalidCell(
      field,
      rowIndex,
      `Column "${field.name}" contains an invalid date.`,
      { value: String(value) },
    );
  }
  if (field.type.kind === "date") {
    const canonical = parsed.toISOString().slice(0, 10);
    if (
      (typeof value === "string" && canonical !== value) ||
      parsed.getUTCHours() !== 0 ||
      parsed.getUTCMinutes() !== 0 ||
      parsed.getUTCSeconds() !== 0 ||
      parsed.getUTCMilliseconds() !== 0
    ) {
      return arrowFailure(
        ArrowDiagnosticCode.VALUE_INVALID,
        `Date column "${field.name}" would lose time-of-day information.`,
        path,
        { value: value instanceof Date ? value.toISOString() : value },
      );
    }
  }
  return parsed;
}

function decimalWords(
  value: RowValue | undefined,
  field: FieldType,
  rowIndex: number,
): Uint32Array {
  if (field.type.kind !== "decimal") {
    return invalidCell(field, rowIndex, `Column "${field.name}" is not a decimal column.`);
  }
  if (!Decimal.isDecimal(value) || !value.isFinite()) {
    return invalidCell(
      field,
      rowIndex,
      `Decimal column "${field.name}" requires a finite decimal.js value.`,
    );
  }
  if (value.decimalPlaces() > field.type.scale) {
    return arrowFailure(
      ArrowDiagnosticCode.DECIMAL_RESCALE_LOSS,
      `Decimal value in column "${field.name}" cannot be represented at scale ${field.type.scale} without losing digits.`,
      `/rows/${rowIndex}/${field.name}`,
      { value: value.toFixed(), scale: field.type.scale },
    );
  }

  const fixed = value.toFixed(field.type.scale);
  const unscaled = fixed.replace(".", "");
  const unsigned = unscaled.startsWith("-") ? unscaled.slice(1) : unscaled;
  const significantDigits = unsigned.replace(/^0+/, "").length || 1;
  if (significantDigits > field.type.precision) {
    return arrowFailure(
      ArrowDiagnosticCode.DECIMAL_PRECISION_EXCEEDED,
      `Decimal value in column "${field.name}" exceeds precision ${field.type.precision}.`,
      `/rows/${rowIndex}/${field.name}`,
      { value: value.toFixed(), precision: field.type.precision, scale: field.type.scale },
    );
  }

  const words = new Uint32Array(4);
  arrow.util.Int128.fromString(unscaled, words);
  return words;
}

function arrowCell(
  value: RowValue | undefined,
  field: FieldType,
  rowIndex: number,
): unknown {
  if (value === null || value === undefined) {
    if (field.type.kind === "null" || field.type.nullable === true) return null;
    return invalidCell(field, rowIndex, `Column "${field.name}" is not nullable.`);
  }

  switch (field.type.kind) {
    case "null":
      return invalidCell(
        field,
        rowIndex,
        `Null column "${field.name}" can contain only null values.`,
      );
    case "boolean":
      return typeof value === "boolean"
        ? value
        : invalidCell(
            field,
            rowIndex,
            `Boolean column "${field.name}" requires a boolean.`,
          );
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : invalidCell(
            field,
            rowIndex,
            `Integer column "${field.name}" requires a safe integer.`,
          );
    case "decimal":
      return decimalWords(value, field, rowIndex);
    case "string":
      return typeof value === "string"
        ? value
        : invalidCell(field, rowIndex, `String column "${field.name}" requires a string.`);
    case "date":
    case "datetime":
      return dateValue(value, field, rowIndex);
    case "object":
    case "table":
      return arrowFailure(
        ArrowDiagnosticCode.TYPE_NOT_REPRESENTABLE,
        `Prism ${field.type.kind} values cannot be represented as Arrow batch columns.`,
        `/rows/${rowIndex}/${field.name}`,
        { kind: field.type.kind },
      );
  }
}

/** Builds one Arrow record batch from materialized escape-hatch rows. */
export function arrowBatchFromRows(
  schema: TableType,
  rows: readonly Readonly<Record<string, RowValue>>[],
  arrowSchema: arrow.Schema = toArrowSchema(schema),
): arrow.RecordBatch {
  const columns: Record<string, arrow.Vector> = {};
  try {
    for (let columnIndex = 0; columnIndex < schema.columns.length; columnIndex += 1) {
      const field = schema.columns[columnIndex];
      const arrowField = arrowSchema.fields[columnIndex];
      if (field === undefined || arrowField === undefined) {
        return arrowFailure(
          ArrowDiagnosticCode.SCHEMA_INVALID,
          "Prism and Arrow schemas have different column counts.",
          "/columns",
        );
      }
      const values = rows.map((row, rowIndex) =>
        arrowCell(row[field.name], field, rowIndex),
      );
      columns[field.name] = arrow.vectorFromArray(values, arrowField.type);
    }
    const table = new arrow.Table(arrowSchema, columns);
    const batch = table.batches[0];
    if (batch === undefined) {
      return arrowFailure(
        ArrowDiagnosticCode.BATCH_BUILD_FAILED,
        "Arrow did not produce a record batch for non-empty input.",
        "/rows",
        { rowCount: rows.length },
      );
    }
    return batch;
  } catch (error) {
    if (error instanceof PrismError) throw error;
    return arrowFailure(
      ArrowDiagnosticCode.BATCH_BUILD_FAILED,
      "Arrow failed to build a dataset batch.",
      "/rows",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function scaledDecimalString(unscaled: string, scale: number): string {
  const negative = unscaled.startsWith("-");
  const digits = negative ? unscaled.slice(1) : unscaled;
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  const split = padded.length - scale;
  return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/** Converts one physical Arrow cell into the materialized Prism row shape. */
export function rowValueFromArrow(
  value: unknown,
  field: FieldType,
  rowIndex: number,
): RowValue {
  if (value === null || value === undefined) return null;
  switch (field.type.kind) {
    case "null":
      return null;
    case "boolean":
      return typeof value === "boolean"
        ? value
        : invalidCell(
            field,
            rowIndex,
            `Arrow boolean column "${field.name}" contains an invalid value.`,
          );
    case "int": {
      if (typeof value !== "bigint") {
        return invalidCell(
          field,
          rowIndex,
          `Arrow Int64 column "${field.name}" contains an invalid value.`,
        );
      }
      const number = Number(value);
      return Number.isSafeInteger(number)
        ? number
        : invalidCell(
            field,
            rowIndex,
            `Arrow Int64 value in column "${field.name}" cannot be materialized as a safe JS integer.`,
            { value: value.toString() },
          );
    }
    case "decimal": {
      if (!(value instanceof Uint32Array)) {
        return invalidCell(
          field,
          rowIndex,
          `Arrow Decimal128 column "${field.name}" contains an invalid value.`,
        );
      }
      const unscaled = arrow.util.bigNumToString(arrow.util.BN.decimal(value));
      return new D(scaledDecimalString(unscaled, field.type.scale));
    }
    case "string":
      return typeof value === "string"
        ? value
        : invalidCell(
            field,
            rowIndex,
            `Arrow UTF-8 column "${field.name}" contains an invalid value.`,
          );
    case "date": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalidCell(
          field,
          rowIndex,
          `Arrow date column "${field.name}" contains an invalid value.`,
        );
      }
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) {
        return invalidCell(
          field,
          rowIndex,
          `Arrow date column "${field.name}" is outside the JS Date range.`,
        );
      }
      return date.toISOString().slice(0, 10);
    }
    case "datetime": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalidCell(
          field,
          rowIndex,
          `Arrow timestamp column "${field.name}" contains an invalid value.`,
        );
      }
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) {
        return invalidCell(
          field,
          rowIndex,
          `Arrow timestamp column "${field.name}" is outside the JS Date range.`,
        );
      }
      return date.toISOString();
    }
    case "object":
    case "table":
      return arrowFailure(
        ArrowDiagnosticCode.TYPE_NOT_REPRESENTABLE,
        `Prism ${field.type.kind} values cannot be materialized from an Arrow batch column.`,
        `/rows/${rowIndex}/${field.name}`,
        { kind: field.type.kind },
      );
  }
}
