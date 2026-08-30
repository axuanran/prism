<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { ChangeApproval } from "../api/types";
import EngineDataBoundary from "../components/EngineDataBoundary.vue";

const approvals = ref<readonly ChangeApproval[]>([]);
const status = ref<ChangeApproval["status"] | "ALL">("PENDING");
const loading = ref(true);
const error = ref<string | null>(null);
const message = ref("");
const visible = computed(() =>
  status.value === "ALL"
    ? approvals.value
    : approvals.value.filter((approval) => approval.status === status.value),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    approvals.value = await api.listApprovals();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : "审批列表加载失败。";
  } finally {
    loading.value = false;
  }
}

async function review(
  approval: ChangeApproval,
  decision: "APPROVE" | "REJECT",
): Promise<void> {
  const label = decision === "APPROVE" ? "批准" : "拒绝";
  const reason = window.prompt(`请输入${label}原因。`)?.trim();
  if (!reason) return;
  error.value = null;
  try {
    await api.reviewApproval(approval.id, approval.version, decision, reason);
    message.value = `${approval.id} 已${label}。`;
    await load();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : `${label}失败。`;
  }
}

async function copyId(id: string): Promise<void> {
  await navigator.clipboard.writeText(id);
  message.value = "Approval ID已复制。由第三位发布者粘贴到原操作。";
}

onMounted(() => void load());
</script>

<template>
  <main class="approval-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">GOVERNANCE / CHANGE CONTROL</p>
        <h1>变更审批</h1>
        <p>请求者、复核者、发布者三方分离；只保存精确指纹。原因不得包含患者数据或凭据。</p>
      </div>
      <div class="actions">
        <select v-model="status" aria-label="审批状态">
          <option value="ALL">全部</option>
          <option value="PENDING">待复核</option>
          <option value="APPROVED">已批准</option>
          <option value="REJECTED">已拒绝</option>
          <option value="CONSUMED">已使用</option>
        </select>
        <button class="button button--secondary" type="button" @click="load">刷新</button>
      </div>
    </header>

    <EngineDataBoundary :loading="loading" :error="error" @retry="load">
      <section class="approval-list">
        <article v-for="approval in visible" :key="approval.id" class="approval-card">
          <header>
            <div>
              <span class="status" :class="`status--${approval.status.toLowerCase()}`">{{
                approval.status
              }}</span>
              <h2>{{ approval.target.permission }}</h2>
            </div>
            <button type="button" @click="copyId(approval.id)">复制ID</button>
          </header>
          <dl>
            <dt>Approval ID</dt>
            <dd>
              <code>{{ approval.id }}</code>
            </dd>
            <dt>目标</dt>
            <dd>{{ approval.target.method }} {{ approval.target.path }}</dd>
            <dt>指纹</dt>
            <dd>
              <code>{{ approval.target.fingerprint }}</code>
            </dd>
            <dt>请求者</dt>
            <dd>{{ approval.requesterId }}</dd>
            <dt>复核者</dt>
            <dd>{{ approval.reviewerId ?? "尚未复核" }}</dd>
            <dt>到期</dt>
            <dd>{{ approval.expiresAt }}</dd>
            <dt>请求原因</dt>
            <dd>{{ approval.requestReason }}</dd>
            <template v-if="approval.reviewReason">
              <dt>复核原因</dt>
              <dd>{{ approval.reviewReason }}</dd>
            </template>
            <dt>发布者</dt>
            <dd>{{ approval.publisherId ?? "尚未使用" }}</dd>
            <dt>执行结果</dt>
            <dd>{{ approval.executionOutcome ?? "—" }}</dd>
            <dt>执行关联</dt>
            <dd>
              <code>{{ approval.executionCorrelationId ?? "—" }}</code>
            </dd>
          </dl>
          <div v-if="approval.status === 'PENDING'" class="review-actions">
            <button
              class="button button--secondary"
              type="button"
              @click="review(approval, 'REJECT')"
            >
              拒绝
            </button>
            <button
              class="button button--primary"
              type="button"
              @click="review(approval, 'APPROVE')"
            >
              批准
            </button>
          </div>
        </article>
        <p v-if="visible.length === 0" class="empty">当前筛选条件下没有审批。</p>
      </section>
    </EngineDataBoundary>
    <p v-if="message" class="message">{{ message }}</p>
  </main>
</template>

<style scoped>
.approval-page {
  display: grid;
  gap: var(--space-5);
}
.status--consumed {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.page-heading,
.actions,
.approval-card header,
.review-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
h1,
h2 {
  margin: 0;
  color: var(--color-text-strong);
}
.page-heading p {
  color: var(--color-text-muted);
}
.eyebrow {
  margin: 0 0 var(--space-1);
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
}
.actions select {
  min-height: 38px;
  padding: 0 var(--space-2);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}
.approval-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--space-3);
}
.approval-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}
.approval-card header button {
  border: 0;
  background: transparent;
  color: var(--color-accent);
  cursor: pointer;
}
.status {
  display: inline-block;
  margin-bottom: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-round);
  font-size: var(--font-size-xs);
  font-weight: 700;
}
.status--pending {
  background: #fff4ce;
  color: #7a5200;
}
.status--approved {
  background: #dff6e5;
  color: #176b2c;
}
.status--rejected {
  background: #fde7e9;
  color: var(--color-danger);
}
dl {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: var(--space-1) var(--space-2);
  margin: 0;
}
dt {
  color: var(--color-text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
code {
  font-size: var(--font-size-xs);
}
.review-actions {
  justify-content: flex-end;
}
.empty {
  grid-column: 1/-1;
  padding: var(--space-5);
  text-align: center;
  color: var(--color-text-muted);
}
.message {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
}
@media (max-width: 720px) {
  .page-heading,
  .actions {
    align-items: stretch;
    flex-direction: column;
  }
  .approval-list {
    grid-template-columns: 1fr;
  }
  dl {
    grid-template-columns: 1fr;
  }
}
</style>
