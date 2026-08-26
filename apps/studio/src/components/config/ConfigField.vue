<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { localizeDiagnostic } from '../../api/client';
import type { Diagnostic, FieldPresentation, JsonSchema, PresentationSpec } from '../../api/types';
import { getEditor } from '../../editors/registry';
import {
  createDefaultValue,
  fieldPresentation,
  normalizeFieldPath,
  objectFields,
  resolveSchema,
  schemaEnum,
  schemaSemantic,
  schemaType,
} from './schema';
import type { ReferenceLoader, ReferenceOption } from './types';

defineOptions({ name: 'ConfigField' });

const props = withDefaults(defineProps<{
  modelValue: unknown;
  schema: JsonSchema;
  rootSchema: JsonSchema;
  path: string;
  fieldKey?: string;
  presentation?: PresentationSpec;
  fieldPresentation?: FieldPresentation;
  diagnostics?: readonly Diagnostic[];
  required?: boolean;
  disabled?: boolean;
  referenceLoader?: ReferenceLoader;
}>(), {
  fieldKey: '',
  fieldPresentation: () => ({}),
  diagnostics: () => [],
  required: false,
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: unknown];
}>();

const referenceOptions = ref<readonly ReferenceOption[]>([]);
const referenceLoading = ref(false);
const referenceError = ref<string | null>(null);
const resolvedSchema = computed(() => resolveSchema(props.schema, props.rootSchema));
const effectivePresentation = computed(() => ({
  ...fieldPresentation(props.presentation, props.path),
  ...props.fieldPresentation,
}));
const type = computed(() => schemaType(resolvedSchema.value, props.rootSchema));
const choices = computed(() => schemaEnum(resolvedSchema.value));
const semantic = computed(() => effectivePresentation.value.editor
  ?? schemaSemantic(resolvedSchema.value, props.rootSchema));
const customEditor = computed(() => getEditor(semantic.value));
const widget = computed(() => {
  const schema = resolvedSchema.value;
  if (schema['x-prism-reference'] || schema.format === 'resource-reference' || (schema.$ref && !schema.$ref.startsWith('#/'))) return 'reference';
  return effectivePresentation.value.widget ?? schema.format ?? type.value;
});
const readonly = computed(() => props.disabled || effectivePresentation.value.readonly === true);
const label = computed(() => effectivePresentation.value.label ?? resolvedSchema.value.title ?? businessFieldLabel(props.fieldKey));
const help = computed(() => effectivePresentation.value.help ?? resolvedSchema.value.description);
const exactDiagnostics = computed(() => props.diagnostics.filter((item) => normalizeFieldPath(item.path ?? '') === normalizeFieldPath(props.path)));
const safePath = computed(() => props.path.replace(/[^a-zA-Z0-9_-]/g, '-'));
const helpId = computed(() => `field-${safePath.value}-help`);
const errorId = computed(() => `field-${safePath.value}-errors`);
const describedBy = computed(() => [
  ...(help.value ? [helpId.value] : []),
  ...(exactDiagnostics.value.length > 0 ? [errorId.value] : []),
].join(' ') || undefined);
const objectValue = computed<Record<string, unknown>>(() =>
  typeof props.modelValue === 'object' && props.modelValue !== null && !Array.isArray(props.modelValue)
    ? props.modelValue as Record<string, unknown>
    : {});
const arrayValue = computed<readonly unknown[]>(() => Array.isArray(props.modelValue) ? props.modelValue : []);
const childFields = computed(() => objectFields(resolvedSchema.value, props.rootSchema, props.presentation, props.path));
const referenceKind = computed(() => {
  const annotation = resolvedSchema.value['x-prism-reference'];
  if (typeof annotation === 'string') return annotation;
  if (typeof annotation === 'object' && annotation !== null && 'kind' in annotation && typeof annotation.kind === 'string') return annotation.kind;
  const configured = effectivePresentation.value.editorOptions?.referenceKind;
  if (resolvedSchema.value.$ref && !resolvedSchema.value.$ref.startsWith('#/')) return resolvedSchema.value.$ref;
  return typeof configured === 'string' ? configured : undefined;
});

function businessFieldLabel(key: string): string {
  if (/^\d+$/.test(key)) return '明细';
  const labels: Readonly<Record<string, string>> = {
    id: '业务标识',
    name: '名称',
    code: '编码',
    title: '名称',
    description: '说明',
    source: '指标来源',
    expression: '计算表达式',
    workloadCode: '工作量编码',
    unit: '计量单位',
    rounding: '舍入规则',
    scale: '小数位数',
    mode: '舍入方式',
    value: '数值',
    effectiveFrom: '生效日期',
    effectiveThrough: '失效日期',
    coefficient: '系数',
    when: '适用条件',
    outputs: '输出',
    rules: '规则',
    columns: '计算列',
    employeeNumber: '工号',
    displayName: '姓名',
    from: '生效日期',
    through: '失效日期',
    personId: '人员',
    organizationUnitId: '所属机构',
    parentId: '上级机构',
    positionId: '岗位',
    kind: '类型',
    status: '状态',
    text: '表达式',
  };
  return labels[key] ?? '配置项';
}

function choiceLabel(value: unknown): string {
  const labels: Readonly<Record<string, string>> = {
    active: '在职', inactive: '停用', primary: '主要归属', secondary: '兼任',
    workload: '工作量', expression: '表达式', manual: '手工录入',
    'half-up': '四舍五入', 'half-even': '银行家舍入', 'half-down': '五舍六入',
    up: '远离零', down: '向零', ceiling: '向上', floor: '向下',
    inner: '仅保留匹配', left: '保留左侧全部',
    keep: '保留', drop: '丢弃', error: '报错', first: '取第一条',
    true: '是', false: '否',
  };
  return labels[String(value)] ?? String(value);
}

function updateObject(key: string, value: unknown): void {
  emit('update:modelValue', { ...objectValue.value, [key]: value });
}

function updateArray(index: number, value: unknown): void {
  emit('update:modelValue', arrayValue.value.map((item, itemIndex) => itemIndex === index ? value : item));
}

function addArrayItem(): void {
  const item = createDefaultValue(resolvedSchema.value.items ?? {}, props.rootSchema);
  emit('update:modelValue', [...arrayValue.value, item]);
}

function removeArrayItem(index: number): void {
  emit('update:modelValue', arrayValue.value.filter((_, itemIndex) => itemIndex !== index));
}

function moveArrayItem(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= arrayValue.value.length) return;
  const next = [...arrayValue.value];
  const current = next[index];
  const other = next[target];
  next[index] = other;
  next[target] = current;
  emit('update:modelValue', next);
}

function updateInput(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (type.value === 'number' || type.value === 'integer') {
    emit('update:modelValue', target.value === '' ? undefined : Number(target.value));
    return;
  }
  emit('update:modelValue', target.value);
}

async function loadReferences(): Promise<void> {
  if (!props.referenceLoader || widget.value !== 'reference') return;
  referenceLoading.value = true;
  referenceError.value = null;
  try {
    referenceOptions.value = await props.referenceLoader({ path: props.path, kind: referenceKind.value });
  } catch (cause: unknown) {
    referenceError.value = cause instanceof Error ? cause.message : '候选项加载失败。';
  } finally {
    referenceLoading.value = false;
  }
}

watch([widget, referenceKind], () => void loadReferences());
onMounted(() => void loadReferences());
</script>

<template>
  <div v-if="!effectivePresentation.hidden" class="config-field" :class="[`config-field--${type}`, { 'config-field--error': exactDiagnostics.length > 0 }]">
    <template v-if="customEditor">
      <div class="config-field__heading">
        <label>{{ label }}<span v-if="required" aria-hidden="true"> *</span></label>
        <p v-if="help" :id="helpId">{{ help }}</p>
      </div>
      <component
        :is="customEditor"
        :model-value="modelValue"
        :schema="resolvedSchema"
        :disabled="readonly"
        :editor-options="effectivePresentation.editorOptions"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>

    <fieldset v-else-if="type === 'object'" class="config-section" :disabled="readonly">
      <legend>{{ label }}<span v-if="required" aria-hidden="true"> *</span></legend>
      <p v-if="help" class="config-field__help">{{ help }}</p>
      <div v-if="childFields.length > 0" class="config-section__fields">
        <ConfigField
          v-for="field in childFields"
          :key="field.key"
          :model-value="objectValue[field.key]"
          :schema="field.schema"
          :root-schema="rootSchema"
          :path="path ? `${path}.${field.key}` : field.key"
          :field-key="field.key"
          :presentation="presentation"
          :field-presentation="field.presentation"
          :diagnostics="diagnostics"
          :required="field.required"
          :disabled="readonly"
          :reference-loader="referenceLoader"
          @update:model-value="updateObject(field.key, $event)"
        />
      </div>
      <p v-else class="config-field__empty">此部分由系统自动维护。</p>
    </fieldset>

    <fieldset v-else-if="type === 'array'" class="config-array" :disabled="readonly">
      <div class="config-array__heading">
        <div>
          <legend>{{ label }}<span v-if="required" aria-hidden="true"> *</span></legend>
          <p v-if="help" class="config-field__help">{{ help }}</p>
        </div>
        <button class="button button--secondary" type="button" :disabled="readonly" @click="addArrayItem">添加</button>
      </div>
      <ol v-if="arrayValue.length > 0" class="config-array__items">
        <li v-for="(item, index) in arrayValue" :key="index">
          <div class="config-array__item-heading">
            <strong>第 {{ index + 1 }} 项</strong>
            <div>
              <button type="button" :disabled="readonly || index === 0" aria-label="上移" @click="moveArrayItem(index, -1)">↑</button>
              <button type="button" :disabled="readonly || index === arrayValue.length - 1" aria-label="下移" @click="moveArrayItem(index, 1)">↓</button>
              <button type="button" :disabled="readonly" @click="removeArrayItem(index)">移除</button>
            </div>
          </div>
          <ConfigField
            :model-value="item"
            :schema="resolvedSchema.items ?? {}"
            :root-schema="rootSchema"
            :path="`${path}.${index}`"
            :field-key="`${index + 1}`"
            :presentation="presentation"
            :diagnostics="diagnostics"
            :disabled="readonly"
            :reference-loader="referenceLoader"
            @update:model-value="updateArray(index, $event)"
          />
        </li>
      </ol>
      <p v-else class="config-field__empty">尚未添加。点击“添加”开始填写。</p>
    </fieldset>

    <template v-else>
      <div class="config-field__heading">
        <label :for="`field-${path}`">{{ label }}<span v-if="required" aria-hidden="true"> *</span></label>
        <p v-if="help" :id="helpId">{{ help }}</p>
      </div>

      <select
        v-if="widget === 'reference'"
        :id="`field-${path}`"
        :value="modelValue ?? ''"
        :disabled="readonly || referenceLoading"
        :aria-describedby="describedBy"
        @change="updateInput"
      >
        <option value="">{{ referenceLoading ? '正在加载…' : '请选择' }}</option>
        <option v-for="option in referenceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <select
        v-else-if="choices.length > 0 || widget === 'select'"
        :id="`field-${path}`"
        :value="modelValue ?? ''"
        :disabled="readonly"
        :aria-describedby="describedBy"
        @change="updateInput"
      >
        <option value="">请选择</option>
        <option v-for="choice in choices" :key="String(choice)" :value="choice as string | number">{{ choiceLabel(choice) }}</option>
      </select>
      <button
        v-else-if="type === 'boolean' || widget === 'switch'"
        :id="`field-${path}`"
        class="config-switch"
        type="button"
        role="switch"
        :aria-checked="Boolean(modelValue)"
        :disabled="readonly"
        @click="emit('update:modelValue', !modelValue)"
      >
        <span aria-hidden="true"></span>{{ modelValue ? '已开启' : '已关闭' }}
      </button>
      <textarea
        v-else-if="widget === 'textarea'"
        :id="`field-${path}`"
        :value="typeof modelValue === 'string' ? modelValue : ''"
        :disabled="readonly"
        :placeholder="effectivePresentation.placeholder"
        :aria-describedby="describedBy"
        rows="4"
        @input="updateInput"
      ></textarea>
      <input
        v-else
        :id="`field-${path}`"
        :type="widget === 'date' ? 'date' : type === 'number' || type === 'integer' ? 'number' : 'text'"
        :inputmode="resolvedSchema['x-prism-decimal'] || resolvedSchema.format === 'decimal' ? 'decimal' : undefined"
        :step="type === 'integer' ? '1' : type === 'number' ? 'any' : undefined"
        :min="resolvedSchema.minimum"
        :max="resolvedSchema.maximum"
        :value="modelValue ?? ''"
        :disabled="readonly"
        :readonly="effectivePresentation.readonly"
        :placeholder="effectivePresentation.placeholder"
        :aria-describedby="describedBy"
        @input="updateInput"
      />
      <p v-if="referenceError" class="config-field__error" role="alert">{{ referenceError }}</p>
    </template>

    <ul v-if="exactDiagnostics.length > 0" :id="errorId" class="config-field__errors" role="alert">
      <li v-for="item in exactDiagnostics" :key="`${item.code}:${item.message}`">{{ localizeDiagnostic(item) }}</li>
    </ul>
  </div>
</template>

<style scoped>
.config-field {
  min-width: 0;
}

.config-field__heading {
  margin-bottom: var(--space-2);
}

.config-field__heading label,
.config-section legend,
.config-array legend {
  color: var(--color-text-strong);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.config-field__heading label span,
.config-section legend span,
.config-array legend span {
  color: var(--color-danger);
}

.config-field__heading p,
.config-field__help {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

input,
select,
textarea {
  width: 100%;
  min-height: var(--control-height);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

textarea {
  resize: vertical;
}

input:focus-visible,
select:focus-visible,
textarea:focus-visible,
.config-switch:focus-visible {
  border-color: var(--color-focus);
  outline: var(--focus-width) solid var(--color-accent-soft);
  outline-offset: var(--focus-offset);
}

.config-field--error input,
.config-field--error select,
.config-field--error textarea {
  border-color: var(--color-danger);
}

.config-section,
.config-array {
  min-width: 0;
  margin: 0;
  padding: var(--space-4);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.config-section__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  margin-top: var(--space-4);
}

.config-section__fields > :deep(.config-field--object),
.config-section__fields > :deep(.config-field--array) {
  grid-column: 1 / -1;
}

.config-array__heading,
.config-array__item-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.config-array__items {
  display: grid;
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
  padding: 0;
  list-style: none;
}

.config-array__items > li {
  padding: var(--space-4);
  border-left: var(--border-width-strong) solid var(--color-accent);
  background: var(--color-surface-muted);
}

.config-array__item-heading {
  margin-bottom: var(--space-3);
}

.config-array__item-heading strong {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.config-array__item-heading div {
  display: flex;
  gap: var(--space-1);
}

.config-array__item-heading button {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.config-field__empty {
  margin: var(--space-3) 0 0;
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

.config-switch {
  display: inline-flex;
  min-height: var(--control-height);
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-round);
  background: var(--color-surface-muted);
}

.config-switch span {
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--radius-round);
  background: var(--color-border-strong);
}

.config-switch[aria-checked='true'] span {
  background: var(--color-accent);
}

.config-field__errors {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

.config-field__error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

@media (max-width: 640px) {
  .config-section__fields {
    grid-template-columns: 1fr;
  }
}
</style>
