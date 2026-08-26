import {
  CalculationDiagnosticCode,
  OperationExtensionPoint,
  SEMANTIC_PLAN_VERSION,
  planRef,
  type Expression,
  type OperationDefinition,
  type PipelineEdge,
  type PipelineNode,
  type PipelineSpec,
  type PortSchema,
  type SemanticPlan,
  type SemanticPlanNode,
  type TypeAnalysisService,
} from "@prismengine/contracts-calculation";
import {
  EngineDiagnosticCode,
  PrismError,
  diagnostic,
  hasErrors,
  type CallContext,
  type Diagnostic,
  type ValueType,
} from "@prismengine/contracts-data";
import type { ExtensionRegistry } from "@prismengine/kernel";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { InputConfig } from "./config.js";
import {
  analysisIdentities,
  createAnalysisSession,
} from "./analysis.js";

export interface OperationRegistryResult {
  readonly operations: ReadonlyMap<string, OperationDefinition<unknown>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface PipelineAnalysis {
  readonly diagnostics: readonly Diagnostic[];
  readonly order: readonly PipelineNode[];
  readonly schemas: readonly PortSchema[];
  readonly outputTypes: ReadonlyMap<string, ValueType>;
  readonly inputTypes: ReadonlyMap<string, Readonly<Record<string, ValueType>>>;
  readonly operations: ReadonlyMap<string, OperationDefinition<unknown>>;
}

export interface LoweringResult extends PipelineAnalysis {
  readonly plan: SemanticPlan;
}

export function operationRegistry(extensions: ExtensionRegistry): OperationRegistryResult {
  const operations = new Map<string, OperationDefinition<unknown>>();
  const owners = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  for (const contribution of extensions.all(OperationExtensionPoint)) {
    const operation = contribution.value as OperationDefinition<unknown>;
    const previous = owners.get(operation.id);
    if (previous !== undefined) {
      diagnostics.push(diagnostic(
        EngineDiagnosticCode.OPERATION_DUPLICATE,
        `Operation "${operation.id}" is contributed by both "${previous}" and "${contribution.pluginId}".`,
        { details: { operationId: operation.id, owners: [previous, contribution.pluginId] } },
      ));
      continue;
    }
    owners.set(operation.id, contribution.pluginId);
    operations.set(operation.id, operation);
  }
  return { operations, diagnostics };
}

function portKey(nodeId: string, port: string): string {
  return `${nodeId}\u0000${port}`;
}

function addNodeDiagnostic(item: Diagnostic, nodeId: string): Diagnostic {
  return item.nodeId === undefined ? { ...item, nodeId } : item;
}

function topologicalOrder(spec: PipelineSpec, nodeById: ReadonlyMap<string, PipelineNode>): readonly PipelineNode[] {
  const indegree = new Map<string, number>([...nodeById.keys()].map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (!nodeById.has(edge.fromNode) || !nodeById.has(edge.toNode)) continue;
    indegree.set(edge.toNode, (indegree.get(edge.toNode) ?? 0) + 1);
    const targets = outgoing.get(edge.fromNode) ?? [];
    targets.push(edge.toNode);
    outgoing.set(edge.fromNode, targets);
  }
  const sourceOrder = new Map(spec.nodes.map((node, index) => [node.id, index]));
  const ready = [...nodeById.keys()]
    .filter((id) => indegree.get(id) === 0)
    .sort((left, right) => (sourceOrder.get(left) ?? 0) - (sourceOrder.get(right) ?? 0));
  const order: PipelineNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const node = nodeById.get(id);
    if (node !== undefined) order.push(node);
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort((left, right) => (sourceOrder.get(left) ?? 0) - (sourceOrder.get(right) ?? 0));
      }
    }
  }
  return order;
}

function configDiagnostics(node: PipelineNode, operation: OperationDefinition<unknown>, nodeIndex: number): readonly Diagnostic[] {
  const schema = operation.config.schema as TSchema;
  if (Value.Check(schema, node.config)) return [];
  return [...Value.Errors(schema, node.config)].map((error) => diagnostic(
    CalculationDiagnosticCode.OPERATION_CONFIG_INVALID,
    `Invalid configuration for operation "${operation.id}": ${error.message}`,
    { nodeId: node.id, path: `/nodes/${nodeIndex}/config${error.path}`, details: { operation: operation.id } },
  ));
}

export function analyzePipeline(
  spec: PipelineSpec,
  registry: OperationRegistryResult,
  typeAnalysis: TypeAnalysisService,
): PipelineAnalysis {
  const diagnostics: Diagnostic[] = [...registry.diagnostics];
  const nodeById = new Map<string, PipelineNode>();
  const nodeIndexes = new Map<string, number>();
  for (let index = 0; index < spec.nodes.length; index += 1) {
    const node = spec.nodes[index];
    if (node === undefined) continue;
    if (nodeById.has(node.id)) {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_DUPLICATE_NODE, `Duplicate pipeline node id "${node.id}".`, { nodeId: node.id, path: `/nodes/${index}/id` }));
      continue;
    }
    nodeById.set(node.id, node);
    nodeIndexes.set(node.id, index);
    const operation = registry.operations.get(node.operation);
    if (operation === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.OPERATION_UNKNOWN, `Unknown operation "${node.operation}".`, { nodeId: node.id, path: `/nodes/${index}/operation` }));
    else diagnostics.push(...configDiagnostics(node, operation, index));
  }

  const declaredParameters = new Set<string>();
  for (let index = 0; index < (spec.parameters ?? []).length; index += 1) {
    const parameter = spec.parameters?.[index];
    if (parameter === undefined) continue;
    if (declaredParameters.has(parameter.name)) {
      diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Duplicate pipeline parameter name "${parameter.name}".`, { path: `/parameters/${index}/name` }));
    }
    declaredParameters.add(parameter.name);
  }

  const incoming = new Map<string, PipelineEdge[]>();
  for (let index = 0; index < spec.edges.length; index += 1) {
    const edge = spec.edges[index];
    if (edge === undefined) continue;
    const sourceNode = nodeById.get(edge.fromNode);
    const targetNode = nodeById.get(edge.toNode);
    const sourceOperation = sourceNode === undefined ? undefined : registry.operations.get(sourceNode.operation);
    const targetOperation = targetNode === undefined ? undefined : registry.operations.get(targetNode.operation);
    if (sourceNode === undefined || sourceOperation?.outputs.some((port) => port.name === edge.fromPort) !== true) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNKNOWN, `Unknown source port "${edge.fromNode}.${edge.fromPort}".`, { path: `/edges/${index}/fromPort` }));
    if (targetNode === undefined || targetOperation?.inputs.some((port) => port.name === edge.toPort) !== true) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNKNOWN, `Unknown target port "${edge.toNode}.${edge.toPort}".`, { path: `/edges/${index}/toPort` }));
    const key = portKey(edge.toNode, edge.toPort);
    const connections = incoming.get(key) ?? [];
    connections.push(edge);
    incoming.set(key, connections);
  }

  for (const node of nodeById.values()) {
    const operation = registry.operations.get(node.operation);
    if (operation === undefined) continue;
    for (const port of operation.inputs) {
      const connections = incoming.get(portKey(node.id, port.name)) ?? [];
      if (port.required && connections.length === 0) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNCONNECTED, `Required port "${node.id}.${port.name}" is not connected.`, { nodeId: node.id }));
      if (connections.length > 1) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Input port "${node.id}.${port.name}" has multiple connections.`, { nodeId: node.id }));
    }
  }

  const order = topologicalOrder(spec, nodeById);
  if (order.length !== nodeById.size) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_CYCLE, "Pipeline graph contains a cycle."));

  const outputTypes = new Map<string, ValueType>();
  const inputTypes = new Map<string, Readonly<Record<string, ValueType>>>();
  const schemas: PortSchema[] = [];
  const pipelineInputs = new Map(spec.inputs.map((input) => [input.name, input.schema]));

  if (order.length === nodeById.size) {
    for (const node of order) {
      const operation = registry.operations.get(node.operation);
      if (operation === undefined || configDiagnostics(node, operation, nodeIndexes.get(node.id) ?? 0).length > 0) continue;
      const resolvedInputs: Record<string, ValueType> = {};
      for (const port of operation.inputs) {
        const edge = incoming.get(portKey(node.id, port.name))?.[0];
        if (edge === undefined) continue;
        const type = outputTypes.get(portKey(edge.fromNode, edge.fromPort));
        if (type !== undefined) {
          resolvedInputs[port.name] = type;
          schemas.push({ nodeId: node.id, port: port.name, type });
        }
      }
      if (node.operation === "calculation.input") {
        const name = (node.config as InputConfig).name;
        const type = pipelineInputs.get(name);
        if (type === undefined) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Pipeline input "${name}" is not declared.`, { nodeId: node.id }));
        else resolvedInputs.source = type;
      }
      inputTypes.set(node.id, resolvedInputs);
      const inferenceRequest = {
        config: node.config,
        inputs: resolvedInputs,
        analysis: typeAnalysis,
      };
      const inferred = operation.infer(inferenceRequest);
      diagnostics.push(...inferred.diagnostics.map((item) => addNodeDiagnostic(item, node.id)));
      diagnostics.push(...(operation.validate?.(inferenceRequest) ?? []).map((item) => addNodeDiagnostic(item, node.id)));
      for (const [port, type] of Object.entries(inferred.outputs)) {
        if (!operation.outputs.some((definition) => definition.name === port)) {
          diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNKNOWN, `Operation "${operation.id}" inferred unknown output port "${port}".`, { nodeId: node.id }));
          continue;
        }
        outputTypes.set(portKey(node.id, port), type);
        schemas.push({ nodeId: node.id, port, type });
      }
    }
  }

  const outputNames = new Set<string>();
  for (let index = 0; index < spec.outputs.length; index += 1) {
    const output = spec.outputs[index];
    if (output === undefined) continue;
    if (outputNames.has(output.name)) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_SCHEMA_MISMATCH, `Duplicate pipeline output name "${output.name}".`, { path: `/outputs/${index}/name` }));
    outputNames.add(output.name);
    if (!outputTypes.has(portKey(output.fromNode, output.fromPort))) diagnostics.push(diagnostic(CalculationDiagnosticCode.PIPELINE_PORT_UNKNOWN, `Pipeline output references unknown port "${output.fromNode}.${output.fromPort}".`, { path: `/outputs/${index}` }));
  }

  return { diagnostics, order, schemas, outputTypes, inputTypes, operations: registry.operations };
}

function collectExpressionParameters(expression: Expression, names: Set<string>): void {
  switch (expression.kind) {
    case "parameter":
      names.add(expression.name);
      return;
    case "unary":
      collectExpressionParameters(expression.operand, names);
      return;
    case "binary":
      collectExpressionParameters(expression.left, names);
      collectExpressionParameters(expression.right, names);
      return;
    case "conditional":
      collectExpressionParameters(expression.test, names);
      collectExpressionParameters(expression.whenTrue, names);
      collectExpressionParameters(expression.whenFalse, names);
      return;
    case "call":
      for (const argument of expression.args) collectExpressionParameters(argument, names);
      return;
    case "field":
    case "literal":
      return;
  }
}

function nodeParameters(node: SemanticPlanNode, names: Set<string>): void {
  switch (node.kind) {
    case "filter":
      collectExpressionParameters(node.predicate, names);
      return;
    case "formula":
      for (const column of node.columns) collectExpressionParameters(column.expression, names);
      return;
    case "lookup":
      for (const output of node.outputs) if (output.defaultValue !== undefined) collectExpressionParameters(output.defaultValue, names);
      return;
    case "decision":
      for (const rule of node.rules) {
        collectExpressionParameters(rule.when, names);
        for (const expression of Object.values(rule.outputs)) collectExpressionParameters(expression, names);
      }
      for (const expression of Object.values(node.defaults ?? {})) collectExpressionParameters(expression, names);
      return;
    case "allocate":
      if (node.amount.kind === "expression") collectExpressionParameters(node.amount.expression, names);
      collectExpressionParameters(node.weight, names);
      return;
    case "validate":
      for (const assertion of node.assertions) collectExpressionParameters(assertion.expression, names);
      return;
    case "input":
    case "project":
    case "join":
    case "aggregate":
    case "output":
      return;
  }
}

export function lowerPipeline(context: CallContext, spec: PipelineSpec, extensions: ExtensionRegistry): LoweringResult {
  const analysisSession = createAnalysisSession(extensions);
  const analysis = analyzePipeline(
    spec,
    operationRegistry(extensions),
    analysisSession.typeService,
  );
  const diagnostics: Diagnostic[] = [
    ...analysisSession.registry.diagnostics,
    ...analysis.diagnostics,
    ...analysisSession.require(spec.requiredAnalyzers ?? []),
  ];
  const nodes: SemanticPlanNode[] = [];

  if (!hasErrors(diagnostics)) {
    const incoming = new Map<string, PipelineEdge>();
    for (const edge of spec.edges) incoming.set(portKey(edge.toNode, edge.toPort), edge);
    for (const node of analysis.order) {
      const operation = analysis.operations.get(node.operation);
      if (operation === undefined) continue;
      const inputs = Object.fromEntries(operation.inputs.flatMap((port) => {
        const edge = incoming.get(portKey(node.id, port.name));
        return edge === undefined ? [] : [[port.name, planRef(edge.fromNode, edge.fromPort)] as const];
      }));
      const outputTypes = Object.fromEntries(operation.outputs.flatMap((port) => {
        const type = analysis.outputTypes.get(portKey(node.id, port.name));
        return type === undefined ? [] : [[port.name, type] as const];
      }));
      try {
        const lowered = operation.lower({
          call: context,
          nodeId: node.id,
          ...(node.label === undefined ? {} : { label: node.label }),
          config: node.config,
          inputs,
          inputTypes: analysis.inputTypes.get(node.id) ?? {},
          outputTypes,
          analysis: analysisSession.typeService,
        });
        const upstream = new Map(nodes.map((existing) => [existing.id, existing]));
        const analyzed = analysisSession.analyzePlanNode(lowered, upstream);
        nodes.push(analyzed.node);
        diagnostics.push(
          ...analyzed.diagnostics.map((item) => addNodeDiagnostic(item, node.id)),
        );
      } catch (error) {
        if (error instanceof PrismError) diagnostics.push(...error.diagnostics.map((item) => addNodeDiagnostic(item, node.id)));
        else diagnostics.push(diagnostic(CalculationDiagnosticCode.OPERATION_CONFIG_INVALID, `Operation "${operation.id}" could not be lowered.`, { nodeId: node.id, details: { error: error instanceof Error ? error.message : String(error) } }));
      }
    }
  }

  const usedParameters = new Set<string>();
  for (const node of nodes) nodeParameters(node, usedParameters);
  const declarations = new Map((spec.parameters ?? []).map((parameter) => [parameter.name, parameter]));
  for (const name of [...usedParameters].sort()) {
    if (!declarations.has(name)) {
      const sourceNode = nodes.find((node) => {
        const names = new Set<string>();
        nodeParameters(node, names);
        return names.has(name);
      });
      diagnostics.push(diagnostic(
        CalculationDiagnosticCode.EXPRESSION_UNKNOWN_FIELD,
        `Unknown pipeline parameter "${name}".`,
        { ...(sourceNode === undefined ? {} : { nodeId: sourceNode.origin.sourceNodeId }), details: { parameter: name } },
      ));
    }
  }

  const plan: SemanticPlan = {
    irVersion: SEMANTIC_PLAN_VERSION,
    pipelineId: spec.id,
    inputs: spec.inputs.map((input) => ({ name: input.name, schema: input.schema })),
    parameters: [...usedParameters]
      .sort()
      .flatMap((name) => {
        const declaration = declarations.get(name);
        return declaration === undefined ? [] : [{ name: declaration.name, type: declaration.type }];
      }),
    analysis: { extensions: analysisIdentities(analysisSession) },
    nodes,
    outputs: spec.outputs.map((output) => ({ name: output.name, from: planRef(output.fromNode, output.fromPort) })),
  };

  return { ...analysis, diagnostics, plan };
}

export function operationVersions(analysis: PipelineAnalysis): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...new Set(analysis.order.map((node) => node.operation))]
      .sort()
      .flatMap((id) => {
        const version = analysis.operations.get(id)?.version;
        return version === undefined ? [] : [[id, version] as const];
      }),
  );
}
