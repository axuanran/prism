import type { ValueType } from "@prism/contracts-data";

/**
 * Expression AST.
 *
 * `eval` and `new Function` are prohibited: expressions are authored by
 * business users through the studio and stored in the database. A parsed AST
 * is the only form that can be validated, type-checked, explained and
 * rendered back into an editor.
 */

export type LiteralValue = string | number | boolean | null;

export interface LiteralExpression {
  readonly kind: "literal";
  readonly value: LiteralValue;
  /** Decimal literals are authored as strings and typed explicitly. */
  readonly type?: ValueType;
}

/** Field access: `amount`, `employee.title`. */
export interface FieldExpression {
  readonly kind: "field";
  readonly path: readonly string[];
}

export type UnaryOperator = "-" | "!";

export interface UnaryExpression {
  readonly kind: "unary";
  readonly operator: UnaryOperator;
  readonly operand: Expression;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "&&"
  | "||";

export interface BinaryExpression {
  readonly kind: "binary";
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

/** Calls resolve against the function registry; there is no dynamic dispatch. */
export interface CallExpression {
  readonly kind: "call";
  readonly callee: string;
  readonly args: readonly Expression[];
}

export interface ConditionalExpression {
  readonly kind: "conditional";
  readonly test: Expression;
  readonly whenTrue: Expression;
  readonly whenFalse: Expression;
}

/**
 * A run parameter, e.g. the period's point value or a budget total.
 *
 * Declarative on purpose. Encoding a parameter as a magic field path such as
 * `$parameters.total` would be a convention only the JS backend knows, which
 * is precisely the opacity the semantic IR exists to remove: a backend must be
 * able to see "this is parameter `total`" without sharing a naming secret.
 */
export interface ParameterExpression {
  readonly kind: "parameter";
  readonly name: string;
}

export type Expression =
  | LiteralExpression
  | FieldExpression
  | ParameterExpression
  | UnaryExpression
  | BinaryExpression
  | CallExpression
  | ConditionalExpression;

/**
 * What a resource stores. Text is the authoring form; the AST is derived and
 * cached. Storing only the AST would make round-tripping to the editor lossy
 * (formatting, comments); storing only text would defer every error to run time.
 */
export interface ExpressionSpec {
  readonly text: string;
}

export interface CompiledExpression {
  readonly source: ExpressionSpec;
  readonly ast: Expression;
  readonly type: ValueType;
  /** Field paths the expression reads. Drives dependency and lineage analysis. */
  readonly references: readonly (readonly string[])[];
}

/** Signature of a registered function. Arity and types are checked statically. */
export interface FunctionSignature {
  readonly name: string;
  readonly parameters: readonly { readonly name: string; readonly type: ValueType }[];
  readonly returns: ValueType;
  /** Trailing parameter repeats, e.g. `coalesce(a, b, c, ...)`. */
  readonly variadic?: boolean;
  readonly description?: string;
}
