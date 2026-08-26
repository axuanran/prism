<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue';
import { ApiError, api } from '../api/client';
import type {
  Diagnostic,
  JsonSchema,
  PipelineSpec,
  PresentationSpec,
  Resource,
  ResourceStatus,
  ResourceTypeDescriptor,
} from '../api/types';
import ConfigForm from '../components/config/ConfigForm.vue';
import { createDefaultValue, validateValue } from '../components/config/schema';
import type { ReferenceLoader } from '../components/config/types';
import EngineDataBoundary from '../components/EngineDataBoundary.vue';

const resourceTypes = ref<readonly ResourceTypeDescriptor[]>([]);
const resources = ref<readonly Resource[]>([]);
const revisions = ref<readonly Resource[]>([]);
const selectedKind = ref<string | null>(null);
const selectedResource = ref<Resource | null>(null);
const loading = ref(true);
const loadingResources = ref(false);
const error = ref<string | null>(null);
const editorOpen = ref(false);
const editorName = ref('');
const editorSpec = ref<unknown>({});
const editorResource = ref<Resource | null>(null);
const editorDiagnostics = ref<readonly Diagnostic[]>([]);
const formValid = ref(true);
const saving = ref(false);
const actionError = ref<string | null>(null);
const validationMessage = ref<string | null>(null);
const statusFilter = ref<ResourceStatus | ''>('');

const selectedType = computed(() => resourceTypes.value.find((item) => item.kind === selectedKind.value));
const visibleResources = computed(() => resources.value.filter((resource) =>
  !statusFilter.value || resource.status === statusFilter.value));
const editorReadonly = computed(() => editorResource.value?.status === 'published' || editorResource.value?.status === 'archived');
const editorPresentation = computed<PresentationSpec | undefined>(() => {
  const base = selectedType.value?.presentation;
  const fields: Record<string, NonNullable<PresentationSpec['fields']>[string]> = { ...(base?.fields ?? {}) };
  for (const path of technicalIdPaths(selectedType.value?.schema)) {
    fields[path] = { ...fields[path], hidden: true };
  }
  return { ...base, fields };
});

const referenceLoader: ReferenceLoader = async () => {
  const candidates = await api.listResources({ status: 'published' });
  return candidates.map((resource) => ({ value: resource.id, label: resource.name, description: `已发布版本 ${resource.revision}` }));
};

function technicalIdPaths(schema: JsonSchema | undefined, parent = ''): readonly string[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).flatMap(([key, child]) => {
    const path = parent ? `${parent}.${key}` : key;
    const own = key === 'id' || key.endsWith('Id') ? [path] : [];
    if (child.items) return [...own, ...technicalIdPaths(child.items, `${path}[]`)];
    return [...own, ...technicalIdPaths(child, path)];
  });
}

function statusLabel(status: ResourceStatus): string {
  return { draft: '草稿', published: '已发布', archived: '已归档' }[status];
}

function statusDescription(status: ResourceStatus): string {
  return status === 'published' ? '此版本已锁定，不可修改' : status === 'draft' ? '可继续编辑和验证' : '仅供历史查询';
}

function retry(): void {
  void loadTypes();
}

async function loadTypes(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    resourceTypes.value = await api.listResourceTypes();
    if (!selectedKind.value) selectedKind.value = resourceTypes.value[0]?.kind ?? null;
    await loadResources();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '配置资源加载失败。';
  } finally {
    loading.value = false;
  }
}

async function loadResources(): Promise<void> {
  if (!selectedKind.value) {
    resources.value = [];
    return;
  }
  loadingResources.value = true;
  actionError.value = null;
  try {
    resources.value = await api.listResources({ kind: selectedKind.value });
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '资源列表加载失败。';
  } finally {
    loadingResources.value = false;
  }
}

function selectType(kind: string): void {
  selectedKind.value = kind;
  selectedResource.value = null;
  revisions.value = [];
  editorOpen.value = false;
  void loadResources();
}

function generatedBusinessKey(): string {
  return `studio-${Date.now().toString(36)}`;
}

function initializeHiddenIds(schema: JsonSchema, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => initializeHiddenIds(schema.items ?? {}, item));
  const result = { ...(value as Record<string, unknown>) };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if ((key === 'id' || key.endsWith('Id')) && !result[key]) result[key] = generatedBusinessKey();
    else if (result[key] !== undefined) result[key] = initializeHiddenIds(child, result[key]);
  }
  return result;
}

function openCreate(): void {
  const descriptor = selectedType.value;
  if (!descriptor) return;
  editorName.value = '';
  editorSpec.value = initializeHiddenIds(descriptor.schema, createDefaultValue(descriptor.schema));
  editorResource.value = null;
  editorDiagnostics.value = [];
  actionError.value = null;
  validationMessage.value = null;
  editorOpen.value = true;
}

async function openResource(resource: Resource): Promise<void> {
  selectedResource.value = resource;
  editorResource.value = resource;
  editorName.value = resource.name;
  editorSpec.value = structuredClone(toRaw(resource.spec));
  editorDiagnostics.value = [];
  actionError.value = null;
  validationMessage.value = null;
  editorOpen.value = true;
  try {
    revisions.value = await api.listResourceRevisions(resource.kind, resource.id);
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '版本记录加载失败。';
  }
}

function updateValidity(valid: boolean): void {
  formValid.value = valid;
}

function looksLikePipeline(value: unknown): value is PipelineSpec {
  return typeof value === 'object' && value !== null
    && 'inputs' in value && Array.isArray(value.inputs)
    && 'nodes' in value && Array.isArray(value.nodes)
    && 'edges' in value && Array.isArray(value.edges)
    && 'outputs' in value && Array.isArray(value.outputs)
    && 'id' in value && typeof value.id === 'string';
}

async function validateResource(): Promise<boolean> {
  const descriptor = selectedType.value;
  if (!descriptor) return false;
  const diagnostics = [...validateValue(descriptor.schema, editorSpec.value)];
  if (looksLikePipeline(editorSpec.value)) {
    try {
      const pipelineResult = await api.validatePipeline(editorSpec.value);
      diagnostics.push(...pipelineResult.diagnostics);
    } catch (cause: unknown) {
      actionError.value = cause instanceof Error ? cause.message : '流水线验证失败。';
      return false;
    }
  }
  editorDiagnostics.value = diagnostics;
  const valid = !diagnostics.some((item) => item.severity === 'error');
  formValid.value = valid;
  validationMessage.value = valid ? '验证通过，可以保存或发布。' : `发现 ${diagnostics.length} 项需要修正的内容。`;
  return valid;
}

async function saveDraft(): Promise<Resource | null> {
  const descriptor = selectedType.value;
  if (!descriptor || editorReadonly.value) return null;
  if (!editorName.value.trim()) {
    actionError.value = '请填写配置名称。';
    return null;
  }
  if (!(await validateResource()) || !formValid.value) return null;
  saving.value = true;
  actionError.value = null;
  try {
    const saved = await api.createResource(descriptor.kind, {
      ...(editorResource.value ? { id: editorResource.value.id } : {}),
      name: editorName.value.trim(),
      spec: editorSpec.value,
    });
    editorResource.value = saved;
    selectedResource.value = saved;
    await loadResources();
    revisions.value = await api.listResourceRevisions(saved.kind, saved.id);
    validationMessage.value = `草稿版本 ${saved.revision} 已保存。`;
    return saved;
  } catch (cause: unknown) {
    if (cause instanceof ApiError) editorDiagnostics.value = cause.diagnostics;
    actionError.value = cause instanceof Error ? cause.message : '草稿保存失败。';
    return null;
  } finally {
    saving.value = false;
  }
}

async function publish(): Promise<void> {
  let draft = editorResource.value?.status === 'draft' ? editorResource.value : null;
  if (!draft) draft = await saveDraft();
  if (!draft || !(await validateResource())) return;
  saving.value = true;
  actionError.value = null;
  try {
    const published = await api.publishResource(draft.kind, draft.id, draft.revision);
    editorResource.value = published;
    selectedResource.value = published;
    await loadResources();
    revisions.value = await api.listResourceRevisions(published.kind, published.id);
    validationMessage.value = `版本 ${published.revision} 已发布并锁定。`;
  } catch (cause: unknown) {
    if (cause instanceof ApiError) editorDiagnostics.value = cause.diagnostics;
    actionError.value = cause instanceof Error ? cause.message : '发布失败。';
  } finally {
    saving.value = false;
  }
}

async function clonePublished(): Promise<void> {
  const resource = editorResource.value;
  if (!resource) return;
  saving.value = true;
  actionError.value = null;
  try {
    const draft = await api.cloneResource(resource.kind, resource.id, resource.revision);
    await loadResources();
    await openResource(draft);
    validationMessage.value = `已从发布版本 ${resource.revision} 复制为草稿版本 ${draft.revision}。`;
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '复制草稿失败。';
  } finally {
    saving.value = false;
  }
}

async function archive(): Promise<void> {
  const resource = editorResource.value;
  if (!resource) return;
  saving.value = true;
  actionError.value = null;
  try {
    await api.archiveResource(resource.kind, resource.id);
    editorOpen.value = false;
    selectedResource.value = null;
    revisions.value = [];
    await loadResources();
  } catch (cause: unknown) {
    actionError.value = cause instanceof Error ? cause.message : '归档失败。';
  } finally {
    saving.value = false;
  }
}

watch(selectedKind, () => {
  statusFilter.value = '';
});

onMounted(() => void loadTypes());
</script>

<template>
  <div>
    <div class="page-intro">
      <div class="page-intro__copy">
        <p class="page-intro__label">Resources</p>
        <h2>配置资源</h2>
        <p class="page-intro__description">创建、验证和发布版本化业务配置。已发布版本保持不可变。</p>
      </div>
      <button class="button button--primary" type="button" :disabled="!selectedType" @click="openCreate">新建{{ selectedType?.title ?? '配置' }}</button>
    </div>

    <EngineDataBoundary :loading="loading" :error="error" @retry="retry">
      <div class="resources-workspace">
        <aside class="resource-type-list panel" aria-label="配置类型">
          <button
            v-for="type in resourceTypes"
            :key="type.kind"
            type="button"
            :class="{ 'resource-type-list__item--active': selectedKind === type.kind }"
            @click="selectType(type.kind)"
          >
            <strong>{{ type.title }}</strong>
            <span>{{ type.description ?? '可版本化业务配置' }}</span>
          </button>
          <p v-if="resourceTypes.length === 0">当前没有开放的业务配置。</p>
        </aside>

        <section class="resource-browser panel" aria-labelledby="resource-browser-title">
          <header class="resource-browser__header">
            <div><h3 id="resource-browser-title">{{ selectedType?.title ?? '配置' }}</h3><p>{{ loadingResources ? '正在同步…' : `共 ${visibleResources.length} 项` }}</p></div>
            <label>状态
              <select v-model="statusFilter">
                <option value="">全部</option>
                <option value="draft">草稿</option>
                <option value="published">已发布</option>
                <option value="archived">已归档</option>
              </select>
            </label>
          </header>
          <p v-if="actionError && !editorOpen" class="form-alert" role="alert">{{ actionError }}</p>
          <ul v-if="visibleResources.length > 0" class="resource-items">
            <li v-for="resource in visibleResources" :key="`${resource.id}:${resource.revision}`">
              <button type="button" @click="openResource(resource)">
                <div><strong>{{ resource.name }}</strong><span>版本 {{ resource.revision }} · 更新于 {{ new Date(resource.updatedAt).toLocaleDateString('zh-CN') }}</span></div>
                <div><span class="resource-status" :class="`resource-status--${resource.status}`">{{ statusLabel(resource.status) }}</span><small>{{ statusDescription(resource.status) }}</small></div>
              </button>
            </li>
          </ul>
          <div v-else-if="!loadingResources" class="business-empty">
            <strong>尚无{{ selectedType?.title ?? '配置' }}</strong>
            <p>创建第一份草稿，验证后即可发布使用。</p>
            <button class="button button--secondary" type="button" @click="openCreate">创建草稿</button>
          </div>
        </section>
      </div>

      <section v-if="editorOpen && selectedType" class="resource-editor panel" aria-labelledby="resource-editor-title">
        <header class="resource-editor__header">
          <div>
            <p>{{ editorResource ? `版本 ${editorResource.revision}` : '新草稿' }}</p>
            <h3 id="resource-editor-title">{{ editorResource?.name ?? `新建${selectedType.title}` }}</h3>
            <span v-if="editorReadonly" class="immutable-note">已发布或归档版本只读。如需调整，请复制为新草稿。</span>
          </div>
          <button class="icon-button" type="button" aria-label="关闭编辑器" @click="editorOpen = false">×</button>
        </header>

        <div class="resource-editor__body">
          <div class="resource-editor__form">
            <label class="name-field">配置名称
              <input v-model="editorName" type="text" :readonly="editorReadonly" placeholder="填写业务名称" />
            </label>
            <ConfigForm
              v-model="editorSpec"
              :schema="selectedType.schema"
              :presentation="editorPresentation"
              :diagnostics="editorDiagnostics"
              :disabled="editorReadonly"
              :reference-loader="referenceLoader"
              @validity="updateValidity"
            />
            <p v-if="validationMessage" class="validation-message" role="status">{{ validationMessage }}</p>
            <p v-if="actionError" class="form-alert" role="alert">{{ actionError }}</p>
          </div>

          <aside class="revision-list" aria-labelledby="revision-list-title">
            <h4 id="revision-list-title">版本记录</h4>
            <p>发布版本锁定，运行记录可始终追溯。</p>
            <ol>
              <li v-for="revision in [...revisions].sort((a, b) => b.revision - a.revision)" :key="revision.revision">
                <button type="button" @click="openResource(revision)">
                  <span>版本 {{ revision.revision }}</span>
                  <strong>{{ statusLabel(revision.status) }}</strong>
                  <small>{{ revision.status === 'published' ? '不可修改' : new Date(revision.updatedAt).toLocaleDateString('zh-CN') }}</small>
                </button>
              </li>
            </ol>
          </aside>
        </div>

        <footer class="resource-editor__actions">
          <button v-if="editorResource" class="button button--danger" type="button" :disabled="saving" @click="archive">归档</button>
          <div>
            <button v-if="editorReadonly" class="button button--secondary" type="button" :disabled="saving" @click="clonePublished">复制为草稿</button>
            <template v-else>
              <button class="button button--secondary" type="button" :disabled="saving" @click="validateResource">验证</button>
              <button class="button button--secondary" type="button" :disabled="saving" @click="saveDraft">{{ saving ? '保存中…' : '保存草稿' }}</button>
              <button class="button button--primary" type="button" :disabled="saving" @click="publish">发布</button>
            </template>
          </div>
        </footer>
      </section>
    </EngineDataBoundary>
  </div>
</template>

<style scoped>
.resources-workspace {
  display: grid;
  grid-template-columns: var(--pipeline-palette-width) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.resource-type-list {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2);
}

.resource-type-list button {
  padding: var(--space-3);
  border: var(--border-width) solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
}

.resource-type-list button:hover,
.resource-type-list__item--active {
  border-color: var(--color-border);
  background: var(--color-surface-muted) !important;
}

.resource-type-list strong,
.resource-type-list span {
  display: block;
}

.resource-type-list strong {
  color: var(--color-text-strong);
}

.resource-type-list span {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.resource-browser {
  overflow: hidden;
}

.resource-browser__header,
.resource-editor__header,
.resource-editor__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: var(--border-width) solid var(--color-border);
}

.resource-browser__header h3,
.resource-browser__header p,
.resource-editor__header h3,
.resource-editor__header p,
.resource-editor__header span {
  margin: 0;
}

.resource-browser__header h3,
.resource-editor__header h3 {
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
}

.resource-browser__header p,
.resource-editor__header p,
.resource-editor__header span {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.resource-browser__header label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.resource-browser__header select,
.name-field input {
  min-height: var(--control-height);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.resource-items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.resource-items li {
  border-bottom: var(--border-width) solid var(--color-border);
}

.resource-items li:last-child {
  border-bottom: 0;
}

.resource-items button {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 0;
  background: transparent;
  text-align: left;
}

.resource-items button:hover {
  background: var(--color-accent-soft);
}

.resource-items strong,
.resource-items span,
.resource-items small {
  display: block;
}

.resource-items strong {
  color: var(--color-text-strong);
  font-size: var(--font-size-md);
}

.resource-items div > span:not(.resource-status),
.resource-items small {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.resource-items div:last-child {
  text-align: right;
}

.resource-status {
  width: fit-content;
  margin-left: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning-strong);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.resource-status--published {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.resource-status--archived {
  background: var(--color-surface-strong);
  color: var(--color-text-muted);
}

.business-empty {
  padding: var(--space-10);
  text-align: center;
}

.business-empty strong {
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
}

.business-empty p {
  margin: var(--space-2) 0 var(--space-4);
  color: var(--color-text-muted);
}

.resource-editor {
  margin-top: var(--space-5);
  overflow: hidden;
}

.immutable-note {
  color: var(--color-warning-strong) !important;
}

.icon-button {
  width: var(--space-8);
  height: var(--space-8);
  border: 0;
  border-radius: var(--radius-round);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.resource-editor__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--pipeline-palette-width);
}

.resource-editor__form {
  display: grid;
  gap: var(--space-5);
  padding: var(--space-5);
}

.name-field {
  display: grid;
  gap: var(--space-2);
  color: var(--color-text-strong);
  font-weight: var(--font-weight-semibold);
}

.revision-list {
  padding: var(--space-5);
  border-left: var(--border-width) solid var(--color-border);
  background: var(--color-surface-muted);
}

.revision-list h4,
.revision-list p {
  margin: 0;
}

.revision-list h4 {
  color: var(--color-text-strong);
}

.revision-list > p {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.revision-list ol {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  padding: 0;
  list-style: none;
}

.revision-list button {
  width: 100%;
  padding: var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  text-align: left;
}

.revision-list span,
.revision-list strong,
.revision-list small {
  display: block;
}

.revision-list strong {
  margin-top: var(--space-1);
  color: var(--color-text-strong);
}

.revision-list small {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
}

.resource-editor__actions {
  border-top: var(--border-width) solid var(--color-border);
  border-bottom: 0;
  background: var(--color-surface-muted);
}

.resource-editor__actions > div {
  display: flex;
  gap: var(--space-2);
}

.validation-message {
  margin: 0;
  padding: var(--space-3);
  border-left: var(--border-width-strong) solid var(--color-success);
  background: var(--color-success-soft);
  color: var(--color-success);
}

.form-alert {
  margin: var(--space-3) var(--space-5);
  color: var(--color-danger);
}

@media (max-width: 900px) {
  .resources-workspace,
  .resource-editor__body {
    grid-template-columns: 1fr;
  }

  .resource-type-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .revision-list {
    border-top: var(--border-width) solid var(--color-border);
    border-left: 0;
  }
}

@media (max-width: 560px) {
  .resource-type-list {
    grid-template-columns: 1fr;
  }

  .resource-browser__header,
  .resource-items button,
  .resource-editor__header,
  .resource-editor__actions {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
