import {
  BackendExtensionPoint,
  CalculationCapabilityToken,
  OperationExtensionPoint,
} from "@prismengine/contracts-calculation";
import { definePlugin } from "@prismengine/kernel";
import {
  DecisionTableResourceSchema,
  LookupTableResourceSchema,
  PipelineResourceSchema,
} from "./config.js";
import { BUILTIN_OPERATIONS } from "./operations.js";
import { MEMORY_BACKEND } from "./memory-backend.js";
import { createCalculationCapability } from "./runtime.js";

export const calculationPlugin = definePlugin({
  id: "calculation.memory",
  version: "0.1.0",
  description: "Deterministic decimal expression and calculation pipeline runtime.",
  provides: [CalculationCapabilityToken],
  register(context) {
    for (const operation of BUILTIN_OPERATIONS) {
      context.extensions.contribute(OperationExtensionPoint, operation);
    }
    context.extensions.contribute(BackendExtensionPoint, MEMORY_BACKEND);
    context.resources.define({
      kind: "calculation.pipeline",
      title: "计算管道",
      description: "可校验、可复现的计算步骤图。",
      config: { schema: PipelineResourceSchema },
      exposure: { configuration: true, frontend: true },
    });
    context.resources.define({
      kind: "calculation.lookup-table",
      title: "查找表",
      description: "用于精确键值查找的版本化数据表。",
      config: { schema: LookupTableResourceSchema },
      exposure: { configuration: true, frontend: true },
    });
    context.resources.define({
      kind: "calculation.decision-table",
      title: "决策表",
      description: "按顺序首条匹配的业务规则表。",
      config: { schema: DecisionTableResourceSchema },
      exposure: { configuration: true, frontend: true },
    });
    context.provide(CalculationCapabilityToken, createCalculationCapability(context.extensions));
  },
});
