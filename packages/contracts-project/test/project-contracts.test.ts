import { describe, expect, it } from "vitest";
import {
  validateVisualPipelineSpec,
  visualPropertyFields,
  type VisualPipelineSpec,
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

  it("rejects cyclic node bindings", () => {
    const material = {
      projectId: "project",
      buildId: "build",
      buildFingerprint: "a".repeat(64),
      sourceRevision: 1,
      sourceFingerprint: "b".repeat(64),
      dependencyLockHash: "c".repeat(64),
      materialId: "performance.coefficient-adjust",
      materialVersion: "1.0.0",
      artifactHash: "d".repeat(64),
      manifestFingerprint: "e".repeat(64),
    };
    const pipeline: VisualPipelineSpec = {
      schemaVersion: "1.0.0",
      code: "coefficient-pipeline",
      name: "Coefficient Pipeline",
      inputs: [],
      nodes: [
        {
          nodeId: "a",
          material,
          configuration: {},
          inputBindings: { input: { kind: "NODE_OUTPUT", nodeId: "b", output: "value" } },
        },
        {
          nodeId: "b",
          material,
          configuration: {},
          inputBindings: { input: { kind: "NODE_OUTPUT", nodeId: "a", output: "value" } },
        },
      ],
      outputs: [],
    };
    const result = validateVisualPipelineSpec(pipeline);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "VISUAL_PIPELINE_CYCLE" }),
    ]));
  });

  it("derives decimal property fields without JavaScript numbers", () => {
    expect(visualPropertyFields({
      type: "object",
      properties: {
        coefficients: {
          type: "object",
          properties: {
            DOCTOR: { type: "string", format: "decimal-string" },
          },
          required: ["DOCTOR"],
        },
      },
    }, {
      properties: {
        coefficients: {
          properties: {
            DOCTOR: { label: "Doctor coefficient" },
          },
        },
      },
    })).toEqual([{
      path: "/coefficients/DOCTOR",
      label: "Doctor coefficient",
      control: "decimal-string",
      required: true,
    }]);
  });
});
