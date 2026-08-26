import {
  CalculationDiagnosticCode,
  type Expression,
  type LowerRequest,
  type OperationDefinition,
  type PlanNodeOrigin,
  type TypeInferenceResult,
  type TypeAnalysisService,
} from "@prismengine/contracts-calculation";
import {
  PrismError,
  diagnostic,
  tableType,
  type Diagnostic,
  type FieldType,
  type TableType,
  type ValueType,
  MAX_DECIMAL_PRECISION,
  decimalType,
} from "@prismengine/contracts-data";
import { INFERRED_DECIMAL_SCALE } from "./expression.js";
import {
  AggregateConfigSchema,
  AllocateConfigSchema,
  DecisionConfigSchema,
  FilterConfigSchema,
  FormulaConfigSchema,
  InputConfigSchema,
  JoinConfigSchema,
  LookupConfigSchema,
  OutputConfigSchema,
  ValidateConfigSchema,
  type AggregateConfig,
  type AllocateConfig,
  type DecisionConfig,
  type FilterConfig,
  type FormulaConfig,
  type InputConfig,
  type JoinConfig,
  type LookupConfig,
  type ValidateConfig,
} from "./config.js";
import { analyzeExpressionInternal } from "./expression.js";

const TABLE_INPUT = [{ name: "in", kind: "table", required: true, title: "输入" }] as const;
const TABLE_OUTPUT = [{ name: "out", kind: "table", required: true, title: "输出" }] as const;
const EXPOSED = Object.freeze({ pipeline: true, configuration: true, frontend: true });
/** See expression.ts: inference must not narrow a decimal column early. */
const DECIMAL_TYPE: ValueType = Object.freeze(
  decimalType(MAX_DECIMAL_PRECISION, INFERRED_DECIMAL_SCALE),
);
const INT_TYPE: ValueType = Object.freeze({ kind: "int" });

function inferenceError(code: string, message: string, details?: Readonly<Record<string, unknown>>): TypeInferenceResult {
  return { outputs: {}, diagnostics: [diagnostic(code, message, { details })] };
}

function inputTable(inputs: Readonly<Record<string, ValueType>>, port = "in"): TableType | undefined {
  const type = inputs[port];
  return type?.kind === "table" ? type : undefined;
}

function tableScope(type: TableType): Readonly<Record<string, ValueType>> {
  return Object.fromEntries(type.columns.map((column) => [column.name, column.type]));
}

function outputTable(type: TableType, diagnostics: readonly Diagnostic[] = []): TypeInferenceResult {
  return { outputs: { out: type }, diagnostics };
}

function replaceColumn(columns: readonly FieldType[], field: FieldType): readonly FieldType[] {
  return [...columns.filter((column) => column.name !== field.name), field];
}

function columnOf(type: TableType, name: string): FieldType | undefined {
  return type.columns.find((column) => column.name === name);
}

function mergedJoinColumns(left: TableType, right: TableType, config: JoinConfig): readonly FieldType[] {
  const names = new Set(left.columns.map((column) => column.name));
  const prefix = config.rightPrefix ?? "right_";
  return [
    ...left.columns,
    ...right.columns
      .filter((column) => column.name !== config.rightKey || column.name !== config.leftKey)
      .map((column) => {
        const named = names.has(column.name) ? { ...column, name: `${prefix}${column.name}` } : column;
        return config.kind === "left" ? { ...named, type: { ...named.type, nullable: true } } : named;
      }),
  ];
}

function lookupOutputType(input: TableType, lookup: TableType, config: LookupConfig): TableType | undefined {
  const field = columnOf(lookup, config.output.field);
  if (field === undefined) return undefined;
  return tableType(replaceColumn(input.columns, {
    name: config.output.as,
    type: {
      ...field.type,
      nullable: (config.missingPolicy ?? "error") !== "default"
        || field.type.nullable,
    },
  }));
}

function aggregateOutputType(input: TableType, config: AggregateConfig): TypeInferenceResult {
  const diagnostics: Diagnostic[] = [];
  const columns: FieldType[] = [];
  for (const name of config.groupBy) {
    const field = columnOf(input, name);
    if (field === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, `Aggregate group field "${name}" does not exist.`));
    else columns.push(field);
  }
  for (const aggregate of config.aggregates) {
    if (aggregate.operation === "count") {
      columns.push({ name: aggregate.name, type: INT_TYPE });
      continue;
    }
    const field = aggregate.field === undefined ? undefined : columnOf(input, aggregate.field);
    if (field === undefined) {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, `Aggregate field for "${aggregate.name}" does not exist.`));
      continue;
    }
    if ((aggregate.operation === "sum" || aggregate.operation === "avg") && field.type.kind !== "decimal" && field.type.kind !== "int") {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, `${aggregate.operation} requires a numeric field.`));
    }
    if ((aggregate.operation === "min" || aggregate.operation === "max") && field.type.kind !== "decimal" && field.type.kind !== "int") {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, `${aggregate.operation} requires a numeric field in V0.1.`));
    }
    columns.push({ name: aggregate.name, type: aggregate.operation === "avg" ? DECIMAL_TYPE : field.type });
  }
  return outputTable(tableType(columns), diagnostics);
}

function origin(operation: OperationDefinition<unknown>, request: LowerRequest<unknown>): PlanNodeOrigin {
  return {
    operation: operation.id,
    version: operation.version,
    sourceNodeId: request.nodeId,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

function loweredOutputType(request: LowerRequest<unknown>): TableType {
  const type = request.outputTypes.out;
  if (type?.kind !== "table") {
    throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Node "${request.nodeId}" has no resolved table output.`);
  }
  return type;
}

function sourceRef(request: LowerRequest<unknown>, port: string): NonNullable<(typeof request.inputs)[string]> {
  const source = request.inputs[port];
  if (source === undefined) {
    throw PrismError.of(CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED, `Required port "${request.nodeId}.${port}" is not connected.`);
  }
  return source;
}

function expressionAst(
  spec: { readonly text: string },
  scope: Readonly<Record<string, ValueType>>,
  analysis: TypeAnalysisService,
): Expression {
  const analyzed = analyzeExpressionInternal(spec, scope, analysis);
  if ("diagnostics" in analyzed) throw new PrismError(analyzed.diagnostics);
  return analyzed.ast;
}

function literalExpression(value: LookupConfig["defaultValue"], type: ValueType): Expression {
  if (value === undefined || value === null) return { kind: "literal", value: null };
  if (type.kind === "decimal") return { kind: "literal", value: String(typeof value === "boolean" ? Number(value) : value), type };
  if (type.kind === "int") return { kind: "literal", value: Number(value), type };
  if (type.kind === "boolean") return { kind: "literal", value: Boolean(value), type };
  return { kind: "literal", value: String(value), type };
}

const inputOperation: OperationDefinition<unknown> = {
  id: "calculation.input",
  version: "0.1.0",
  title: "输入数据",
  description: "读取管道声明的数据集。",
  category: "数据",
  inputs: [],
  outputs: TABLE_OUTPUT,
  config: { schema: InputConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const source = inputTable(request.inputs, "source");
    return source === undefined
      ? inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "The configured pipeline input does not exist.")
      : outputTable(source);
  },
  lower(request) {
    const config = request.config as InputConfig;
    return {
      id: request.nodeId,
      kind: "input",
      origin: origin(inputOperation, request),
      outputType: loweredOutputType(request),
      dataset: config.name,
    };
  },
};

const filterOperation: OperationDefinition<unknown> = {
  id: "calculation.filter",
  version: "0.1.0",
  title: "筛选",
  description: "保留满足条件的数据行。",
  category: "数据",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: FilterConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    if (input === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Filter requires a table input.");
    const config = request.config as FilterConfig;
    const analyzed = analyzeExpressionInternal(config.where, tableScope(input), request.analysis);
    if ("diagnostics" in analyzed) return outputTable(input, analyzed.diagnostics);
    const diagnostics = analyzed.type.kind === "boolean"
      ? []
      : [diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, "Filter expression must return boolean.")];
    return outputTable(input, diagnostics);
  },
  lower(request) {
    const config = request.config as FilterConfig;
    const input = inputTable(request.inputTypes);
    if (input === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Filter requires a table input.");
    return {
      id: request.nodeId,
      kind: "filter",
      origin: origin(filterOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      predicate: expressionAst(config.where, tableScope(input), request.analysis),
    };
  },
};

const formulaOperation: OperationDefinition<unknown> = {
  id: "calculation.formula",
  version: "0.1.0",
  title: "公式",
  description: "用已校验的表达式新增或替换列。",
  category: "计算",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: FormulaConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    if (input === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Formula requires a table input.");
    const config = request.config as FormulaConfig;
    let columns = input.columns;
    const diagnostics: Diagnostic[] = [];
    for (const column of config.columns) {
      const analyzed = analyzeExpressionInternal(column.expression, tableScope(tableType(columns)), request.analysis);
      if ("diagnostics" in analyzed) {
        diagnostics.push(...analyzed.diagnostics);
        continue;
      }
      // Evaluation failures are represented as null alongside a structured
      // diagnostic until execution stops, so the physical output is nullable.
      columns = replaceColumn(columns, {
        name: column.name,
        type: { ...analyzed.type, nullable: true },
      });
    }
    return outputTable(tableType(columns), diagnostics);
  },
  lower(request) {
    const config = request.config as FormulaConfig;
    const input = inputTable(request.inputTypes);
    if (input === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Formula requires a table input.");
    let columns = input.columns;
    const formulas: { readonly name: string; readonly expression: Expression; readonly type: ValueType }[] = [];
    for (const column of config.columns) {
      const analyzed = analyzeExpressionInternal(column.expression, tableScope(tableType(columns)), request.analysis);
      if ("diagnostics" in analyzed) throw new PrismError(analyzed.diagnostics);
      const type = { ...analyzed.type, nullable: true };
      formulas.push({ name: column.name, expression: analyzed.ast, type });
      columns = replaceColumn(columns, { name: column.name, type });
    }
    return {
      id: request.nodeId,
      kind: "formula",
      origin: origin(formulaOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      columns: formulas,
    };
  },
};

const joinOperation: OperationDefinition<unknown> = {
  id: "calculation.join",
  version: "0.1.0",
  title: "关联",
  description: "按声明的基数约束关联两个数据集。",
  category: "数据",
  inputs: [
    { name: "left", kind: "table", required: true, title: "左表" },
    { name: "right", kind: "table", required: true, title: "右表" },
  ],
  outputs: TABLE_OUTPUT,
  config: { schema: JoinConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const left = inputTable(request.inputs, "left");
    const right = inputTable(request.inputs, "right");
    if (left === undefined || right === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Join requires left and right table inputs.");
    const config = request.config as JoinConfig;
    const leftKey = columnOf(left, config.leftKey);
    const rightKey = columnOf(right, config.rightKey);
    if (leftKey === undefined || rightKey === undefined) return inferenceError(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, "Join key column does not exist.");
    if (leftKey.type.kind !== rightKey.type.kind && !(leftKey.type.kind === "int" && rightKey.type.kind === "decimal") && !(leftKey.type.kind === "decimal" && rightKey.type.kind === "int")) {
      return inferenceError(CalculationDiagnosticCode.JOIN_KEY_TYPE_MISMATCH, "Join key types are incompatible.", { left: leftKey.type.kind, right: rightKey.type.kind });
    }
    return outputTable(tableType(mergedJoinColumns(left, right, config)));
  },
  lower(request) {
    const config = request.config as JoinConfig;
    return {
      id: request.nodeId,
      kind: "join",
      origin: origin(joinOperation, request),
      outputType: loweredOutputType(request),
      left: sourceRef(request, "left"),
      right: sourceRef(request, "right"),
      joinType: config.kind,
      keys: [{ left: config.leftKey, right: config.rightKey }],
      expectedCardinality: config.expectedCardinality,
      ...(config.rightPrefix === undefined ? {} : { rightPrefix: config.rightPrefix }),
    };
  },
};

const lookupOperation: OperationDefinition<unknown> = {
  id: "calculation.lookup",
  version: "0.1.0",
  title: "查表",
  description: "按键查找一个值，并显式处理缺失和重复。",
  category: "数据",
  inputs: [
    { name: "in", kind: "table", required: true, title: "输入" },
    { name: "lookup", kind: "table", required: true, title: "查找表" },
  ],
  outputs: TABLE_OUTPUT,
  config: { schema: LookupConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    const lookup = inputTable(request.inputs, "lookup");
    if (input === undefined || lookup === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Lookup requires input and lookup table ports.");
    const config = request.config as LookupConfig;
    const inputKey = columnOf(input, config.key.input);
    const lookupKey = columnOf(lookup, config.key.lookup);
    const output = lookupOutputType(input, lookup, config);
    if (inputKey === undefined || lookupKey === undefined || output === undefined) return inferenceError(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, "Lookup key or output column does not exist.");
    if (inputKey.type.kind !== lookupKey.type.kind && !(inputKey.type.kind === "int" && lookupKey.type.kind === "decimal") && !(inputKey.type.kind === "decimal" && lookupKey.type.kind === "int")) {
      return inferenceError(CalculationDiagnosticCode.JOIN_KEY_TYPE_MISMATCH, "Lookup key types are incompatible.");
    }
    if ((config.missingPolicy ?? "error") === "default" && config.defaultValue === undefined) {
      return outputTable(output, [diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, "Lookup default policy requires defaultValue.")]);
    }
    return outputTable(output);
  },
  lower(request) {
    const config = request.config as LookupConfig;
    const lookupType = inputTable(request.inputTypes, "lookup");
    const selectedType = lookupType === undefined ? undefined : columnOf(lookupType, config.output.field)?.type;
    if (selectedType === undefined) throw PrismError.of(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, "Lookup output field does not exist.");
    return {
      id: request.nodeId,
      kind: "lookup",
      origin: origin(lookupOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      table: sourceRef(request, "lookup"),
      keys: [{ left: config.key.input, right: config.key.lookup }],
      outputs: [{
        name: config.output.as,
        from: config.output.field,
        ...((config.missingPolicy ?? "error") === "default" ? { defaultValue: literalExpression(config.defaultValue, selectedType) } : {}),
      }],
      missingPolicy: config.missingPolicy ?? "error",
      multiplePolicy: config.multiplePolicy ?? "error",
    };
  },
};

const decisionOperation: OperationDefinition<unknown> = {
  id: "calculation.decision",
  version: "0.1.0",
  title: "决策表",
  description: "按顺序执行规则，首个匹配规则生效。",
  category: "计算",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: DecisionConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    if (input === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Decision requires a table input.");
    const config = request.config as DecisionConfig;
    const diagnostics: Diagnostic[] = [];
    let columns = input.columns;
    const outputTypes = new Map<string, ValueType>();
    for (const rule of config.rules) {
      const condition = analyzeExpressionInternal(rule.when, tableScope(input), request.analysis);
      if ("diagnostics" in condition) diagnostics.push(...condition.diagnostics);
      else if (condition.type.kind !== "boolean") diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, `Decision rule "${rule.id}" condition must be boolean.`));
      for (const [name, expression] of Object.entries(rule.outputs)) {
        const analyzed = analyzeExpressionInternal(expression, tableScope(input), request.analysis);
        if ("diagnostics" in analyzed) {
          diagnostics.push(...analyzed.diagnostics);
          continue;
        }
        const previous = outputTypes.get(name);
        if (previous !== undefined && previous.kind !== analyzed.type.kind) diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, `Decision output "${name}" has inconsistent types.`));
        else outputTypes.set(name, analyzed.type);
      }
    }
    for (const [name, type] of outputTypes) columns = replaceColumn(columns, { name, type: { ...type, nullable: (config.unmatchedPolicy ?? "keep") !== "error" } });
    return outputTable(tableType(columns), diagnostics);
  },
  validate(request) {
    const config = request.config as DecisionConfig;
    const ids = new Set<string>();
    const diagnostics: Diagnostic[] = [];
    for (const rule of config.rules) {
      if (ids.has(rule.id)) diagnostics.push(diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, `Duplicate decision rule id "${rule.id}".`));
      ids.add(rule.id);
    }
    return diagnostics;
  },
  lower(request) {
    const config = request.config as DecisionConfig;
    const input = inputTable(request.inputTypes);
    if (input === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Decision requires a table input.");
    const scope = tableScope(input);
    const outputType = loweredOutputType(request);
    const outputNames = [...new Set(config.rules.flatMap((rule) => Object.keys(rule.outputs)))];
    const onNoMatch = config.unmatchedPolicy === "drop"
      ? "drop" as const
      : config.unmatchedPolicy === "error" ? "error" as const : "null" as const;
    return {
      id: request.nodeId,
      kind: "decision",
      origin: origin(decisionOperation, request),
      outputType,
      source: sourceRef(request, "in"),
      rules: config.rules.map((rule) => ({
        id: rule.id,
        when: expressionAst(rule.when, scope, request.analysis),
        outputs: Object.fromEntries(Object.entries(rule.outputs).map(([name, expression]) => [name, expressionAst(expression, scope, request.analysis)])),
      })),
      outputs: outputNames.map((name) => ({ name, type: columnOf(outputType, name)?.type ?? { kind: "null", nullable: true } })),
      onNoMatch,
    };
  },
};

const aggregateOperation: OperationDefinition<unknown> = {
  id: "calculation.aggregate",
  version: "0.1.0",
  title: "汇总",
  description: "按分组精确汇总数据。",
  category: "计算",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: AggregateConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    return input === undefined
      ? inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Aggregate requires a table input.")
      : aggregateOutputType(input, request.config as AggregateConfig);
  },
  lower(request) {
    const config = request.config as AggregateConfig;
    const outputType = loweredOutputType(request);
    return {
      id: request.nodeId,
      kind: "aggregate",
      origin: origin(aggregateOperation, request),
      outputType,
      source: sourceRef(request, "in"),
      groupBy: config.groupBy,
      aggregations: config.aggregates.map((aggregate) => ({
        name: aggregate.name,
        fn: aggregate.operation,
        ...(aggregate.field === undefined ? {} : { column: aggregate.field }),
        type: columnOf(outputType, aggregate.name)?.type ?? (aggregate.operation === "count" ? INT_TYPE : DECIMAL_TYPE),
      })),
      division: config.division ?? { precision: 28, rounding: "half-up" },
    };
  },
};

const allocateOperation: OperationDefinition<unknown> = {
  id: "calculation.allocate",
  version: "0.1.0",
  title: "分配",
  description: "按权重分配金额，并逐分区强制守恒。余数并列按 sortBy、规范行 JSON、原始行号依次破同分。",
  category: "分配",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: AllocateConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    if (input === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Allocate requires a table input.");
    const config = request.config as AllocateConfig;
    const diagnostics: Diagnostic[] = [];
    for (const field of config.partitionBy) if (columnOf(input, field) === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, `Allocation partition field "${field}" does not exist.`));
    if ("field" in config.amount && columnOf(input, config.amount.field) === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, `Allocation amount field "${config.amount.field}" does not exist.`));
    for (const field of config.sortBy ?? []) if (columnOf(input, field) === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD, `Allocation sort field "${field}" does not exist.`));
    const weight = analyzeExpressionInternal(config.weight, tableScope(input), request.analysis);
    if ("diagnostics" in weight) diagnostics.push(...weight.diagnostics);
    else if (weight.type.kind !== "decimal" && weight.type.kind !== "int") diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, "Allocation weight must be numeric."));
    return outputTable(tableType(replaceColumn(input.columns, { name: config.output ?? "allocated", type: decimalType(MAX_DECIMAL_PRECISION, config.policy.scale) })), diagnostics);
  },
  lower(request) {
    const config = request.config as AllocateConfig;
    const input = inputTable(request.inputTypes);
    if (input === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Allocate requires a table input.");
    const amount = "field" in config.amount
      ? { kind: "column" as const, column: config.amount.field }
      : "parameter" in config.amount
        ? { kind: "expression" as const, expression: { kind: "parameter" as const, name: config.amount.parameter } }
        : { kind: "expression" as const, expression: { kind: "literal" as const, value: config.amount.value, type: DECIMAL_TYPE } };
    return {
      id: request.nodeId,
      kind: "allocate",
      origin: origin(allocateOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      amount,
      weight: expressionAst(config.weight, tableScope(input), request.analysis),
      partitionBy: config.partitionBy,
      output: config.output ?? "allocated",
      sortBy: config.sortBy ?? [],
      policy: config.policy,
    };
  },
};

const validateOperation: OperationDefinition<unknown> = {
  id: "calculation.validate",
  version: "0.1.0",
  title: "校验",
  description: "逐行执行断言，并定位不符合要求的数据。",
  category: "质量",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: ValidateConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    if (input === undefined) return inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Validate requires a table input.");
    const config = request.config as ValidateConfig;
    const diagnostics: Diagnostic[] = [];
    for (const assertion of config.assert) {
      const analyzed = analyzeExpressionInternal(assertion.expression, tableScope(input), request.analysis);
      if ("diagnostics" in analyzed) diagnostics.push(...analyzed.diagnostics);
      else if (analyzed.type.kind !== "boolean") diagnostics.push(diagnostic(CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR, `Validation assertion "${assertion.id}" must return boolean.`));
    }
    return outputTable(input, diagnostics);
  },
  lower(request) {
    const config = request.config as ValidateConfig;
    const input = inputTable(request.inputTypes);
    if (input === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Validate requires a table input.");
    return {
      id: request.nodeId,
      kind: "validate",
      origin: origin(validateOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      assertions: config.assert.map((assertion) => ({
        id: assertion.id,
        expression: expressionAst(assertion.expression, tableScope(input), request.analysis),
        message: assertion.message ?? `Validation assertion "${assertion.id}" failed.`,
        severity: "error" as const,
      })),
    };
  },
};

const outputOperation: OperationDefinition<unknown> = {
  id: "calculation.output",
  version: "0.1.0",
  title: "输出",
  description: "标记管道的业务输出。",
  category: "数据",
  inputs: TABLE_INPUT,
  outputs: TABLE_OUTPUT,
  config: { schema: OutputConfigSchema },
  exposure: EXPOSED,
  infer(request) {
    const input = inputTable(request.inputs);
    return input === undefined
      ? inferenceError(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Output requires a table input.")
      : outputTable(input);
  },
  lower(request) {
    return {
      id: request.nodeId,
      kind: "output",
      origin: origin(outputOperation, request),
      outputType: loweredOutputType(request),
      source: sourceRef(request, "in"),
      name: request.label ?? request.nodeId,
    };
  },
};

export const BUILTIN_OPERATIONS: readonly OperationDefinition<unknown>[] = Object.freeze([
  inputOperation,
  filterOperation,
  formulaOperation,
  joinOperation,
  lookupOperation,
  decisionOperation,
  aggregateOperation,
  allocateOperation,
  validateOperation,
  outputOperation,
]);
