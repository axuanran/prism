<script setup lang="ts">
defineProps<{
  eyebrow: string;
  title: string;
  description: string;
}>();
</script>

<template>
  <section class="empty-state" aria-labelledby="empty-state-title">
    <div class="empty-state__rule" aria-hidden="true"></div>
    <p class="empty-state__eyebrow">{{ eyebrow }}</p>
    <h2 id="empty-state-title">{{ title }}</h2>
    <p class="empty-state__description">{{ description }}</p>
    <div class="empty-state__status">
      <span class="empty-state__dot" aria-hidden="true"></span>
      <span>尚未启用</span>
    </div>
  </section>
</template>

<style scoped>
.empty-state {
  min-height: var(--empty-state-min-height);
  padding: var(--space-8);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.empty-state__rule {
  width: var(--space-10);
  height: var(--border-width-strong);
  margin-bottom: var(--space-8);
  background: var(--color-accent);
}

.empty-state__eyebrow {
  margin: 0 0 var(--space-3);
  color: var(--color-accent-strong);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.empty-state h2 {
  max-width: var(--content-narrow);
  margin: 0;
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-2xl);
  line-height: var(--line-height-tight);
}

.empty-state__description {
  max-width: var(--content-narrow);
  margin: var(--space-4) 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-md);
  line-height: var(--line-height-relaxed);
}

.empty-state__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-8);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning-strong);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.empty-state__dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-round);
  background: var(--color-warning);
}

@media (max-width: 640px) {
  .empty-state {
    min-height: auto;
    padding: var(--space-6);
  }
}
</style>
