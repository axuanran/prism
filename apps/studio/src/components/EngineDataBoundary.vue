<script setup lang="ts">
defineProps<{
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div v-if="loading" class="state-panel" role="status" aria-live="polite">
    <span class="loading-mark" aria-hidden="true"></span>
    <div>
      <strong>正在读取引擎状态</strong>
      <p>请稍候，工作台正在同步运行信息。</p>
    </div>
  </div>
  <div v-else-if="error" class="state-panel state-panel--error" role="alert">
    <div>
      <strong>引擎状态暂不可用</strong>
      <p>{{ error }}</p>
    </div>
    <button class="button button--secondary" type="button" @click="emit('retry')">重新加载</button>
  </div>
  <slot v-else />
</template>

<style scoped>
.state-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  min-height: var(--state-panel-min-height);
  padding: var(--space-6);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.state-panel--error {
  border-color: var(--color-danger-border);
  background: var(--color-danger-soft);
}

.state-panel strong {
  display: block;
  color: var(--color-text-strong);
  font-size: var(--font-size-md);
}

.state-panel p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
}

.loading-mark {
  width: var(--space-3);
  height: var(--space-3);
  flex: 0 0 auto;
  border-radius: var(--radius-round);
  background: var(--color-accent);
  box-shadow: 0 0 0 var(--space-2) var(--color-accent-soft);
  animation: pulse var(--duration-slow) var(--ease-out) infinite alternate;
}

@keyframes pulse {
  to {
    opacity: var(--opacity-muted);
    transform: scale(0.75);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-mark {
    animation: none;
  }
}

@media (max-width: 640px) {
  .state-panel {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
