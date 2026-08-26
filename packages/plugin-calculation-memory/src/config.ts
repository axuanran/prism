import type {
  AllocationPolicy,
  ExpressionSpec,
} from "@prism/contracts-calculation";
import type { RoundingMode } from "@prism/contracts-data";
import { Type } from "@sinclair/typebox";

export interface InputConfig {
  readonly name: string;
}

export interface FilterConfig {
  readonly where: ExpressionSpec;
}

export interface FormulaColumnConfig {
  readonly name: string;
  readonly expression: ExpressionSpec;
}

export interface FormulaConfig {
  readonly columns: readonly FormulaColumnConfig[];
}

export interface JoinConfig {
  readonly kind: "inner" | "left";
  readonly leftKey: string;
  readonly rightKey: string;
  readonly expectedCardinality: "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";
  readonly rightPrefix?: string;
}

export interface LookupConfig {
  readonly key: {
    readonly input: string;
    readonly lookup: string;
  };
  readonly output: {
    readonly field: string;
    readonly as: string;
  };
  readonly missingPolicy?: "error" | "null" | "default";
  readonly defaultValue?: string | number | boolean | null;
  readonly multiplePolicy?: "error" | "first";
}

export interface DecisionRuleConfig {
  readonly id: string;
  readonly when: ExpressionSpec;
  readonly outputs: Readonly<Record<string, ExpressionSpec>>;
}

export interface DecisionConfig {
  readonly rules: readonly DecisionRuleConfig[];
  readonly unmatchedPolicy?: "keep" | "drop" | "error";
}

export type AggregateOperation = "sum" | "count" | "min" | "max" | "avg";

export interface AggregateColumnConfig {
  readonly name: string;
  readonly operation: AggregateOperation;
  readonly field?: string;
}

export interface AggregateConfig {
  readonly groupBy: readonly string[];
  readonly aggregates: readonly AggregateColumnConfig[];
  readonly division?: {
    readonly precision: number;
    readonly rounding: RoundingMode;
  };
}

export type AllocationAmountSource =
  | { readonly field: string }
  | { readonly parameter: string }
  | { readonly value: string };

export interface AllocateConfig {
  readonly amount: AllocationAmountSource;
  readonly weight: ExpressionSpec;
  readonly partitionBy: readonly string[];
  readonly policy: AllocationPolicy;
  readonly output?: string;
  /** Deterministic remainder ordering. Defaults to canonical row JSON. */
  readonly sortBy?: readonly string[];
}

export interface ValidationAssertionConfig {
  readonly id: string;
  readonly expression: ExpressionSpec;
  readonly message?: string;
}

export interface ValidateConfig {
  readonly assert: readonly ValidationAssertionConfig[];
}

export type OutputConfig = Readonly<Record<string, never>>;

const ExpressionSchema = Type.Object(
  { text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ScalarConfigValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

const RoundingModeSchema = Type.Union([
  Type.Literal("half-up"),
  Type.Literal("half-even"),
  Type.Literal("half-down"),
  Type.Literal("up"),
  Type.Literal("down"),
  Type.Literal("ceiling"),
  Type.Literal("floor"),
]);

export const InputConfigSchema = Type.Object(
  { name: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const FilterConfigSchema = Type.Object(
  { where: ExpressionSchema },
  { additionalProperties: false },
);

export const FormulaConfigSchema = Type.Object(
  {
    columns: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          expression: ExpressionSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const JoinConfigSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("inner"), Type.Literal("left")]),
    leftKey: Type.String({ minLength: 1 }),
    rightKey: Type.String({ minLength: 1 }),
    expectedCardinality: Type.Union([
      Type.Literal("one-to-one"),
      Type.Literal("many-to-one"),
      Type.Literal("one-to-many"),
      Type.Literal("many-to-many"),
    ]),
    rightPrefix: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LookupConfigSchema = Type.Object(
  {
    key: Type.Object(
      {
        input: Type.String({ minLength: 1 }),
        lookup: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      {
        field: Type.String({ minLength: 1 }),
        as: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    missingPolicy: Type.Optional(Type.Union([
      Type.Literal("error"),
      Type.Literal("null"),
      Type.Literal("default"),
    ], { default: "error" })),
    defaultValue: Type.Optional(ScalarConfigValueSchema),
    multiplePolicy: Type.Optional(Type.Union([
      Type.Literal("error"),
      Type.Literal("first"),
    ], { default: "error" })),
  },
  { additionalProperties: false },
);

export const DecisionConfigSchema = Type.Object(
  {
    rules: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          when: ExpressionSchema,
          outputs: Type.Record(Type.String({ minLength: 1 }), ExpressionSchema),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    unmatchedPolicy: Type.Optional(Type.Union([
      Type.Literal("keep"),
      Type.Literal("drop"),
      Type.Literal("error"),
    ], { default: "keep" })),
  },
  { additionalProperties: false },
);

export const AggregateConfigSchema = Type.Object(
  {
    groupBy: Type.Array(Type.String({ minLength: 1 })),
    aggregates: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          operation: Type.Union([
            Type.Literal("sum"),
            Type.Literal("count"),
            Type.Literal("min"),
            Type.Literal("max"),
            Type.Literal("avg"),
          ]),
          field: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    division: Type.Optional(Type.Object(
      {
        precision: Type.Integer({ minimum: 1, maximum: 34 }),
        rounding: RoundingModeSchema,
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

const AllocationRemainderSchema = Type.Union([
  Type.Object({ kind: Type.Literal("largest-remainder") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("to-row"), rowKey: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("reject") }, { additionalProperties: false }),
]);

const AllocationPolicySchema = Type.Object(
  {
    scale: Type.Integer({ minimum: 0, maximum: 18 }),
    rounding: RoundingModeSchema,
    remainder: AllocationRemainderSchema,
    onZeroWeight: Type.Union([
      Type.Literal("equal"),
      Type.Literal("zero"),
      Type.Literal("error"),
    ]),
    allowNegativeWeights: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AllocateConfigSchema = Type.Object(
  {
    amount: Type.Union([
      Type.Object({ field: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ parameter: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ value: Type.String({ pattern: "^-?[0-9]+(?:\\.[0-9]+)?$" }) }, { additionalProperties: false }),
    ]),
    weight: ExpressionSchema,
    partitionBy: Type.Array(Type.String({ minLength: 1 })),
    policy: AllocationPolicySchema,
    output: Type.Optional(Type.String({ minLength: 1, default: "allocated" })),
    sortBy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const ValidateConfigSchema = Type.Object(
  {
    assert: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          expression: ExpressionSchema,
          message: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const OutputConfigSchema = Type.Object({}, { additionalProperties: false });

export const PipelineResourceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    inputs: Type.Array(Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        schema: Type.Unknown(),
        description: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    )),
    parameters: Type.Optional(Type.Array(Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        type: Type.Unknown(),
        description: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ))),
    nodes: Type.Array(Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        operation: Type.String({ minLength: 1 }),
        config: Type.Unknown(),
        label: Type.Optional(Type.String()),
        position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false })),
      },
      { additionalProperties: false },
    )),
    edges: Type.Array(Type.Object(
      {
        fromNode: Type.String({ minLength: 1 }),
        fromPort: Type.String({ minLength: 1 }),
        toNode: Type.String({ minLength: 1 }),
        toPort: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    )),
    outputs: Type.Array(Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        fromNode: Type.String({ minLength: 1 }),
        fromPort: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

export const LookupTableResourceSchema = Type.Object(
  {
    columns: Type.Array(Type.Object(
      { name: Type.String({ minLength: 1 }), type: Type.Unknown() },
      { additionalProperties: false },
    )),
    rows: Type.Array(Type.Record(Type.String(), ScalarConfigValueSchema)),
  },
  { additionalProperties: false },
);

export const DecisionTableResourceSchema = Type.Object(
  { rules: DecisionConfigSchema.properties.rules },
  { additionalProperties: false },
);
