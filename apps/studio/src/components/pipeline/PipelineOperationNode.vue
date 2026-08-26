<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import type { NodeProps } from '@vue-flow/core';
import type { PortDefinition } from '../../api/types';

export interface PipelineNodeData {
  readonly operationId: string;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  readonly inputs: readonly PortDefinition[];
  readonly outputs: readonly PortDefinition[];
}

const props = defineProps<NodeProps<PipelineNodeData>>();

function handlePosition(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}
</script>

<template>
  <article class="pipeline-node" :class="{ 'pipeline-node--selected': props.selected }">
    <Handle
      v-for="(port, index) in data.inputs"
      :id="port.name"
      :key="`input-${port.name}`"
      type="target"
      :position="Position.Left"
      :connectable="connectable"
      :style="{ top: handlePosition(index, data.inputs.length) }"
      :aria-label="`输入端口：${port.title ?? port.name}`"
    />
    <Handle
      v-for="(port, index) in data.outputs"
      :id="port.name"
      :key="`output-${port.name}`"
      type="source"
      :position="Position.Right"
      :connectable="connectable"
      :style="{ top: handlePosition(index, data.outputs.length) }"
      :aria-label="`输出端口：${port.title ?? port.name}`"
    />
    <p>{{ data.category }}</p>
    <h4>{{ data.title }}</h4>
    <span v-if="data.description">{{ data.description }}</span>
    <div class="pipeline-node__ports">
      <small>{{ data.inputs.length }} 输入</small>
      <small>{{ data.outputs.length }} 输出</small>
    </div>
  </article>
</template>

<style scoped>
.pipeline-node {
  width: var(--pipeline-node-width);
  padding: var(--space-3) var(--space-4);
  border: var(--border-width-strong) solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.pipeline-node--selected {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 var(--space-1) var(--color-accent-soft);
}

.pipeline-node p,
.pipeline-node h4,
.pipeline-node > span {
  margin: 0;
}

.pipeline-node p {
  color: var(--color-accent-strong);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.pipeline-node h4 {
  margin-top: var(--space-1);
  color: var(--color-text-strong);
  font-size: var(--font-size-sm);
}

.pipeline-node > span {
  display: block;
  margin-top: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.pipeline-node__ports {
  display: flex;
  justify-content: space-between;
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: var(--border-width) solid var(--color-border);
  color: var(--color-text-faint);
  font-size: var(--font-size-2xs);
}

:deep(.vue-flow__handle) {
  width: var(--space-3);
  height: var(--space-3);
  border: var(--border-width-strong) solid var(--color-surface);
  background: var(--color-accent);
}
</style>
