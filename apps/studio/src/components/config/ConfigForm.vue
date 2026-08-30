<script setup lang="ts">
import { computed, watch } from "vue";
import type {
  Diagnostic,
  JsonSchema,
  PresentationGroup,
  PresentationSpec,
} from "../../api/types";
import { getEditor } from "../../editors/registry";
import ConfigField from "./ConfigField.vue";
import {
  fieldPresentation,
  objectFields,
  resolveSchema,
  schemaSemantic,
  schemaType,
  validateValue,
} from "./schema";
import type { ReferenceLoader } from "./types";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    schema: JsonSchema;
    presentation?: PresentationSpec;
    diagnostics?: readonly Diagnostic[];
    disabled?: boolean;
    referenceLoader?: ReferenceLoader;
  }>(),
  {
    diagnostics: () => [],
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  validity: [valid: boolean, diagnostics: readonly Diagnostic[]];
}>();

const resolvedSchema = computed(() => resolveSchema(props.schema, props.schema));
const objectValue = computed<Record<string, unknown>>(() =>
  typeof props.modelValue === "object" &&
  props.modelValue !== null &&
  !Array.isArray(props.modelValue)
    ? (props.modelValue as Record<string, unknown>)
    : {},
);
const fields = computed(() =>
  objectFields(resolvedSchema.value, props.schema, props.presentation, ""),
);
const localDiagnostics = computed(() =>
  validateValue(resolvedSchema.value, props.modelValue, props.schema),
);
const allDiagnostics = computed(() => [...props.diagnostics, ...localDiagnostics.value]);
const rootSemantic = computed(
  () => props.presentation?.editor ?? schemaSemantic(resolvedSchema.value, props.schema),
);
const rootEditor = computed(() => getEditor(rootSemantic.value));
const groups = computed(() =>
  [...(props.presentation?.groups ?? [])].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER),
  ),
);
const ungroupedFields = computed(() =>
  fields.value.filter((field) => {
    const group = fieldPresentation(props.presentation, field.key).group;
    return !group || !groups.value.some((item) => item.id === group);
  }),
);

function groupFields(group: PresentationGroup) {
  return fields.value.filter(
    (field) => fieldPresentation(props.presentation, field.key).group === group.id,
  );
}

function updateField(key: string, value: unknown): void {
  emit("update:modelValue", { ...objectValue.value, [key]: value });
}

function validate(): readonly Diagnostic[] {
  return allDiagnostics.value;
}

defineExpose({ validate });

watch(
  allDiagnostics,
  (diagnostics) => {
    emit("validity", !diagnostics.some((item) => item.severity === "error"), diagnostics);
  },
  { immediate: true },
);
</script>

<template>
  <div class="config-form">
    <component
      :is="rootEditor"
      v-if="rootEditor"
      :model-value="modelValue"
      :schema="resolvedSchema"
      :disabled="disabled"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <template v-else-if="schemaType(resolvedSchema, schema) === 'object'">
      <section v-if="ungroupedFields.length > 0" class="config-form__grid">
        <ConfigField
          v-for="field in ungroupedFields"
          :key="field.key"
          :model-value="objectValue[field.key]"
          :schema="field.schema"
          :root-schema="schema"
          :path="field.key"
          :field-key="field.key"
          :presentation="presentation"
          :field-presentation="field.presentation"
          :diagnostics="allDiagnostics"
          :required="field.required"
          :disabled="disabled"
          :reference-loader="referenceLoader"
          @update:model-value="updateField(field.key, $event)"
        />
      </section>

      <details
        v-for="group in groups"
        v-show="groupFields(group).length > 0"
        :key="group.id"
        class="config-form__group"
        :open="!group.collapsed"
      >
        <summary>
          <span>{{ group.title }}</span>
          <small v-if="group.description">{{ group.description }}</small>
        </summary>
        <div class="config-form__grid">
          <ConfigField
            v-for="field in groupFields(group)"
            :key="field.key"
            :model-value="objectValue[field.key]"
            :schema="field.schema"
            :root-schema="schema"
            :path="field.key"
            :field-key="field.key"
            :presentation="presentation"
            :field-presentation="field.presentation"
            :diagnostics="allDiagnostics"
            :required="field.required"
            :disabled="disabled"
            :reference-loader="referenceLoader"
            @update:model-value="updateField(field.key, $event)"
          />
        </div>
      </details>
    </template>

    <ConfigField
      v-else
      :model-value="modelValue"
      :schema="resolvedSchema"
      :root-schema="schema"
      path="value"
      :presentation="presentation"
      :diagnostics="allDiagnostics"
      :disabled="disabled"
      :reference-loader="referenceLoader"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped>
.config-form {
  display: grid;
  gap: var(--space-5);
}

.config-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.config-form__grid > :deep(.config-field--object),
.config-form__grid > :deep(.config-field--array) {
  grid-column: 1 / -1;
}

.config-form__group {
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}

.config-form__group summary {
  display: flex;
  cursor: pointer;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.config-form__group summary small {
  color: var(--color-text-muted);
  font-family: var(--font-body);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}

.config-form__group .config-form__grid {
  padding: 0 var(--space-5) var(--space-5);
}

@media (max-width: 640px) {
  .config-form__grid {
    grid-template-columns: 1fr;
  }

  .config-form__group summary {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
