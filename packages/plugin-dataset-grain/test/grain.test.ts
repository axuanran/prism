import { describe, expect, it } from "vitest";
import {
  CalculationCapabilityToken,
  CalculationDiagnosticCode,
  PlanAnalysisExtensionPoint,
  type PipelineSpec,
} from "@prism/contracts-calculation";
import { D, datasetFromRows, systemCallContext, tableType } from "@prism/contracts-data";
import { createEngine } from "@prism/kernel";
import { calculationPlugin } from "@prism/plugin-calculation-memory";
import {
  GRAIN_ANALYZER_SEMANTIC_VERSION,
  GrainCapabilityToken,
  GrainDiagnosticCode,
  grainPlugin,
} from "@prism/plugin-dataset-grain";

const context = systemCallContext({ asOf: { validAt: "2026-01-31" } });
const DECIMAL = { kind: "decimal", precision: 28, scale: 6 } as const;

async function boot() {
  const engine = createEngine({ plugins: [calculationPlugin, grainPlugin] });
  await engine.start();
  return engine;
}

function requiredGrain() {
  return [{
    id: "dataset.grain",
    kind: "plan" as const,
    contractVersion: PlanAnalysisExtensionPoint.version,
  }];
}

describe("dataset grain analysis plugin", () => {
  it("preserves grain through Formula and derives Aggregate grain from groupBy", async () => {
    const engine = await boot();
    const grain = engine.capability(GrainCapabilityToken);
    const source = grain.annotate(tableType([
      { name: "month", type: { kind: "string" } },
      { name: "entity", type: { kind: "string" } },
      { name: "amount", type: DECIMAL },
    ]), {
      dimensions: ["month", "entity"],
      uniqueBy: ["month", "entity"],
    });
    const spec: PipelineSpec = {
      id: "grain-aggregate",
      inputs: [{ name: "source", schema: source }],
      requiredAnalyzers: requiredGrain(),
      nodes: [
        { id: "input", operation: "calculation.input", config: { name: "source" } },
        {
          id: "formula",
          operation: "calculation.formula",
          config: { columns: [{ name: "doubled", expression: { text: "amount * 2" } }] },
        },
        {
          id: "aggregate",
          operation: "calculation.aggregate",
          config: {
            groupBy: ["month"],
            aggregates: [{ name: "total", operation: "sum", field: "doubled" }],
          },
        },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "input", fromPort: "out", toNode: "formula", toPort: "in" },
        { fromNode: "formula", fromPort: "out", toNode: "aggregate", toPort: "in" },
        { fromNode: "aggregate", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    };

    const compiled = await engine
      .capability(CalculationCapabilityToken)
      .compilePipeline(context, spec);

    expect(compiled.diagnostics).toEqual([]);
    const formula = compiled.plan.nodes.find((node) => node.id === "formula");
    const aggregate = compiled.plan.nodes.find((node) => node.id === "aggregate");
    expect(formula?.analysis?.[0]?.spec).toEqual({
      dimensions: ["entity", "month"],
      uniqueBy: ["entity", "month"],
    });
    expect(aggregate?.analysis?.[0]?.spec).toEqual({
      dimensions: ["month"],
      uniqueBy: ["month"],
    });
    expect(compiled.plan.analysis.extensions["dataset.grain"]).toEqual({
      extensionPoint: PlanAnalysisExtensionPoint.id,
      contractVersion: PlanAnalysisExtensionPoint.version,
      semanticVersion: GRAIN_ANALYZER_SEMANTIC_VERSION,
    });

    await engine.stop();
  });

  it("emits a runtime uniqueness constraint and actual duplicate Lookup data still fails", async () => {
    const engine = await boot();
    const grain = engine.capability(GrainCapabilityToken);
    const inputSchema = grain.annotate(tableType([
      { name: "entity", type: { kind: "string" } },
      { name: "code", type: { kind: "string" } },
    ]), {
      dimensions: ["entity", "code"],
      uniqueBy: ["entity", "code"],
    });
    const lookupSchema = tableType([
      { name: "code", type: { kind: "string" } },
      { name: "value", type: DECIMAL },
    ]);
    const spec: PipelineSpec = {
      id: "grain-lookup",
      inputs: [
        { name: "source", schema: inputSchema },
        { name: "standards", schema: lookupSchema },
      ],
      requiredAnalyzers: requiredGrain(),
      nodes: [
        { id: "source", operation: "calculation.input", config: { name: "source" } },
        { id: "standards", operation: "calculation.input", config: { name: "standards" } },
        {
          id: "lookup",
          operation: "calculation.lookup",
          config: {
            key: { input: "code", lookup: "code" },
            output: { field: "value", as: "point" },
            missingPolicy: "error",
            multiplePolicy: "error",
          },
        },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "source", fromPort: "out", toNode: "lookup", toPort: "in" },
        { fromNode: "standards", fromPort: "out", toNode: "lookup", toPort: "lookup" },
        { fromNode: "lookup", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    };
    const calculation = engine.capability(CalculationCapabilityToken);
    const compiled = await calculation.compilePipeline(context, spec);
    expect(compiled.diagnostics).toEqual([]);
    const lookup = compiled.plan.nodes.find((node) => node.id === "lookup");
    expect(lookup?.constraints).toEqual([
      {
        contract: "dataset.grain.unique",
        contractVersion: "1.0.0",
        enforcement: "runtime",
        spec: { input: "table", keys: ["code"] },
      },
    ]);

    const result = await calculation.executePipeline(context, compiled, {
      datasets: {
        source: datasetFromRows("source", inputSchema, [{ entity: "E1", code: "A" }]),
        standards: datasetFromRows("standards", lookupSchema, [
          { code: "A", value: new D("1") },
          { code: "A", value: new D("2") },
        ]),
      },
    });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.map((item) => item.code)).toContain(
      CalculationDiagnosticCode.LOOKUP_AMBIGUOUS,
    );

    await engine.stop();
  });

  it("rejects Lookup first-policy because it cannot enforce the Grain constraint", async () => {
    const engine = await boot();
    const grain = engine.capability(GrainCapabilityToken);
    const inputSchema = grain.annotate(tableType([
      { name: "entity", type: { kind: "string" } },
      { name: "code", type: { kind: "string" } },
    ]), {
      dimensions: ["entity", "code"],
      uniqueBy: ["entity", "code"],
    });
    const lookupSchema = tableType([
      { name: "code", type: { kind: "string" } },
      { name: "value", type: DECIMAL },
    ]);
    const spec: PipelineSpec = {
      id: "unsafe-first-lookup",
      inputs: [
        { name: "source", schema: inputSchema },
        { name: "standards", schema: lookupSchema },
      ],
      requiredAnalyzers: requiredGrain(),
      nodes: [
        { id: "source", operation: "calculation.input", config: { name: "source" } },
        { id: "standards", operation: "calculation.input", config: { name: "standards" } },
        {
          id: "lookup",
          operation: "calculation.lookup",
          config: {
            key: { input: "code", lookup: "code" },
            output: { field: "value", as: "point" },
            multiplePolicy: "first",
          },
        },
        { id: "output", operation: "calculation.output", config: {} },
      ],
      edges: [
        { fromNode: "source", fromPort: "out", toNode: "lookup", toPort: "in" },
        { fromNode: "standards", fromPort: "out", toNode: "lookup", toPort: "lookup" },
        { fromNode: "lookup", fromPort: "out", toNode: "output", toPort: "in" },
      ],
      outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
    };

    const compiled = await engine
      .capability(CalculationCapabilityToken)
      .compilePipeline(context, spec);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: GrainDiagnosticCode.LOOKUP_POLICY }),
    );
    await engine.stop();
  });
});
