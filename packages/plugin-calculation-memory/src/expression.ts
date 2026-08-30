import {
  CalculationDiagnosticCode,
  type CompiledExpression,
  type Expression,
  type ExpressionSpec,
  type FunctionSignature,
  type AnalysisResult,
  type TypeAnalysisService,
} from "@prismengine/contracts-calculation";
import {
  D,
  Decimal,
  diagnostic,
  type Diagnostic,
  type Row,
  type RowValue,
  type ValueType,
  MAX_DECIMAL_PRECISION,
  decimalType,
} from "@prismengine/contracts-data";

/**
 * Scale used for a decimal the schema did not pin. Wide on purpose: an
 * inferred intermediate must not silently round before the policy that owns
 * rounding gets to decide.
 */
export const INFERRED_DECIMAL_SCALE = 10;

/**
 * Type assigned to an inferred decimal result. Widest representable form:
 * arithmetic keeps full working precision and only rounds where a policy says
 * so, therefore inference must not narrow the column ahead of that.
 */
const DECIMAL_TYPE: ValueType = Object.freeze(
  decimalType(MAX_DECIMAL_PRECISION, INFERRED_DECIMAL_SCALE),
);
const BOOLEAN_TYPE: ValueType = Object.freeze({ kind: "boolean" });
const STRING_TYPE: ValueType = Object.freeze({ kind: "string" });
const NULL_TYPE: ValueType = Object.freeze({ kind: "null", nullable: true });

type TokenKind =
  "number" | "string" | "identifier" | "operator" | "(" | ")" | "," | "." | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly position: number;
}

class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = "ExpressionSyntaxError";
  }
}

class Lexer {
  private position = 0;

  constructor(private readonly source: string) {}

  next(): Token {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
    const start = this.position;
    if (start >= this.source.length) return { kind: "eof", text: "", position: start };

    const first = this.source[start] ?? "";
    if (/\d/u.test(first) || (first === "." && /\d/u.test(this.source[start + 1] ?? ""))) {
      return this.number();
    }
    if (first === '"' || first === "'") return this.string(first);
    if (/[A-Za-z_$]/u.test(first)) {
      this.position += 1;
      while (/[A-Za-z0-9_$]/u.test(this.source[this.position] ?? "")) this.position += 1;
      return {
        kind: "identifier",
        text: this.source.slice(start, this.position),
        position: start,
      };
    }

    const pair = this.source.slice(start, start + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(pair)) {
      this.position += 2;
      return { kind: "operator", text: pair, position: start };
    }
    if (["+", "-", "*", "/", ">", "<", "!"].includes(first)) {
      this.position += 1;
      return { kind: "operator", text: first, position: start };
    }
    if (["(", ")", ",", "."].includes(first)) {
      this.position += 1;
      return { kind: first as "(" | ")" | "," | ".", text: first, position: start };
    }
    throw new ExpressionSyntaxError(`Unexpected character "${first}".`, start);
  }

  private number(): Token {
    const start = this.position;
    let sawDot = false;
    if (this.source[this.position] === ".") {
      sawDot = true;
      this.position += 1;
    }
    while (/\d/u.test(this.source[this.position] ?? "")) this.position += 1;
    if (!sawDot && this.source[this.position] === ".") {
      sawDot = true;
      this.position += 1;
      while (/\d/u.test(this.source[this.position] ?? "")) this.position += 1;
    }
    if ((this.source[this.position] ?? "").toLowerCase() === "e") {
      const exponent = this.position;
      this.position += 1;
      if (["+", "-"].includes(this.source[this.position] ?? "")) this.position += 1;
      const digits = this.position;
      while (/\d/u.test(this.source[this.position] ?? "")) this.position += 1;
      if (digits === this.position)
        throw new ExpressionSyntaxError("Invalid numeric exponent.", exponent);
    }
    return {
      kind: "number",
      text: this.source.slice(start, this.position),
      position: start,
    };
  }

  private string(quote: string): Token {
    const start = this.position;
    this.position += 1;
    let value = "";
    while (this.position < this.source.length) {
      const current = this.source[this.position] ?? "";
      this.position += 1;
      if (current === quote) return { kind: "string", text: value, position: start };
      if (current !== "\\") {
        value += current;
        continue;
      }
      if (this.position >= this.source.length) break;
      const escaped = this.source[this.position] ?? "";
      this.position += 1;
      const escapes: Readonly<Record<string, string>> = {
        n: "\n",
        r: "\r",
        t: "\t",
        "\\": "\\",
        '"': '"',
        "'": "'",
      };
      value += escapes[escaped] ?? escaped;
    }
    throw new ExpressionSyntaxError("Unterminated string literal.", start);
  }
}

const PRECEDENCE: Readonly<Record<string, number>> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
};

class Parser {
  private readonly lexer: Lexer;
  private current: Token;

  constructor(source: string) {
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  parse(): Expression {
    if (this.at("eof")) throw new ExpressionSyntaxError("Expression is empty.", 0);
    const expression = this.parseExpression(0);
    if (!this.at("eof")) {
      throw new ExpressionSyntaxError(
        `Unexpected token "${this.current.text}".`,
        this.current.position,
      );
    }
    return expression;
  }

  private parseExpression(minimumPrecedence: number): Expression {
    let left = this.parsePrefix();
    while (this.current.kind === "operator") {
      const precedence = PRECEDENCE[this.current.text];
      if (precedence === undefined || precedence < minimumPrecedence) break;
      const operator = this.current.text as
        "+" | "-" | "*" | "/" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "&&" | "||";
      this.advance();
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }

  private parsePrefix(): Expression {
    if (
      this.current.kind === "operator" &&
      (this.current.text === "-" || this.current.text === "!")
    ) {
      const operator = this.current.text;
      this.advance();
      return { kind: "unary", operator, operand: this.parseExpression(7) };
    }
    if (this.current.kind === "(") {
      this.advance();
      const expression = this.parseExpression(0);
      this.expect(")");
      return expression;
    }
    if (this.current.kind === "number") {
      const value = this.current.text;
      this.advance();
      return { kind: "literal", value, type: DECIMAL_TYPE };
    }
    if (this.current.kind === "string") {
      const value = this.current.text;
      this.advance();
      return { kind: "literal", value };
    }
    if (this.current.kind !== "identifier") {
      throw new ExpressionSyntaxError(
        `Expected an expression, found "${this.current.text}".`,
        this.current.position,
      );
    }

    const identifier = this.current.text;
    this.advance();
    if (identifier === "true" || identifier === "false") {
      return { kind: "literal", value: identifier === "true" };
    }
    if (identifier === "null") return { kind: "literal", value: null };
    if (this.at("(")) return this.parseCall(identifier);

    const path = [identifier];
    while (this.at(".")) {
      this.advance();
      if (this.current.kind !== "identifier") {
        throw new ExpressionSyntaxError(
          "Expected a field name after '.'.",
          this.current.position,
        );
      }
      path.push(this.current.text);
      this.advance();
    }
    return { kind: "field", path };
  }

  private parseCall(callee: string): Expression {
    this.expect("(");
    const args: Expression[] = [];
    if (this.current.kind !== ")") {
      while (true) {
        args.push(this.parseExpression(0));
        if (this.current.kind !== ",") break;
        this.advance();
      }
    }
    this.expect(")");
    return { kind: "call", callee, args };
  }

  private expect(kind: TokenKind): void {
    if (this.current.kind !== kind) {
      throw new ExpressionSyntaxError(
        `Expected "${kind}", found "${this.current.text}".`,
        this.current.position,
      );
    }
    this.advance();
  }

  private at(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private advance(): void {
    this.current = this.lexer.next();
  }
}

export const FUNCTION_SIGNATURES: readonly FunctionSignature[] = Object.freeze([
  {
    name: "round",
    parameters: [
      { name: "x", type: DECIMAL_TYPE },
      { name: "scale", type: DECIMAL_TYPE },
    ],
    returns: DECIMAL_TYPE,
    description: "Rounds a decimal; scale defaults to 2.",
  },
  { name: "abs", parameters: [{ name: "x", type: DECIMAL_TYPE }], returns: DECIMAL_TYPE },
  {
    name: "min",
    parameters: [{ name: "value", type: DECIMAL_TYPE }],
    returns: DECIMAL_TYPE,
    variadic: true,
  },
  {
    name: "max",
    parameters: [{ name: "value", type: DECIMAL_TYPE }],
    returns: DECIMAL_TYPE,
    variadic: true,
  },
  {
    name: "coalesce",
    parameters: [{ name: "value", type: DECIMAL_TYPE }],
    returns: DECIMAL_TYPE,
    variadic: true,
  },
  {
    name: "if",
    parameters: [
      { name: "condition", type: BOOLEAN_TYPE },
      { name: "whenTrue", type: DECIMAL_TYPE },
      { name: "whenFalse", type: DECIMAL_TYPE },
    ],
    returns: DECIMAL_TYPE,
  },
]);

function isNumeric(type: ValueType): boolean {
  return type.kind === "decimal" || type.kind === "int";
}

function compatible(left: ValueType, right: ValueType): boolean {
  if (left.kind === "null" || right.kind === "null") return true;
  if (isNumeric(left) && isNumeric(right)) return true;
  return left.kind === right.kind;
}

function commonType(left: ValueType, right: ValueType): ValueType {
  if (left.kind === "null") return { ...right, nullable: true };
  if (right.kind === "null") return { ...left, nullable: true };
  if (isNumeric(left) && isNumeric(right)) return DECIMAL_TYPE;
  return left;
}

const NO_TYPE_ANALYSIS: TypeAnalysisService = {
  inferUnary: () => ({ kind: "not-applicable" }),
  inferBinary: () => ({ kind: "not-applicable" }),
  inferFunction: () => ({ kind: "not-applicable" }),
};

interface TypeState {
  readonly diagnostics: Diagnostic[];
  readonly references: string[][];
  readonly scope: Readonly<Record<string, ValueType>>;
  readonly analysis: TypeAnalysisService;
}

function typeError(state: TypeState, message: string): void {
  state.diagnostics.push(
    diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, message),
  );
}

function extensionType(
  result: AnalysisResult<ValueType>,
  state: TypeState,
): ValueType | undefined {
  if (result.kind === "not-applicable") return undefined;
  state.diagnostics.push(...result.diagnostics);
  return result.kind === "handled" ? result.value : NULL_TYPE;
}

function inferExpression(expression: Expression, state: TypeState): ValueType {
  switch (expression.kind) {
    case "literal":
      if (expression.type !== undefined) return expression.type;
      if (expression.value === null) return NULL_TYPE;
      if (typeof expression.value === "boolean") return BOOLEAN_TYPE;
      if (typeof expression.value === "number") return DECIMAL_TYPE;
      return STRING_TYPE;
    case "parameter":
      state.diagnostics.push(
        diagnostic(
          CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
          `Unknown parameter "${expression.name}".`,
          { details: { parameter: expression.name } },
        ),
      );
      return NULL_TYPE;
    case "field": {
      state.references.push([...expression.path]);
      const root = state.scope[expression.path[0] ?? ""];
      if (root === undefined) {
        state.diagnostics.push(
          diagnostic(
            CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
            `Unknown field "${expression.path.join(".")}".`,
            { details: { field: expression.path.join(".") } },
          ),
        );
        return NULL_TYPE;
      }
      let type: ValueType = root;
      for (const segment of expression.path.slice(1)) {
        if (type.kind !== "object") {
          state.diagnostics.push(
            diagnostic(
              CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
              `Field "${expression.path.join(".")}" does not exist.`,
              { details: { field: expression.path.join(".") } },
            ),
          );
          return NULL_TYPE;
        }
        const nested: ValueType | undefined = type.fields.find(
          (field) => field.name === segment,
        )?.type;
        if (nested === undefined) {
          state.diagnostics.push(
            diagnostic(
              CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
              `Field "${expression.path.join(".")}" does not exist.`,
              { details: { field: expression.path.join(".") } },
            ),
          );
          return NULL_TYPE;
        }
        type = nested;
      }
      return type;
    }
    case "unary": {
      const operand = inferExpression(expression.operand, state);
      const extended = extensionType(
        state.analysis.inferUnary({ operator: expression.operator, operand }),
        state,
      );
      if (extended !== undefined) return extended;
      if (expression.operator === "-") {
        if (!isNumeric(operand)) typeError(state, "Unary '-' requires a numeric operand.");
        return DECIMAL_TYPE;
      }
      if (operand.kind !== "boolean")
        typeError(state, "Unary '!' requires a boolean operand.");
      return BOOLEAN_TYPE;
    }
    case "binary": {
      const left = inferExpression(expression.left, state);
      const right = inferExpression(expression.right, state);
      const extended = extensionType(
        state.analysis.inferBinary({
          operator: expression.operator,
          left,
          right,
        }),
        state,
      );
      if (extended !== undefined) return extended;
      if (["+", "-", "*", "/"].includes(expression.operator)) {
        if (!isNumeric(left) || !isNumeric(right))
          typeError(state, `Operator '${expression.operator}' requires numeric operands.`);
        return DECIMAL_TYPE;
      }
      if (["&&", "||"].includes(expression.operator)) {
        if (left.kind !== "boolean" || right.kind !== "boolean")
          typeError(state, `Operator '${expression.operator}' requires boolean operands.`);
        return BOOLEAN_TYPE;
      }
      const equality = expression.operator === "==" || expression.operator === "!=";
      const ordered =
        (isNumeric(left) && isNumeric(right)) ||
        (left.kind === right.kind && ["string", "date", "datetime"].includes(left.kind));
      if (
        equality &&
        (!compatible(left, right) ||
          ["object", "table"].includes(left.kind) ||
          ["object", "table"].includes(right.kind))
      ) {
        typeError(
          state,
          `Operator '${expression.operator}' received incompatible operand types '${left.kind}' and '${right.kind}'.`,
        );
      }
      if (!equality && !ordered)
        typeError(
          state,
          `Operator '${expression.operator}' requires compatible ordered operands.`,
        );
      return BOOLEAN_TYPE;
    }
    case "conditional": {
      const test = inferExpression(expression.test, state);
      const whenTrue = inferExpression(expression.whenTrue, state);
      const whenFalse = inferExpression(expression.whenFalse, state);
      if (test.kind !== "boolean") typeError(state, "Conditional test must be boolean.");
      if (!compatible(whenTrue, whenFalse))
        typeError(state, "Conditional branches must have compatible types.");
      return commonType(whenTrue, whenFalse);
    }
    case "call":
      return inferCall(expression.callee, expression.args, state);
  }
}

function inferCall(
  callee: string,
  args: readonly Expression[],
  state: TypeState,
): ValueType {
  const types = args.map((argument) => inferExpression(argument, state));
  const extended = extensionType(
    state.analysis.inferFunction({ name: callee, arguments: types }),
    state,
  );
  if (extended !== undefined) return extended;
  const known = FUNCTION_SIGNATURES.some((signature) => signature.name === callee);
  if (!known) {
    state.diagnostics.push(
      diagnostic(
        CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FUNCTION,
        `Unknown function "${callee}".`,
        { details: { function: callee } },
      ),
    );
    return NULL_TYPE;
  }
  if (callee === "round") {
    if (types.length < 1 || types.length > 2)
      typeError(state, "round requires one or two arguments.");
    if (types[0] !== undefined && !isNumeric(types[0]))
      typeError(state, "round requires a numeric first argument.");
    if (types[1] !== undefined && !isNumeric(types[1]))
      typeError(state, "round scale must be numeric.");
    return DECIMAL_TYPE;
  }
  if (callee === "abs") {
    if (types.length !== 1) typeError(state, "abs requires exactly one argument.");
    if (types[0] !== undefined && !isNumeric(types[0]))
      typeError(state, "abs requires a numeric argument.");
    return DECIMAL_TYPE;
  }
  if (callee === "min" || callee === "max") {
    if (types.length === 0) typeError(state, `${callee} requires at least one argument.`);
    if (types.some((type) => !isNumeric(type)))
      typeError(state, `${callee} requires numeric arguments.`);
    return DECIMAL_TYPE;
  }
  if (callee === "coalesce") {
    if (types.length === 0) {
      typeError(state, "coalesce requires at least one argument.");
      return NULL_TYPE;
    }
    const first = types[0] ?? NULL_TYPE;
    if (types.slice(1).some((type) => !compatible(first, type)))
      typeError(state, "coalesce arguments must have compatible types.");
    return types.reduce(commonType, NULL_TYPE);
  }
  if (types.length !== 3) typeError(state, "if requires exactly three arguments.");
  if (types[0] !== undefined && types[0].kind !== "boolean")
    typeError(state, "if condition must be boolean.");
  const whenTrue = types[1] ?? NULL_TYPE;
  const whenFalse = types[2] ?? NULL_TYPE;
  if (!compatible(whenTrue, whenFalse))
    typeError(state, "if branches must have compatible types.");
  return commonType(whenTrue, whenFalse);
}

export type ExpressionValue = RowValue;

export type ExpressionParameterBindings = Readonly<
  Record<string, string | number | boolean | Decimal>
>;

export type ExpressionEvaluator = (
  row: Row,
  parameters: ExpressionParameterBindings,
  report: (item: Diagnostic) => void,
  path?: string,
) => ExpressionValue;

interface EvaluationContext {
  readonly row: Row;
  readonly parameters: ExpressionParameterBindings;
  readonly report: (item: Diagnostic) => void;
  readonly path?: string;
}

type Evaluator = (context: EvaluationContext) => ExpressionValue;

function decimalValue(value: ExpressionValue): Decimal | null {
  if (Decimal.isDecimal(value)) return new D(value);
  if (typeof value === "number") return new D(value);
  return null;
}

function fieldValue(row: Row, path: readonly string[]): ExpressionValue {
  let value: RowValue | undefined = row[path[0] ?? ""];
  for (const segment of path.slice(1)) {
    if (
      value === null ||
      typeof value !== "object" ||
      Decimal.isDecimal(value) ||
      value instanceof Date
    )
      return null;
    value = value[segment];
  }
  return value ?? null;
}

function compareValues(left: ExpressionValue, right: ExpressionValue): number {
  const leftDecimal = decimalValue(left);
  const rightDecimal = decimalValue(right);
  if (leftDecimal !== null && rightDecimal !== null)
    return leftDecimal.comparedTo(rightDecimal);
  if (left instanceof Date && right instanceof Date)
    return left.getTime() - right.getTime();
  if (typeof left === "string" && typeof right === "string")
    return left.localeCompare(right);
  if (typeof left === "boolean" && typeof right === "boolean")
    return Number(left) - Number(right);
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return String(left).localeCompare(String(right));
}

function compileEvaluator(expression: Expression): Evaluator {
  switch (expression.kind) {
    case "literal":
      if (expression.type?.kind === "decimal") {
        const decimal = new D(String(expression.value));
        return () => decimal;
      }
      return () => expression.value;
    case "field":
      return (context) => fieldValue(context.row, expression.path);
    case "parameter":
      return (context) => {
        const value = context.parameters[expression.name];
        if (value !== undefined) return value;
        context.report(
          diagnostic(
            CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED,
            `Required parameter "${expression.name}" was not supplied.`,
            {
              ...(context.path === undefined ? {} : { path: context.path }),
              details: { parameter: expression.name },
            },
          ),
        );
        return null;
      };
    case "unary": {
      const operand = compileEvaluator(expression.operand);
      if (expression.operator === "!") return (context) => !Boolean(operand(context));
      return (context) => decimalValue(operand(context))?.negated() ?? null;
    }
    case "binary":
      return compileBinary(
        expression.operator,
        compileEvaluator(expression.left),
        compileEvaluator(expression.right),
      );
    case "conditional": {
      const test = compileEvaluator(expression.test);
      const whenTrue = compileEvaluator(expression.whenTrue);
      const whenFalse = compileEvaluator(expression.whenFalse);
      return (context) => (Boolean(test(context)) ? whenTrue(context) : whenFalse(context));
    }
    case "call":
      return compileCall(expression.callee, expression.args.map(compileEvaluator));
  }
}

function compileBinary(operator: string, left: Evaluator, right: Evaluator): Evaluator {
  if (operator === "&&")
    return (context) => Boolean(left(context)) && Boolean(right(context));
  if (operator === "||")
    return (context) => Boolean(left(context)) || Boolean(right(context));
  if (["==", "!=", ">", ">=", "<", "<="].includes(operator)) {
    return (context) => {
      const comparison = compareValues(left(context), right(context));
      if (operator === "==") return comparison === 0;
      if (operator === "!=") return comparison !== 0;
      if (operator === ">") return comparison > 0;
      if (operator === ">=") return comparison >= 0;
      if (operator === "<") return comparison < 0;
      return comparison <= 0;
    };
  }
  return (context) => {
    const leftValue = decimalValue(left(context));
    const rightValue = decimalValue(right(context));
    if (leftValue === null || rightValue === null) return null;
    if (operator === "+") return leftValue.plus(rightValue);
    if (operator === "-") return leftValue.minus(rightValue);
    if (operator === "*") return leftValue.times(rightValue);
    if (rightValue.isZero()) {
      context.report(
        diagnostic(CalculationDiagnosticCode.DIVISION_BY_ZERO, "Division by zero.", {
          ...(context.path === undefined ? {} : { path: context.path }),
        }),
      );
      return null;
    }
    return leftValue.dividedBy(rightValue);
  };
}

function compileCall(callee: string, args: readonly Evaluator[]): Evaluator {
  if (callee === "if") {
    return (context) =>
      Boolean(args[0]?.(context))
        ? (args[1]?.(context) ?? null)
        : (args[2]?.(context) ?? null);
  }
  if (callee === "coalesce") {
    return (context) => {
      for (const argument of args) {
        const value = argument(context);
        if (value !== null) return value;
      }
      return null;
    };
  }
  if (callee === "round") {
    return (context) => {
      const value = decimalValue(args[0]?.(context) ?? null);
      const scale = decimalValue(args[1]?.(context) ?? new D(2));
      if (value === null || scale === null) return null;
      if (!scale.isInteger() || scale.isNegative() || scale.greaterThan(100)) {
        context.report(
          diagnostic(
            CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR,
            "round scale must be an integer from 0 through 100.",
            { ...(context.path === undefined ? {} : { path: context.path }) },
          ),
        );
        return null;
      }
      return value.toDecimalPlaces(scale.toNumber(), Decimal.ROUND_HALF_UP);
    };
  }
  if (callee === "abs") {
    return (context) => decimalValue(args[0]?.(context) ?? null)?.abs() ?? null;
  }
  if (callee === "min" || callee === "max") {
    return (context) => {
      const values = args.map((argument) => decimalValue(argument(context)));
      if (values.some((value) => value === null)) return null;
      const decimals = values.filter((value): value is Decimal => value !== null);
      return decimals.reduce((selected, value) =>
        callee === "min" ? Decimal.min(selected, value) : Decimal.max(selected, value),
      );
    };
  }
  return () => null;
}

export function compileExpressionEvaluator(expression: Expression): ExpressionEvaluator {
  const evaluate = compileEvaluator(expression);
  return (row, parameters, report, path) =>
    evaluate({
      row,
      parameters,
      report,
      ...(path === undefined ? {} : { path }),
    });
}

export function analyzeExpressionInternal(
  spec: ExpressionSpec,
  scope: Readonly<Record<string, ValueType>>,
  analysis: TypeAnalysisService = NO_TYPE_ANALYSIS,
): CompiledExpression | { readonly diagnostics: readonly Diagnostic[] } {
  let ast: Expression;
  try {
    ast = new Parser(spec.text).parse();
  } catch (error) {
    const syntax =
      error instanceof ExpressionSyntaxError
        ? error
        : new ExpressionSyntaxError("Expression could not be parsed.", 0);
    return {
      diagnostics: [
        diagnostic(CalculationDiagnosticCode.EXPRESSION_PARSE_ERROR, syntax.message, {
          details: { position: syntax.position },
        }),
      ],
    };
  }

  const state: TypeState = { diagnostics: [], references: [], scope, analysis };
  const type = inferExpression(ast, state);
  if (state.diagnostics.length > 0) return { diagnostics: state.diagnostics };
  const uniqueReferences = [
    ...new Map(state.references.map((path) => [path.join("."), path] as const)).values(),
  ];
  return { source: spec, ast, type, references: uniqueReferences };
}

export function compilePublicExpression(
  spec: ExpressionSpec,
  scope: Readonly<Record<string, ValueType>>,
  analysis: TypeAnalysisService = NO_TYPE_ANALYSIS,
): CompiledExpression | { readonly diagnostics: readonly Diagnostic[] } {
  return analyzeExpressionInternal(spec, scope, analysis);
}
