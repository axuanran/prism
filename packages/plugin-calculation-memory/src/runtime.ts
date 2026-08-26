import {
  BackendExtensionPoint,
  CalculationDiagnosticCode,
  backendSupportsPlan,
  planNodeSources,
  type CalculationBackend,
  type CalculationCapability,
  type CompiledPipeline,
  type ExecutablePlan,
  type ExecutionOptions,
  type ExecutionResult,
  type OperationDescriptor,
  type PlanExplanation,
  type SemanticPlanNode,
} from "@prismengine/contracts-calculation";
import {
  PrismError,
  diagnostic,
  hasErrors,
  type CallContext,
  type Diagnostic,
  type InputSnapshot,
  type VersionStamp,
} from "@prismengine/contracts-data";
import { isExposed } from "@prismengine/kernel";
import type { ExtensionRegistry, ValidationResult } from "@prismengine/kernel";
import { stableHash } from "./determinism.js";
import { FUNCTION_SIGNATURES, compilePublicExpression } from "./expression.js";
import { lowerPipeline, operationRegistry, operationVersions } from "./lowering.js";
import { MEMORY_BACKEND } from "./memory-backend.js";
import { createAnalysisSession } from "./analysis.js";

const ENGINE_VERSION = "0.1.0";

interface RuntimeArtifact {
  readonly backend: CalculationBackend;
  readonly executable: ExecutablePlan;
}

function selectBackend(extensions: ExtensionRegistry, plan: CompiledPipeline["plan"]): CalculationBackend {
  const contributed = extensions.all(BackendExtensionPoint)
    .map((contribution) => contribution.value)
    .filter((backend) => backend.id !== MEMORY_BACKEND.id);
  return contributed.find((backend) => backendSupportsPlan(backend, plan)) ?? MEMORY_BACKEND;
}

function planSummary(node: SemanticPlanNode): string {
  switch (node.kind) {
    case "input": return `读取输入数据 ${node.dataset}`;
    case "filter": return "按业务条件筛选数据行";
    case "project": return `选择并重命名 ${node.columns.length} 个字段`;
    case "formula": return `计算 ${node.columns.map((column) => column.name).join("、")} 派生字段`;
    case "join": return `按 ${node.keys.map((key) => `${key.left}=${key.right}`).join("、")} 执行 ${node.joinType} 关联并校验 ${node.expectedCardinality} 基数`;
    case "lookup": return `按 ${node.keys.map((key) => `${key.left}=${key.right}`).join("、")} 查找并补充业务属性`;
    case "decision": return `按顺序匹配首条决策规则；未匹配时执行 ${node.onNoMatch}`;
    case "aggregate": return `按 ${node.groupBy.join("、") || "全表"} 汇总 ${node.aggregations.map((item) => item.name).join("、")}`;
    case "allocate": return `按权重分配到 ${node.output} 并校验金额守恒`;
    case "validate": return `校验 ${node.assertions.length} 条逐行业务断言`;
    case "output": return `生成管道业务输出 ${node.name}`;
  }
}

function emptySnapshot(context: CallContext): InputSnapshot {
  return {
    ref: {
      fingerprint: stableHash([]),
      capturedAt: context.asOf.knownAs?.capturedAt ?? new Date().toISOString(),
    },
    datasets: [],
        parameters: [],
  };
}

function unavailableExecution(
  context: CallContext,
  plan: CompiledPipeline,
  options: ExecutionOptions,
  extra: readonly Diagnostic[],
): ExecutionResult {
  const traceLevel = options.traceLevel ?? "summary";
  return {
    status: "failed",
    outputs: {},
    diagnostics: [...plan.diagnostics, ...extra],
    trace: { level: traceLevel, nodes: [], totalDurationMs: 0 },
    input: emptySnapshot(context),
    versions: plan.versions,
    planHash: plan.planHash,
  };
}

export function createCalculationCapability(extensions: ExtensionRegistry): CalculationCapability {
  const runtimeArtifacts = new WeakMap<CompiledPipeline, RuntimeArtifact>();

  return {
    async validatePipeline(context, spec): Promise<ValidationResult> {
      const lowered = lowerPipeline(context, spec, extensions);
      return { valid: !hasErrors(lowered.diagnostics), diagnostics: lowered.diagnostics };
    },

    async compilePipeline(context, spec): Promise<CompiledPipeline> {
      const lowered = lowerPipeline(context, spec, extensions);
      // The backend is selected before the stamp is built: which backend ran
      // a plan is part of the run's code identity, not an execution detail.
      const backend = selectBackend(extensions, lowered.plan);
      const versions: VersionStamp = {
        engine: ENGINE_VERSION,
        operations: operationVersions(lowered),
        backend: { id: backend.id, version: backend.version },
        components: {},
      };
      const planHash = stableHash({
        plan: lowered.plan,
        operationVersions: versions.operations,
        engineVersion: versions.engine,
      });
      const compiled: CompiledPipeline = {
        pipelineId: spec.id,
        plan: lowered.plan,
        planHash,
        versions,
        backendId: backend.id,
        schemas: lowered.schemas,
        diagnostics: lowered.diagnostics,
      };
      if (!hasErrors(lowered.diagnostics)) {
        context.signal?.throwIfAborted();
        const executable = await backend.compile(lowered.plan, { call: context, planHash, versions });
        runtimeArtifacts.set(compiled, { backend, executable });
      }
      return compiled;
    },

    async executePipeline(context, plan, input, options = {}): Promise<ExecutionResult> {
      const artifact = runtimeArtifacts.get(plan);
      if (artifact === undefined) {
        const extra = hasErrors(plan.diagnostics)
          ? []
          : [diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, "Compiled plan does not belong to this calculation runtime.")];
        return unavailableExecution(context, plan, options, extra);
      }
      if (artifact.backend.id !== plan.backendId || artifact.executable.backendId !== plan.backendId) {
        return unavailableExecution(context, plan, options, [diagnostic(
          CalculationDiagnosticCode.OPERATION_CONFIG_INVALID,
          `Compiled plan backend "${plan.backendId}" does not match its executable artifact.`,
        )]);
      }
      return artifact.backend.execute(
        artifact.executable,
        { datasets: input.datasets, parameters: input.parameters ?? {} },
        { call: context, options },
      );
    },

    async explainPlan(_context, plan): Promise<PlanExplanation> {
      return {
        planHash: plan.planHash,
        steps: plan.plan.nodes.map((node) => ({
          nodeId: node.origin.sourceNodeId,
          operation: node.origin.operation,
          ...(node.origin.label === undefined ? {} : { label: node.origin.label }),
          dependsOn: planNodeSources(node).map((source) => source.node),
          summary: planSummary(node),
        })),
      };
    },

    listOperations(_context): readonly OperationDescriptor[] {
      const registry = operationRegistry(extensions);
      if (hasErrors(registry.diagnostics)) throw new PrismError(registry.diagnostics);
      return [...registry.operations.values()]
        // Exposure is a declaration the engine must honour, not documentation.
        // An operation meant for internal use must not reach the editor
        // palette merely because it is registered.
        .filter((operation) => isExposed(operation.exposure, "pipeline"))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((operation) => ({
          id: operation.id,
          version: operation.version,
          title: operation.title,
          ...(operation.description === undefined ? {} : { description: operation.description }),
          ...(operation.category === undefined ? {} : { category: operation.category }),
          inputs: operation.inputs,
          outputs: operation.outputs,
          configSchema: operation.config.schema,
          ...(operation.presentation === undefined ? {} : { presentation: operation.presentation }),
        }));
    },

    compileExpression(_context, spec, scope) {
      const analysis = createAnalysisSession(extensions);
      const compiled = compilePublicExpression(spec, scope, analysis.typeService);
      if (
        "diagnostics" in compiled ||
        analysis.registry.diagnostics.length === 0
      ) {
        return "diagnostics" in compiled
          ? {
              diagnostics: [
                ...analysis.registry.diagnostics,
                ...compiled.diagnostics,
              ],
            }
          : compiled;
      }
      return { diagnostics: analysis.registry.diagnostics };
    },

    listFunctions(_context) {
      return FUNCTION_SIGNATURES;
    },
  };
}
