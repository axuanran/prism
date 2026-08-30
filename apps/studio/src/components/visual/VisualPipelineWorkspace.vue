<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, api, localizeDiagnostic } from "../../api/client";
import { resolveApproval } from "../../api/governance";
import type {
  CodeProjectSpec,
  Diagnostic,
  ExactProjectMaterialRef,
  ProjectBuildRequest,
  PublishedVisualPipeline,
  Resource,
  ValidationResult,
  VisualInputBinding,
  VisualMaterialCatalogItem,
  VisualPipelineDiff,
  VisualPipelineNode,
  VisualPipelineSpec,
  VisualPropertyField,
} from "../../api/types";

type CodeProject = Resource<CodeProjectSpec>;
type MutablePipeline = {
  schemaVersion: "1.0.0";
  code: string;
  name: string;
  inputs: Array<{ name: string; schema: unknown }>;
  nodes: Array<{
    nodeId: string;
    material: ExactProjectMaterialRef;
    configuration: unknown;
    inputBindings: Record<string, VisualInputBinding>;
    outputAliases?: Record<string, string>;
  }>;
  outputs: Array<{ name: string; binding: VisualInputBinding }>;
};

type Operation = "idle" | "loading" | "validating" | "saving" | "diffing" | "publishing";
type OutlineSelection = "details" | "inputs" | "outputs" | `node:${string}`;

const props = defineProps<{
  project: CodeProject;
  projects: readonly CodeProject[];
  builds: readonly ProjectBuildRequest[];
}>();

const emit = defineEmits<{
  selectProject: [project: CodeProject];
  published: [];
}>();

const successfulBuilds = computed(() =>
  props.builds.filter((item) => item.status === "SUCCESS"),
);
const selectedBuildId = ref("");
const materials = ref<readonly VisualMaterialCatalogItem[]>([]);
const pipeline = ref<MutablePipeline>(emptyPipeline(props.project));
const saved = ref<Resource<PublishedVisualPipeline> | null>(null);
const published = ref<Resource<PublishedVisualPipeline> | null>(null);
const validation = ref<ValidationResult>({ valid: false, diagnostics: [] });
const diff = ref<VisualPipelineDiff | null>(null);
const dirty = ref(false);
const operation = ref<Operation>("loading");
const selection = ref<OutlineSelection>("details");
const message = ref("");
const error = ref<ApiError | Error | null>(null);
const localDiagnostics = ref<Diagnostic[]>([]);
let loadController: AbortController | null = null;
let loadGeneration = 0;
let operationGeneration = 0;

const activeNodeId = computed(() =>
  selection.value.startsWith("node:") ? selection.value.slice("node:".length) : "",
);
const activeNode = computed(
  () => pipeline.value.nodes.find((item) => item.nodeId === activeNodeId.value) ?? null,
);
const activeMaterial = computed(() =>
  activeNode.value ? materialFor(activeNode.value) : null,
);
const allDiagnostics = computed(() => [
  ...localDiagnostics.value,
  ...validation.value.diagnostics,
]);
const canSave = computed(
  () => dirty.value && operation.value === "idle" && Boolean(selectedBuildId.value),
);
const canPublish = computed(
  () =>
    operation.value === "idle" &&
    !dirty.value &&
    saved.value?.status === "draft" &&
    validation.value.valid,
);
const documentState = computed(() => {
  if (operation.value === "saving") return "正在保存";
  if (dirty.value) return "有未保存修改";
  if (saved.value?.status === "draft") return `Draft r${saved.value.revision}`;
  if (published.value) return `Published r${published.value.revision}`;
  return "尚未保存";
});
const validationState = computed(() => {
  if (operation.value === "validating") return "验证中";
  if (validation.value.diagnostics.length === 0) return "未验证";
  return validation.value.valid
    ? "验证通过"
    : `${validation.value.diagnostics.filter((item) => item.severity === "error").length} 个错误`;
});

function emptyPipeline(project: CodeProject): MutablePipeline {
  return {
    schemaVersion: "1.0.0",
    code: `${project.spec.slug}-visual`,
    name: `${project.name} Visual Pipeline`,
    inputs: [],
    nodes: [],
    outputs: [],
  };
}

function mutablePipeline(spec: VisualPipelineSpec): MutablePipeline {
  return structuredClone(spec) as MutablePipeline;
}

function immutablePipeline(): VisualPipelineSpec {
  return structuredClone(pipeline.value) as VisualPipelineSpec;
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function setError(cause: unknown, fallback: string): void {
  if (isAbort(cause)) return;
  error.value = cause instanceof Error ? cause : new Error(fallback);
}

function markDirty(): void {
  dirty.value = true;
  diff.value = null;
  message.value = "";
}

async function load(): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const generation = ++loadGeneration;
  operation.value = "loading";
  error.value = null;
  try {
    const state = await api.getVisualPipeline(props.project.id, controller.signal);
    if (generation !== loadGeneration) return;
    saved.value = state.current;
    published.value = state.published;
    const currentBuildId = state.current?.spec.nodes[0]?.material.buildId;
    selectedBuildId.value = successfulBuilds.value.some(
      (item) => item.id === currentBuildId,
    )
      ? (currentBuildId ?? "")
      : (successfulBuilds.value[0]?.id ?? "");
    pipeline.value = state.current
      ? mutablePipeline(state.current.spec)
      : emptyPipeline(props.project);
    materials.value = selectedBuildId.value
      ? await api.listVisualMaterials(selectedBuildId.value, controller.signal)
      : [];
    if (generation !== loadGeneration) return;
    dirty.value = false;
    validation.value = { valid: false, diagnostics: [] };
    diff.value = null;
    selection.value = pipeline.value.nodes[0]
      ? `node:${pipeline.value.nodes[0].nodeId}`
      : "details";
  } catch (cause: unknown) {
    setError(cause, "Visual Pipeline加载失败。");
  } finally {
    if (generation === loadGeneration) operation.value = "idle";
  }
}

async function changeBuild(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value;
  if (next === selectedBuildId.value) return;
  if (
    dirty.value &&
    !window.confirm("切换Build会保留当前字段，但所有Material引用需要重新选择。继续？")
  ) {
    (event.target as HTMLSelectElement).value = selectedBuildId.value;
    return;
  }
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const generation = ++loadGeneration;
  operation.value = "loading";
  error.value = null;
  try {
    const catalog = await api.listVisualMaterials(next, controller.signal);
    if (generation !== loadGeneration) return;
    selectedBuildId.value = next;
    materials.value = catalog;
    validation.value = { valid: false, diagnostics: [] };
    markDirty();
  } catch (cause: unknown) {
    setError(cause, "Visual Material加载失败。");
  } finally {
    if (generation === loadGeneration) operation.value = "idle";
  }
}

function chooseProject(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  const project = props.projects.find((item) => item.id === id);
  if (!project || project.id === props.project.id) return;
  if (!confirmLeave()) {
    (event.target as HTMLSelectElement).value = props.project.id;
    return;
  }
  emit("selectProject", project);
}

function addInput(): void {
  const used = new Set(pipeline.value.inputs.map((item) => item.name));
  let index = pipeline.value.inputs.length + 1;
  while (used.has(`input${index}`)) index += 1;
  pipeline.value.inputs.push({ name: `input${index}`, schema: { type: "object" } });
  selection.value = "inputs";
  markDirty();
}

function removeInput(index: number): void {
  const input = pipeline.value.inputs[index];
  if (!input) return;
  const references = pipeline.value.nodes.flatMap((node) =>
    Object.entries(node.inputBindings)
      .filter(
        ([, binding]) => binding.kind === "PIPELINE_INPUT" && binding.input === input.name,
      )
      .map(([port]) => `${node.nodeId}.${port}`),
  );
  if (references.length > 0) {
    message.value = `无法删除：${input.name}仍被${references.join("、")}引用。`;
    return;
  }
  pipeline.value.inputs.splice(index, 1);
  markDirty();
}

function updateInputSchema(index: number, event: Event): void {
  const input = pipeline.value.inputs[index];
  if (!input) return;
  try {
    input.schema = JSON.parse((event.target as HTMLTextAreaElement).value) as unknown;
    clearLocalDiagnostic(`/inputs/${index}/schema`);
    markDirty();
  } catch {
    setLocalDiagnostic(
      `/inputs/${index}/schema`,
      "VISUAL_PIPELINE_SCHEMA_JSON_INVALID",
      "Schema不是有效JSON。",
    );
  }
}

function addNode(): void {
  const material = materials.value[0];
  if (!material) {
    message.value = "当前Build没有声明Visual Operator的Code Material。";
    return;
  }
  const used = new Set(pipeline.value.nodes.map((item) => item.nodeId));
  let index = pipeline.value.nodes.length + 1;
  while (used.has(`node${index}`)) index += 1;
  const nodeId = `node${index}`;
  pipeline.value.nodes.push({
    nodeId,
    material: structuredClone(material.exactRef),
    configuration: {},
    inputBindings: {},
    outputAliases: {},
  });
  selection.value = `node:${nodeId}`;
  markDirty();
}

function removeNode(nodeId: string): void {
  const references = pipeline.value.nodes.flatMap((node) =>
    Object.entries(node.inputBindings)
      .filter(([, binding]) => binding.kind === "NODE_OUTPUT" && binding.nodeId === nodeId)
      .map(([port]) => `${node.nodeId}.${port}`),
  );
  references.push(
    ...pipeline.value.outputs
      .filter(
        (output) =>
          output.binding.kind === "NODE_OUTPUT" && output.binding.nodeId === nodeId,
      )
      .map((output) => `output:${output.name}`),
  );
  if (references.length > 0) {
    message.value = `无法删除：${nodeId}仍被${references.join("、")}引用。`;
    return;
  }
  pipeline.value.nodes = pipeline.value.nodes.filter((item) => item.nodeId !== nodeId);
  selection.value = pipeline.value.nodes[0]
    ? `node:${pipeline.value.nodes[0].nodeId}`
    : "details";
  markDirty();
}

function renameNode(node: MutablePipeline["nodes"][number], value: string): void {
  const next = value.trim();
  if (
    !next ||
    next === node.nodeId ||
    pipeline.value.nodes.some((item) => item !== node && item.nodeId === next)
  )
    return;
  const prior = node.nodeId;
  node.nodeId = next;
  for (const candidate of pipeline.value.nodes) {
    candidate.inputBindings = Object.fromEntries(
      Object.entries(candidate.inputBindings).map(([port, binding]) => [
        port,
        binding.kind === "NODE_OUTPUT" && binding.nodeId === prior
          ? { ...binding, nodeId: next }
          : binding,
      ]),
    );
  }
  pipeline.value.outputs = pipeline.value.outputs.map((output) => ({
    ...output,
    binding:
      output.binding.kind === "NODE_OUTPUT" && output.binding.nodeId === prior
        ? { ...output.binding, nodeId: next }
        : output.binding,
  }));
  selection.value = `node:${next}`;
  markDirty();
}

function changeMaterial(node: MutablePipeline["nodes"][number], event: Event): void {
  const fingerprint = (event.target as HTMLSelectElement).value;
  const material = materials.value.find(
    (item) => item.exactRef.manifestFingerprint === fingerprint,
  );
  if (
    !material ||
    material.exactRef.manifestFingerprint === node.material.manifestFingerprint
  )
    return;
  const hasConfiguration =
    typeof node.configuration === "object" &&
    node.configuration !== null &&
    Object.keys(node.configuration as Record<string, unknown>).length > 0;
  if (
    hasConfiguration &&
    !window.confirm("切换Material不会迁移旧配置。清空当前节点配置并继续？")
  ) {
    (event.target as HTMLSelectElement).value = node.material.manifestFingerprint;
    return;
  }
  node.material = structuredClone(material.exactRef);
  node.configuration = {};
  node.inputBindings = {};
  node.outputAliases = {};
  markDirty();
}

function materialFor(node: VisualPipelineNode): VisualMaterialCatalogItem | null {
  return (
    materials.value.find(
      (item) => item.exactRef.manifestFingerprint === node.material.manifestFingerprint,
    ) ?? null
  );
}

function schemaProperties(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const properties = (value as Record<string, unknown>).properties;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

function inputPorts(node: VisualPipelineNode): readonly string[] {
  const ports = schemaProperties(materialFor(node)?.manifest.visualOperator.inputSchema);
  return ports.length > 0 ? ports : ["input"];
}

function outputPorts(node: VisualPipelineNode): readonly string[] {
  const ports = schemaProperties(materialFor(node)?.manifest.visualOperator.outputSchema);
  return ports.length > 0 ? ports : ["output"];
}

function bindingOptions(nodeId?: string): readonly { value: string; label: string }[] {
  const inputs = pipeline.value.inputs.map((input) => ({
    value: `pipeline:${input.name}`,
    label: `Pipeline / ${input.name}`,
  }));
  const nodes = pipeline.value.nodes
    .filter((node) => node.nodeId !== nodeId)
    .flatMap((node) =>
      outputPorts(node).map((output) => ({
        value: `node:${node.nodeId}:${output}`,
        label: `${node.nodeId} / ${output}`,
      })),
    );
  return [...inputs, ...nodes];
}

function bindingValue(binding: VisualInputBinding | undefined): string {
  if (!binding) return "";
  return binding.kind === "PIPELINE_INPUT"
    ? `pipeline:${binding.input}`
    : `node:${binding.nodeId}:${binding.output}`;
}

function parseBinding(value: string): VisualInputBinding | null {
  const [kind, first, ...rest] = value.split(":");
  if (kind === "pipeline" && first) return { kind: "PIPELINE_INPUT", input: first };
  if (kind === "node" && first && rest.length > 0) {
    return { kind: "NODE_OUTPUT", nodeId: first, output: rest.join(":") };
  }
  return null;
}

function updateNodeBinding(
  node: MutablePipeline["nodes"][number],
  port: string,
  event: Event,
): void {
  const binding = parseBinding((event.target as HTMLSelectElement).value);
  if (binding) node.inputBindings = { ...node.inputBindings, [port]: binding };
  else {
    const { [port]: _, ...remaining } = node.inputBindings;
    node.inputBindings = remaining;
  }
  markDirty();
}

function addOutput(): void {
  const option = bindingOptions()[0];
  if (!option) {
    message.value = "先创建Pipeline Input或Node，才能声明Output。";
    return;
  }
  const binding = parseBinding(option.value);
  if (!binding) return;
  pipeline.value.outputs.push({
    name: `output${pipeline.value.outputs.length + 1}`,
    binding,
  });
  selection.value = "outputs";
  markDirty();
}

function updateOutputBinding(
  output: MutablePipeline["outputs"][number],
  event: Event,
): void {
  const binding = parseBinding((event.target as HTMLSelectElement).value);
  if (!binding) return;
  output.binding = binding;
  markDirty();
}

function fieldValue(field: VisualPropertyField): unknown {
  let value = activeNode.value?.configuration;
  for (const segment of field.path.split("/").filter(Boolean)) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function setFieldValue(field: VisualPropertyField, value: unknown): void {
  const node = activeNode.value;
  if (!node) return;
  const segments = field.path.split("/").filter(Boolean);
  const root =
    typeof node.configuration === "object" &&
    node.configuration !== null &&
    !Array.isArray(node.configuration)
      ? (structuredClone(node.configuration) as Record<string, unknown>)
      : {};
  let target = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      target[segment] = value;
      return;
    }
    const child = target[segment];
    target[segment] =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    target = target[segment] as Record<string, unknown>;
  });
  node.configuration = root;
  clearLocalDiagnostic(
    `/nodes/${pipeline.value.nodes.indexOf(node)}/configuration${field.path}`,
  );
  markDirty();
}

function updateTextField(field: VisualPropertyField, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  setFieldValue(field, field.control === "integer" ? Number(value) : value);
}

function updateJsonField(field: VisualPropertyField, event: Event): void {
  const path = `/nodes/${pipeline.value.nodes.indexOf(activeNode.value!)}/configuration${field.path}`;
  try {
    setFieldValue(
      field,
      JSON.parse((event.target as HTMLTextAreaElement).value) as unknown,
    );
  } catch {
    setLocalDiagnostic(
      path,
      "VISUAL_PIPELINE_CONFIGURATION_JSON_INVALID",
      `${field.label}不是有效JSON。`,
    );
  }
}

function setLocalDiagnostic(path: string, code: string, messageText: string): void {
  localDiagnostics.value = [
    ...localDiagnostics.value.filter((item) => item.path !== path),
    { code, severity: "error", message: messageText, path },
  ];
}

function clearLocalDiagnostic(path: string): void {
  localDiagnostics.value = localDiagnostics.value.filter((item) => item.path !== path);
}

function diagnosticsFor(path: string): readonly Diagnostic[] {
  return allDiagnostics.value.filter(
    (item) => item.path === path || item.path?.startsWith(`${path}/`),
  );
}

async function validate(): Promise<ValidationResult | null> {
  if (
    !selectedBuildId.value ||
    localDiagnostics.value.some((item) => item.severity === "error")
  )
    return null;
  const generation = ++operationGeneration;
  operation.value = "validating";
  error.value = null;
  try {
    const result = await api.validateVisualPipeline(
      selectedBuildId.value,
      immutablePipeline(),
    );
    if (generation !== operationGeneration) return null;
    validation.value = result;
    message.value = result.valid
      ? "服务端验证通过。"
      : "验证发现错误；点击诊断可定位字段。";
    return result;
  } catch (cause: unknown) {
    setError(cause, "Visual Pipeline验证失败。");
    return null;
  } finally {
    if (generation === operationGeneration) operation.value = "idle";
  }
}

async function saveDraft(): Promise<void> {
  if (!canSave.value) return;
  const generation = ++operationGeneration;
  operation.value = "saving";
  error.value = null;
  try {
    const response = await api.saveVisualPipelineDraft(
      props.project.id,
      selectedBuildId.value,
      immutablePipeline(),
      saved.value?.updatedAt ?? null,
    );
    if (generation !== operationGeneration) return;
    saved.value = response.resource;
    pipeline.value = mutablePipeline(response.resource.spec);
    validation.value = response.validation;
    dirty.value = false;
    message.value = response.validation.valid
      ? `Draft r${response.resource.revision}已保存并验证通过。`
      : `Draft r${response.resource.revision}已保存，但仍有配置错误，不能发布。`;
    await loadDiff(false);
  } catch (cause: unknown) {
    setError(cause, "Draft保存失败；本地内容已保留。");
  } finally {
    if (generation === operationGeneration) operation.value = "idle";
  }
}

async function loadDiff(showOperation = true): Promise<void> {
  if (showOperation) operation.value = "diffing";
  error.value = null;
  try {
    diff.value = await api.diffVisualPipeline(props.project.id);
  } catch (cause: unknown) {
    setError(cause, "Diff加载失败；编辑内容已保留。");
  } finally {
    if (showOperation) operation.value = "idle";
  }
}

async function publishPipeline(): Promise<void> {
  const draft = saved.value;
  if (!canPublish.value || !draft) return;
  const changeReason = window.prompt("请输入发布Visual Pipeline的变更原因。")?.trim();
  if (!changeReason) return;
  const generation = ++operationGeneration;
  operation.value = "publishing";
  error.value = null;
  try {
    const body = {
      buildId: selectedBuildId.value,
      revision: draft.revision,
      expectedUpdatedAt: draft.updatedAt,
      expectedPipelineFingerprint: draft.spec.fingerprint,
    };
    const approval = await resolveApproval(
      {
        permission: "pipeline.publish",
        method: "POST",
        path: "/api/code-projects/:id/visual-pipeline/publish",
        params: { id: props.project.id },
        body,
        changeReason,
      },
      changeReason,
    );
    if (approval.status === "requested") {
      message.value = `审批请求已创建：${approval.approval.id}。批准后由第三位发布者重试。`;
      return;
    }
    const result = await api.publishVisualPipeline(
      props.project.id,
      selectedBuildId.value,
      draft.revision,
      draft.updatedAt,
      draft.spec.fingerprint,
      changeReason,
      approval.approvalId,
    );
    if (generation !== operationGeneration) return;
    saved.value = result.pipeline;
    published.value = result.pipeline;
    validation.value = result.validation;
    diff.value = null;
    message.value = `Published r${result.pipeline.revision}；Release r${result.release.revision}；${result.release.spec.releaseFingerprint.slice(0, 12)}…`;
    emit("published");
  } catch (cause: unknown) {
    setError(cause, "Publish失败；Draft已保留。");
  } finally {
    if (generation === operationGeneration) operation.value = "idle";
  }
}

function selectDiagnostic(item: Diagnostic): void {
  const nodeMatch = item.path?.match(/^\/nodes\/(\d+)/);
  if (nodeMatch) {
    const node = pipeline.value.nodes[Number(nodeMatch[1])];
    if (node) selection.value = `node:${node.nodeId}`;
  } else if (item.path?.startsWith("/inputs")) selection.value = "inputs";
  else if (item.path?.startsWith("/outputs")) selection.value = "outputs";
  else selection.value = "details";
}

async function copyDiagnostics(): Promise<void> {
  const apiError = error.value instanceof ApiError ? error.value : null;
  const report = {
    timestamp: new Date().toISOString(),
    projectId: props.project.id,
    buildId: selectedBuildId.value,
    draftRevision: saved.value?.revision ?? null,
    draftUpdatedAt: saved.value?.updatedAt ?? null,
    pipelineFingerprint: saved.value?.spec.fingerprint ?? null,
    operation: operation.value,
    request: apiError
      ? {
          method: apiError.method,
          path: apiError.path,
          status: apiError.status,
          correlationId: apiError.correlationId,
        }
      : null,
    diagnostics: allDiagnostics.value.map((item) => ({
      code: item.code,
      severity: item.severity,
      path: item.path,
      message: localizeDiagnostic(item),
    })),
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  message.value = "排障信息已复制；不包含Authorization、Cookie或配置值。";
}

function confirmLeave(): boolean {
  return !dirty.value || window.confirm("Visual Pipeline有未保存修改。放弃修改并继续？");
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

defineExpose({ confirmLeave });

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void load();
});

onBeforeUnmount(() => {
  loadController?.abort();
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <section class="visual-workspace">
    <header class="context-bar panel">
      <div class="context-selectors">
        <label
          >Project<select
            :value="project.id"
            :disabled="operation !== 'idle'"
            @change="chooseProject"
          >
            <option v-for="item in projects" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select></label
        >
        <label
          >Build<select
            :value="selectedBuildId"
            :disabled="operation !== 'idle'"
            @change="changeBuild"
          >
            <option value="">选择成功Build</option>
            <option v-for="build in successfulBuilds" :key="build.id" :value="build.id">
              {{ build.id }} · Source r{{ build.sourceRevision }}
            </option>
          </select></label
        >
      </div>
      <div class="state-strip">
        <span :class="{ warning: dirty }">{{ documentState }}</span
        ><span
          :class="{ danger: !validation.valid && validation.diagnostics.length > 0 }"
          >{{ validationState }}</span
        ><span v-if="published">Published r{{ published.revision }}</span>
      </div>
      <div class="toolbar">
        <button
          class="button button--secondary"
          type="button"
          :disabled="operation !== 'idle' || !selectedBuildId"
          @click="validate"
        >
          Validate</button
        ><button
          class="button button--secondary"
          type="button"
          :disabled="operation !== 'idle' || !saved"
          @click="loadDiff()"
        >
          Diff</button
        ><button
          class="button button--primary"
          type="button"
          :disabled="!canSave"
          @click="saveDraft"
        >
          保存Draft</button
        ><button
          class="button button--primary"
          type="button"
          :disabled="!canPublish"
          @click="publishPipeline"
        >
          Publish
        </button>
      </div>
    </header>

    <div v-if="successfulBuilds.length === 0" class="empty panel">
      <h2>尚无成功Build</h2>
      <p>先在Source / Build页签发布Source并完成Build。</p>
    </div>

    <div v-else class="workspace-grid">
      <aside class="outline panel">
        <header>
          <div>
            <p class="eyebrow">PIPELINE</p>
            <strong>{{ pipeline.code }}</strong>
          </div>
        </header>
        <button
          type="button"
          :class="{ active: selection === 'details' }"
          @click="selection = 'details'"
        >
          基本信息
        </button>
        <button
          type="button"
          :class="{ active: selection === 'inputs' }"
          @click="selection = 'inputs'"
        >
          Inputs <span>{{ pipeline.inputs.length }}</span>
        </button>
        <div class="outline-group">
          <div class="outline-title">
            <span>Nodes</span
            ><button type="button" :disabled="!materials.length" @click="addNode">
              ＋
            </button>
          </div>
          <button
            v-for="node in pipeline.nodes"
            :key="node.nodeId"
            type="button"
            :class="{ active: selection === `node:${node.nodeId}` }"
            @click="selection = `node:${node.nodeId}`"
          >
            <span>{{ node.nodeId }}</span
            ><small>{{
              materialFor(node)?.manifest.displayName ?? "Material需重新选择"
            }}</small>
          </button>
        </div>
        <button
          type="button"
          :class="{ active: selection === 'outputs' }"
          @click="selection = 'outputs'"
        >
          Outputs <span>{{ pipeline.outputs.length }}</span>
        </button>
      </aside>

      <section class="editor panel">
        <div v-if="operation === 'loading'" class="empty"><p>加载Visual Pipeline…</p></div>
        <form v-else-if="selection === 'details'" class="form-section" @submit.prevent>
          <header>
            <div>
              <p class="eyebrow">PIPELINE IDENTITY</p>
              <h2>基本信息</h2>
            </div>
          </header>
          <label>Code<input v-model="pipeline.code" required @input="markDirty" /></label>
          <label>名称<input v-model="pipeline.name" required @input="markDirty" /></label>
          <p class="scope-note">
            Schema Version固定为1.0.0。Build和Material使用服务端生成的精确引用。
          </p>
        </form>

        <section v-else-if="selection === 'inputs'" class="form-section">
          <header>
            <div>
              <p class="eyebrow">PIPELINE INPUTS</p>
              <h2>Inputs</h2>
            </div>
            <button class="button button--secondary" type="button" @click="addInput">
              新增Input
            </button>
          </header>
          <article v-for="(input, index) in pipeline.inputs" :key="index" class="card">
            <div class="card-heading">
              <input
                v-model="input.name"
                aria-label="Input名称"
                @input="markDirty"
              /><button type="button" class="danger-link" @click="removeInput(index)">
                删除
              </button>
            </div>
            <label
              >Schema<textarea
                :value="JSON.stringify(input.schema, null, 2)"
                @change="updateInputSchema(index, $event)"
              />
            </label>
            <p
              v-for="item in diagnosticsFor(`/inputs/${index}`)"
              :key="item.code + item.path"
              class="field-error"
            >
              {{ localizeDiagnostic(item) }}
            </p>
          </article>
          <p v-if="pipeline.inputs.length === 0" class="empty-inline">
            尚无Pipeline Input。
          </p>
        </section>

        <section v-else-if="activeNode" class="form-section">
          <header>
            <div>
              <p class="eyebrow">VISUAL NODE</p>
              <h2>{{ activeNode.nodeId }}</h2>
            </div>
            <button
              type="button"
              class="danger-link"
              @click="removeNode(activeNode.nodeId)"
            >
              删除节点
            </button>
          </header>
          <label
            >Node ID<input
              :value="activeNode.nodeId"
              @change="renameNode(activeNode, ($event.target as HTMLInputElement).value)"
          /></label>
          <label
            >Exact Code Material<select
              :value="activeNode.material.manifestFingerprint"
              @change="changeMaterial(activeNode, $event)"
            >
              <option
                v-for="item in materials"
                :key="item.exactRef.manifestFingerprint"
                :value="item.exactRef.manifestFingerprint"
              >
                {{ item.manifest.displayName }} · {{ item.manifest.version }}
              </option>
            </select></label
          >
          <details v-if="activeMaterial" class="identity">
            <summary>精确Material身份</summary>
            <dl>
              <dt>Build</dt>
              <dd>{{ activeMaterial.exactRef.buildId }}</dd>
              <dt>Artifact</dt>
              <dd>{{ activeMaterial.exactRef.artifactHash }}</dd>
              <dt>Manifest</dt>
              <dd>{{ activeMaterial.exactRef.manifestFingerprint }}</dd>
            </dl>
          </details>

          <div class="subsection">
            <h3>Configuration</h3>
            <div v-if="activeMaterial?.visualPropertyFields.length" class="field-grid">
              <label v-for="field in activeMaterial.visualPropertyFields" :key="field.path"
                ><span>{{ field.label }}<strong v-if="field.required"> *</strong></span
                ><input
                  v-if="
                    [
                      'string',
                      'decimal-string',
                      'field-reference',
                      'dataset-reference',
                      'material-reference',
                      'integer',
                    ].includes(field.control)
                  "
                  :type="field.control === 'integer' ? 'number' : 'text'"
                  :value="fieldValue(field) ?? ''"
                  @input="updateTextField(field, $event)"
                /><input
                  v-else-if="field.control === 'boolean'"
                  type="checkbox"
                  :checked="fieldValue(field) === true"
                  @change="
                    setFieldValue(field, ($event.target as HTMLInputElement).checked)
                  "
                /><select
                  v-else-if="field.control === 'enum'"
                  :value="JSON.stringify(fieldValue(field))"
                  @change="
                    setFieldValue(
                      field,
                      JSON.parse(($event.target as HTMLSelectElement).value),
                    )
                  "
                >
                  <option value="">选择</option>
                  <option
                    v-for="value in field.enumValues"
                    :key="JSON.stringify(value)"
                    :value="JSON.stringify(value)"
                  >
                    {{ String(value) }}
                  </option></select
                ><textarea
                  v-else
                  :value="
                    JSON.stringify(
                      fieldValue(field) ?? (field.control === 'array' ? [] : {}),
                      null,
                      2,
                    )
                  "
                  @change="updateJsonField(field, $event)"
                /><small
                  v-for="item in diagnosticsFor(
                    `/nodes/${pipeline.nodes.indexOf(activeNode)}/configuration${field.path}`,
                  )"
                  :key="item.code + item.path"
                  class="field-error"
                  >{{ localizeDiagnostic(item) }}</small
                ></label
              >
            </div>
            <p v-else class="empty-inline">该Material没有可视化配置字段。</p>
          </div>

          <div class="subsection">
            <h3>Input Bindings</h3>
            <label v-for="port in inputPorts(activeNode)" :key="port"
              >{{ port
              }}<select
                :value="bindingValue(activeNode.inputBindings[port])"
                @change="updateNodeBinding(activeNode, port, $event)"
              >
                <option value="">未绑定</option>
                <option
                  v-for="option in bindingOptions(activeNode.nodeId)"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select></label
            >
          </div>
          <div class="subsection">
            <h3>Output Aliases</h3>
            <label v-for="port in outputPorts(activeNode)" :key="port"
              >{{ port
              }}<input
                :value="activeNode.outputAliases?.[port] ?? ''"
                placeholder="可选别名"
                @input="
                  activeNode.outputAliases = {
                    ...activeNode.outputAliases,
                    [port]: ($event.target as HTMLInputElement).value,
                  };
                  markDirty();
                "
            /></label>
          </div>
        </section>

        <section v-else-if="selection === 'outputs'" class="form-section">
          <header>
            <div>
              <p class="eyebrow">PIPELINE OUTPUTS</p>
              <h2>Outputs</h2>
            </div>
            <button class="button button--secondary" type="button" @click="addOutput">
              新增Output
            </button>
          </header>
          <article v-for="(output, index) in pipeline.outputs" :key="index" class="card">
            <div class="card-heading">
              <input
                v-model="output.name"
                aria-label="Output名称"
                @input="markDirty"
              /><button
                type="button"
                class="danger-link"
                @click="
                  pipeline.outputs.splice(index, 1);
                  markDirty();
                "
              >
                删除
              </button>
            </div>
            <label
              >Binding<select
                :value="bindingValue(output.binding)"
                @change="updateOutputBinding(output, $event)"
              >
                <option
                  v-for="option in bindingOptions()"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select></label
            >
          </article>
          <p v-if="pipeline.outputs.length === 0" class="empty-inline">
            尚无Pipeline Output。
          </p>
        </section>
      </section>

      <aside class="diagnostics panel">
        <header>
          <div>
            <p class="eyebrow">DIAGNOSTICS</p>
            <h2>诊断与Diff</h2>
          </div>
          <button
            type="button"
            :disabled="!allDiagnostics.length && !error"
            @click="copyDiagnostics"
          >
            复制排障信息
          </button>
        </header>
        <div v-if="error" class="error-card">
          <strong>{{ error.message }}</strong
          ><template v-if="error instanceof ApiError"
            ><code>{{ error.status }} · {{ error.correlationId }}</code
            ><small>{{ error.method }} {{ error.path }}</small></template
          >
        </div>
        <button
          v-for="item in allDiagnostics"
          :key="item.code + item.path"
          type="button"
          class="diagnostic"
          @click="selectDiagnostic(item)"
        >
          <strong>{{ localizeDiagnostic(item) }}</strong
          ><code>{{ item.code }}</code
          ><small>{{ item.path ?? "全局" }}</small>
        </button>
        <p v-if="!allDiagnostics.length && !error" class="empty-inline">暂无诊断。</p>
        <section v-if="diff" class="diff">
          <h3>Saved Draft vs Published</h3>
          <p v-if="dirty" class="warning">当前有未保存修改；Diff基于上次保存的Draft。</p>
          <dl>
            <dt>Draft</dt>
            <dd>{{ diff.draftRevision ?? "无" }}</dd>
            <dt>Published</dt>
            <dd>{{ diff.publishedRevision ?? "首次发布" }}</dd>
            <dt>变更区段</dt>
            <dd>{{ diff.changedSections.join("、") || "无" }}</dd>
            <dt>新增节点</dt>
            <dd>{{ diff.addedNodes.join("、") || "无" }}</dd>
            <dt>删除节点</dt>
            <dd>{{ diff.removedNodes.join("、") || "无" }}</dd>
            <dt>修改节点</dt>
            <dd>{{ diff.changedNodes.join("、") || "无" }}</dd>
          </dl>
        </section>
      </aside>
    </div>
    <p v-if="message" class="message">{{ message }}</p>
  </section>
</template>

<style scoped>
.visual-workspace {
  display: grid;
  gap: var(--space-3);
}
.panel {
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}
.context-bar {
  display: grid;
  grid-template-columns: minmax(340px, 1fr) auto auto;
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-3);
}
.context-selectors,
.toolbar,
.state-strip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.context-selectors label {
  display: grid;
  gap: var(--space-1);
  min-width: 190px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
select,
input,
textarea {
  width: 100%;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  padding: var(--space-2);
}
textarea {
  min-height: 110px;
  font-family: ui-monospace, monospace;
  resize: vertical;
}
.state-strip {
  flex-wrap: wrap;
}
.state-strip span {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-round);
  background: var(--color-accent-soft);
  font-size: var(--font-size-xs);
}
.warning {
  color: #8a5a00;
}
.danger,
.field-error {
  color: var(--color-danger);
}
.workspace-grid {
  display: grid;
  grid-template-columns: 240px minmax(480px, 1fr) 320px;
  gap: var(--space-3);
  min-height: 680px;
}
.outline,
.diagnostics {
  padding: var(--space-3);
  overflow: auto;
}
.outline {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.outline > button,
.outline-group > button,
.diagnostic {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.outline button.active {
  background: var(--color-accent-soft);
  color: var(--color-text-strong);
}
.outline button span {
  display: flex;
  justify-content: space-between;
}
.outline button small {
  color: var(--color-text-muted);
}
.outline-title,
.card-heading,
.form-section header,
.diagnostics header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.outline-title {
  padding: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-transform: uppercase;
}
.outline-title button,
.diagnostics header button {
  border: 0;
  background: transparent;
  color: var(--color-accent);
  cursor: pointer;
}
.editor {
  overflow: auto;
}
.form-section {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  padding: var(--space-4);
}
.form-section h2,
.diagnostics h2 {
  margin: 0;
}
.form-section label,
.subsection {
  display: grid;
  gap: var(--space-1);
}
.eyebrow {
  margin: 0 0 var(--space-1);
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
}
.scope-note,
.empty-inline {
  color: var(--color-text-muted);
}
.empty {
  display: grid;
  place-items: center;
  min-height: 240px;
  padding: var(--space-5);
  text-align: center;
}
.card,
.subsection,
.identity,
.error-card,
.diff {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}
.card-heading input {
  max-width: 320px;
}
.danger-link {
  border: 0;
  background: transparent;
  color: var(--color-danger);
  cursor: pointer;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
.field-grid label {
  align-content: start;
}
.identity dl,
.diff dl {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  margin: 0;
}
.identity dd,
.diff dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, monospace;
  font-size: var(--font-size-xs);
}
.diagnostics {
  display: grid;
  align-content: start;
  gap: var(--space-2);
}
.diagnostic {
  border: var(--border-width) solid var(--color-border);
}
.diagnostic code,
.diagnostic small,
.error-card code,
.error-card small {
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.message {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
}
@media (max-width: 1280px) {
  .context-bar {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
  .workspace-grid {
    grid-template-columns: 210px 1fr;
  }
  .diagnostics {
    grid-column: 1 / -1;
  }
}
@media (max-width: 760px) {
  .workspace-grid {
    grid-template-columns: 1fr;
  }
  .context-selectors,
  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .field-grid {
    grid-template-columns: 1fr;
  }
  .outline {
    max-height: 300px;
  }
}
</style>
