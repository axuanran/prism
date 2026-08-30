<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, localizeDiagnostic } from "../api/client";
import type { Diagnostic, JsonSchema, PipelineSpec } from "../api/types";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    schema?: JsonSchema;
    disabled?: boolean;
    editorOptions?: Readonly<Record<string, unknown>>;
  }>(),
  {
    schema: () => ({}),
    disabled: false,
    editorOptions: () => ({}),
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  diagnostics: [diagnostics: readonly Diagnostic[]];
}>();

interface ExpressionFieldHint {
  readonly label: string;
  readonly value: string;
  readonly kind: "string" | "decimal";
}

const builtInFunctions = ["round", "abs", "min", "max", "coalesce", "if"] as const;
const VALIDATION_DELAY_MS = 420;
const validationState = ref<"idle" | "checking" | "valid" | "invalid">("idle");
const validationMessages = ref<readonly string[]>([]);
let validationTimer: ReturnType<typeof setTimeout> | undefined;
let validationSequence = 0;

const text = computed(() => {
  if (typeof props.modelValue === "string") return props.modelValue;
  if (
    typeof props.modelValue === "object" &&
    props.modelValue !== null &&
    "text" in props.modelValue
  ) {
    const value = (props.modelValue as { readonly text?: unknown }).text;
    return typeof value === "string" ? value : "";
  }
  return "";
});

const fieldHints = computed<readonly ExpressionFieldHint[]>(() => {
  const fields = props.editorOptions.fields;
  if (Array.isArray(fields)) {
    return fields
      .filter((item): item is string => typeof item === "string")
      .map((value) => ({ label: value, value, kind: "decimal" }));
  }
  return [
    { label: "工作量", value: "quantity", kind: "decimal" },
    { label: "点值", value: "pointValue", kind: "decimal" },
    { label: "系数", value: "coefficient", kind: "decimal" },
    { label: "职称", value: "title", kind: "string" },
  ];
});

function updateText(value: string): void {
  const next =
    typeof props.modelValue === "string" && props.schema.type !== "object"
      ? value
      : { text: value };
  emit("update:modelValue", next);
}

function insertHint(hint: string, callable: boolean): void {
  const addition = callable ? `${hint}()` : hint;
  updateText(text.value ? `${text.value} ${addition}` : addition);
}

function validationSpec(expression: string): PipelineSpec {
  const fields = fieldHints.value.map((field) => ({
    name: field.value,
    type: { kind: field.kind } as const,
  }));
  return {
    id: "studio-expression-validation",
    inputs: [{ name: "source", schema: { kind: "table", columns: fields } }],
    nodes: [
      { id: "source", operation: "calculation.input", config: { name: "source" } },
      {
        id: "formula",
        operation: "calculation.formula",
        config: { columns: [{ name: "结果", expression: { text: expression } }] },
      },
    ],
    edges: [{ fromNode: "source", fromPort: "out", toNode: "formula", toPort: "in" }],
    outputs: [{ name: "结果", fromNode: "formula", fromPort: "out" }],
  };
}

async function validateExpression(expression: string, sequence: number): Promise<void> {
  validationState.value = "checking";
  try {
    const result = await api.validatePipeline(validationSpec(expression));
    if (sequence !== validationSequence) return;
    const expressionDiagnostics = result.diagnostics.filter(
      (item) => item.nodeId === "formula" || item.code.startsWith("EXPRESSION_"),
    );
    validationMessages.value = expressionDiagnostics.map(localizeDiagnostic);
    validationState.value = expressionDiagnostics.some((item) => item.severity === "error")
      ? "invalid"
      : "valid";
    emit("diagnostics", expressionDiagnostics);
  } catch (cause: unknown) {
    if (sequence !== validationSequence) return;
    validationState.value = "invalid";
    validationMessages.value = [
      cause instanceof Error ? cause.message : "表达式校验暂不可用。",
    ];
  }
}

watch(
  text,
  (value) => {
    validationSequence += 1;
    if (validationTimer !== undefined) clearTimeout(validationTimer);
    if (!value.trim()) {
      validationState.value = "idle";
      validationMessages.value = [];
      emit("diagnostics", []);
      return;
    }
    const sequence = validationSequence;
    validationTimer = setTimeout(
      () => void validateExpression(value, sequence),
      VALIDATION_DELAY_MS,
    );
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (validationTimer !== undefined) clearTimeout(validationTimer);
});
</script>

<template>
  <div class="expression-editor">
    <textarea
      :value="text"
      :disabled="disabled"
      rows="5"
      spellcheck="false"
      placeholder="例如：工作量 * 点值 * 系数"
      aria-label="业务表达式"
      @input="updateText(($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <div class="expression-editor__hints" aria-label="表达式提示">
      <span>字段</span>
      <button
        v-for="field in fieldHints"
        :key="field.value"
        type="button"
        :disabled="disabled"
        @click="insertHint(field.value, false)"
      >
        {{ field.label }}
      </button>
      <span>函数</span>
      <button
        v-for="fn in builtInFunctions"
        :key="fn"
        type="button"
        :disabled="disabled"
        @click="insertHint(fn, true)"
      >
        {{ fn }}
      </button>
    </div>
    <div
      class="expression-editor__status"
      :class="`expression-editor__status--${validationState}`"
      role="status"
      aria-live="polite"
    >
      <span v-if="validationState === 'checking'">正在校验表达式…</span>
      <span v-else-if="validationState === 'valid'">表达式有效</span>
      <span v-else-if="validationState === 'invalid'">{{
        validationMessages.join("；")
      }}</span>
      <span v-else>输入后自动校验</span>
    </div>
  </div>
</template>

<style scoped>
.expression-editor {
  display: grid;
  gap: var(--space-2);
}

textarea {
  width: 100%;
  resize: vertical;
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  font-family: var(--font-mono);
  line-height: var(--line-height-relaxed);
  padding: var(--space-3);
}

textarea:focus-visible {
  border-color: var(--color-focus);
  outline: var(--focus-width) solid var(--color-accent-soft);
  outline-offset: var(--focus-offset);
}

.expression-editor__hints {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.expression-editor__hints span {
  margin-left: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
}

.expression-editor__hints span:first-child {
  margin-left: 0;
}

.expression-editor__hints button {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
}

.expression-editor__hints button:hover {
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
}

.expression-editor__status {
  min-height: var(--space-5);
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

.expression-editor__status--valid {
  color: var(--color-success);
}

.expression-editor__status--invalid {
  color: var(--color-danger);
}
</style>
