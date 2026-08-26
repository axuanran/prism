<script setup lang="ts">
import { computed } from 'vue';

interface DecisionRule {
  readonly id: string;
  readonly when: { readonly text: string };
  readonly outputs: Readonly<Record<string, { readonly text: string }>>;
}

const props = withDefaults(defineProps<{
  modelValue: unknown;
  disabled?: boolean;
}>(), { disabled: false });

const emit = defineEmits<{
  'update:modelValue': [value: unknown];
}>();

const rules = computed<readonly DecisionRule[]>(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.filter(isDecisionRule);
  if (typeof props.modelValue === 'object' && props.modelValue !== null && 'rules' in props.modelValue) {
    const candidate = (props.modelValue as { readonly rules?: unknown }).rules;
    return Array.isArray(candidate) ? candidate.filter(isDecisionRule) : [];
  }
  return [];
});

const outputNames = computed<readonly string[]>(() => {
  const names = new Set(rules.value.flatMap((rule) => Object.keys(rule.outputs)));
  return names.size > 0 ? [...names] : ['结果'];
});

function isDecisionRule(value: unknown): value is DecisionRule {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return false;
  if (!('when' in value) || typeof value.when !== 'object' || value.when === null || !('text' in value.when) || typeof value.when.text !== 'string') return false;
  if (!('outputs' in value) || typeof value.outputs !== 'object' || value.outputs === null || Array.isArray(value.outputs)) return false;
  return Object.values(value.outputs).every((output) =>
    typeof output === 'object' && output !== null && 'text' in output && typeof output.text === 'string');
}

function commit(nextRules: readonly DecisionRule[]): void {
  const value = Array.isArray(props.modelValue) ? nextRules : { rules: nextRules };
  emit('update:modelValue', value);
}

function createRule(): DecisionRule {
  const outputs = Object.fromEntries(outputNames.value.map((name) => [name, { text: '' }]));
  return {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    when: { text: '' },
    outputs,
  };
}

function addRule(): void {
  commit([...rules.value, createRule()]);
}

function removeRule(index: number): void {
  commit(rules.value.filter((_, itemIndex) => itemIndex !== index));
}

function moveRule(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= rules.value.length) return;
  const next = [...rules.value];
  const current = next[index];
  const other = next[target];
  if (!current || !other) return;
  next[index] = other;
  next[target] = current;
  commit(next);
}

function updateCondition(index: number, text: string): void {
  commit(rules.value.map((rule, itemIndex) => itemIndex === index ? { ...rule, when: { text } } : rule));
}

function updateOutput(index: number, name: string, text: string): void {
  commit(rules.value.map((rule, itemIndex) => itemIndex === index
    ? { ...rule, outputs: { ...rule.outputs, [name]: { text } } }
    : rule));
}
</script>

<template>
  <div class="decision-editor">
    <div class="decision-editor__table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">顺序</th>
            <th scope="col">满足条件时</th>
            <th v-for="name in outputNames" :key="name" scope="col">{{ name }}</th>
            <th scope="col"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, index) in rules" :key="rule.id">
            <th scope="row">{{ index + 1 }}</th>
            <td>
              <input
                :value="rule.when.text"
                :disabled="disabled"
                aria-label="匹配条件"
                placeholder="例如：职称 = '主任医师'"
                @input="updateCondition(index, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td v-for="name in outputNames" :key="name">
              <input
                :value="rule.outputs[name]?.text ?? ''"
                :disabled="disabled"
                :aria-label="`${name}表达式`"
                placeholder="填写输出表达式"
                @input="updateOutput(index, name, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td>
              <div class="decision-editor__actions">
                <button type="button" :disabled="disabled || index === 0" aria-label="上移规则" @click="moveRule(index, -1)">↑</button>
                <button type="button" :disabled="disabled || index === rules.length - 1" aria-label="下移规则" @click="moveRule(index, 1)">↓</button>
                <button type="button" :disabled="disabled" aria-label="删除规则" @click="removeRule(index)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="rules.length === 0">
            <td :colspan="outputNames.length + 3" class="decision-editor__empty">尚无规则。添加后将按从上到下的顺序匹配第一条规则。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <button class="button button--secondary" type="button" :disabled="disabled" @click="addRule">添加规则</button>
  </div>
</template>

<style scoped>
.decision-editor {
  display: grid;
  gap: var(--space-3);
}

.decision-editor__table-wrap {
  overflow-x: auto;
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-md);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: var(--space-2);
  border-bottom: var(--border-width) solid var(--color-border);
  text-align: left;
}

thead th {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

tbody tr:last-child th,
tbody tr:last-child td {
  border-bottom: 0;
}

input {
  width: 100%;
  min-width: var(--input-wide-min);
  padding: var(--space-2);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-family: var(--font-mono);
}

.decision-editor__actions {
  display: flex;
  gap: var(--space-1);
}

.decision-editor__actions button {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.decision-editor__empty {
  padding: var(--space-5);
  color: var(--color-text-muted);
  text-align: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
