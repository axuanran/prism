<script setup lang="ts">
import { computed } from 'vue';
import EngineDataBoundary from '../components/EngineDataBoundary.vue';
import { useEngineStore } from '../stores/engine';

const engineStore = useEngineStore();

const phaseLabel = computed(() => {
  switch (engineStore.inspection?.phase) {
    case 'running':
    case 'started':
      return '运行中';
    case 'starting':
      return '启动中';
    case 'stopping':
      return '停止中';
    case 'stopped':
      return '已停止';
    default:
      return '状态未知';
  }
});

const diagnosticSummary = computed(() => ({
  info: engineStore.inspection?.diagnostics.filter((item) => item.severity === 'info').length ?? 0,
  warning: engineStore.inspection?.diagnostics.filter((item) => item.severity === 'warning').length ?? 0,
  error: engineStore.inspection?.diagnostics.filter((item) => item.severity === 'error').length ?? 0,
}));

function retry(): void {
  void engineStore.load(true);
}
</script>

<template>
  <div>
    <div class="page-intro">
      <div class="page-intro__copy">
        <p class="page-intro__label">Dashboard</p>
        <h2>运行状态一览</h2>
        <p class="page-intro__description">集中查看引擎健康状态与当前可用范围。</p>
      </div>
      <div class="snapshot-label">当前快照</div>
    </div>

    <EngineDataBoundary :loading="engineStore.loading" :error="engineStore.error" @retry="retry">
      <template v-if="engineStore.inspection">
        <section class="overview-grid" aria-label="引擎状态摘要">
          <article class="engine-status">
            <div class="engine-status__heading">
              <p>引擎阶段</p>
              <span class="status-chip"><i aria-hidden="true"></i>{{ phaseLabel }}</span>
            </div>
            <strong class="engine-status__version">v{{ engineStore.inspection.engineVersion }}</strong>
            <p class="engine-status__caption">当前版本运行稳定，工作台已完成状态同步。</p>
            <div class="engine-status__line" aria-hidden="true"><span></span></div>
          </article>

          <div class="inventory-stats">
            <article>
              <p>已加载插件</p>
              <strong>{{ engineStore.inspection.plugins.length }}</strong>
              <span>运行组件</span>
            </article>
            <article>
              <p>可用能力</p>
              <strong>{{ engineStore.inspection.capabilities.length }}</strong>
              <span>服务能力</span>
            </article>
          </div>
        </section>

        <section class="panel diagnostics" aria-labelledby="diagnostics-title">
          <div class="panel__header">
            <div>
              <h3 id="diagnostics-title">诊断摘要</h3>
              <p>按严重程度汇总当前引擎反馈</p>
            </div>
            <span class="diagnostics__total">共 {{ engineStore.inspection.diagnostics.length }} 项</span>
          </div>
          <div class="diagnostics__rows">
            <div class="diagnostic-row diagnostic-row--error">
              <span class="diagnostic-row__mark" aria-hidden="true"></span>
              <span>错误</span>
              <strong>{{ diagnosticSummary.error }}</strong>
            </div>
            <div class="diagnostic-row diagnostic-row--warning">
              <span class="diagnostic-row__mark" aria-hidden="true"></span>
              <span>警告</span>
              <strong>{{ diagnosticSummary.warning }}</strong>
            </div>
            <div class="diagnostic-row diagnostic-row--info">
              <span class="diagnostic-row__mark" aria-hidden="true"></span>
              <span>信息</span>
              <strong>{{ diagnosticSummary.info }}</strong>
            </div>
          </div>
        </section>
      </template>
    </EngineDataBoundary>
  </div>
</template>

<style scoped>
.snapshot-label {
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(18rem, 0.8fr);
  gap: var(--space-5);
}

.engine-status {
  position: relative;
  min-height: var(--empty-state-min-height);
  padding: var(--space-8);
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: var(--color-navigation);
  color: var(--color-navigation-text);
  box-shadow: var(--shadow-md);
}

.engine-status__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.engine-status__heading p {
  margin: 0;
  color: var(--color-navigation-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-navigation-border);
  border-radius: var(--radius-round);
  color: var(--color-navigation-strong);
  font-size: var(--font-size-xs);
}

.status-chip i {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-round);
  background: var(--color-success);
}

.engine-status__version {
  display: block;
  margin-top: var(--space-12);
  color: var(--color-navigation-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-metric);
  font-weight: var(--font-weight-medium);
  letter-spacing: var(--letter-spacing-tight);
}

.engine-status__caption {
  max-width: var(--content-narrow);
  margin: var(--space-3) 0 0;
  color: var(--color-navigation-text);
  font-size: var(--font-size-md);
}

.engine-status__line {
  position: absolute;
  right: var(--space-8);
  bottom: var(--space-8);
  left: var(--space-8);
  height: var(--border-width);
  background: var(--color-navigation-border);
}

.engine-status__line span {
  display: block;
  width: 74%;
  height: var(--border-width-strong);
  background: var(--color-brand-mark);
  transform: translateY(-50%);
}

.inventory-stats {
  display: grid;
  gap: var(--space-5);
}

.inventory-stats article {
  display: grid;
  min-height: 0;
  padding: var(--space-6);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.inventory-stats p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.inventory-stats strong {
  align-self: end;
  margin-top: var(--space-5);
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-metric);
  line-height: var(--line-height-tight);
}

.inventory-stats span {
  margin-top: var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

.diagnostics {
  margin-top: var(--space-5);
}

.diagnostics__total {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.diagnostics__rows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.diagnostic-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-6);
  border-right: var(--border-width) solid var(--color-border);
  color: var(--color-text-muted);
}

.diagnostic-row:last-child {
  border-right: 0;
}

.diagnostic-row strong {
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
}

.diagnostic-row__mark {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-round);
}

.diagnostic-row--error .diagnostic-row__mark {
  background: var(--color-danger);
}

.diagnostic-row--warning .diagnostic-row__mark {
  background: var(--color-warning);
}

.diagnostic-row--info .diagnostic-row__mark {
  background: var(--color-info);
}

@media (max-width: 800px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }

  .engine-status {
    min-height: 20rem;
  }

  .inventory-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .engine-status {
    min-height: 18rem;
    padding: var(--space-6);
  }

  .engine-status__line {
    right: var(--space-6);
    bottom: var(--space-6);
    left: var(--space-6);
  }

  .inventory-stats,
  .diagnostics__rows {
    grid-template-columns: 1fr;
  }

  .diagnostic-row {
    border-right: 0;
    border-bottom: var(--border-width) solid var(--color-border);
  }

  .diagnostic-row:last-child {
    border-bottom: 0;
  }
}
</style>
