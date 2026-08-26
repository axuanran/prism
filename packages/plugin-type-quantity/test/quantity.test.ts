import { describe, expect, it } from "vitest";
import {
  CalculationCapabilityToken,
  TypeAnalysisExtensionPoint,
  type PipelineSpec,
} from "@prismengine/contracts-calculation";
import { tableType, type ValueType } from "@prismengine/contracts-data";
import { createEngine, type Engine } from "@prismengine/kernel";
import { calculationPlugin } from "@prismengine/plugin-calculation-memory";
import {
  QUANTITY_ANALYZER_SEMANTIC_VERSION,
  QUANTITY_PLUGIN_VERSION,
  QuantityCapabilityToken,
  QuantityDiagnosticCode,
  quantityPlugin,
} from "@prismengine/plugin-type-quantity";
import { testCallContext } from "@prismengine/testing";

const context = testCallContext();

async function compile(
  expression: string,
  fields: readonly { readonly name: string; readonly type: ValueType }[],
  installQuantity = true,
) {
  const engine = createEngine({
    plugins: installQuantity
      ? [calculationPlugin, quantityPlugin]
      : [calculationPlugin],
  });
  await engine.start();
  const spec: PipelineSpec = {
    id: "quantity-test",
    inputs: [{ name: "source", schema: tableType(fields) }],
    requiredAnalyzers: [{
      id: "calculation.type.quantity",
      kind: "type",
      contractVersion: TypeAnalysisExtensionPoint.version,
    }],
    nodes: [
      { id: "input", operation: "calculation.input", config: { name: "source" } },
      {
        id: "formula",
        operation: "calculation.formula",
        config: { columns: [{ name: "result", expression: { text: expression } }] },
      },
      { id: "output", operation: "calculation.output", config: {} },
    ],
    edges: [
      { fromNode: "input", fromPort: "out", toNode: "formula", toPort: "in" },
      { fromNode: "formula", fromPort: "out", toNode: "output", toPort: "in" },
    ],
    outputs: [{ name: "result", fromNode: "output", fromPort: "out" }],
  };
  const compiled = await engine
    .capability(CalculationCapabilityToken)
    .compilePipeline(context, spec);
  return { engine, compiled };
}

const DECIMAL: ValueType = { kind: "decimal", precision: 28, scale: 6 };

function quantityType(
  engine: Engine,
  dimension: string,
  unit?: string,
): ValueType {
  return engine.capability(QuantityCapabilityToken).annotate(DECIMAL, {
    numerator: [{ dimension, unit: unit ?? "", exponent: 1 }],
    denominator: [],
  });
}

describe("quantity analysis plugin", () => {
  it("reduces WORKLOAD × POINT_PER_WORKLOAD to POINT", async () => {
    const boot = createEngine({ plugins: [calculationPlugin, quantityPlugin] });
    await boot.start();
    const quantity = boot.capability(QuantityCapabilityToken);
    const workload = quantity.annotate(DECIMAL, {
      numerator: [{ dimension: "WORKLOAD", unit: "VISIT", exponent: 1 }],
      denominator: [],
    });
    const pointRate = quantity.annotate(DECIMAL, {
      numerator: [{ dimension: "POINT", unit: "", exponent: 1 }],
      denominator: [{ dimension: "WORKLOAD", unit: "VISIT", exponent: 1 }],
    });
    await boot.stop();

    const { engine, compiled } = await compile("workload * rate", [
      { name: "workload", type: workload },
      { name: "rate", type: pointRate },
    ]);

    expect(compiled.diagnostics).toEqual([]);
    const formula = compiled.plan.nodes.find((node) => node.kind === "formula");
    const resultType = formula?.outputType.columns.find((column) => column.name === "result")?.type;
    const resultQuantity = engine.capability(QuantityCapabilityToken).read(resultType!);
    expect(resultQuantity).toEqual({
      numerator: [{ dimension: "POINT", unit: "", exponent: 1 }],
      denominator: [],
    });
    expect(compiled.plan.analysis.extensions["calculation.type.quantity"]).toEqual({
      extensionPoint: TypeAnalysisExtensionPoint.id,
      contractVersion: TypeAnalysisExtensionPoint.version,
      semanticVersion: QUANTITY_ANALYZER_SEMANTIC_VERSION,
    });
    expect(QUANTITY_PLUGIN_VERSION).not.toBe(QUANTITY_ANALYZER_SEMANTIC_VERSION);

    await engine.stop();
  });

  it("rejects WORKLOAD + POINT at compile time", async () => {
    const boot = createEngine({ plugins: [calculationPlugin, quantityPlugin] });
    await boot.start();
    const workload = quantityType(boot, "WORKLOAD", "VISIT");
    const point = quantityType(boot, "POINT");
    await boot.stop();

    const { engine, compiled } = await compile("workload + point", [
      { name: "workload", type: workload },
      { name: "point", type: point },
    ]);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: QuantityDiagnosticCode.MISMATCH }),
    );
    await engine.stop();
  });

  it("rejects MONEY<CNY> + MONEY<USD>", async () => {
    const boot = createEngine({ plugins: [calculationPlugin, quantityPlugin] });
    await boot.start();
    const cny = quantityType(boot, "MONEY", "CNY");
    const usd = quantityType(boot, "MONEY", "USD");
    await boot.stop();

    const { engine, compiled } = await compile("cny + usd", [
      { name: "cny", type: cny },
      { name: "usd", type: usd },
    ]);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: QuantityDiagnosticCode.MISMATCH }),
    );
    await engine.stop();
  });

  it("loses the capability when the plugin is not installed", async () => {
    const { engine, compiled } = await compile("amount + amount", [
      { name: "amount", type: DECIMAL },
    ], false);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "REQUIRED_ANALYZER_MISSING" }),
    );
    expect(() => engine.capability(QuantityCapabilityToken)).toThrow();
    await engine.stop();
  });
});
