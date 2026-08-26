import { createHash } from "node:crypto";
import {
  CalculationDiagnosticCode,
  planNodeSources,
  type AggregatePlanNode,
  type AllocatePlanNode,
  type BackendExecutionContext,
  type CalculationBackend,
  type CompileContext,
  type DecisionPlanNode,
  type ExecutablePlan,
  type ExecutionResult,
  type JoinCardinality,
  type JoinPlanNode,
  type LookupPlanNode,
  type NodeTrace,
  type NodeTraceDetail,
  type ParameterBindings,
  type PlanBindings,
  type PlanRef,
  type SemanticPlan,
  type SemanticPlanNode,
  type TraceLevel,
  type ValidatePlanNode,
  type ParameterValue,
} from "@prismengine/contracts-calculation";
import {
  D,
  Decimal,
  PrismError,
  countRows,
  datasetFromRows,
  diagnostic,
  hasErrors,
  materializeBatchRows,
  roundDecimal,
  type CallContext,
  type DataBatch,
  type Dataset,
  type DatasetFingerprint,
  type ParameterFingerprint,
  type Diagnostic,
  type InputSnapshot,
  type Row,
  type RoundingMode,
  type RowValue,
  type TableType,
  type ValueType,
  type VersionStamp,
  decimalToJson,
} from "@prismengine/contracts-data";
import { canonicalValue, stableHash, stableStringify } from "./determinism.js";
import { compileExpressionEvaluator, type ExpressionEvaluator } from "./expression.js";

const FULL_TRACE_SAMPLE_LIMIT = 20;

interface NodeExecutionContext {
  readonly call: CallContext;
  readonly bindings: PlanBindings;
  readonly datasets: ReadonlyMap<string, Dataset>;
  report(item: Diagnostic): void;
  trace(detail: NodeTraceDetail): void;
}

interface CompiledMemoryNode {
  readonly node: SemanticPlanNode;
  execute(context: NodeExecutionContext): Promise<Dataset>;
}

interface MemoryExecutablePlan extends ExecutablePlan {
  readonly semanticPlan: SemanticPlan;
  readonly versions: VersionStamp;
  readonly nodes: readonly CompiledMemoryNode[];
}

interface AggregateState {
  readonly groupValues: Readonly<Record<string, RowValue>>;
  readonly values: Map<string, Decimal | number | null>;
  readonly counts: Map<string, number>;
}

interface IndexedAllocationRow {
  readonly row: Row;
  readonly index: number;
  readonly stableKey: string;
  weight: Decimal;
  part: Decimal;
  residual: Decimal;
}

function datasetFor(ref: PlanRef, context: NodeExecutionContext): Dataset | undefined {
  return context.datasets.get(ref.node);
}

/**
 * The sole columnar-to-row conversion used by the row-oriented MemoryBackend.
 * Fingerprinting and tracing share it so the Arrow ABI never leaks inward.
 */
function rowsFromMemoryBatch(batch: DataBatch): readonly Row[] {
  return materializeBatchRows(batch);
}

async function rowsFromMemoryDataset(
  dataset: Dataset,
  context: CallContext,
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  for await (const batch of dataset.stream(context)) {
    rows.push(...rowsFromMemoryBatch(batch));
  }
  return rows;
}

async function rowsFor(ref: PlanRef, context: NodeExecutionContext): Promise<readonly Row[]> {
  const dataset = datasetFor(ref, context);
  return dataset === undefined
    ? []
    : rowsFromMemoryDataset(dataset, context.call);
}

/**
 * The sole MemoryBackend row-to-columnar conversion. A future columnar
 * backend replaces this adapter rather than changing operation contracts.
 */
function datasetFromMemoryRows(
  name: string,
  schema: TableType,
  rows: readonly Row[],
): Dataset {
  return datasetFromRows(name, schema, rows);
}

function reportForNode(context: NodeExecutionContext, node: SemanticPlanNode, item: Diagnostic): void {
  context.report(item.nodeId === undefined ? { ...item, nodeId: node.origin.sourceNodeId } : item);
}

function runtimeDiagnostic(
  context: NodeExecutionContext,
  node: SemanticPlanNode,
  code: string,
  message: string,
  extra: { readonly path?: string; readonly details?: Readonly<Record<string, unknown>>; readonly severity?: "warning" | "error" } = {},
): void {
  context.report(diagnostic(code, message, { nodeId: node.origin.sourceNodeId, ...extra }));
}

function expressionReport(context: NodeExecutionContext, node: SemanticPlanNode, path: string): (item: Diagnostic) => void {
  return (item) => reportForNode(context, node, { ...item, path: item.path ?? path });
}

function valueKey(values: readonly (RowValue | undefined)[]): string {
  return stableStringify(values.map((value) => canonicalValue(value ?? null)));
}

function joinKey(row: Row, fields: readonly string[]): string {
  return valueKey(fields.map((field) => row[field]));
}

function actualCardinality(leftCounts: ReadonlyMap<string, number>, rightCounts: ReadonlyMap<string, number>): JoinCardinality {
  let repeatedLeft = false;
  let repeatedRight = false;
  for (const [key, count] of leftCounts) {
    if (!rightCounts.has(key)) continue;
    repeatedLeft ||= count > 1;
    repeatedRight ||= (rightCounts.get(key) ?? 0) > 1;
  }
  if (repeatedLeft && repeatedRight) return "many-to-many";
  if (repeatedLeft) return "many-to-one";
  if (repeatedRight) return "one-to-many";
  return "one-to-one";
}

function cardinalityAllowed(expected: JoinCardinality, actual: JoinCardinality): boolean {
  if (expected === "many-to-many") return true;
  if (expected === "many-to-one") return actual === "many-to-one" || actual === "one-to-one";
  if (expected === "one-to-many") return actual === "one-to-many" || actual === "one-to-one";
  return actual === "one-to-one";
}

function mergeJoinRow(left: Row, right: Row, leftType: TableType, node: JoinPlanNode): Row {
  const result: Record<string, RowValue> = { ...left };
  const names = new Set(leftType.columns.map((column) => column.name));
  const sameKeys = new Set(node.keys.filter((key) => key.left === key.right).map((key) => key.right));
  const prefix = node.rightPrefix ?? "right_";
  for (const [name, value] of Object.entries(right)) {
    if (sameKeys.has(name)) continue;
    result[names.has(name) ? `${prefix}${name}` : name] = value;
  }
  return result;
}

function unmatchedJoinRow(left: Row, rightType: TableType, leftType: TableType, node: JoinPlanNode): Row {
  const result: Record<string, RowValue> = { ...left };
  const names = new Set(leftType.columns.map((column) => column.name));
  const sameKeys = new Set(node.keys.filter((key) => key.left === key.right).map((key) => key.right));
  const prefix = node.rightPrefix ?? "right_";
  for (const column of rightType.columns) {
    if (sameKeys.has(column.name)) continue;
    result[names.has(column.name) ? `${prefix}${column.name}` : column.name] = null;
  }
  return result;
}

function decimalRounding(mode: RoundingMode): Decimal.Rounding {
  const modes: Readonly<Record<RoundingMode, Decimal.Rounding>> = {
    "half-up": Decimal.ROUND_HALF_UP,
    "half-even": Decimal.ROUND_HALF_EVEN,
    "half-down": Decimal.ROUND_HALF_DOWN,
    up: Decimal.ROUND_UP,
    down: Decimal.ROUND_DOWN,
    ceiling: Decimal.ROUND_CEIL,
    floor: Decimal.ROUND_FLOOR,
  };
  return modes[mode];
}

function addAggregate(state: AggregateState, aggregate: AggregatePlanNode["aggregations"][number], value: RowValue | undefined): void {
  if (aggregate.fn === "count") {
    state.values.set(aggregate.name, Number(state.values.get(aggregate.name) ?? 0) + 1);
    return;
  }
  if (!Decimal.isDecimal(value) && typeof value !== "number") return;
  const decimal = new D(value);
  state.counts.set(aggregate.name, (state.counts.get(aggregate.name) ?? 0) + 1);
  const current = state.values.get(aggregate.name);
  if (aggregate.fn === "sum" || aggregate.fn === "avg") {
    state.values.set(aggregate.name, current instanceof Decimal ? current.plus(decimal) : decimal);
    return;
  }
  if (!(current instanceof Decimal)) {
    state.values.set(aggregate.name, decimal);
    return;
  }
  state.values.set(aggregate.name, aggregate.fn === "min" ? Decimal.min(current, decimal) : Decimal.max(current, decimal));
}

function allocationSortKey(row: Row, sortBy: readonly string[]): string {
  return sortBy.length > 0
    ? sortBy.map((name) => canonicalValue(row[name] ?? null)).join("|")
    : stableStringify(row);
}

function decimalFromExpression(value: RowValue | undefined): Decimal | null {
  if (Decimal.isDecimal(value) || typeof value === "number" || typeof value === "string") {
    try {
      return new D(value);
    } catch {
      return null;
    }
  }
  return null;
}

function distributeRemainder(rows: IndexedAllocationRow[], remainder: Decimal, node: AllocatePlanNode, context: NodeExecutionContext): void {
  if (remainder.isZero()) return;
  const unit = new D(1).dividedBy(new D(10).pow(node.policy.scale));
  const units = BigInt(remainder.times(new D(10).pow(node.policy.scale)).toFixed(0));
  const remainderPolicy = node.policy.remainder;
  if (remainderPolicy.kind === "reject") {
    runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION, "Allocation produced a remainder that policy rejects.", { details: { remainder: remainder.toFixed() } });
    return;
  }
  if (remainderPolicy.kind === "to-row") {
    const selected = rows.find((row) =>
      row.stableKey === remainderPolicy.rowKey
      || (node.sortBy.length === 1 && String(row.row[node.sortBy[0] ?? ""]) === remainderPolicy.rowKey),
    );
    if (selected === undefined) {
      runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION, "Allocation remainder row was not found.", { details: { rowKey: remainderPolicy.rowKey } });
      return;
    }
    selected.part = selected.part.plus(unit.times(units.toString()));
    return;
  }
  const direction = units < 0n ? -1 : 1;
  const ordered = [...rows].sort((left, right) => {
    const residual = direction > 0
      ? right.residual.comparedTo(left.residual)
      : left.residual.comparedTo(right.residual);
    return residual !== 0 ? residual : left.stableKey.localeCompare(right.stableKey) || left.index - right.index;
  });
  if (ordered.length === 0) return;
  let remaining = units < 0n ? -units : units;
  let position = 0;
  while (remaining > 0n) {
    const selected = ordered[position % ordered.length];
    if (selected !== undefined) selected.part = selected.part.plus(direction > 0 ? unit : unit.negated());
    position += 1;
    remaining -= 1n;
  }
}

function compileInput(node: Extract<SemanticPlanNode, { readonly kind: "input" }>): CompiledMemoryNode {
  return {
    node,
    async execute(context) {
      const source = context.bindings.datasets[node.dataset];
      if (source !== undefined) return source;
      runtimeDiagnostic(context, node, CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED, `Input dataset "${node.dataset}" was not supplied.`);
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, []);
    },
  };
}

function compileFilter(node: Extract<SemanticPlanNode, { readonly kind: "filter" }>): CompiledMemoryNode {
  const predicate = compileExpressionEvaluator(node.predicate);
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const output = rows.filter((row, index) => Boolean(predicate(
        row,
        context.bindings.parameters,
        expressionReport(context, node, `/rows/${index}`),
        `/rows/${index}`,
      )));
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileProject(node: Extract<SemanticPlanNode, { readonly kind: "project" }>): CompiledMemoryNode {
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const output = rows.map((row) => Object.fromEntries(node.columns.map((column) => [column.name, row[column.from] ?? null])));
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileFormula(node: Extract<SemanticPlanNode, { readonly kind: "formula" }>): CompiledMemoryNode {
  const formulas = node.columns.map((column) => ({ ...column, evaluate: compileExpressionEvaluator(column.expression) }));
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const output = rows.map((row, index) => {
        const result: Record<string, RowValue> = { ...row };
        for (const formula of formulas) {
          const path = `/rows/${index}/${formula.name}`;
          result[formula.name] = formula.evaluate(result, context.bindings.parameters, expressionReport(context, node, path), path);
        }
        return result;
      });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileJoin(node: JoinPlanNode, sourceTypes: ReadonlyMap<string, TableType>): CompiledMemoryNode {
  const leftType = sourceTypes.get(node.left.node);
  const rightType = sourceTypes.get(node.right.node);
  return {
    node,
    async execute(context) {
      if (leftType === undefined || rightType === undefined) throw PrismError.of(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, "Join source types are unavailable.");
      const leftRows = await rowsFor(node.left, context);
      const rightRows = await rowsFor(node.right, context);
      const leftFields = node.keys.map((key) => key.left);
      const rightFields = node.keys.map((key) => key.right);
      const rightIndex = new Map<string, Row[]>();
      const leftCounts = new Map<string, number>();
      const rightCounts = new Map<string, number>();
      for (const row of rightRows) {
        const key = joinKey(row, rightFields);
        const matches = rightIndex.get(key) ?? [];
        matches.push(row);
        rightIndex.set(key, matches);
        rightCounts.set(key, (rightCounts.get(key) ?? 0) + 1);
      }
      for (const row of leftRows) {
        const key = joinKey(row, leftFields);
        leftCounts.set(key, (leftCounts.get(key) ?? 0) + 1);
      }
      const actual = actualCardinality(leftCounts, rightCounts);
      const unmatchedLeft = leftRows.filter((row) => !rightIndex.has(joinKey(row, leftFields))).length;
      const matchedRightKeys = new Set(leftRows.map((row) => joinKey(row, leftFields)));
      const unmatchedRight = rightRows.filter((row) => !matchedRightKeys.has(joinKey(row, rightFields))).length;
      context.trace({ kind: "join", expected: node.expectedCardinality, actual, unmatchedLeft, unmatchedRight });
      if (!cardinalityAllowed(node.expectedCardinality, actual)) {
        runtimeDiagnostic(context, node, CalculationDiagnosticCode.JOIN_CARDINALITY_VIOLATION, `Join cardinality is ${actual}, exceeding declared ${node.expectedCardinality}.`, { details: { expected: node.expectedCardinality, actual } });
        return datasetFromMemoryRows(`${node.id}.out`, node.outputType, []);
      }
      const output: Row[] = [];
      for (const left of leftRows) {
        const matches = rightIndex.get(joinKey(left, leftFields)) ?? [];
        if (matches.length === 0 && node.joinType === "left") {
          output.push(unmatchedJoinRow(left, rightType, leftType, node));
          continue;
        }
        for (const right of matches) output.push(mergeJoinRow(left, right, leftType, node));
      }
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileLookup(node: LookupPlanNode): CompiledMemoryNode {
  const defaults = node.outputs.map((output) => ({
    output,
    evaluate: output.defaultValue === undefined ? undefined : compileExpressionEvaluator(output.defaultValue),
  }));
  return {
    node,
    async execute(context) {
      const inputRows = await rowsFor(node.source, context);
      const lookupRows = await rowsFor(node.table, context);
      const leftFields = node.keys.map((key) => key.left);
      const rightFields = node.keys.map((key) => key.right);
      const index = new Map<string, Row[]>();
      for (const row of lookupRows) {
        const key = joinKey(row, rightFields);
        const matches = index.get(key) ?? [];
        matches.push(row);
        index.set(key, matches);
      }
      let matched = 0;
      let missing = 0;
      let ambiguous = 0;
      const output: Row[] = [];
      for (let rowIndex = 0; rowIndex < inputRows.length; rowIndex += 1) {
        const row = inputRows[rowIndex];
        if (row === undefined) continue;
        const matches = index.get(joinKey(row, leftFields)) ?? [];
        if (matches.length === 0) {
          missing += 1;
          if (node.missingPolicy === "error") runtimeDiagnostic(context, node, CalculationDiagnosticCode.LOOKUP_MISSING, "Lookup key has no match.", { path: `/rows/${rowIndex}/${leftFields[0] ?? ""}` });
          const result: Record<string, RowValue> = { ...row };
          for (const item of defaults) {
            const path = `/rows/${rowIndex}/${item.output.name}`;
            result[item.output.name] = node.missingPolicy === "default" && item.evaluate !== undefined
              ? item.evaluate(row, context.bindings.parameters, expressionReport(context, node, path), path)
              : null;
          }
          output.push(result);
          continue;
        }
        if (matches.length > 1) {
          ambiguous += 1;
          if (node.multiplePolicy === "error") {
            runtimeDiagnostic(context, node, CalculationDiagnosticCode.LOOKUP_AMBIGUOUS, "Lookup key has multiple matches.", { path: `/rows/${rowIndex}/${leftFields[0] ?? ""}`, details: { matches: matches.length } });
            output.push({ ...row, ...Object.fromEntries(node.outputs.map((item) => [item.name, null])) });
            continue;
          }
        }
        matched += 1;
        const selected = matches[0];
        output.push({ ...row, ...Object.fromEntries(node.outputs.map((item) => [item.name, selected?.[item.from] ?? null])) });
      }
      context.trace({ kind: "lookup", matched, missing, ambiguous });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileDecision(node: DecisionPlanNode): CompiledMemoryNode {
  const rules = node.rules.map((rule) => ({
    id: rule.id,
    when: compileExpressionEvaluator(rule.when),
    outputs: Object.entries(rule.outputs).map(([name, expression]) => ({ name, evaluate: compileExpressionEvaluator(expression) })),
  }));
  const defaults = Object.entries(node.defaults ?? {}).map(([name, expression]) => ({ name, evaluate: compileExpressionEvaluator(expression) }));
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const matchedRules: Record<string, number> = {};
      let unmatched = 0;
      const output: Row[] = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (row === undefined) continue;
        const rowPath = `/rows/${rowIndex}`;
        let selected: (typeof rules)[number] | undefined;
        for (const rule of rules) {
          if (Boolean(rule.when(row, context.bindings.parameters, expressionReport(context, node, rowPath), rowPath))) {
            selected = rule;
            break;
          }
        }
        if (selected === undefined) {
          unmatched += 1;
          if (node.onNoMatch === "error") runtimeDiagnostic(context, node, CalculationDiagnosticCode.DECISION_NO_MATCH, "No decision rule matched the row.", { path: rowPath });
          if (node.onNoMatch === "drop") continue;
          const result: Record<string, RowValue> = { ...row };
          if (node.onNoMatch === "default") {
            for (const assignment of defaults) {
              const path = `${rowPath}/${assignment.name}`;
              result[assignment.name] = assignment.evaluate(row, context.bindings.parameters, expressionReport(context, node, path), path);
            }
          } else {
            for (const declared of node.outputs) result[declared.name] = null;
          }
          output.push(result);
          continue;
        }
        matchedRules[selected.id] = (matchedRules[selected.id] ?? 0) + 1;
        const result: Record<string, RowValue> = { ...row };
        for (const assignment of selected.outputs) {
          const path = `${rowPath}/${assignment.name}`;
          result[assignment.name] = assignment.evaluate(row, context.bindings.parameters, expressionReport(context, node, path), path);
        }
        output.push(result);
      }
      context.trace({ kind: "decision", matchedRules, unmatched });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function compileAggregate(node: AggregatePlanNode): CompiledMemoryNode {
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const groups = new Map<string, AggregateState>();
      for (const row of rows) {
        const key = joinKey(row, node.groupBy);
        let state = groups.get(key);
        if (state === undefined) {
          state = {
            groupValues: Object.fromEntries(node.groupBy.map((name) => [name, row[name] ?? null])),
            values: new Map(),
            counts: new Map(),
          };
          groups.set(key, state);
        }
        for (const aggregate of node.aggregations) addAggregate(state, aggregate, aggregate.column === undefined ? null : row[aggregate.column]);
      }
      const output = [...groups.values()].map((state) => {
        const row: Record<string, RowValue> = { ...state.groupValues };
        for (const aggregate of node.aggregations) {
          const value = state.values.get(aggregate.name) ?? (aggregate.fn === "count" ? 0 : null);
          if (aggregate.fn === "avg" && value instanceof Decimal) {
            const count = state.counts.get(aggregate.name) ?? 0;
            row[aggregate.name] = value.dividedBy(count).toSignificantDigits(node.division.precision, decimalRounding(node.division.rounding));
          } else row[aggregate.name] = value;
        }
        return row;
      });
      context.trace({ kind: "aggregate", groups: groups.size });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, output);
    },
  };
}

function allocationAmountEvaluator(node: AllocatePlanNode): ExpressionEvaluator | undefined {
  return node.amount.kind === "expression" ? compileExpressionEvaluator(node.amount.expression) : undefined;
}

function compileAllocate(node: AllocatePlanNode): CompiledMemoryNode {
  const weightEvaluator = compileExpressionEvaluator(node.weight);
  const amountEvaluator = allocationAmountEvaluator(node);
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      const partitions = new Map<string, { readonly row: Row; readonly index: number }[]>();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row === undefined) continue;
        const key = joinKey(row, node.partitionBy);
        const partition = partitions.get(key) ?? [];
        partition.push({ row, index });
        partitions.set(key, partition);
      }
      const results: Row[] = [...rows];
      let inputTotal = new D(0);
      let outputTotal = new D(0);
      for (const partition of partitions.values()) {
        const partitionRows = partition.map((item) => item.row);
        let amount: Decimal | null = null;
        if (node.amount.kind === "column") {
          const column = node.amount.column;
          amount = decimalFromExpression(partitionRows[0]?.[column]);
          if (amount !== null) {
            const expected = amount;
            if (partitionRows.some((row) => {
              const value = decimalFromExpression(row[column]);
              return value === null || !value.equals(expected);
            })) amount = null;
          }
        } else if (amountEvaluator !== undefined) {
          const values = partitionRows.length === 0 ? [{}] : partitionRows;
          const first = amountEvaluator(values[0] ?? {}, context.bindings.parameters, expressionReport(context, node, "/amount"), "/amount");
          amount = decimalFromExpression(first);
          if (amount !== null) {
            const expected = amount;
            if (values.slice(1).some((row) => {
              const value = decimalFromExpression(amountEvaluator(row, context.bindings.parameters, expressionReport(context, node, "/amount"), "/amount"));
              return value === null || !value.equals(expected);
            })) amount = null;
          }
        }
        if (amount === null) {
          runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION, "Allocation amount source is missing or inconsistent within a partition.");
          continue;
        }
        const target = roundDecimal(amount, { scale: node.policy.scale, mode: node.policy.rounding });
        inputTotal = inputTotal.plus(target);
        const indexed: IndexedAllocationRow[] = partition.map(({ row, index }) => {
          const path = `/rows/${index}`;
          const raw = weightEvaluator(row, context.bindings.parameters, expressionReport(context, node, path), path);
          const weight = Decimal.isDecimal(raw) || typeof raw === "number" ? new D(raw) : new D(0);
          return { row, index, stableKey: allocationSortKey(row, node.sortBy), weight, part: new D(0), residual: new D(0) };
        });
        if (node.policy.allowNegativeWeights !== true && indexed.some((item) => item.weight.isNegative())) {
          runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_NEGATIVE_WEIGHT, "Allocation contains a negative weight.");
          continue;
        }
        let weightTotal = indexed.reduce((sum, item) => sum.plus(item.weight), new D(0));
        if (weightTotal.isZero()) {
          if (node.policy.onZeroWeight === "error") {
            runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_ZERO_WEIGHT, "Allocation partition has zero total weight.");
            continue;
          }
          if (node.policy.onZeroWeight === "equal") {
            for (const item of indexed) item.weight = new D(1);
            weightTotal = new D(indexed.length);
          }
        }
        if (weightTotal.isZero()) {
          for (const item of indexed) results[item.index] = { ...item.row, [node.output]: new D(0) };
          if (!target.isZero()) runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION, "Zero-weight policy left a non-zero amount unallocated.", { details: { total: target.toFixed() } });
          continue;
        }
        for (const item of indexed) {
          const ideal = target.times(item.weight).dividedBy(weightTotal);
          item.part = node.policy.remainder.kind === "largest-remainder"
            ? ideal.toDecimalPlaces(node.policy.scale, Decimal.ROUND_DOWN)
            : roundDecimal(ideal, { scale: node.policy.scale, mode: node.policy.rounding });
          item.residual = ideal.minus(item.part);
        }
        const baseTotal = indexed.reduce((sum, item) => sum.plus(item.part), new D(0));
        distributeRemainder(indexed, target.minus(baseTotal), node, context);
        const partitionOutput = indexed.reduce((sum, item) => sum.plus(item.part), new D(0));
        outputTotal = outputTotal.plus(partitionOutput);
        if (!partitionOutput.equals(target)) runtimeDiagnostic(context, node, CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION, "Allocation does not conserve the partition total.", { details: { input: target.toFixed(), output: partitionOutput.toFixed() } });
        for (const item of indexed) results[item.index] = { ...item.row, [node.output]: item.part };
      }
      context.trace({ kind: "allocate", inputTotal: inputTotal.toFixed(), outputTotal: outputTotal.toFixed(), remainder: inputTotal.minus(outputTotal).toFixed() });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, results);
    },
  };
}

function compileValidate(node: ValidatePlanNode): CompiledMemoryNode {
  const assertions = node.assertions.map((assertion) => ({ ...assertion, evaluate: compileExpressionEvaluator(assertion.expression) }));
  return {
    node,
    async execute(context) {
      const rows = await rowsFor(node.source, context);
      let failures = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (row === undefined) continue;
        const path = `/rows/${rowIndex}`;
        for (const assertion of assertions) {
          if (Boolean(assertion.evaluate(row, context.bindings.parameters, expressionReport(context, node, path), path))) continue;
          failures += 1;
          runtimeDiagnostic(context, node, CalculationDiagnosticCode.VALIDATION_FAILED, assertion.message, { path, details: { assertionId: assertion.id }, severity: assertion.severity });
        }
      }
      context.trace({ kind: "validate", failures });
      return datasetFromMemoryRows(`${node.id}.out`, node.outputType, rows);
    },
  };
}

function compileOutput(node: Extract<SemanticPlanNode, { readonly kind: "output" }>): CompiledMemoryNode {
  return {
    node,
    async execute(context) {
      return datasetFor(node.source, context) ?? datasetFromMemoryRows(`${node.id}.out`, node.outputType, []);
    },
  };
}

function compileNode(node: SemanticPlanNode, sourceTypes: ReadonlyMap<string, TableType>): CompiledMemoryNode {
  switch (node.kind) {
    case "input": return compileInput(node);
    case "filter": return compileFilter(node);
    case "project": return compileProject(node);
    case "formula": return compileFormula(node);
    case "join": return compileJoin(node, sourceTypes);
    case "lookup": return compileLookup(node);
    case "decision": return compileDecision(node);
    case "aggregate": return compileAggregate(node);
    case "allocate": return compileAllocate(node);
    case "validate": return compileValidate(node);
    case "output": return compileOutput(node);
  }
}

async function fingerprintDataset(name: string, dataset: Dataset, context: CallContext): Promise<DatasetFingerprint> {
  const hash = createHash("sha256");
  hash.update(stableStringify(dataset.schema));
  let rowCount = 0;
  for await (const batch of dataset.stream(context)) {
    for (const row of rowsFromMemoryBatch(batch)) {
      hash.update("\n");
      hash.update(stableStringify(row));
    }
    rowCount += batch.numRows;
  }
  return { name, fingerprint: hash.digest("hex"), rowCount };
}

async function inputSnapshot(
  bindings: PlanBindings,
  context: CallContext,
): Promise<InputSnapshot> {
  const datasets: DatasetFingerprint[] = [];
  for (const name of Object.keys(bindings.datasets).sort()) {
    const dataset = bindings.datasets[name];
    if (dataset !== undefined) datasets.push(await fingerprintDataset(name, dataset, context));
  }

  // Parameter VALUES belong in the fingerprint. Their declarations are in the
  // plan hash, but a run at a point value of 10 and one at 20 would otherwise
  // share a run identity while paying out different amounts.
  const parameters: ParameterFingerprint[] = Object.keys(bindings.parameters)
    .sort()
    .map((name) => ({
      name,
      fingerprint: stableHash(parameterKey(bindings.parameters[name])),
    }));

  const known = context.asOf.knownAs;
  return {
    ref: {
      ...(known?.id === undefined ? {} : { id: known.id }),
      fingerprint: stableHash({ datasets, parameters }),
      capturedAt: known?.capturedAt ?? new Date().toISOString(),
    },
    datasets,
    parameters,
  };
}

/**
 * Canonical, type-tagged form of a bound scalar. Tagged so the string "10"
 * and the decimal 10 cannot collide into one fingerprint.
 */
function parameterKey(value: ParameterValue | undefined): readonly [string, string] {
  if (value === undefined) return ["undefined", ""];
  if (Decimal.isDecimal(value)) return ["decimal", decimalToJson(value)];
  return [typeof value, String(value)];
}

function emptySnapshot(context: CallContext): InputSnapshot {
  return {
    ref: {
      fingerprint: stableHash({ datasets: [], parameters: [] }),
      capturedAt: context.asOf.knownAs?.capturedAt ?? new Date().toISOString(),
    },
    datasets: [],
    parameters: [],
  };
}

async function inspectDataset(dataset: Dataset | undefined, context: CallContext, sampleLimit: number): Promise<{ readonly count: number; readonly samples: readonly Row[] }> {
  if (dataset === undefined) return { count: 0, samples: [] };
  let count = 0;
  const samples: Row[] = [];
  for await (const batch of dataset.stream(context)) {
    count += batch.numRows;
    if (samples.length < sampleLimit) {
      samples.push(
        ...rowsFromMemoryBatch(batch).slice(0, sampleLimit - samples.length),
      );
    }
  }
  return { count, samples };
}

function cancellationDiagnostic(timedOut: boolean): Diagnostic {
  return diagnostic(CalculationDiagnosticCode.EXECUTION_CANCELLED, timedOut ? "Pipeline execution timed out." : "Pipeline execution was cancelled.", { details: { reason: timedOut ? "timeout" : "aborted" } });
}

function parameterMatches(type: ValueType, value: ParameterBindings[string]): boolean {
  if (value === undefined) return false;
  if (type.kind === "decimal") {
    if (Decimal.isDecimal(value) || typeof value === "number") return true;
    if (typeof value !== "string") return false;
    try {
      new D(value);
      return true;
    } catch {
      return false;
    }
  }
  if (type.kind === "int") return typeof value === "number" && Number.isSafeInteger(value);
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "boolean") return typeof value === "boolean";
  return false;
}

function memoryExecutable(plan: ExecutablePlan): plan is MemoryExecutablePlan {
  const candidate = plan as Partial<MemoryExecutablePlan>;
  return plan.backendId === "memory" && candidate.semanticPlan !== undefined && candidate.versions !== undefined && Array.isArray(candidate.nodes);
}

export class MemoryBackend implements CalculationBackend {
  readonly id = "memory";
  readonly version = "0.1.0";

  supports(_node: SemanticPlanNode): boolean {
    return true;
  }

  async compile(plan: SemanticPlan, context: CompileContext): Promise<ExecutablePlan> {
    const sourceTypes = new Map(plan.nodes.map((node) => [node.id, node.outputType]));
    const executable: MemoryExecutablePlan = {
      backendId: this.id,
      planHash: context.planHash,
      semanticPlan: plan,
      versions: context.versions,
      nodes: plan.nodes.map((node) => compileNode(node, sourceTypes)),
    };
    return executable;
  }

  async execute(plan: ExecutablePlan, bindings: PlanBindings, context: BackendExecutionContext): Promise<ExecutionResult> {
    const startedAt = performance.now();
    const diagnostics: Diagnostic[] = [];
    const traces: NodeTrace[] = [];
    const outputs: Record<string, Dataset> = {};
    const traceLevel: TraceLevel = context.options.traceLevel ?? "summary";
    if (!memoryExecutable(plan)) {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, "Executable plan was not compiled by the memory backend."));
      return {
        status: "failed",
        outputs,
        diagnostics,
        trace: { level: traceLevel, nodes: traces, totalDurationMs: performance.now() - startedAt },
        input: emptySnapshot(context.call),
        versions: {
          engine: "unknown",
          operations: {},
          backend: { id: this.id, version: this.version },
          components: {},
        },
        planHash: plan.planHash,
      };
    }

    const timeoutController = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutMs = context.options.timeoutMs === undefined ? undefined : Math.max(0, context.options.timeoutMs);
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }
    const signals: AbortSignal[] = [timeoutController.signal];
    if (context.call.signal !== undefined) signals.push(context.call.signal);
    const executionCall: CallContext = { ...context.call, signal: AbortSignal.any(signals) };
    const checkCancellation = (): void => {
      if (deadline !== undefined && Date.now() >= deadline && !executionCall.signal?.aborted) {
        timedOut = true;
        timeoutController.abort();
      }
      executionCall.signal?.throwIfAborted();
    };

    let snapshot = emptySnapshot(context.call);
    try {
      checkCancellation();
      snapshot = await inputSnapshot(bindings, executionCall);
      checkCancellation();
      for (const declared of plan.semanticPlan.inputs) {
        const provided = bindings.datasets[declared.name];
        if (provided === undefined) {
          diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED, `Required input dataset "${declared.name}" was not supplied.`, { path: `/datasets/${declared.name}` }));
        } else if (stableStringify(provided.schema) !== stableStringify(declared.schema)) {
          diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Input dataset "${declared.name}" does not match its declared schema.`, { path: `/datasets/${declared.name}/schema` }));
        }
      }
      for (const declared of plan.semanticPlan.parameters) {
        const value = bindings.parameters[declared.name];
        if (value === undefined) {
          diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED, `Required parameter "${declared.name}" was not supplied.`, { path: `/parameters/${declared.name}`, details: { parameter: declared.name } }));
        } else if (!parameterMatches(declared.type, value)) {
          diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Parameter "${declared.name}" does not match its declared type.`, { path: `/parameters/${declared.name}`, details: { parameter: declared.name, expected: declared.type.kind } }));
        }
      }
      if (!hasErrors(diagnostics)) {
        const datasets = new Map<string, Dataset>();
        for (const compiledNode of plan.nodes) {
          checkCancellation();
          const nodeStartedAt = performance.now();
          const nodeDiagnostics: Diagnostic[] = [];
          let detail: NodeTraceDetail = { kind: "generic" };
          const inputDatasets = compiledNode.node.kind === "input"
            ? [bindings.datasets[compiledNode.node.dataset]].filter((dataset): dataset is Dataset => dataset !== undefined)
            : planNodeSources(compiledNode.node).flatMap((ref) => {
              const dataset = datasets.get(ref.node);
              return dataset === undefined ? [] : [dataset];
            });
          let inputRows = 0;
          if (traceLevel === "summary" || traceLevel === "full") {
            const counts = await Promise.all(inputDatasets.map((dataset) => countRows(dataset, executionCall)));
            inputRows = counts.reduce((total, count) => total + count, 0);
          }
          const result = await compiledNode.execute({
            call: executionCall,
            bindings,
            datasets,
            report(item) {
              nodeDiagnostics.push(item.nodeId === undefined ? { ...item, nodeId: compiledNode.node.origin.sourceNodeId } : item);
            },
            trace(value) {
              detail = value;
            },
          });
          checkCancellation();
          datasets.set(compiledNode.node.id, result);
          diagnostics.push(...nodeDiagnostics);
          const phase = hasErrors(nodeDiagnostics) ? "error" as const : "ok" as const;
          const shouldTrace = traceLevel === "summary" || traceLevel === "full" || (traceLevel === "errors" && phase === "error");
          if (shouldTrace) {
            if (traceLevel === "errors") {
              const counts = await Promise.all(inputDatasets.map((dataset) => countRows(dataset, executionCall)));
              inputRows = counts.reduce((total, count) => total + count, 0);
            }
            const inspected = await inspectDataset(result, executionCall, traceLevel === "full" ? FULL_TRACE_SAMPLE_LIMIT : 0);
            traces.push({
              nodeId: compiledNode.node.origin.sourceNodeId,
              operation: compiledNode.node.origin.operation,
              ...(compiledNode.node.origin.label === undefined ? {} : { label: compiledNode.node.origin.label }),
              phase,
              inputRows,
              outputRows: inspected.count,
              durationMs: performance.now() - nodeStartedAt,
              detail,
              diagnostics: nodeDiagnostics,
              ...(traceLevel === "full" ? { sampleRows: inspected.samples } : {}),
            });
          }
          if (phase === "error") break;
        }
        if (!hasErrors(diagnostics)) {
          for (const output of plan.semanticPlan.outputs) {
            const dataset = datasets.get(output.from.node);
            if (dataset !== undefined) outputs[output.name] = dataset;
          }
        }
      }
    } catch (error) {
      if (executionCall.signal?.aborted === true) diagnostics.push(cancellationDiagnostic(timedOut));
      else if (error instanceof PrismError) diagnostics.push(...error.diagnostics);
      else diagnostics.push(diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, "Pipeline operation failed unexpectedly.", { details: { error: error instanceof Error ? error.message : String(error) } }));
    } finally {
      clearTimeout(timer);
    }
    return {
      status: hasErrors(diagnostics) ? "failed" : "success",
      outputs,
      diagnostics,
      trace: { level: traceLevel, nodes: traces, totalDurationMs: performance.now() - startedAt },
      input: snapshot,
      versions: plan.versions,
      planHash: plan.planHash,
    };
  }
}

export const MEMORY_BACKEND: CalculationBackend = new MemoryBackend();
