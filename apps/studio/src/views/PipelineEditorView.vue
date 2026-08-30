<script setup lang="ts">
import { ref } from "vue";
import type { PipelineSpec } from "../api/types";
import PipelineEditor from "../components/pipeline/PipelineEditor.vue";

const pipeline = ref<PipelineSpec>({
  id: "studio-pipeline",
  inputs: [
    {
      name: "source",
      description: "编辑器执行时提供的空白示例数据",
      schema: { kind: "table", columns: [] },
    },
  ],
  nodes: [],
  edges: [],
  outputs: [],
});
</script>

<template>
  <div>
    <div class="page-intro">
      <div class="page-intro__copy">
        <p class="page-intro__label">Pipeline Editor</p>
        <h2>计算流水线</h2>
        <p class="page-intro__description">
          组合通用计算步骤，检查端口、配置、结果与执行跟踪。此页属于开发者工具。
        </p>
      </div>
      <span class="developer-badge">DEVELOPER</span>
    </div>
    <PipelineEditor v-model="pipeline" />
  </div>
</template>

<style scoped>
.developer-badge {
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-developer-accent);
  border-radius: var(--radius-sm);
  background: var(--color-developer-surface);
  color: var(--color-developer-accent);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}
</style>
