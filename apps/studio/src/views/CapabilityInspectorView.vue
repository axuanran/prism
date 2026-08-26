<script setup lang="ts">
import { computed } from 'vue';
import EngineDataBoundary from '../components/EngineDataBoundary.vue';
import { useEngineStore } from '../stores/engine';

interface DependencyItem {
  consumer: string;
  capabilityId: string;
  provider: string | null;
  optional: boolean;
}

const engineStore = useEngineStore();

const dependencies = computed<DependencyItem[]>(() =>
  (engineStore.inspection?.plugins ?? []).flatMap((plugin) =>
    plugin.requires.map((requirement) => ({
      consumer: plugin.id,
      capabilityId: requirement.capabilityId,
      provider: requirement.resolvedTo ?? null,
      optional: requirement.optional,
    })),
  ),
);

function retry(): void {
  void engineStore.load(true);
}
</script>

<template>
  <div>
    <div class="page-intro">
      <div class="page-intro__copy">
        <p class="page-intro__label">Capability Inspector</p>
        <h2>插件与能力解析</h2>
        <p class="page-intro__description">检查插件声明、能力依赖与运行时解析结果。此页面保留完整技术标识。</p>
      </div>
      <span class="developer-badge">DEVELOPER</span>
    </div>

    <EngineDataBoundary :loading="engineStore.loading" :error="engineStore.error" @retry="retry">
      <template v-if="engineStore.inspection">
        <section class="panel" aria-labelledby="plugin-table-title">
          <div class="panel__header">
            <div>
              <h3 id="plugin-table-title">插件清单</h3>
              <p>{{ engineStore.inspection.plugins.length }} plugins · {{ engineStore.inspection.capabilities.length }} capabilities</p>
            </div>
            <span class="phase-code mono">phase={{ engineStore.inspection.phase }}</span>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Plugin</th>
                  <th scope="col">Provides</th>
                  <th scope="col">Requires</th>
                  <th scope="col">Resolved to</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="plugin in engineStore.inspection.plugins" :key="plugin.id">
                  <th scope="row">
                    <code>{{ plugin.id }}</code>
                    <span>v{{ plugin.version }}</span>
                  </th>
                  <td>
                    <ul v-if="plugin.provides.length" class="code-list">
                      <li v-for="capability in plugin.provides" :key="capability"><code>{{ capability }}</code></li>
                    </ul>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <ul v-if="plugin.requires.length" class="requirement-list">
                      <li v-for="requirement in plugin.requires" :key="requirement.key">
                        <code>{{ requirement.capabilityId }}</code>
                        <span>{{ requirement.range }}</span>
                        <em v-if="requirement.optional">optional</em>
                      </li>
                    </ul>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <ul v-if="plugin.requires.length" class="resolved-list">
                      <li v-for="requirement in plugin.requires" :key="requirement.key">
                        <code v-if="requirement.resolvedTo">{{ requirement.resolvedTo }}</code>
                        <span v-else class="unresolved">unresolved</span>
                      </li>
                    </ul>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel dependency-panel" aria-labelledby="dependency-title">
          <div class="panel__header">
            <div>
              <h3 id="dependency-title">依赖关系</h3>
              <p>consumer → capability → provider</p>
            </div>
          </div>
          <ol class="dependency-list">
            <li v-for="dependency in dependencies" :key="`${dependency.consumer}:${dependency.capabilityId}`">
              <code>{{ dependency.consumer }}</code>
              <span aria-hidden="true">→</span>
              <code>{{ dependency.capabilityId }}</code>
              <span aria-hidden="true">→</span>
              <code v-if="dependency.provider">{{ dependency.provider }}</code>
              <span v-else class="unresolved">unresolved</span>
              <em v-if="dependency.optional">optional</em>
            </li>
          </ol>
        </section>
      </template>
    </EngineDataBoundary>
  </div>
</template>

<style scoped>
.developer-badge,
.phase-code {
  padding: var(--space-2) var(--space-3);
  border: var(--border-width) solid var(--color-developer-accent);
  border-radius: var(--radius-sm);
  background: var(--color-developer-surface);
  color: var(--color-developer-accent);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.phase-code {
  border-color: var(--color-border);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  letter-spacing: normal;
}

.table-scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  min-width: var(--table-min-width);
  border-collapse: collapse;
  text-align: left;
}

th,
td {
  padding: var(--space-4) var(--space-5);
  border-bottom: var(--border-width) solid var(--color-border);
  vertical-align: top;
}

thead th {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
  text-transform: uppercase;
}

tbody tr:last-child th,
tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover {
  background: var(--color-accent-soft);
}

tbody th > code {
  display: block;
  color: var(--color-text-strong);
}

tbody th > span {
  display: block;
  margin-top: var(--space-2);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-medium);
}

code {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.code-list,
.requirement-list,
.resolved-list,
.dependency-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.code-list,
.requirement-list,
.resolved-list {
  display: grid;
  gap: var(--space-3);
}

.requirement-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-1) var(--space-2);
}

.requirement-list span {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
}

.requirement-list em,
.dependency-list em {
  width: fit-content;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft);
  color: var(--color-warning-strong);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
  font-style: normal;
}

.resolved-list li {
  min-height: var(--space-8);
}

.muted {
  color: var(--color-text-faint);
}

.unresolved {
  color: var(--color-warning-strong);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.dependency-panel {
  margin-top: var(--space-5);
}

.dependency-list {
  display: grid;
}

.dependency-list li {
  display: grid;
  grid-template-columns: minmax(10rem, 1fr) auto minmax(10rem, 1fr) auto minmax(10rem, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-bottom: var(--border-width) solid var(--color-border);
}

.dependency-list li:last-child {
  border-bottom: 0;
}

.dependency-list li > span:not(.unresolved) {
  color: var(--color-text-faint);
}

@media (max-width: 720px) {
  .dependency-list li {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }

  .dependency-list li > span:not(.unresolved) {
    transform: rotate(90deg);
    transform-origin: left center;
  }
}
</style>
