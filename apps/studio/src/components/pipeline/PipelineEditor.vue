<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, ref, watch } from 'vue';
import { VueFlow } from '@vue-flow/core';
import type { Connection, NodeMouseEvent } from '@vue-flow/core';
import { api, localizeDiagnostic } from '../../api/client';
import type {
  DatasetPayload,
  Diagnostic,
  OperationDescriptor,
  PipelineExecutionResponse,
  PipelineSpec,
} from '../../api/types';
import ConfigForm from '../config/ConfigForm.vue';
import { createDefaultValue } from '../config/schema';
import PipelineOperationNode from './PipelineOperationNode.vue';
import type { PipelineNodeData } from './PipelineOperationNode.vue';

interface StudioFlowNode {
  readonly id: string;
  readonly type: 'operation';
  position: { x: number; y: number };
  readonly data: PipelineNodeData;
}

interface StudioFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly sourceHandle: string;
  readonly target: string;
  readonly targetHandle: string;
}

const props = withDefaults(defineProps<{
  modelValue: PipelineSpec;
  embedded?: boolean;
  readonly?: boolean;
}>(), { embedded: false, readonly: false });

const emit = defineEmits<{
  'update:modelValue': [value: PipelineSpec];
}>();

const NODE_GRID_X = 260;
const NODE_GRID_Y = 150;
const operations = ref<readonly OperationDescriptor[]>([]);
const loadingOperations = ref(true);
const loadError = ref<string | null>(null);
const flowNodes = ref<StudioFlowNode[]>([]);
const flowEdges = ref<StudioFlowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);
const connectionSourceNodeId = ref('');
const connectionSourcePort = ref('');
const connectionTargetNodeId = ref('');
const connectionTargetPort = ref('');
const validating = ref(false);
const executing = ref(false);
const validationResult = ref<{ readonly valid: boolean; readonly diagnostics: readonly Diagnostic[] } | null>(null);
const executionResult = ref<PipelineExecutionResponse | null>(null);
const actionError = ref<string | null>(null);
let suppressPropSync = false;

const nodeTypes = { operation: markRaw(PipelineOperationNode) };
const operationById = computed(() => new Map(operations.value.map((operation) => [operation.id, operation])));
const operationGroups = computed(() => {
  const groups = new Map<string, OperationDescriptor[]>();
  for (const operation of operations.value) {
    const category = operation.category ?? '其他';
    const items = groups.get(category) ?? [];
    items.push(operation);
    groups.set(category, items);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
});
const selectedFlowNode = computed<StudioFlowNode | undefined>(() => flowNodes.value.find((node) => node.id === selectedNodeId.value));
const selectedOperation = computed(() => {
  const operationId = selectedFlowNode.value?.data?.operationId;
  return operationId ? operationById.value.get(operationId) : undefined;
});
const selectedConfig = computed({
  get: () => {
    const node = props.modelValue.nodes.find((item) => item.id === selectedNodeId.value);
    return node?.config ?? {};
  },
  set: (config: unknown) => {
    if (!selectedNodeId.value) return;
    const spec = currentSpec();
    publishSpec({
      ...spec,
      nodes: spec.nodes.map((node) => node.id === selectedNodeId.value ? { ...node, config } : node),
    });
  },
});
const selectedDiagnostics = computed(() => {
  if (!selectedNodeId.value) return [];
  return [...(validationResult.value?.diagnostics ?? []), ...(executionResult.value?.diagnostics ?? [])]
    .filter((item) => item.nodeId === selectedNodeId.value)
    .map((item) => ({ ...item, path: item.path?.replace(/^\/?nodes\/\d+\/config\/?/, '') }));
});
const connectionRows = computed(() => flowEdges.value.map((edge) => {
  const source = flowNodes.value.find((node) => node.id === edge.source);
  const target = flowNodes.value.find((node) => node.id === edge.target);
  return {
    id: edge.id,
    source: source?.data?.title ?? '步骤',
    sourcePort: portTitle(source?.data?.outputs, edge.sourceHandle),
    target: target?.data?.title ?? '步骤',
    targetPort: portTitle(target?.data?.inputs, edge.targetHandle),
  };
}));
const connectionSourceNodes = computed(() => flowNodes.value.filter((node) => node.data.outputs.length > 0));
const connectionTargetNodes = computed(() => flowNodes.value.filter((node) => node.data.inputs.length > 0));
const connectionSourcePorts = computed(() =>
  flowNodes.value.find((node) => node.id === connectionSourceNodeId.value)?.data.outputs ?? []);
const connectionTargetPorts = computed(() =>
  flowNodes.value.find((node) => node.id === connectionTargetNodeId.value)?.data.inputs ?? []);

function newNodeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `node-${crypto.randomUUID()}`;
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function portTitle(ports: PipelineNodeData['inputs'] | undefined, portName: string | null | undefined): string {
  return ports?.find((port) => port.name === portName)?.title ?? '端口';
}

function prepareConnectionDefaults(): void {
  if (!connectionSourceNodes.value.some((node) => node.id === connectionSourceNodeId.value)) {
    connectionSourceNodeId.value = connectionSourceNodes.value[0]?.id ?? '';
  }
  if (!connectionTargetNodes.value.some((node) => node.id === connectionTargetNodeId.value)) {
    connectionTargetNodeId.value = connectionTargetNodes.value.find((node) => node.id !== connectionSourceNodeId.value)?.id
      ?? connectionTargetNodes.value[0]?.id
      ?? '';
  }
  if (!connectionSourcePorts.value.some((port) => port.name === connectionSourcePort.value)) {
    connectionSourcePort.value = connectionSourcePorts.value[0]?.name ?? '';
  }
  if (!connectionTargetPorts.value.some((port) => port.name === connectionTargetPort.value)) {
    connectionTargetPort.value = connectionTargetPorts.value[0]?.name ?? '';
  }
}

function toFlowNode(node: PipelineSpec['nodes'][number], index: number): StudioFlowNode {
  const operation = operationById.value.get(node.operation);
  return {
    id: node.id,
    type: 'operation',
    position: node.position ?? { x: (index % 3) * NODE_GRID_X, y: Math.floor(index / 3) * NODE_GRID_Y },
    data: {
      operationId: node.operation,
      title: node.label ?? operation?.title ?? '不可用步骤',
      category: operation?.category ?? '未分类',
      ...(operation?.description ? { description: operation.description } : {}),
      inputs: operation?.inputs ?? [],
      outputs: operation?.outputs ?? [],
    },
  };
}

function syncFromSpec(spec: PipelineSpec): void {
  if (suppressPropSync) return;
  flowNodes.value = spec.nodes.map(toFlowNode);
  flowEdges.value = spec.edges.map((edge, index) => ({
    id: `edge-${index}-${edge.fromNode}-${edge.toNode}`,
    source: edge.fromNode,
    sourceHandle: edge.fromPort,
    target: edge.toNode,
    targetHandle: edge.toPort,
  }));
}

function derivedOutputs(nodes: readonly PipelineSpec['nodes'][number][], edges: readonly PipelineSpec['edges'][number][]): PipelineSpec['outputs'] {
  const hasOutgoing = new Set(edges.map((edge) => edge.fromNode));
  const terminalIds = new Set(nodes.filter((node) => !hasOutgoing.has(node.id)).map((node) => node.id));
  const preserved = props.modelValue.outputs.filter((output) => terminalIds.has(output.fromNode));
  if (preserved.length > 0) return preserved;
  return nodes
    .filter((node) => !hasOutgoing.has(node.id))
    .flatMap((node, index) => {
      const operation = operationById.value.get(node.operation);
      const port = operation?.outputs[0];
      return port ? [{ name: node.label ?? operation.title ?? `输出 ${index + 1}`, fromNode: node.id, fromPort: port.name }] : [];
    });
}

function currentSpec(): PipelineSpec {
  const nodes = flowNodes.value.map((node) => {
    const existing = props.modelValue.nodes.find((item) => item.id === node.id);
    return {
      id: node.id,
      operation: node.data?.operationId ?? existing?.operation ?? '',
      config: existing?.config ?? {},
      label: node.data?.title,
      position: { x: node.position.x, y: node.position.y },
    };
  });
  const edges = flowEdges.value.map((edge) => ({
    fromNode: edge.source,
    fromPort: edge.sourceHandle ?? '',
    toNode: edge.target,
    toPort: edge.targetHandle ?? '',
  }));
  return {
    id: props.modelValue.id,
    inputs: props.modelValue.inputs,
    nodes,
    edges,
    outputs: derivedOutputs(nodes, edges),
  };
}

function publishSpec(spec = currentSpec()): void {
  suppressPropSync = true;
  emit('update:modelValue', spec);
  void nextTick(() => {
    suppressPropSync = false;
  });
}

function addOperation(operation: OperationDescriptor): void {
  if (props.readonly) return;
  const id = newNodeId();
  const defaultConfig = createDefaultValue(operation.configSchema) ?? {};
  const config = operation.inputs.length === 0
    && typeof defaultConfig === 'object'
    && defaultConfig !== null
    && 'name' in defaultConfig
    && !String((defaultConfig as { readonly name?: unknown }).name ?? '').trim()
    ? { ...defaultConfig, name: props.modelValue.inputs[0]?.name ?? 'source' }
    : defaultConfig;
  const node: StudioFlowNode = {
    id,
    type: 'operation',
    position: { x: (flowNodes.value.length % 3) * NODE_GRID_X, y: Math.floor(flowNodes.value.length / 3) * NODE_GRID_Y },
    data: {
      operationId: operation.id,
      title: operation.title,
      category: operation.category ?? '其他',
      ...(operation.description ? { description: operation.description } : {}),
      inputs: operation.inputs,
      outputs: operation.outputs,
    },
  };
  flowNodes.value = [...flowNodes.value, node];
  const spec = currentSpec();
  publishSpec({ ...spec, nodes: spec.nodes.map((item) => item.id === id ? { ...item, config } : item) });
  selectedNodeId.value = id;
  validationResult.value = null;
  executionResult.value = null;
}

function connect(connection: Connection): void {
  if (props.readonly || !connection.sourceHandle || !connection.targetHandle) return;
  const withoutExistingTarget = flowEdges.value.filter((edge) =>
    edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  flowEdges.value = [...withoutExistingTarget, {
    id: `edge-${newNodeId()}`,
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
  }];
  publishSpec();
  validationResult.value = null;
  executionResult.value = null;
}

function connectSelection(): void {
  if (!connectionSourceNodeId.value || !connectionSourcePort.value || !connectionTargetNodeId.value || !connectionTargetPort.value) return;
  connect({
    source: connectionSourceNodeId.value,
    sourceHandle: connectionSourcePort.value,
    target: connectionTargetNodeId.value,
    targetHandle: connectionTargetPort.value,
  });
}

function disconnect(edgeId: string): void {
  if (props.readonly) return;
  flowEdges.value = flowEdges.value.filter((edge) => edge.id !== edgeId);
  publishSpec();
}

function selectNode(event: NodeMouseEvent): void {
  selectedNodeId.value = event.node.id;
}

function deleteSelectedNode(): void {
  const id = selectedNodeId.value;
  if (!id || props.readonly) return;
  flowNodes.value = flowNodes.value.filter((node) => node.id !== id);
  flowEdges.value = flowEdges.value.filter((edge) => edge.source !== id && edge.target !== id);
  selectedNodeId.value = null;
  publishSpec();
}

function emptyInputs(spec: PipelineSpec): Readonly<Record<string, DatasetPayload>> {
  return Object.fromEntries(spec.inputs.map((input) => [input.name, {
    columns: input.schema.columns.map((column) => ({
      name: column.name,
      kind: typeof column.type.kind === 'string' ? column.type.kind : 'string',
    })),
    rows: [],
    truncated: false,
  }]));
}

async function validatePipeline(): Promise<void> {
  validating.value = true;
  actionError.value = null;
  try {
    const spec = currentSpec();
    publishSpec(spec);
    validationResult.value = await api.validatePipeline(spec);
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '流水线校验失败。';
  } finally {
    validating.value = false;
  }
}

async function executePipeline(): Promise<void> {
  executing.value = true;
  actionError.value = null;
  try {
    const spec = currentSpec();
    publishSpec(spec);
    executionResult.value = await api.executePipeline(spec, emptyInputs(spec));
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '流水线执行失败。';
  } finally {
    executing.value = false;
  }
}

async function loadOperations(): Promise<void> {
  loadingOperations.value = true;
  loadError.value = null;
  try {
    operations.value = await api.listOperations();
    syncFromSpec(props.modelValue);
  } catch (cause: unknown) {
    loadError.value = cause instanceof Error ? cause.message : '无法读取可用步骤。';
  } finally {
    loadingOperations.value = false;
  }
}
watch(flowNodes, prepareConnectionDefaults, { immediate: true });
watch(connectionSourceNodeId, prepareConnectionDefaults);
watch(connectionTargetNodeId, prepareConnectionDefaults);

watch(() => props.modelValue, (spec) => syncFromSpec(spec), { deep: true });
onMounted(() => void loadOperations());
</script>

<template>
  <section class="pipeline-editor" :class="{ 'pipeline-editor--embedded': embedded }" aria-labelledby="pipeline-editor-title">
    <header class="pipeline-editor__header">
      <div>
        <p>可视化计算</p>
        <h3 id="pipeline-editor-title">流水线编辑器</h3>
        <span>从左侧添加步骤，拖动端口建立数据连接；所有步骤配置均由配置契约自动生成。</span>
      </div>
      <div class="pipeline-editor__actions">
        <button class="button button--secondary" type="button" :disabled="validating || loadingOperations" @click="validatePipeline">
          {{ validating ? '验证中…' : '验证' }}
        </button>
        <button class="button button--primary" type="button" :disabled="executing || loadingOperations" @click="executePipeline">
          {{ executing ? '执行中…' : '执行' }}
        </button>
      </div>
    </header>

    <p v-if="loadError || actionError" class="inline-alert" role="alert">{{ loadError ?? actionError }}</p>

    <div class="pipeline-editor__workspace">
      <aside class="pipeline-palette" aria-label="步骤面板">
        <div class="pipeline-palette__heading">
          <strong>步骤</strong>
          <span v-if="loadingOperations">加载中</span>
        </div>
        <div v-for="group in operationGroups" :key="group.category" class="pipeline-palette__group">
          <p>{{ group.category }}</p>
          <button
            v-for="operation in group.items"
            :key="operation.id"
            type="button"
            :disabled="readonly"
            :title="operation.description"
            @click="addOperation(operation)"
          >
            <strong>{{ operation.title }}</strong>
            <span>{{ operation.description ?? '添加计算步骤' }}</span>
          </button>
        </div>
        <p v-if="!loadingOperations && operations.length === 0" class="pipeline-palette__empty">暂无可添加步骤。</p>
      </aside>

      <div class="pipeline-canvas" aria-label="流水线画布">
        <VueFlow
          v-model:nodes="flowNodes"
          v-model:edges="flowEdges"
          :node-types="nodeTypes"
          :nodes-draggable="!readonly"
          :nodes-connectable="!readonly"
          :elements-selectable="true"
          fit-view-on-init
          @connect="connect"
          @node-click="selectNode"
          @node-drag-stop="publishSpec()"
        >
          <div class="pipeline-canvas__hint">拖动步骤调整布局 · 从圆点拖到圆点连接</div>
        </VueFlow>
      </div>

      <aside class="pipeline-config" aria-label="步骤配置">
        <template v-if="selectedFlowNode && selectedOperation">
          <div class="pipeline-config__heading">
            <div>
              <span>当前步骤</span>
              <h4>{{ selectedFlowNode.data?.title }}</h4>
            </div>
            <button type="button" :disabled="readonly" @click="deleteSelectedNode">删除步骤</button>
          </div>
          <ConfigForm
            v-model="selectedConfig"
            :schema="selectedOperation.configSchema"
            :presentation="selectedOperation.presentation"
            :diagnostics="selectedDiagnostics"
            :disabled="readonly"
          />
        </template>
        <div v-else class="pipeline-config__empty">
          <strong>选择一个步骤</strong>
          <p>点击画布中的步骤，在此调整配置。</p>
        </div>
      </aside>
    </div>

    <section v-if="flowNodes.length > 1" class="pipeline-connections" aria-labelledby="connection-title">
      <div class="pipeline-connections__heading">
        <div>
          <h4 id="connection-title">端口连接</h4>
          <span>{{ connectionRows.length }} 条已连接</span>
        </div>
        <div class="pipeline-connections__builder">
          <label>从
            <select v-model="connectionSourceNodeId" :disabled="readonly">
              <option v-for="node in connectionSourceNodes" :key="node.id" :value="node.id">{{ node.data.title }}</option>
            </select>
          </label>
          <label>输出
            <select v-model="connectionSourcePort" :disabled="readonly">
              <option v-for="port in connectionSourcePorts" :key="port.name" :value="port.name">{{ port.title ?? '输出端口' }}</option>
            </select>
          </label>
          <i aria-hidden="true">→</i>
          <label>到
            <select v-model="connectionTargetNodeId" :disabled="readonly">
              <option v-for="node in connectionTargetNodes" :key="node.id" :value="node.id">{{ node.data.title }}</option>
            </select>
          </label>
          <label>输入
            <select v-model="connectionTargetPort" :disabled="readonly">
              <option v-for="port in connectionTargetPorts" :key="port.name" :value="port.name">{{ port.title ?? '输入端口' }}</option>
            </select>
          </label>
          <button type="button" :disabled="readonly" @click="connectSelection">建立连接</button>
        </div>
      </div>
      <ul v-if="connectionRows.length > 0">
        <li v-for="edge in connectionRows" :key="edge.id">
          <span>{{ edge.source }} · {{ edge.sourcePort }}</span>
          <i aria-hidden="true">→</i>
          <span>{{ edge.target }} · {{ edge.targetPort }}</span>
          <button type="button" :disabled="readonly" @click="disconnect(edge.id)">断开</button>
        </li>
      </ul>
      <p v-else class="pipeline-connections__empty">选择两端步骤和端口后建立连接，也可直接在画布拖动圆点。</p>
    </section>

    <section v-if="validationResult" class="pipeline-feedback" :class="{ 'pipeline-feedback--success': validationResult.valid }" aria-live="polite">
      <div>
        <strong>{{ validationResult.valid ? '验证通过' : '需要修正' }}</strong>
        <span>{{ validationResult.valid ? '流水线结构与配置有效。' : `发现 ${validationResult.diagnostics.length} 项问题。` }}</span>
      </div>
      <ul v-if="validationResult.diagnostics.length > 0">
        <li v-for="item in validationResult.diagnostics" :key="`${item.nodeId}:${item.code}:${item.path}`">{{ localizeDiagnostic(item) }}</li>
      </ul>
    </section>

    <section v-if="executionResult" class="pipeline-results" aria-labelledby="pipeline-result-title">
      <header>
        <div>
          <p>查看结果 / Trace</p>
          <h4 id="pipeline-result-title">{{ executionResult.status === 'success' ? '执行完成' : '执行失败' }}</h4>
        </div>
        <span>总耗时 {{ executionResult.trace.totalDurationMs }} ms</span>
      </header>
      <div class="pipeline-results__trace">
        <article v-for="node in executionResult.trace.nodes" :key="node.nodeId">
          <div>
            <strong>{{ flowNodes.find((item) => item.id === node.nodeId)?.data?.title ?? node.label ?? '计算步骤' }}</strong>
            <span :class="`trace-status trace-status--${node.phase}`">{{ node.phase === 'ok' ? '完成' : node.phase === 'skipped' ? '跳过' : '失败' }}</span>
          </div>
          <dl>
            <div><dt>输入行数</dt><dd>{{ node.inputRows }}</dd></div>
            <div><dt>输出行数</dt><dd>{{ node.outputRows }}</dd></div>
            <div><dt>耗时</dt><dd>{{ node.durationMs }} ms</dd></div>
          </dl>
          <ul v-if="node.diagnostics.length > 0">
            <li v-for="item in node.diagnostics" :key="item.code">{{ localizeDiagnostic(item) }}</li>
          </ul>
        </article>
      </div>
      <div v-if="Object.keys(executionResult.outputs).length > 0" class="pipeline-results__datasets">
        <details v-for="(dataset, name) in executionResult.outputs" :key="name">
          <summary>{{ name }} · {{ dataset.rows.length }} 行</summary>
          <div class="table-scroll">
            <table>
              <thead><tr><th v-for="column in dataset.columns" :key="column.name" scope="col">{{ column.name }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, index) in dataset.rows" :key="index"><td v-for="column in dataset.columns" :key="column.name">{{ row[column.name] ?? '—' }}</td></tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  </section>
</template>

<style scoped>
.pipeline-editor {
  overflow: hidden;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.pipeline-editor__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  border-bottom: var(--border-width) solid var(--color-border);
}

.pipeline-editor__header p,
.pipeline-editor__header h3,
.pipeline-editor__header span,
.pipeline-results header p,
.pipeline-results header h4 {
  margin: 0;
}

.pipeline-editor__header p,
.pipeline-results header p {
  color: var(--color-accent-strong);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.pipeline-editor__header h3 {
  margin-top: var(--space-1);
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
}

.pipeline-editor__header span {
  display: block;
  margin-top: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-editor__actions {
  display: flex;
  gap: var(--space-2);
}

.pipeline-editor__workspace {
  display: grid;
  grid-template-columns: var(--pipeline-palette-width) minmax(0, 1fr) var(--pipeline-panel-width);
  min-height: var(--canvas-min-height);
}

.pipeline-palette,
.pipeline-config {
  overflow-y: auto;
  background: var(--color-surface-muted);
}

.pipeline-palette {
  border-right: var(--border-width) solid var(--color-border);
  padding: var(--space-4);
}

.pipeline-config {
  border-left: var(--border-width) solid var(--color-border);
  padding: var(--space-4);
}

.pipeline-palette__heading,
.pipeline-config__heading,
.pipeline-connections__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.pipeline-palette__heading span,
.pipeline-connections__heading span {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

.pipeline-palette__group {
  margin-top: var(--space-4);
}

.pipeline-palette__group > p {
  margin: 0 0 var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.pipeline-palette__group > button {
  display: block;
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  text-align: left;
}

.pipeline-palette__group > button:hover {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-sm);
}

.pipeline-palette__group button strong,
.pipeline-palette__group button span {
  display: block;
}

.pipeline-palette__group button strong {
  color: var(--color-text-strong);
  font-size: var(--font-size-sm);
}

.pipeline-palette__group button span {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-palette__empty,
.pipeline-config__empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-canvas {
  position: relative;
  min-width: 0;
  background: var(--color-canvas);
}

.pipeline-canvas__hint {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: 2;
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
  pointer-events: none;
}

.pipeline-config__heading {
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
}

.pipeline-config__heading span {
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
}

.pipeline-config__heading h4 {
  margin: var(--space-1) 0 0;
  color: var(--color-text-strong);
}

.pipeline-config__heading button,
.pipeline-connections li button {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-danger-border);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

.pipeline-connections {
  padding: var(--space-4) var(--space-6);
  border-top: var(--border-width) solid var(--color-border);
}

.pipeline-connections h4 {
  margin: 0;
  color: var(--color-text-strong);
}

.pipeline-connections__builder {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.pipeline-connections__builder label {
  display: grid;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}

.pipeline-connections__builder select {
  min-height: var(--control-height);
  max-width: var(--input-wide-min);
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.pipeline-connections__builder button {
  min-height: var(--control-height);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-surface);
  font-weight: var(--font-weight-semibold);
}

.pipeline-connections__empty {
  margin: var(--space-3) 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-connections ul {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.pipeline-connections li {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-muted);
}

.pipeline-connections i {
  color: var(--color-accent);
  font-style: normal;
}

.inline-alert,
.pipeline-feedback {
  margin: var(--space-4) var(--space-6);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid var(--color-danger-border);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.pipeline-feedback--success {
  border-color: var(--color-success);
  background: var(--color-success-soft);
  color: var(--color-success);
}

.pipeline-feedback div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
}

.pipeline-feedback ul {
  margin: var(--space-2) 0 0;
}

.pipeline-results {
  border-top: var(--border-width) solid var(--color-border);
  padding: var(--space-5) var(--space-6);
}

.pipeline-results > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
}

.pipeline-results header h4 {
  margin-top: var(--space-1);
  color: var(--color-text-strong);
  font-size: var(--font-size-lg);
}

.pipeline-results header > span {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-results__trace {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--pipeline-node-width), 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.pipeline-results__trace article {
  padding: var(--space-4);
  border: var(--border-width) solid var(--color-border);
  background: var(--color-surface-muted);
}

.pipeline-results__trace article > div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.trace-status {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.trace-status--ok {
  color: var(--color-success);
}

.trace-status--error {
  color: var(--color-danger);
}

.pipeline-results dl {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
}

.pipeline-results dl div {
  display: grid;
}

.pipeline-results dt {
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
}

.pipeline-results dd {
  margin: var(--space-1) 0 0;
  color: var(--color-text-strong);
  font-weight: var(--font-weight-semibold);
}

.pipeline-results__datasets {
  display: grid;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.pipeline-results__datasets details {
  border: var(--border-width) solid var(--color-border);
}

.pipeline-results__datasets summary {
  cursor: pointer;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-strong);
  font-weight: var(--font-weight-semibold);
}

.table-scroll {
  overflow-x: auto;
}

.pipeline-results table {
  width: 100%;
  border-collapse: collapse;
}

.pipeline-results th,
.pipeline-results td {
  padding: var(--space-2) var(--space-3);
  border-top: var(--border-width) solid var(--color-border);
  text-align: left;
}

@media (max-width: 1120px) {
  .pipeline-editor__workspace {
    grid-template-columns: var(--pipeline-palette-width) minmax(0, 1fr);
  }

  .pipeline-config {
    grid-column: 1 / -1;
    border-top: var(--border-width) solid var(--color-border);
    border-left: 0;
  }
}

@media (max-width: 720px) {
  .pipeline-editor__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .pipeline-editor__workspace {
    grid-template-columns: 1fr;
  }

  .pipeline-palette {
    max-height: var(--empty-state-min-height);
    border-right: 0;
    border-bottom: var(--border-width) solid var(--color-border);
  }

  .pipeline-canvas {
    min-height: var(--empty-state-min-height);
  }

  .pipeline-connections li {
    grid-template-columns: 1fr auto;
  }
}
</style>
