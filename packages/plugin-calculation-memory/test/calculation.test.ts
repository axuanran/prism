import {
  BackendExtensionPoint,
  CalculationCapabilityToken,
  CalculationDiagnosticCode,
  OperationExtensionPoint,
  PlanAnalysisExtensionPoint,
  TypeAnalysisExtensionPoint,
  type CalculationBackend,
  type CalculationCapability,
  type OperationDefinition,
  type PipelineSpec,
  type CompiledPipeline,
  type PlanAnalysisExtension,
  type TypeAnalysisExtension,
} from "@prism/contracts-calculation";
import {
  D,
  Decimal,
  collectRows,
  datasetFromRows,
  systemCallContext,
  defineSemanticAnnotationContract,
  semanticAnnotation,
  tableType,
  type Dataset,
  type Row,
  type TableType,
  type ValueType,
} from "@prism/contracts-data";
import { createEngine, definePlugin, type Engine } from "@prism/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculationPlugin } from "../src/index.js";

const context = systemCallContext({
  asOf: { validAt: "2026-01-31" },
  correlationId: "plugin-calculation-test",
});

const DECIMAL: ValueType = { kind: "decimal", precision: 28, scale: 6 };
const STRING: ValueType = { kind: "string" };
const BOOLEAN: ValueType = { kind: "boolean" };

let capability: CalculationCapability;
let engine: Engine;

const consumerPlugin = definePlugin({
  id: "calculation-test-consumer",
  version: "0.1.0",
  requires: { calculation: CalculationCapabilityToken },
  start(pluginContext) {
    capability = pluginContext.dependencies.calculation;
  },
});

beforeAll(async () => {
  engine = createEngine({ plugins: [calculationPlugin, consumerPlugin] });
  await engine.start();
});

afterAll(async () => {
  await engine.stop();
});

function dataset(name: string, schema: TableType, rows: readonly Row[]): Dataset {
  return datasetFromRows(name, schema, rows);
}

async function execute(spec: PipelineSpec, datasets: Readonly<Record<string, Dataset>>, traceLevel: "none" | "errors" | "summary" | "full" = "summary") {
  const validation = await capability.validatePipeline(context, spec);
  expect(validation.valid, validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n")).toBe(true);
  const plan = await capability.compilePipeline(context, spec);
  return capability.executePipeline(context, plan, { datasets }, { traceLevel });
}

function oneInputPipeline(
  id: string,
  schema: TableType,
  operation: string,
  config: unknown,
): PipelineSpec {
  return {
    id,
    inputs: [{ name: "source", schema }],
    nodes: [
      { id: "input", operation: "calculation.input", config: { name: "source" } },
      { id: "operation", operation, config },
      { id: "output", operation: "calculation.output", config: {} },
    ],
    edges: [
      { fromNode: "input", fromPort: "out", toNode: "operation", toPort: "in" },
      { fromNode: "operation", fromPort: "out", toNode: "output", toPort: "in" },
    ],
    outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
  };
}

describe("expression engine", () => {
  it("uses Decimal arithmetic so 0.1 + 0.2 equals 0.3", async () => {
    const schema = tableType([{ name: "id", type: STRING }]);
    const spec = oneInputPipeline("decimal-expression", schema, "calculation.formula", {
      columns: [{ name: "equal", expression: { text: "0.1 + 0.2 == 0.3" } }],
    });
    const result = await execute(spec, { source: dataset("source", schema, [{ id: "one" }]) });
    expect(result.status).toBe("success");
    const rows = await collectRows(result.outputs.result!, context);
    expect(rows[0]?.equal).toBe(true);
  });

  it("reports division by zero instead of Infinity or NaN", async () => {
    const schema = tableType([{ name: "amount", type: DECIMAL }]);
    const spec = oneInputPipeline("division-zero", schema, "calculation.formula", {
      columns: [{ name: "result", expression: { text: "amount / 0" } }],
    });
    const result = await execute(spec, { source: dataset("source", schema, [{ amount: new D(10) }]) });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.DIVISION_BY_ZERO);
  });

  it.each([
    ["1 +", {}, CalculationDiagnosticCode.EXPRESSION_PARSE_ERROR],
    ["name + 1", { name: STRING }, CalculationDiagnosticCode.EXPRESSION_TYPE_ERROR],
    ["missing + 1", {}, CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD],
    ["mystery(1)", {}, CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FUNCTION],
  ] as const)("diagnoses %s with %s", (text, scope, code) => {
    const compiled = capability.compileExpression(context, { text }, scope);
    expect("diagnostics" in compiled).toBe(true);
    if ("diagnostics" in compiled) expect(compiled.diagnostics.map((item) => item.code)).toContain(code);
  });

  it("exposes the fixed function registry", () => {
    expect(capability.listFunctions(context).map((item) => item.name)).toEqual([
      "round",
      "abs",
      "min",
      "max",
      "coalesce",
      "if",
    ]);
  });
});

describe("relational operations", () => {
  it("fails a declared many-to-one join when the right side is one-to-many", async () => {
    const leftSchema = tableType([{ name: "id", type: STRING }]);
    const rightSchema = tableType([{ name: "id", type: STRING }, { name: "label", type: STRING }]);
    const spec: PipelineSpec = {
      id: "join-cardinality",
      inputs: [{ name: "left", schema: leftSchema }, { name: "right", schema: rightSchema }],
      nodes: [
        { id: "left", operation: "calculation.input", config: { name: "left" } },
        { id: "right", operation: "calculation.input", config: { name: "right" } },
        { id: "join", operation: "calculation.join", config: { kind: "left", leftKey: "id", rightKey: "id", expectedCardinality: "many-to-one" } },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "left", fromPort: "out", toNode: "join", toPort: "left" },
        { fromNode: "right", fromPort: "out", toNode: "join", toPort: "right" },
        { fromNode: "join", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    };
    const result = await execute(spec, {
      left: dataset("left", leftSchema, [{ id: "A" }]),
      right: dataset("right", rightSchema, [{ id: "A", label: "first" }, { id: "A", label: "second" }]),
    });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.JOIN_CARDINALITY_VIOLATION);
    const detail = result.trace.nodes.find((node) => node.nodeId === "join")?.detail;
    expect(detail).toMatchObject({ kind: "join", expected: "many-to-one", actual: "one-to-many" });
  });

  it("implements every lookup missing and multiple policy", async () => {
    const inputSchema = tableType([{ name: "key", type: STRING }]);
    const lookupSchema = tableType([{ name: "key", type: STRING }, { name: "value", type: STRING }]);
    const makeSpec = (config: unknown): PipelineSpec => ({
      id: `lookup-${JSON.stringify(config)}`,
      inputs: [{ name: "input", schema: inputSchema }, { name: "lookup", schema: lookupSchema }],
      nodes: [
        { id: "input", operation: "calculation.input", config: { name: "input" } },
        { id: "table", operation: "calculation.input", config: { name: "lookup" } },
        { id: "lookup", operation: "calculation.lookup", config },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "input", fromPort: "out", toNode: "lookup", toPort: "in" },
        { fromNode: "table", fromPort: "out", toNode: "lookup", toPort: "lookup" },
        { fromNode: "lookup", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    });
    const base = { key: { input: "key", lookup: "key" }, output: { field: "value", as: "found" } };
    const missingInput = dataset("input", inputSchema, [{ key: "missing" }]);
    const emptyLookup = dataset("lookup", lookupSchema, []);

    const missingError = await execute(makeSpec({ ...base, missingPolicy: "error" }), { input: missingInput, lookup: emptyLookup });
    expect(missingError.status).toBe("failed");
    expect(missingError.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.LOOKUP_MISSING);

    const missingNull = await execute(makeSpec({ ...base, missingPolicy: "null" }), { input: missingInput, lookup: emptyLookup });
    expect((await collectRows(missingNull.outputs.result!, context))[0]?.found).toBeNull();

    const missingDefault = await execute(makeSpec({ ...base, missingPolicy: "default", defaultValue: "fallback" }), { input: missingInput, lookup: emptyLookup });
    expect((await collectRows(missingDefault.outputs.result!, context))[0]?.found).toBe("fallback");

    const duplicateLookup = dataset("lookup", lookupSchema, [{ key: "A", value: "first" }, { key: "A", value: "second" }]);
    const matchedInput = dataset("input", inputSchema, [{ key: "A" }]);
    const ambiguousError = await execute(makeSpec({ ...base, multiplePolicy: "error" }), { input: matchedInput, lookup: duplicateLookup });
    expect(ambiguousError.status).toBe("failed");
    expect(ambiguousError.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.LOOKUP_AMBIGUOUS);

    const ambiguousFirst = await execute(makeSpec({ ...base, multiplePolicy: "first" }), { input: matchedInput, lookup: duplicateLookup });
    expect((await collectRows(ambiguousFirst.outputs.result!, context))[0]?.found).toBe("first");
    expect(ambiguousFirst.trace.nodes.find((node) => node.nodeId === "lookup")?.detail).toMatchObject({ kind: "lookup", ambiguous: 1, matched: 1 });
  });

  it("uses first-match decision semantics and traces the selected rule id", async () => {
    const schema = tableType([{ name: "score", type: DECIMAL }]);
    const spec = oneInputPipeline("decision-first", schema, "calculation.decision", {
      rules: [
        { id: "first", when: { text: "score >= 10" }, outputs: { band: { text: "\"A\"" } } },
        { id: "second", when: { text: "score >= 1" }, outputs: { band: { text: "\"B\"" } } },
      ],
    });
    const result = await execute(spec, { source: dataset("source", schema, [{ score: new D(20) }]) });
    expect((await collectRows(result.outputs.result!, context))[0]?.band).toBe("A");
    expect(result.trace.nodes.find((node) => node.nodeId === "operation")?.detail).toMatchObject({
      kind: "decision",
      matchedRules: { first: 1 },
      unmatched: 0,
    });
  });

  it("sums 1000 decimal rows exactly", async () => {
    const schema = tableType([{ name: "amount", type: DECIMAL }]);
    const spec = oneInputPipeline("aggregate-exact", schema, "calculation.aggregate", {
      groupBy: [],
      aggregates: [{ name: "total", operation: "sum", field: "amount" }],
    });
    const rows = Array.from({ length: 1000 }, () => ({ amount: new D("0.01") }));
    const result = await execute(spec, { source: dataset("source", schema, rows) });
    const total = (await collectRows(result.outputs.result!, context))[0]?.total;
    expect(Decimal.isDecimal(total)).toBe(true);
    expect((total as Decimal).equals(new D(10))).toBe(true);
  });

  it("filters rows and reports validate assertion failures with row paths", async () => {
    const schema = tableType([{ name: "amount", type: DECIMAL }]);
    const filterSpec = oneInputPipeline("filter-rows", schema, "calculation.filter", {
      where: { text: "amount > 0" },
    });
    const source = dataset("source", schema, [{ amount: new D(1) }, { amount: new D(-1) }]);
    const filtered = await execute(filterSpec, { source });
    expect((await collectRows(filtered.outputs.result!, context)).length).toBe(1);

    const validateSpec = oneInputPipeline("validate-rows", schema, "calculation.validate", {
      assert: [{ id: "positive", expression: { text: "amount > 0" } }],
    });
    const validated = await execute(validateSpec, { source });
    const failure = validated.diagnostics.find((item) => item.code === CalculationDiagnosticCode.VALIDATION_FAILED);
    expect(validated.status).toBe("failed");
    expect(failure?.path).toBe("/rows/1");
  });

  it("uses the configured decimal division policy for averages", async () => {
    const schema = tableType([{ name: "amount", type: DECIMAL }]);
    const spec = oneInputPipeline("aggregate-average", schema, "calculation.aggregate", {
      groupBy: [],
      aggregates: [{ name: "average", operation: "avg", field: "amount" }],
      division: { precision: 4, rounding: "half-up" },
    });
    const result = await execute(spec, {
      source: dataset("source", schema, [{ amount: new D(1) }, { amount: new D(0) }, { amount: new D(0) }]),
    });
    const average = (await collectRows(result.outputs.result!, context))[0]?.average;
    expect((average as Decimal).toFixed()).toBe("0.3333");
  });
});

describe("allocation", () => {
  it("conserves 200 random partition totals and breaks equal remainders deterministically", async () => {
    const schema = tableType([
      { name: "caseId", type: STRING },
      { name: "rowId", type: STRING },
      { name: "total", type: DECIMAL },
      { name: "weight", type: DECIMAL },
    ]);
    let seed = 0x12345678;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const expected = new Map<string, Decimal>();
    const rows: Row[] = [];
    for (let caseIndex = 0; caseIndex < 200; caseIndex += 1) {
      const caseId = `case-${caseIndex}`;
      const total = new D(Math.floor(random() * 1_000_000)).dividedBy(100);
      expected.set(caseId, total);
      const length = 1 + Math.floor(random() * 12);
      const equal = caseIndex % 11 === 1;
      const zero = caseIndex % 17 === 0;
      for (let rowIndex = 0; rowIndex < length; rowIndex += 1) {
        const weight = zero ? new D(0) : equal ? new D(1) : new D(Math.floor(random() * 50));
        rows.push({ caseId, rowId: String(rowIndex).padStart(3, "0"), total, weight });
      }
    }
    rows.push(
      { caseId: "fixed", rowId: "a", total: new D("0.01"), weight: new D(1) },
      { caseId: "fixed", rowId: "b", total: new D("0.01"), weight: new D(1) },
    );
    expected.set("fixed", new D("0.01"));
    const spec = oneInputPipeline("allocation-property", schema, "calculation.allocate", {
      amount: { field: "total" },
      weight: { text: "weight" },
      partitionBy: ["caseId"],
      output: "part",
      sortBy: ["rowId"],
      policy: {
        scale: 2,
        rounding: "half-up",
        remainder: { kind: "largest-remainder" },
        onZeroWeight: "equal",
      },
    });
    const result = await execute(spec, { source: dataset("source", schema, rows) });
    expect(result.status, result.diagnostics.map((item) => item.message).join("\n")).toBe("success");
    const output = await collectRows(result.outputs.result!, context);
    const actual = new Map<string, Decimal>();
    for (const row of output) {
      const caseId = String(row.caseId);
      const part = row.part;
      expect(Decimal.isDecimal(part)).toBe(true);
      actual.set(caseId, (actual.get(caseId) ?? new D(0)).plus(part as Decimal));
    }
    for (const [caseId, total] of expected) expect(actual.get(caseId)?.equals(total), caseId).toBe(true);
    const fixed = output.filter((row) => row.caseId === "fixed");
    expect((fixed.find((row) => row.rowId === "a")?.part as Decimal).toFixed(2)).toBe("0.01");
    expect((fixed.find((row) => row.rowId === "b")?.part as Decimal).toFixed(2)).toBe("0.00");
  });

  it("implements to-row and reject remainder policies", async () => {
    const schema = tableType([
      { name: "rowId", type: STRING },
      { name: "weight", type: DECIMAL },
    ]);
    const source = dataset("source", schema, [
      { rowId: "a", weight: new D(1) },
      { rowId: "b", weight: new D(1) },
    ]);
    const base = {
      amount: { value: "0.01" },
      weight: { text: "weight" },
      partitionBy: [],
      output: "part",
      sortBy: ["rowId"],
    };
    const toRowSpec = oneInputPipeline("allocation-to-row", schema, "calculation.allocate", {
      ...base,
      policy: {
        scale: 2,
        rounding: "down",
        remainder: { kind: "to-row", rowKey: "b" },
        onZeroWeight: "error",
      },
    });
    const toRow = await execute(toRowSpec, { source });
    const parts = await collectRows(toRow.outputs.result!, context);
    expect((parts.find((row) => row.rowId === "a")?.part as Decimal).toFixed(2)).toBe("0.00");
    expect((parts.find((row) => row.rowId === "b")?.part as Decimal).toFixed(2)).toBe("0.01");

    const rejectSpec = oneInputPipeline("allocation-reject", schema, "calculation.allocate", {
      ...base,
      policy: {
        scale: 2,
        rounding: "down",
        remainder: { kind: "reject" },
        onZeroWeight: "error",
      },
    });
    const rejected = await execute(rejectSpec, { source });
    expect(rejected.status).toBe("failed");
    expect(rejected.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.ALLOCATION_CONSERVATION_VIOLATION);
  });
});

describe("semantic lowering", () => {
  it("produces a plain JSON SemanticPlan with no executable closure", async () => {
    const schema = tableType([{ name: "amount", type: DECIMAL }]);
    const spec = oneInputPipeline("serializable-plan", schema, "calculation.formula", {
      columns: [{ name: "doubled", expression: { text: "amount * 2" } }],
    });
    const compiled = await capability.compilePipeline(context, spec);
    const serialized = JSON.stringify(compiled.plan);
    const roundTripped: unknown = JSON.parse(serialized);
    expect(roundTripped).toEqual(compiled.plan);
    const assertPlainJsonValue = (value: unknown): void => {
      if (value === null || typeof value !== "object") {
        expect(typeof value).not.toBe("function");
        return;
      }
      expect(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype).toBe(true);
      for (const child of Object.values(value as Readonly<Record<string, unknown>>)) assertPlainJsonValue(child);
    };
    assertPlainJsonValue(compiled.plan);
    expect(serialized).toContain("\"kind\":\"binary\"");
    expect(serialized).not.toContain("function");
  });

  it("makes join keys and declared cardinality inspectable without execution", async () => {
    const leftSchema = tableType([{ name: "personId", type: STRING }]);
    const rightSchema = tableType([{ name: "personId", type: STRING }, { name: "name", type: STRING }]);
    const spec: PipelineSpec = {
      id: "inspectable-join",
      inputs: [{ name: "left", schema: leftSchema }, { name: "right", schema: rightSchema }],
      nodes: [
        { id: "left", operation: "calculation.input", config: { name: "left" } },
        { id: "right", operation: "calculation.input", config: { name: "right" } },
        { id: "join", operation: "calculation.join", config: { kind: "left", leftKey: "personId", rightKey: "personId", expectedCardinality: "many-to-one" } },
      ],
      edges: [
        { fromNode: "left", fromPort: "out", toNode: "join", toPort: "left" },
        { fromNode: "right", fromPort: "out", toNode: "join", toPort: "right" },
      ],
      outputs: [{ name: "result", fromNode: "join", fromPort: "out" }],
    };
    const compiled = await capability.compilePipeline(context, spec);
    const join = compiled.plan.nodes.find((node) => node.kind === "join");
    expect(join).toMatchObject({
      kind: "join",
      expectedCardinality: "many-to-one",
      keys: [{ left: "personId", right: "personId" }],
    });
  });

  it("declares allocation parameters in JSON IR and evaluates the bound parameter", async () => {
    const schema = tableType([{ name: "rowId", type: STRING }, { name: "weight", type: DECIMAL }]);
    const base = oneInputPipeline("parameter-allocation", schema, "calculation.allocate", {
      amount: { parameter: "budget" },
      weight: { text: "weight" },
      partitionBy: [],
      output: "part",
      sortBy: ["rowId"],
      policy: {
        scale: 2,
        rounding: "half-up",
        remainder: { kind: "largest-remainder" },
        onZeroWeight: "error",
      },
    });
    const unknown = await capability.validatePipeline(context, base);
    expect(unknown.valid).toBe(false);
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({
      code: CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
      message: expect.stringContaining("parameter"),
    }));

    const spec: PipelineSpec = { ...base, parameters: [{ name: "budget", type: DECIMAL }] };
    const compiled = await capability.compilePipeline(context, spec);
    expect(JSON.parse(JSON.stringify(compiled.plan))).toEqual(compiled.plan);
    expect(compiled.plan.parameters).toEqual([{ name: "budget", type: DECIMAL }]);
    expect(compiled.plan.nodes.find((node) => node.kind === "allocate")).toMatchObject({
      kind: "allocate",
      amount: { kind: "expression", expression: { kind: "parameter", name: "budget" } },
    });
    const result = await capability.executePipeline(
      context,
      compiled,
      {
        datasets: {
          source: dataset("source", schema, [
            { rowId: "a", weight: new D(1) },
            { rowId: "b", weight: new D(1) },
          ]),
        },
        parameters: { budget: new D("0.01") },
      },
    );
    const rows = await collectRows(result.outputs.result!, context);
    expect(result.status).toBe("success");
    expect(rows.reduce((sum, row) => sum.plus(row.part as Decimal), new D(0)).equals(new D("0.01"))).toBe(true);
  });

  it("lowers and executes decision drop as an explicit cardinality rule", async () => {
    const schema = tableType([{ name: "score", type: DECIMAL }]);
    const spec = oneInputPipeline("decision-drop", schema, "calculation.decision", {
      rules: [{ id: "positive", when: { text: "score > 0" }, outputs: { band: { text: "\"positive\"" } } }],
      unmatchedPolicy: "drop",
    });
    const compiled = await capability.compilePipeline(context, spec);
    expect(compiled.plan.nodes.find((node) => node.kind === "decision")).toMatchObject({
      kind: "decision",
      onNoMatch: "drop",
    });
    const result = await capability.executePipeline(context, compiled, {
      datasets: {
        source: dataset("source", schema, [{ score: new D(1) }, { score: new D(-1) }]),
      },
    });
    expect(await collectRows(result.outputs.result!, context)).toEqual([
      { score: new D(1), band: "positive" },
    ]);
  });

  it("keeps an operation that declares no pipeline exposure out of the palette", async () => {
    const hidden: OperationDefinition<Record<string, never>> = {
      id: "test.internal",
      version: "0.1.0",
      title: "内部算子",
      inputs: [],
      outputs: [{ name: "out", kind: "table", required: true }],
      config: { schema: { type: "object", additionalProperties: false } },
      // Registered, and deliberately not exposed to the pipeline surface.
      exposure: {},
      infer: () => ({ outputs: { out: tableType([]) }, diagnostics: [] }),
      lower: () => {
        throw new Error("must never be lowered: it is not in the palette");
      },
    };

    const contributor = definePlugin({
      id: "test.hidden-operation",
      version: "0.1.0",
      register(pluginContext) {
        pluginContext.extensions.contribute(OperationExtensionPoint, hidden);
      },
    });

    const isolated = createEngine({ plugins: [calculationPlugin, contributor] });
    await isolated.start();

    const palette = isolated
      .capability(CalculationCapabilityToken)
      .listOperations(context)
      .map((operation) => operation.id);

    expect(palette).not.toContain("test.internal");
    expect(palette).toContain("calculation.formula");

    await isolated.stop();
  });

  it("fingerprints parameter values, so two budgets are two different runs", async () => {
    // The plan hash covers parameter DECLARATIONS. If the bound VALUES were
    // left out of the input fingerprint, a run at a budget of 100 and one at
    // 200 would share a run identity while paying out different amounts.
    const schema = tableType([
      { name: "rowId", type: STRING },
      { name: "weight", type: DECIMAL },
    ]);
    const spec: PipelineSpec = {
      ...oneInputPipeline("parameter-fingerprint", schema, "calculation.allocate", {
        amount: { parameter: "budget" },
        weight: { text: "weight" },
        partitionBy: [],
        output: "part",
        sortBy: ["rowId"],
        policy: {
          scale: 2,
          rounding: "half-up",
          remainder: { kind: "largest-remainder" },
          onZeroWeight: "error",
        },
      }),
      parameters: [{ name: "budget", type: DECIMAL }],
    };

    const compiled = await capability.compilePipeline(context, spec);
    const rows: Row[] = [
      { rowId: "a", weight: new D(1) },
      { rowId: "b", weight: new D(1) },
    ];

    const fingerprintAt = async (budget: string): Promise<string> => {
      const result = await capability.executePipeline(context, compiled, {
        datasets: { source: dataset("source", schema, rows) },
        parameters: { budget: new D(budget) },
      });
      expect(result.status, JSON.stringify(result.diagnostics)).toBe("success");
      return result.input.ref.fingerprint;
    };

    const atOneHundred = await fingerprintAt("100");
    const atTwoHundred = await fingerprintAt("200");
    const atOneHundredAgain = await fingerprintAt("100");

    expect(atOneHundred).not.toBe(atTwoHundred);
    // Same inputs must still fingerprint identically, or nothing replays.
    expect(atOneHundredAgain).toBe(atOneHundred);
  });

  it("selects a contributed backend only when it supports the whole plan", async () => {
    const stubBackend: CalculationBackend = {
      id: "stub-no-allocate",
      version: "0.1.0",
      supports(node) {
        return node.kind !== "allocate";
      },
      async compile(_plan, compileContext) {
        return { backendId: "stub-no-allocate", planHash: compileContext.planHash };
      },
      async execute() {
        throw new Error("Backend selection test does not execute the stub artifact.");
      },
    };
    let selectedCapability: CalculationCapability | undefined;
    const backendPlugin = definePlugin({
      id: "calculation-test-backend",
      version: "0.1.0",
      register(pluginContext) {
        pluginContext.extensions.contribute(BackendExtensionPoint, stubBackend);
      },
    });
    const selectedConsumer = definePlugin({
      id: "calculation-test-backend-consumer",
      version: "0.1.0",
      requires: { calculation: CalculationCapabilityToken },
      start(pluginContext) {
        selectedCapability = pluginContext.dependencies.calculation;
      },
    });
    const selectionEngine = createEngine({ plugins: [backendPlugin, calculationPlugin, selectedConsumer] });
    await selectionEngine.start();
    try {
      const schema = tableType([{ name: "active", type: BOOLEAN }, { name: "weight", type: DECIMAL }]);
      const filter = oneInputPipeline("stub-supported", schema, "calculation.filter", { where: { text: "active == true" } });
      const allocate = oneInputPipeline("stub-unsupported", schema, "calculation.allocate", {
        amount: { value: "1" },
        weight: { text: "weight" },
        partitionBy: [],
        policy: {
          scale: 2,
          rounding: "half-up",
          remainder: { kind: "largest-remainder" },
          onZeroWeight: "error",
        },
      });
      expect((await selectedCapability!.compilePipeline(context, filter)).backendId).toBe("stub-no-allocate");
      expect((await selectedCapability!.compilePipeline(context, allocate)).backendId).toBe("memory");
    } finally {
      await selectionEngine.stop();
    }
  });
});

describe("pipeline runtime", () => {
  it("produces stable plan hashes and changes the hash when config changes", async () => {
    const schema = tableType([{ name: "active", type: BOOLEAN }]);
    const firstSpec = oneInputPipeline("hash", schema, "calculation.filter", { where: { text: "active == true" } });
    const secondSpec = oneInputPipeline("hash", schema, "calculation.filter", { where: { text: "active != true" } });
    const first = await capability.compilePipeline(context, firstSpec);
    const repeat = await capability.compilePipeline(context, firstSpec);
    const changed = await capability.compilePipeline(context, secondSpec);
    expect(first.planHash).toBe(repeat.planHash);
    expect(first.planHash).not.toBe(changed.planHash);
    const explanation = await capability.explainPlan(context, first);
    expect(explanation.steps).toHaveLength(3);
    expect(explanation.steps.every((step) => step.summary.length > 0)).toBe(true);
  });

  it("rejects a pipeline cycle without reading data", async () => {
    const spec: PipelineSpec = {
      id: "cycle",
      inputs: [],
      nodes: [
        { id: "a", operation: "calculation.output", config: {} },
        { id: "b", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "a", fromPort: "out", toNode: "b", toPort: "in" },
        { fromNode: "b", fromPort: "out", toNode: "a", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "a", fromPort: "out" }],
    };
    const validation = await capability.validatePipeline(context, spec);
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.PIPELINE_CYCLE);
  });

  it("honours a zero-millisecond timeout with a structured cancellation diagnostic", async () => {
    const schema = tableType([{ name: "active", type: BOOLEAN }]);
    const spec = oneInputPipeline("timeout", schema, "calculation.filter", { where: { text: "active == true" } });
    const plan = await capability.compilePipeline(context, spec);
    const result = await capability.executePipeline(
      context,
      plan,
      { datasets: { source: dataset("source", schema, [{ active: true }]) } },
      { timeoutMs: 0 },
    );
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((item) => item.code)).toContain(CalculationDiagnosticCode.EXECUTION_CANCELLED);
  });

  it("runs input -> lookup -> formula -> output and returns 1200 exactly", async () => {
    const workloadSchema = tableType([
      { name: "employee", type: STRING },
      { name: "title", type: STRING },
      { name: "workload", type: DECIMAL },
      { name: "pointValue", type: DECIMAL },
    ]);
    const coefficientSchema = tableType([
      { name: "title", type: STRING },
      { name: "coefficient", type: DECIMAL },
    ]);
    const spec: PipelineSpec = {
      id: "reference-allocation",
      inputs: [{ name: "workload", schema: workloadSchema }, { name: "coefficients", schema: coefficientSchema }],
      nodes: [
        { id: "input", operation: "calculation.input", config: { name: "workload" } },
        { id: "coefficient-input", operation: "calculation.input", config: { name: "coefficients" } },
        {
          id: "lookup",
          operation: "calculation.lookup",
          config: {
            key: { input: "title", lookup: "title" },
            output: { field: "coefficient", as: "coefficient" },
            missingPolicy: "error",
            multiplePolicy: "error",
          },
        },
        { id: "formula", operation: "calculation.formula", config: { columns: [{ name: "performance", expression: { text: "workload * pointValue * coefficient" } }] } },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "input", fromPort: "out", toNode: "lookup", toPort: "in" },
        { fromNode: "coefficient-input", fromPort: "out", toNode: "lookup", toPort: "lookup" },
        { fromNode: "lookup", fromPort: "out", toNode: "formula", toPort: "in" },
        { fromNode: "formula", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    };
    const result = await execute(spec, {
      workload: dataset("workload", workloadSchema, [{ employee: "张三", title: "主任医师", workload: new D(100), pointValue: new D(10) }]),
      coefficients: dataset("coefficients", coefficientSchema, [{ title: "主任医师", coefficient: new D("1.2") }]),
    }, "full");
    expect(result.status).toBe("success");
    const rows = await collectRows(result.outputs.result!, context);
    const performance = rows[0]?.performance;
    expect(Decimal.isDecimal(performance)).toBe(true);
    expect((performance as Decimal).equals(new D(1200))).toBe(true);
    expect(result.trace.nodes.every((node) => (node.sampleRows?.length ?? 0) <= 20)).toBe(true);
    expect(result.input.datasets.map((item) => [item.name, item.rowCount])).toEqual([
      ["coefficients", 1],
      ["workload", 1],
    ]);
    expect(result.input.datasets.every((item) => /^[a-f0-9]{64}$/u.test(item.fingerprint))).toBe(true);
  });

  it("registers the complete V0.1 operation palette", () => {
    expect(capability.listOperations(context).map((operation) => operation.id)).toEqual([
      "calculation.aggregate",
      "calculation.allocate",
      "calculation.decision",
      "calculation.filter",
      "calculation.formula",
      "calculation.input",
      "calculation.join",
      "calculation.lookup",
      "calculation.output",
      "calculation.validate",
    ]);
  });

  it("registers exposed calculation resource types", () => {
    const resourceTypes = engine.inspect().resourceTypes.filter((resource) => resource.kind.startsWith("calculation."));
    expect(resourceTypes.map((resource) => resource.kind).sort()).toEqual([
      "calculation.decision-table",
      "calculation.lookup-table",
      "calculation.pipeline",
    ]);
    expect(resourceTypes.every((resource) => resource.exposure.configuration === true && resource.exposure.frontend === true)).toBe(true);
  });
});

describe("compiler analysis extensions", () => {
  const QuantityFact = defineSemanticAnnotationContract<{
    readonly dimension: string;
  }>({
    id: "test.quantity",
    version: "1.0.0",
  });
  const GrainFact = defineSemanticAnnotationContract<{
    readonly dimensions: readonly string[];
  }>({
    id: "test.grain",
    version: "1.0.0",
  });

  const quantityType: ValueType = {
    kind: "decimal",
    precision: 28,
    scale: 6,
    semanticAnnotations: [
      semanticAnnotation(QuantityFact, { dimension: "TEST" }),
    ],
  };

  function pipeline(requiredAnalyzers: PipelineSpec["requiredAnalyzers"] = []): PipelineSpec {
    return {
      ...oneInputPipeline(
        "analysis-extension",
        tableType([{ name: "amount", type: quantityType }]),
        "calculation.formula",
        {
          columns: [
            {
              name: "total",
              expression: { text: "amount + amount" },
            },
          ],
        },
      ),
      requiredAnalyzers,
    };
  }

  function quantityAnalyzer(semanticVersion: string): TypeAnalysisExtension {
    return {
      id: "test.quantity-analyzer",
      semanticVersion,
      inferBinary(request) {
        const annotated = request.left.semanticAnnotations?.some(
          (annotation) => annotation.contract === QuantityFact.id,
        );
        return annotated === true
          ? { kind: "handled", value: request.left, diagnostics: [] }
          : { kind: "not-applicable" };
      },
    };
  }

  async function compileWith(
    contributions: (
      | { readonly kind: "type"; readonly extension: TypeAnalysisExtension }
      | { readonly kind: "plan"; readonly extension: PlanAnalysisExtension }
    )[],
    spec: PipelineSpec = pipeline(),
  ): Promise<{ readonly engine: Engine; readonly compiled: CompiledPipeline }> {
    const contributor = definePlugin({
      id: `analysis-contributor-${Math.random().toString(36).slice(2)}`,
      version: "0.1.0",
      register(pluginContext) {
        for (const contribution of contributions) {
          if (contribution.kind === "type") {
            pluginContext.extensions.contribute(
              TypeAnalysisExtensionPoint,
              contribution.extension,
            );
          } else {
            pluginContext.extensions.contribute(
              PlanAnalysisExtensionPoint,
              contribution.extension,
            );
          }
        }
      },
    });
    const isolated = createEngine({
      plugins: [calculationPlugin, contributor],
    });
    await isolated.start();
    const compiled = await isolated
      .capability(CalculationCapabilityToken)
      .compilePipeline(context, spec);
    return { engine: isolated, compiled };
  }

  it("installs type semantics through a public extension and persists its identity", async () => {
    const { engine: isolated, compiled } = await compileWith([
      { kind: "type", extension: quantityAnalyzer("1.2.0") },
    ], pipeline([
      {
        id: "test.quantity-analyzer",
        kind: "type",
        contractVersion: TypeAnalysisExtensionPoint.version,
      },
    ]));

    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.plan.analysis.extensions).toEqual({
      "test.quantity-analyzer": {
        extensionPoint: TypeAnalysisExtensionPoint.id,
        contractVersion: TypeAnalysisExtensionPoint.version,
        semanticVersion: "1.2.0",
      },
    });
    const formula = compiled.plan.nodes.find((node) => node.kind === "formula");
    expect(formula?.outputType.columns.find((column) => column.name === "total")?.type)
      .toMatchObject({ semanticAnnotations: quantityType.semanticAnnotations });
    expect(JSON.parse(JSON.stringify(compiled.plan))).toEqual(compiled.plan);

    await isolated.stop();
  });

  it("rejects a required analyzer when the plugin is absent", async () => {
    const { engine: isolated, compiled } = await compileWith([], pipeline([
      {
        id: "test.quantity-analyzer",
        kind: "type",
        contractVersion: TypeAnalysisExtensionPoint.version,
      },
    ]));

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CalculationDiagnosticCode.REQUIRED_ANALYZER_MISSING,
      }),
    );
    await isolated.stop();
  });

  it("rejects multiple analyzers that both handle one expression", async () => {
    const second: TypeAnalysisExtension = {
      ...quantityAnalyzer("1.0.0"),
      id: "test.second-quantity-analyzer",
    };
    const { engine: isolated, compiled } = await compileWith([
      { kind: "type", extension: quantityAnalyzer("1.0.0") },
      { kind: "type", extension: second },
    ]);

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({
        code: CalculationDiagnosticCode.ANALYSIS_EXTENSION_CONFLICT,
      }),
    );
    await isolated.stop();
  });

  it("changes plan hash when analyzer semantics change, not package metadata", async () => {
    const first = await compileWith([
      { kind: "type", extension: quantityAnalyzer("1.0.0") },
    ]);
    const second = await compileWith([
      { kind: "type", extension: quantityAnalyzer("1.0.1") },
    ]);

    expect(first.compiled.plan.analysis.extensions["test.quantity-analyzer"]?.semanticVersion)
      .toBe("1.0.0");
    expect(second.compiled.plan.analysis.extensions["test.quantity-analyzer"]?.semanticVersion)
      .toBe("1.0.1");
    expect(first.compiled.planHash).not.toBe(second.compiled.planHash);

    await first.engine.stop();
    await second.engine.stop();
  });

  it("attaches plan-analysis facts without changing backend execution code", async () => {
    const grainAnalyzer: PlanAnalysisExtension = {
      id: "test.grain-analyzer",
      semanticVersion: "1.0.1",
      analyzeNode(request) {
        return request.node.kind === "formula"
          ? {
              kind: "handled",
              value: {
                annotations: [
                  semanticAnnotation(GrainFact, {
                    dimensions: ["entity"],
                  }),
                ],
                constraints: [
                  {
                    contract: "test.grain.unique",
                    contractVersion: "1.0.0",
                    enforcement: "runtime",
                    spec: { keys: ["entity"] },
                  },
                ],
              },
              diagnostics: [],
            }
          : { kind: "not-applicable" };
      },
    };
    const spec = pipeline([
      {
        id: grainAnalyzer.id,
        kind: "plan",
        contractVersion: PlanAnalysisExtensionPoint.version,
      },
    ]);
    const { engine: isolated, compiled } = await compileWith([
      { kind: "type", extension: quantityAnalyzer("1.0.0") },
      { kind: "plan", extension: grainAnalyzer },
    ], spec);

    expect(compiled.diagnostics).toEqual([]);
    const formula = compiled.plan.nodes.find((node) => node.kind === "formula");
    expect(formula?.analysis).toEqual([
      semanticAnnotation(GrainFact, { dimensions: ["entity"] }),
    ]);
    expect(formula?.constraints).toEqual([
      {
        contract: "test.grain.unique",
        contractVersion: "1.0.0",
        enforcement: "runtime",
        spec: { keys: ["entity"] },
      },
    ]);
    expect(compiled.plan.analysis.extensions["test.grain-analyzer"]).toEqual({
      extensionPoint: PlanAnalysisExtensionPoint.id,
      contractVersion: PlanAnalysisExtensionPoint.version,
      semanticVersion: "1.0.1",
    });

    await isolated.stop();
  });
});
