import {
  NOT_APPLICABLE,
  TypeAnalysisExtensionPoint,
  type AnalysisResult,
  type BinaryTypeAnalysisRequest,
  type FunctionTypeAnalysisRequest,
  type TypeAnalysisExtension,
  type UnaryTypeAnalysisRequest,
} from "@prismengine/contracts-calculation";
import {
  canonicalSemanticAnnotations,
  decimalType,
  defineSemanticAnnotationContract,
  diagnostic,
  findSemanticAnnotation,
  semanticAnnotation,
  PrismError,
  type DecimalType,
  type JsonObject,
  type ValueType,
} from "@prismengine/contracts-data";
import { defineCapability, definePlugin } from "@prismengine/kernel";

export const QUANTITY_ANNOTATION_VERSION = "1.0.0";
export const QUANTITY_ANALYZER_SEMANTIC_VERSION = "1.0.0";
export const QUANTITY_PLUGIN_VERSION = "0.1.0";

export interface QuantityFactor extends JsonObject {
  readonly dimension: string;
  /** Empty string means a dimension with no named unit. */
  readonly unit: string;
  /** Positive integer; repeated dimensions are canonicalized by the plugin. */
  readonly exponent: number;
}

export interface QuantitySpec extends JsonObject {
  readonly numerator: readonly QuantityFactor[];
  readonly denominator: readonly QuantityFactor[];
}

export const QuantityAnnotation =
  defineSemanticAnnotationContract<QuantitySpec>({
    id: "type.quantity",
    version: QUANTITY_ANNOTATION_VERSION,
  });

export interface QuantityCapability {
  annotate<T extends ValueType>(type: T, quantity: QuantitySpec): T;
  read(type: ValueType): QuantitySpec | undefined;
  normalize(quantity: QuantitySpec): QuantitySpec;
}

export const QuantityCapabilityToken = defineCapability<QuantityCapability>({
  id: "type.quantity",
  version: "1.0.0",
});

export const QuantityDiagnosticCode = {
  INVALID: "QUANTITY_INVALID",
  MISMATCH: "QUANTITY_MISMATCH",
  UNIT_MISMATCH: "QUANTITY_UNIT_MISMATCH",
} as const;

const capability: QuantityCapability = {
  annotate<T extends ValueType>(type: T, quantity: QuantitySpec): T {
    const normalized = normalize(quantity);
    const existing = (type.semanticAnnotations ?? []).filter(
      (annotation) => annotation.contract !== QuantityAnnotation.id,
    );
    return {
      ...type,
      semanticAnnotations: canonicalSemanticAnnotations([
        ...existing,
        semanticAnnotation(QuantityAnnotation, normalized),
      ]),
    };
  },
  read(type) {
    return findSemanticAnnotation(
      type.semanticAnnotations,
      QuantityAnnotation,
    )?.spec;
  },
  normalize,
};

export const quantityTypeAnalyzer: TypeAnalysisExtension = {
  id: "calculation.type.quantity",
  semanticVersion: QUANTITY_ANALYZER_SEMANTIC_VERSION,
  inferUnary: analyzeUnary,
  inferBinary: analyzeBinary,
  inferFunction: analyzeFunction,
};

export const quantityPlugin = definePlugin({
  id: "type.quantity",
  version: QUANTITY_PLUGIN_VERSION,
  provides: [QuantityCapabilityToken],
  register(context) {
    context.extensions.contribute(
      TypeAnalysisExtensionPoint,
      quantityTypeAnalyzer,
    );
    context.provide(QuantityCapabilityToken, capability);
  },
});

function analyzeUnary(
  request: UnaryTypeAnalysisRequest,
): AnalysisResult<ValueType> {
  const quantity = capability.read(request.operand);
  if (quantity === undefined) return NOT_APPLICABLE;
  if (request.operator !== "-" || !isNumeric(request.operand)) {
    return invalid("A quantity supports only numeric unary '-'.");
  }
  return handled(capability.annotate(request.operand, quantity));
}

function analyzeBinary(
  request: BinaryTypeAnalysisRequest,
): AnalysisResult<ValueType> {
  const leftQuantity = capability.read(request.left);
  const rightQuantity = capability.read(request.right);
  if (leftQuantity === undefined && rightQuantity === undefined) {
    return NOT_APPLICABLE;
  }
  if (!isNumeric(request.left) || !isNumeric(request.right)) {
    return invalid(`Operator '${request.operator}' requires numeric quantity operands.`);
  }

  if (request.operator === "+" || request.operator === "-") {
    if (
      leftQuantity === undefined ||
      rightQuantity === undefined ||
      !sameQuantity(leftQuantity, rightQuantity)
    ) {
      return invalid(
        `Operator '${request.operator}' requires identical quantity dimensions and units.`,
        QuantityDiagnosticCode.MISMATCH,
      );
    }
    return handled(
      capability.annotate(arithmeticType(request.left, request.right, request.operator), leftQuantity),
    );
  }

  if (request.operator === "*" || request.operator === "/") {
    const combined = combine(
      leftQuantity ?? dimensionless(),
      rightQuantity ?? dimensionless(),
      request.operator === "*" ? 1 : -1,
    );
    const raw = arithmeticType(request.left, request.right, request.operator);
    return handled(isDimensionless(combined) ? raw : capability.annotate(raw, combined));
  }

  if (["==", "!=", ">", ">=", "<", "<="].includes(request.operator)) {
    if (
      leftQuantity === undefined ||
      rightQuantity === undefined ||
      !sameQuantity(leftQuantity, rightQuantity)
    ) {
      return invalid(
        `Comparison '${request.operator}' requires identical quantity dimensions and units.`,
        QuantityDiagnosticCode.MISMATCH,
      );
    }
    return handled({ kind: "boolean" });
  }

  return invalid(`Operator '${request.operator}' is not defined for quantities.`);
}

function analyzeFunction(
  request: FunctionTypeAnalysisRequest,
): AnalysisResult<ValueType> {
  const quantities = request.arguments.map((argument) => capability.read(argument));
  if (quantities.every((quantity) => quantity === undefined)) return NOT_APPLICABLE;

  if (request.name === "abs" || request.name === "round") {
    const first = request.arguments[0];
    const quantity = quantities[0];
    if (first === undefined || quantity === undefined || !isNumeric(first)) {
      return invalid(`${request.name} requires a quantity first argument.`);
    }
    return handled(capability.annotate(decimalOf(first), quantity));
  }

  if (["min", "max", "coalesce"].includes(request.name)) {
    const first = quantities.find((quantity) => quantity !== undefined);
    if (
      first === undefined ||
      quantities.some((quantity) => quantity === undefined || !sameQuantity(first, quantity))
    ) {
      return invalid(`${request.name} requires identical quantities.`);
    }
    return handled(capability.annotate(decimalOf(request.arguments[0] ?? decimalType(38, 10)), first));
  }

  if (request.name === "if") {
    const whenTrue = request.arguments[1];
    const trueQuantity = quantities[1];
    const falseQuantity = quantities[2];
    if (
      whenTrue === undefined ||
      trueQuantity === undefined ||
      falseQuantity === undefined ||
      !sameQuantity(trueQuantity, falseQuantity)
    ) {
      return invalid("if branches require identical quantities.");
    }
    return handled(capability.annotate(decimalOf(whenTrue), trueQuantity));
  }

  return invalid(`Function '${request.name}' is not defined for quantities.`);
}

function handled(value: ValueType): AnalysisResult<ValueType> {
  return { kind: "handled", value, diagnostics: [] };
}

function invalid(
  message: string,
  code: string = QuantityDiagnosticCode.INVALID,
): AnalysisResult<ValueType> {
  return {
    kind: "invalid",
    diagnostics: [diagnostic(code, message)],
  };
}

function normalize(quantity: QuantitySpec): QuantitySpec {
  const powers = new Map<string, {
    readonly dimension: string;
    readonly unit: string;
    exponent: number;
  }>();
  addFactors(powers, quantity.numerator, 1);
  addFactors(powers, quantity.denominator, -1);
  const factors = [...powers.values()]
    .filter((factor) => factor.exponent !== 0)
    .sort((left, right) => factorKey(left).localeCompare(factorKey(right)));
  return {
    numerator: factors
      .filter((factor) => factor.exponent > 0)
      .map((factor) => toFactor(factor, factor.exponent)),
    denominator: factors
      .filter((factor) => factor.exponent < 0)
      .map((factor) => toFactor(factor, -factor.exponent)),
  };
}

function addFactors(
  powers: Map<string, { readonly dimension: string; readonly unit: string; exponent: number }>,
  factors: readonly QuantityFactor[],
  direction: 1 | -1,
): void {
  for (const factor of factors) {
    if (
      factor.dimension.trim() === "" ||
      !Number.isInteger(factor.exponent) ||
      factor.exponent <= 0
    ) {
      throw PrismError.of(
        QuantityDiagnosticCode.INVALID,
        "Quantity factors require a dimension and positive integer exponent.",
        { factor },
      );
    }
    const key = factorKey(factor);
    const existing = powers.get(key);
    if (existing === undefined) {
      powers.set(key, {
        dimension: factor.dimension,
        unit: factor.unit,
        exponent: direction * factor.exponent,
      });
    } else {
      existing.exponent += direction * factor.exponent;
    }
  }
}

function combine(left: QuantitySpec, right: QuantitySpec, direction: 1 | -1): QuantitySpec {
  return normalize({
    numerator: [
      ...left.numerator,
      ...(direction === 1 ? right.numerator : right.denominator),
    ],
    denominator: [
      ...left.denominator,
      ...(direction === 1 ? right.denominator : right.numerator),
    ],
  });
}

function sameQuantity(left: QuantitySpec, right: QuantitySpec): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function dimensionless(): QuantitySpec {
  return { numerator: [], denominator: [] };
}

function isDimensionless(quantity: QuantitySpec): boolean {
  const normalized = normalize(quantity);
  return normalized.numerator.length === 0 && normalized.denominator.length === 0;
}

function isNumeric(type: ValueType): boolean {
  return type.kind === "decimal" || type.kind === "int";
}

function decimalOf(type: ValueType): DecimalType {
  return type.kind === "decimal" ? type : decimalType(38, 0);
}

function arithmeticType(
  left: ValueType,
  right: ValueType,
  operator: "+" | "-" | "*" | "/",
): DecimalType {
  const leftDecimal = decimalOf(left);
  const rightDecimal = decimalOf(right);
  const scale = operator === "*"
    ? Math.min(38, leftDecimal.scale + rightDecimal.scale)
    : operator === "/"
      ? Math.max(10, leftDecimal.scale)
      : Math.max(leftDecimal.scale, rightDecimal.scale);
  return decimalType(38, Math.min(38, scale));
}

function factorKey(factor: { readonly dimension: string; readonly unit: string }): string {
  return `${factor.dimension}\u0000${factor.unit}`;
}

function toFactor(
  factor: { readonly dimension: string; readonly unit: string },
  exponent: number,
): QuantityFactor {
  return {
    dimension: factor.dimension,
    unit: factor.unit,
    exponent,
  };
}

