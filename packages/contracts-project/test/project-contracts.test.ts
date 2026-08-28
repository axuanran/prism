import { describe, expect, it } from "vitest";
import {
  validateMaterialManifest,
  type MaterialManifest,
  type VisualOperatorContract,
} from "@prismengine/contracts-project";

const visualOperator: VisualOperatorContract = {
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  configurationSchema: { type: "object" },
  executionModel: "ROW_MAP",
  cardinality: "ONE_TO_ONE",
  grainEffect: "PRESERVE",
  supportedBackends: ["calculation.memory"],
};

function manifest(operator: VisualOperatorContract): MaterialManifest {
  return {
    id: "performance.coefficient-adjust",
    version: "1.0.0",
    kind: "operator",
    authoringMode: "CODE",
    displayName: "Coefficient Adjust",
    category: "performance",
    runtimeTarget: "pipeline",
    visualOperator: operator,
  };
}

describe("Visual Operator Contract V1", () => {
  it("accepts the static ROW_MAP subset", () => {
    expect(validateMaterialManifest(manifest(visualOperator))).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects operators whose cardinality is outside the V1 analyzer model", () => {
    const result = validateMaterialManifest(manifest({
      ...visualOperator,
      cardinality: "ONE_TO_MANY",
    }));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MATERIAL_VISUAL_OPERATOR_UNSUPPORTED" }),
    ]));
  });
});
