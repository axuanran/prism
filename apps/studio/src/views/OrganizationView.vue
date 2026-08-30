<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError, api } from "../api/client";
import { resolveApproval } from "../api/governance";
import type {
  Assignment,
  Diagnostic,
  OrganizationUnit,
  Person,
  PresentationSpec,
  ResourceTypeDescriptor,
} from "../api/types";
import ConfigForm from "../components/config/ConfigForm.vue";
import type { ReferenceLoader } from "../components/config/types";
import EngineDataBoundary from "../components/EngineDataBoundary.vue";
import { createDefaultValue, validateValue } from "../components/config/schema";

type OrganizationTab = "people" | "units" | "assignments";

const people = ref<readonly Person[]>([]);
const units = ref<readonly OrganizationUnit[]>([]);
const assignments = ref<readonly Assignment[]>([]);
const resourceTypes = ref<readonly ResourceTypeDescriptor[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref<OrganizationTab>("people");
const creating = ref(false);
const saving = ref(false);
const formValue = ref<unknown>({});
const formDiagnostics = ref<readonly Diagnostic[]>([]);
const actionError = ref<string | null>(null);
const actionMessage = ref<string | null>(null);

const typeKindByTab: Readonly<Record<OrganizationTab, string>> = {
  people: "organization.person",
  units: "organization.unit",
  assignments: "organization.assignment",
};
const currentType = computed(() =>
  resourceTypes.value.find((item) => item.kind === typeKindByTab[activeTab.value]),
);
const personById = computed(
  () => new Map(people.value.map((person) => [person.id, person])),
);
const unitById = computed(() => new Map(units.value.map((unit) => [unit.id, unit])));
const currentPresentation = computed<PresentationSpec | undefined>(() => {
  const base = currentType.value?.presentation;
  const fields = { ...(base?.fields ?? {}) };
  if (activeTab.value === "units") {
    fields.parentId = {
      ...fields.parentId,
      widget: "reference",
      editorOptions: { referenceKind: "units" },
    };
  }
  if (activeTab.value === "assignments") {
    fields.personId = {
      ...fields.personId,
      widget: "reference",
      editorOptions: { referenceKind: "people" },
    };
    fields.organizationUnitId = {
      ...fields.organizationUnitId,
      widget: "reference",
      editorOptions: { referenceKind: "units" },
    };
    fields.positionId = { ...fields.positionId, hidden: true };
  }
  return { ...base, fields };
});

const referenceLoader: ReferenceLoader = async (request) => {
  if (request.kind === "people") {
    return people.value.map((person) => ({
      value: person.id,
      label: `${person.displayName}（${person.employeeNumber}）`,
    }));
  }
  if (request.kind === "units") {
    return units.value.map((unit) => ({
      value: unit.id,
      label: `${unit.name}（${unit.code}）`,
    }));
  }
  return [];
};

function tabLabel(tab: OrganizationTab): string {
  return { people: "人员", units: "机构", assignments: "人员归属" }[tab];
}

function statusLabel(status: Person["status"]): string {
  return status === "active" ? "在职" : "停用";
}

function assignmentKindLabel(kind: Assignment["kind"]): string {
  return kind === "primary" ? "主要归属" : "兼任";
}

function openCreate(): void {
  const descriptor = currentType.value;
  if (!descriptor) {
    actionError.value = "当前表单配置尚未加载。";
    return;
  }
  formValue.value = createDefaultValue(descriptor.schema);
  formDiagnostics.value = [];
  actionError.value = null;
  actionMessage.value = null;
  creating.value = true;
}

function switchTab(tab: OrganizationTab): void {
  activeTab.value = tab;
  creating.value = false;
  actionError.value = null;
  actionMessage.value = null;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [types, loadedPeople, loadedUnits, loadedAssignments] = await Promise.all([
      api.listResourceTypes(),
      api.listPeople(),
      api.listUnits(),
      api.listAssignments(),
    ]);
    resourceTypes.value = types;
    people.value = loadedPeople;
    units.value = loadedUnits;
    assignments.value = loadedAssignments;
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : "组织数据加载失败。";
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  const descriptor = currentType.value;
  if (!descriptor) return;
  const diagnostics = validateValue(descriptor.schema, formValue.value);
  formDiagnostics.value = diagnostics;
  if (diagnostics.some((item) => item.severity === "error")) {
    actionError.value = "请先完成必填项。";
    return;
  }
  const value = formValue.value as Record<string, unknown>;
  const changeReason = window.prompt("请输入组织变更原因。")?.trim();
  if (!changeReason) return;
  const personBody = {
    employeeNumber: String(value.employeeNumber ?? ""),
    displayName: String(value.displayName ?? ""),
    ...(typeof value.title === "string" && value.title.trim()
      ? { title: value.title }
      : {}),
  };
  const unitBody = {
    code: String(value.code ?? ""),
    name: String(value.name ?? ""),
    from: String(value.from ?? ""),
    ...(typeof value.parentId === "string" && value.parentId
      ? { parentId: value.parentId }
      : {}),
    ...(typeof value.through === "string" && value.through
      ? { through: value.through }
      : {}),
  };
  const assignmentBody = {
    personId: String(value.personId ?? ""),
    organizationUnitId: String(value.organizationUnitId ?? ""),
    kind: value.kind === "secondary" ? ("secondary" as const) : ("primary" as const),
    from: String(value.from ?? ""),
    ...(typeof value.through === "string" && value.through
      ? { through: value.through }
      : {}),
  };
  const target =
    activeTab.value === "people"
      ? { path: "/api/organization/people", body: personBody }
      : activeTab.value === "units"
        ? { path: "/api/organization/units", body: unitBody }
        : { path: "/api/organization/assignments", body: assignmentBody };
  saving.value = true;
  actionError.value = null;
  actionMessage.value = null;
  try {
    const approval = await resolveApproval(
      {
        permission: "organization.write",
        method: "POST",
        path: target.path,
        params: {},
        body: target.body,
        changeReason,
      },
      changeReason,
    );
    if (approval.status === "requested") {
      actionMessage.value = `审批请求已创建：${approval.approval.id}。批准后由第三位操作者重试。`;
      return;
    }
    if (activeTab.value === "people") {
      await api.createPerson(personBody, changeReason, approval.approvalId);
    } else if (activeTab.value === "units") {
      await api.createUnit(unitBody, changeReason, approval.approvalId);
    } else {
      await api.createAssignment(assignmentBody, changeReason, approval.approvalId);
    }
    creating.value = false;
    await load();
  } catch (cause: unknown) {
    if (cause instanceof ApiError) formDiagnostics.value = cause.diagnostics;
    actionError.value = cause instanceof Error ? cause.message : "保存失败。";
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div>
    <div class="page-intro">
      <div class="page-intro__copy">
        <p class="page-intro__label">Organization</p>
        <h2>组织与人员</h2>
        <p class="page-intro__description">
          维护人员、机构和生效期归属。表单随引擎配置契约自动生成。
        </p>
      </div>
      <button
        class="button button--primary"
        type="button"
        :disabled="loading"
        @click="openCreate"
      >
        新建{{ tabLabel(activeTab) }}
      </button>
    </div>

    <EngineDataBoundary :loading="loading" :error="error" @retry="load">
      <div class="organization-layout">
        <section
          class="panel organization-directory"
          aria-labelledby="organization-tabs-title"
        >
          <div class="organization-tabs" role="tablist" aria-label="组织数据分类">
            <h3 id="organization-tabs-title" class="sr-only">组织数据</h3>
            <button
              v-for="tab in ['people', 'units', 'assignments'] as const"
              :key="tab"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab"
              @click="switchTab(tab)"
            >
              {{ tabLabel(tab) }}
              <span>{{
                tab === "people"
                  ? people.length
                  : tab === "units"
                    ? units.length
                    : assignments.length
              }}</span>
            </button>
          </div>

          <div class="directory-content">
            <div v-if="activeTab === 'people'" class="table-scroll">
              <table v-if="people.length > 0">
                <thead>
                  <tr>
                    <th scope="col">姓名</th>
                    <th scope="col">工号</th>
                    <th scope="col">职称</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="person in people" :key="person.id">
                    <th scope="row">{{ person.displayName }}</th>
                    <td>{{ person.employeeNumber }}</td>
                    <td>{{ person.title ?? "未填写" }}</td>
                    <td>
                      <span class="status-badge">{{ statusLabel(person.status) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="business-empty">
                <strong>尚无人员</strong>
                <p>新建第一位人员，开始维护组织关系。</p>
              </div>
            </div>

            <div v-else-if="activeTab === 'units'" class="table-scroll">
              <table v-if="units.length > 0">
                <thead>
                  <tr>
                    <th scope="col">机构名称</th>
                    <th scope="col">机构编码</th>
                    <th scope="col">上级机构</th>
                    <th scope="col">生效日期</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="unit in units" :key="unit.id">
                    <th scope="row">{{ unit.name }}</th>
                    <td>{{ unit.code }}</td>
                    <td>
                      {{
                        unit.parentId
                          ? (unitById.get(unit.parentId)?.name ?? "上级机构已停用")
                          : "顶级机构"
                      }}
                    </td>
                    <td>{{ unit.effectivePeriod.from }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="business-empty">
                <strong>尚无机构</strong>
                <p>先建立机构，再为人员设置归属。</p>
              </div>
            </div>

            <div v-else class="table-scroll">
              <table v-if="assignments.length > 0">
                <thead>
                  <tr>
                    <th scope="col">人员</th>
                    <th scope="col">所属机构</th>
                    <th scope="col">归属类型</th>
                    <th scope="col">生效期</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="assignment in assignments" :key="assignment.id">
                    <th scope="row">
                      {{ personById.get(assignment.personId)?.displayName ?? "人员已停用" }}
                    </th>
                    <td>
                      {{
                        unitById.get(assignment.organizationUnitId)?.name ?? "机构已停用"
                      }}
                    </td>
                    <td>{{ assignmentKindLabel(assignment.kind) }}</td>
                    <td>{{ assignment.effectivePeriod.from }} 起</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="business-empty">
                <strong>尚无人员归属</strong>
                <p>选择人员和机构，建立带生效日期的关系。</p>
              </div>
            </div>
          </div>
        </section>

        <aside
          v-if="creating && currentType"
          class="panel organization-form"
          aria-labelledby="organization-form-title"
        >
          <div class="panel__header">
            <div>
              <h3 id="organization-form-title">新建{{ tabLabel(activeTab) }}</h3>
              <p>填写内容将直接保存到当前业务环境。</p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="关闭表单"
              @click="creating = false"
            >
              ×
            </button>
          </div>
          <form @submit.prevent="submit">
            <ConfigForm
              v-model="formValue"
              :schema="currentType.schema"
              :presentation="currentPresentation"
              :diagnostics="formDiagnostics"
              :reference-loader="referenceLoader"
            />
            <p v-if="actionError" class="form-alert" role="alert">{{ actionError }}</p>
            <p v-if="actionMessage" class="form-message">{{ actionMessage }}</p>
            <div class="form-actions">
              <button
                class="button button--secondary"
                type="button"
                @click="creating = false"
              >
                取消
              </button>
              <button class="button button--primary" type="submit" :disabled="saving">
                {{ saving ? "保存中…" : "保存" }}
              </button>
            </div>
          </form>
        </aside>
      </div>
    </EngineDataBoundary>
  </div>
</template>

<style scoped>
.organization-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, var(--drawer-width));
  gap: var(--space-5);
  align-items: start;
}

.organization-layout:not(:has(.organization-form)) {
  grid-template-columns: 1fr;
}

.organization-directory,
.organization-form {
  overflow: hidden;
}

.organization-tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: var(--border-width) solid var(--color-border);
  background: var(--color-surface-muted);
}

.organization-tabs button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-weight: var(--font-weight-semibold);
}

.organization-tabs button[aria-selected="true"] {
  background: var(--color-surface);
  color: var(--color-accent-strong);
  box-shadow: var(--shadow-sm);
}

.organization-tabs span {
  padding: 0 var(--space-2);
  border-radius: var(--radius-round);
  background: var(--color-surface-strong);
  font-size: var(--font-size-xs);
}

.directory-content,
.organization-form form {
  padding: var(--space-5);
}

.table-scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  min-width: var(--table-min-width-small);
  border-collapse: collapse;
  text-align: left;
}

th,
td {
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width) solid var(--color-border);
}

thead th {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

tbody th {
  color: var(--color-text-strong);
}

.status-badge {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft);
  color: var(--color-success);
  font-size: var(--font-size-xs);
}

.business-empty {
  padding: var(--space-10);
  text-align: center;
}

.business-empty strong {
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
}

.business-empty p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
}

.icon-button {
  width: var(--space-8);
  height: var(--space-8);
  border: 0;
  border-radius: var(--radius-round);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: var(--border-width) solid var(--color-border);
}

.form-alert {
  margin: var(--space-4) 0 0;
  color: var(--color-danger);
}
.form-message {
  margin: var(--space-4) 0 0;
  color: var(--color-accent);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 1000px) {
  .organization-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .organization-tabs {
    overflow-x: auto;
  }

  .directory-content,
  .organization-form form {
    padding: var(--space-4);
  }
}
</style>
