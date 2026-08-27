<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api/client';
import type {
  ActiveProjectRelease,
  CodeProjectSpec,
  DraftMaterialCatalogItem,
  ProjectBuildRequest,
  ProjectActionRun,
  ProjectReleaseDefinition,
  ProjectReleaseMaterialCatalogItem,
  ProjectRuntimeLog,
  ProjectSourceDiff,
  ProjectSourceDraft,
  ProjectSourceFile,
  PublishedProjectSource,
  Resource,
} from '../api/types';
import EngineDataBoundary from '../components/EngineDataBoundary.vue';
import PrismDiffEditor from '../components/code/PrismDiffEditor.vue';
import PrismMonacoEditor from '../components/code/PrismMonacoEditor.vue';

type MutableFile = { -readonly [K in keyof ProjectSourceFile]: ProjectSourceFile[K] };
type CodeProject = Resource<CodeProjectSpec>;
type SourceRevision = Resource<PublishedProjectSource>;

const projects = ref<readonly CodeProject[]>([]);
const selected = ref<CodeProject | null>(null);
const draft = ref<ProjectSourceDraft | null>(null);
const files = ref<MutableFile[]>([]);
const tabs = ref<string[]>([]);
const activePath = ref('');
const revisions = ref<readonly SourceRevision[]>([]);
const materials = ref<readonly DraftMaterialCatalogItem[]>([]);
const diff = ref<ProjectSourceDiff | null>(null);
const diffPath = ref('');
const loading = ref(true);
const saving = ref(false);
const builds = ref<readonly ProjectBuildRequest[]>([]);
const releases = ref<readonly Resource<ProjectReleaseDefinition>[]>([]);
const buildLog = ref<readonly string[]>([]);
const activeBuildId = ref('');
const activeRelease = ref<ActiveProjectRelease | null>(null);
const actionRuns = ref<readonly ProjectActionRun[]>([]);
const runtimeLogs = ref<readonly ProjectRuntimeLog[]>([]);
const actionForm = ref({ actionId: 'calculate', input: '{\"base\":1200}' });
const releaseCatalog = ref<readonly ProjectReleaseMaterialCatalogItem[]>([]);
const materialResult = ref<unknown>(null);
const saveState = ref<'idle' | 'dirty' | 'saving' | 'saved' | 'conflict'>('idle');
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const createOpen = ref(false);
const createForm = ref({ slug: '', name: '', description: '' });
const manifestError = ref<string | null>(null);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const activeFile = computed(() => files.value.find((file) => file.path === activePath.value) ?? null);
const diffOriginal = computed(() => {
  if (!diff.value || !selected.value || !diffPath.value) return '';
  if (diff.value.from === 'draft') return files.value.find((file) => file.path === diffPath.value)?.content ?? '';
  return revisions.value.find((item) => item.revision === diff.value?.from)
    ?.spec.files.find((file) => file.path === diffPath.value)?.content ?? '';
});
const diffModified = computed(() => {
  if (!diff.value || !selected.value || !diffPath.value) return '';
  if (diff.value.to === 'draft') return files.value.find((file) => file.path === diffPath.value)?.content ?? '';
  return revisions.value.find((item) => item.revision === diff.value?.to)
    ?.spec.files.find((file) => file.path === diffPath.value)?.content ?? '';
});
const diffFiles = computed(() => [
  ...(diff.value?.added ?? []),
  ...(diff.value?.removed ?? []),
  ...(diff.value?.changed ?? []),
]);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    projects.value = await api.listCodeProjects();
    const preferred = projects.value.find((item) => item.id === selected.value?.id)
      ?? projects.value[0]
      ?? null;
    if (preferred) await selectProject(preferred);
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '项目加载失败。';
  } finally {
    loading.value = false;
  }
}

async function selectProject(project: CodeProject): Promise<void> {
  selected.value = project;
  const [
    loadedDraft,
    loadedRevisions,
    loadedBuilds,
    loadedReleases,
    loadedActive,
    loadedRuns,
    loadedRuntimeLogs,
  ] = await Promise.all([
    api.getProjectSourceDraft(project.id),
    api.listProjectSourceRevisions(project.id),
    api.listProjectBuilds(project.id),
    api.listProjectReleases(project.id),
    api.getActiveProjectRelease(project.id),
    api.listProjectActionRuns(project.id),
    api.listProjectRuntimeLogs(project.id),
  ]);
  draft.value = loadedDraft;
  files.value = loadedDraft.files.map((file) => ({ ...file }));
  revisions.value = loadedRevisions;
  builds.value = loadedBuilds;
  releases.value = loadedReleases;
  activeRelease.value = loadedActive;
  actionRuns.value = loadedRuns;
  runtimeLogs.value = loadedRuntimeLogs;
  tabs.value = [];
  openFile(files.value[0]?.path ?? '');
  diff.value = null;
  await refreshMaterials();
}

async function createProject(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const created = await api.createCodeProject({
      slug: createForm.value.slug.trim(),
      name: createForm.value.name.trim(),
      ...(createForm.value.description.trim()
        ? { description: createForm.value.description.trim() }
        : {}),
    });
    projects.value = await api.listCodeProjects();
    createOpen.value = false;
    await selectProject(created.project);
    message.value = 'Code Project和Source Draft已创建。';
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '项目创建失败。';
  } finally {
    saving.value = false;
  }
}

function openFile(path: string): void {
  if (!path) return;
  if (!tabs.value.includes(path)) tabs.value.push(path);
  activePath.value = path;
}

function closeTab(path: string): void {
  const index = tabs.value.indexOf(path);
  tabs.value = tabs.value.filter((item) => item !== path);
  if (activePath.value === path) {
    activePath.value = tabs.value[Math.max(0, index - 1)] ?? tabs.value[0] ?? '';
  }
}

function updateContent(content: string): void {
  const file = activeFile.value;
  if (!file) return;
  file.content = content;
  queueSave();
  if (file.path === 'prism.materials.json') parseManifestForm();
}

function queueSave(): void {
  saveState.value = 'dirty';
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 700);
}

async function saveNow(): Promise<void> {
  if (!selected.value || !draft.value || saveState.value === 'saving') return;
  saving.value = true;
  saveState.value = 'saving';
  try {
    const saved = await api.saveProjectSourceDraft(
      selected.value.id,
      draft.value.draftVersion,
      files.value,
    );
    draft.value = saved;
    files.value = saved.files.map((file) => ({ ...file }));
    saveState.value = 'saved';
    await refreshMaterials();
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '自动保存失败。';
    saveState.value = error.value.includes('conflict') || error.value.includes('冲突')
      ? 'conflict'
      : 'dirty';
  } finally {
    saving.value = false;
  }
}

function createFile(): void {
  const path = window.prompt('项目相对路径，例如 src/shared/model.ts');
  if (!path || files.value.some((file) => file.path.toLowerCase() === path.toLowerCase())) return;
  files.value.push({ path, mediaType: mediaType(path), content: '' });
  files.value.sort((left, right) => left.path.localeCompare(right.path));
  openFile(path);
  queueSave();
}

function renameFile(file: MutableFile): void {
  const path = window.prompt('新项目相对路径', file.path);
  if (!path || path === file.path || files.value.some((item) => item.path.toLowerCase() === path.toLowerCase())) return;
  const previous = file.path;
  file.path = path;
  tabs.value = tabs.value.map((item) => item === previous ? path : item);
  if (activePath.value === previous) activePath.value = path;
  queueSave();
}

function deleteFile(file: MutableFile): void {
  if (!window.confirm(`删除 ${file.path}？`)) return;
  files.value = files.value.filter((item) => item !== file);
  closeTab(file.path);
  queueSave();
}

async function publishSource(): Promise<void> {
  if (!selected.value || !draft.value) return;
  if (saveState.value === 'dirty') await saveNow();
  if (!draft.value) return;
  saving.value = true;
  try {
    const published = await api.publishProjectSource(selected.value.id, draft.value.draftVersion);
    message.value = `ProjectSource Revision ${published.revision} 已发布；尚未构建，不可运行。`;
    await selectProject(selected.value);
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : 'Source发布失败。';
  } finally {
    saving.value = false;
  }
}

async function showDiff(from: number, to: number | 'draft'): Promise<void> {
  if (!selected.value) return;
  diff.value = await api.diffProjectSource(selected.value.id, from, to);
  diffPath.value = diffFiles.value[0] ?? '';
}

async function refreshMaterials(): Promise<void> {
  if (!selected.value) return;
  try {
    materials.value = await api.listDraftMaterials(selected.value.id);
    manifestError.value = null;
  } catch (cause: unknown) {
    materials.value = [];
    manifestError.value = cause instanceof Error ? cause.message : 'Manifest解析失败。';
  }
}

function parseManifestForm(): void {
  const source = files.value.find((file) => file.path === 'prism.materials.json');
  if (!source) return;
  try {
    JSON.parse(source.content);
    manifestError.value = null;
  } catch {
    manifestError.value = 'prism.materials.json语法错误；源码保留，表单只读。';
  }
}

function addMaterial(): void {
  const source = files.value.find((file) => file.path === 'prism.materials.json');
  if (!source) return;
  try {
    const parsed = JSON.parse(source.content) as { schemaVersion: string; materials: unknown[] };
    const entry = `src/materials/material-${parsed.materials.length + 1}.ts`;
    parsed.materials.push({
      id: `project.material-${parsed.materials.length + 1}`,
      version: '1.0.0',
      kind: 'operator',
      authoringMode: 'CODE',
      displayName: '新代码材料',
      category: '项目',
      runtimeTarget: 'pipeline',
      entry,
      exportName: 'default',
    });
    source.content = `${JSON.stringify(parsed, null, 2)}\n`;
    if (!files.value.some((file) => file.path === entry)) {
      files.value.push({ path: entry, mediaType: 'text/typescript', content: 'export default function material() {}\n' });
      files.value.sort((left, right) => left.path.localeCompare(right.path));
    }
    openFile('prism.materials.json');
    queueSave();
  } catch {
    manifestError.value = '修复prism.materials.json后才能使用表单。';
  }
}

async function buildRevision(revision: number): Promise<void> {
  if (!selected.value) return;
  saving.value = true;
  error.value = null;
  try {
    const build = await api.buildProject(selected.value.id, revision);
    builds.value = await api.listProjectBuilds(selected.value.id);
    releases.value = await api.listProjectReleases(selected.value.id);
    activeBuildId.value = build.id;
    buildLog.value = await api.getProjectBuildLog(build.id);
    message.value = build.status === 'SUCCESS'
      ? `Build ${build.id} SUCCESS；Project Release已创建。`
      : `Build ${build.id} FAILED；未创建Project Release。`;
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '构建失败。';
  } finally {
    saving.value = false;
  }
}

async function showBuildLog(buildId: string): Promise<void> {
  activeBuildId.value = buildId;
  buildLog.value = await api.getProjectBuildLog(buildId);
}

async function activateRelease(revision: number): Promise<void> {
  if (!selected.value) return;
  saving.value = true;
  try {
    activeRelease.value = await api.activateProjectRelease(
      selected.value.id,
      revision,
      activeRelease.value?.release ?? null,
    );
    message.value = `Active Release已切换为${revision}。`;
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : 'Release激活失败。';
  } finally {
    saving.value = false;
  }
}

async function invokeAction(): Promise<void> {
  if (!selected.value) return;
  try {
    const input: unknown = JSON.parse(actionForm.value.input);
    if (!activeRelease.value) return;
    const run = await api.invokeProjectAction(
      selected.value.id,
      activeRelease.value.release,
      actionForm.value.actionId,
      input,
    );
    actionRuns.value = await api.listProjectActionRuns(selected.value.id);
    runtimeLogs.value = await api.listProjectRuntimeLogs(selected.value.id);
    message.value = `Action Run ${run.id} ${run.status}。`;
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : 'Action调用失败。';
  }
}

async function showReleaseMaterials(revision: number): Promise<void> {
  if (!selected.value) return;
  releaseCatalog.value = await api.listProjectReleaseMaterials(selected.value.id, revision);
}

async function executeReleaseMaterial(item: ProjectReleaseMaterialCatalogItem): Promise<void> {
  if (!selected.value || !activeRelease.value) return;
  try {
    materialResult.value = await api.executeProjectMaterial(
      selected.value.id,
      activeRelease.value.release,
      item.manifest.id,
      item.manifest.version,
      JSON.parse(actionForm.value.input),
      {},
    );
  } catch (cause: unknown) {
    error.value = cause instanceof Error ? cause.message : 'Material执行失败。';
  }
}

function openActiveApp(): void {
  if (selected.value) window.open(`/apps/${selected.value.spec.slug}`, '_blank');
}

function mediaType(path: string): string {
  if (/\.tsx$/i.test(path)) return 'text/typescript-jsx';
  if (/\.ts$/i.test(path)) return 'text/typescript';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.css$/i.test(path)) return 'text/css';
  if (/\.md$/i.test(path)) return 'text/markdown';
  if (/\.sql$/i.test(path)) return 'application/sql';
  return 'text/plain';
}

onMounted(() => void load());
onBeforeUnmount(() => {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
});
</script>

<template>
  <main class="project-page">
    <header class="page-heading">
      <div><p class="eyebrow">PROGRAMMABLE STUDIO / SOURCE</p><h1>代码项目</h1><p>编辑Source、构建Release、激活Runtime并保留RunPin。</p></div>
      <div class="actions"><span class="save-state">{{ saveState }}</span><button class="button button--secondary" type="button" @click="createOpen = !createOpen">新建项目</button><button class="button button--primary" type="button" :disabled="!draft || saving" @click="publishSource">发布Source Revision</button></div>
    </header>

    <form v-if="createOpen" class="panel create-form" @submit.prevent="createProject"><label>Slug<input v-model="createForm.slug" required pattern="[a-z0-9-]+" /></label><label>项目名称<input v-model="createForm.name" required /></label><label>说明<input v-model="createForm.description" /></label><button class="button button--primary" type="submit" :disabled="saving">创建</button></form>

    <EngineDataBoundary :loading="loading" :error="error" @retry="load">
      <section class="ide-shell">
        <aside class="project-panel panel">
          <h2>项目</h2>
          <button v-for="project in projects" :key="project.id" class="project-item" :class="{ active: selected?.id === project.id }" type="button" @click="selectProject(project)"><strong>{{ project.spec.name }}</strong><span>{{ project.spec.slug }}</span></button>
          <hr />
          <div class="tree-heading"><h2>项目文件</h2><button type="button" title="创建文件" @click="createFile">＋</button></div>
          <div class="file-tree"><div v-for="file in files" :key="file.path" class="file-row" :class="{ active: activePath === file.path }"><button type="button" @click="openFile(file.path)">{{ file.path }}</button><span><button type="button" title="重命名" @click="renameFile(file)">✎</button><button type="button" title="删除" @click="deleteFile(file)">×</button></span></div></div>
        </aside>

        <section class="editor-panel panel">
          <div class="tabs"><button v-for="tab in tabs" :key="tab" type="button" :class="{ active: activePath === tab }" @click="openFile(tab)">{{ tab }} <span @click.stop="closeTab(tab)">×</span></button></div>
          <PrismMonacoEditor v-if="activeFile" :model-value="activeFile.content" :path="activeFile.path" :project-id="selected?.id ?? 'none'" @update:model-value="updateContent" />
          <div v-else class="empty-editor">选择文件开始编辑。</div>
        </section>

        <aside class="material-panel panel">
          <div class="tree-heading"><h2>Draft Materials</h2><button type="button" :disabled="!!manifestError" @click="addMaterial">＋</button></div>
          <p class="scope-note">仅当前项目预览可见；未进入Installed Registry。</p>
          <p v-if="manifestError" class="error-text">{{ manifestError }}</p>
          <article v-for="item in materials" :key="`${item.manifest.id}@${item.manifest.version}`" class="material-card"><strong>{{ item.manifest.displayName }}</strong><span>{{ item.manifest.id }}@{{ item.manifest.version }}</span><small>{{ item.status }} / {{ item.buildStatus }}</small><button type="button" @click="openFile('prism.materials.json')">编辑Manifest</button></article>
          <hr />
          <h2>Source Revisions</h2>
          <article v-for="revision in revisions" :key="revision.revision" class="revision-card"><strong>Revision {{ revision.revision }}</strong><code>{{ revision.spec.fingerprint.slice(0, 12) }}</code><button type="button" @click="showDiff(revision.revision, 'draft')">与Draft比较</button><button type="button" :disabled="saving" @click="buildRevision(revision.revision)">构建Release</button></article>
        </aside>
      </section>

      <section v-if="diff" class="panel diff-section"><header><div><p class="eyebrow">SOURCE DIFF</p><h2>{{ diff.from }} → {{ diff.to }}</h2></div><p>新增 {{ diff.added.length }} · 删除 {{ diff.removed.length }} · 修改 {{ diff.changed.length }}</p></header><div class="diff-files"><button v-for="path in diffFiles" :key="path" type="button" :class="{ active: diffPath === path }" @click="diffPath = path">{{ path }}</button></div><PrismDiffEditor v-if="diffPath" :path="diffPath" :original="diffOriginal" :modified="diffModified" /></section>

      <section class="panel build-section">
        <div><p class="eyebrow">BUILD WORKER</p><h2>构建与Release</h2></div>
        <div class="build-grid">
          <div><h3>Build Requests</h3><button v-for="build in builds" :key="build.id" type="button" class="build-row" :class="{ active: activeBuildId === build.id }" @click="showBuildLog(build.id)"><span>{{ build.status }} · Source r{{ build.sourceRevision }}</span><code>{{ build.id.slice(0, 12) }}</code></button></div>
          <div>
            <h3>Project Releases</h3>
            <article v-for="release in releases" :key="release.revision" class="release-row">
              <strong>Release {{ release.revision }} <span v-if="activeRelease?.release.revision === release.revision">ACTIVE</span></strong>
              <span>Source r{{ release.spec.sourceRevision }}</span>
              <code>{{ release.spec.buildManifestArtifact.hash.slice(0, 12) }}</code>
              <small>{{ release.spec.testResult.passed ? 'TEST PASS' : 'TEST FAIL' }} · BUILD {{ release.spec.buildReproducibility }} · RUNTIME {{ release.spec.runtimeReproducibility }}</small>
              <button type="button" :disabled="saving || activeRelease?.release.revision === release.revision" @click="activateRelease(release.revision)">{{ activeRelease ? '切换/回滚到此版本' : '激活' }}</button>
              <button type="button" @click="showReleaseMaterials(release.revision)">查看Release材料</button>
            </article>
          </div>
          <pre class="build-log">{{ buildLog.join('\n') || '选择Build查看日志。' }}</pre>
        </div>
      </section>

      <section class="panel runtime-section">
        <header><div><p class="eyebrow">APP RUNTIME</p><h2>Active Release与Action Runs</h2></div><div class="actions"><span>Active: {{ activeRelease?.release.revision ?? 'NONE' }}</span><button class="button button--secondary" type="button" :disabled="!activeRelease" @click="openActiveApp">打开正式应用</button></div></header>
        <div class="runtime-grid">
          <form @submit.prevent="invokeAction"><label>Action ID<input v-model="actionForm.actionId" /></label><label>JSON Input<textarea v-model="actionForm.input"></textarea></label><button class="button button--primary" type="submit" :disabled="!activeRelease">调用Action</button></form>
          <div><h3>Runs</h3><article v-for="run in actionRuns" :key="run.id" class="run-row"><strong>{{ run.status }} · {{ run.actionId }}</strong><span>Release {{ run.release.revision }}</span><code>{{ run.id.slice(0, 12) }}</code><small>{{ run.reproducibility }}</small></article></div>
          <div><h3>Runtime Logs</h3><pre class="runtime-log">{{ runtimeLogs.map(log => `[${log.level}] r${log.release.revision} ${log.message}`).join('\n') || '暂无日志。' }}</pre></div>
          <div><h3>Release Material Catalog</h3><article v-for="item in releaseCatalog" :key="`${item.manifest.id}@${item.manifest.version}`" class="run-row"><strong>{{ item.manifest.displayName }}</strong><span>{{ item.manifest.id }}@{{ item.manifest.version }}</span><code>{{ item.artifact.hash.slice(0, 12) }}</code><small>{{ item.status }}</small><button type="button" :disabled="!activeRelease" @click="executeReleaseMaterial(item)">用JSON Input执行</button></article><pre class="runtime-log">{{ materialResult === null ? '暂无Material结果。' : JSON.stringify(materialResult, null, 2) }}</pre></div>
        </div>
      </section>
      <p v-if="message" class="message">{{ message }}</p>
    </EngineDataBoundary>
  </main>
</template>

<style scoped>
.project-page { display: grid; gap: var(--space-5); }.page-heading,.actions,.tree-heading,.diff-section header { display:flex;align-items:center;justify-content:space-between;gap:var(--space-3); }h1,h2 { margin:0;color:var(--color-text-strong); }.page-heading p,.scope-note { color:var(--color-text-muted); }.eyebrow { margin:0 0 var(--space-1);color:var(--color-accent);font-size:var(--font-size-xs);font-weight:700;letter-spacing:.08em; }.save-state { padding:var(--space-1) var(--space-2);border-radius:var(--radius-round);background:var(--color-accent-soft);font-family:ui-monospace,monospace;font-size:var(--font-size-xs); }.panel { border:var(--border-width) solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-sm); }.create-form { display:flex;align-items:end;gap:var(--space-3);padding:var(--space-4); }.create-form label { display:grid;gap:var(--space-1); }.create-form input { min-height:38px;padding:0 var(--space-2);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-sm); }.ide-shell { display:grid;grid-template-columns:260px minmax(460px,1fr) 280px;min-height:620px;gap:var(--space-3); }.project-panel,.material-panel { padding:var(--space-3);overflow:auto; }.project-item,.material-card,.revision-card { display:grid;width:100%;gap:var(--space-1);padding:var(--space-2);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-sm);background:transparent;color:var(--color-text);text-align:left;margin-bottom:var(--space-2); }.project-item.active { border-color:var(--color-accent);background:var(--color-accent-soft); }.project-item span,.material-card span,.material-card small,.revision-card code { color:var(--color-text-muted);font-size:var(--font-size-xs); }.tree-heading button,.file-row button,.tabs button,.material-card button,.revision-card button,.diff-files button { border:0;background:transparent;color:inherit;cursor:pointer;text-align:left; }.file-row { display:flex;align-items:center;justify-content:space-between;border-radius:var(--radius-sm); }.file-row>button { flex:1;padding:var(--space-1);overflow:hidden;text-overflow:ellipsis; }.file-row.active { background:var(--color-accent-soft); }.editor-panel { display:grid;grid-template-rows:auto 1fr;overflow:hidden; }.tabs { display:flex;overflow-x:auto;border-bottom:var(--border-width) solid var(--color-border); }.tabs button { padding:var(--space-2) var(--space-3);white-space:nowrap;border-right:var(--border-width) solid var(--color-border); }.tabs button.active { background:var(--color-accent-soft); }.empty-editor { display:grid;place-items:center;color:var(--color-text-muted); }.material-card button,.revision-card button { color:var(--color-accent);padding:0; }.error-text { color:var(--color-danger); }.diff-section { padding:var(--space-4);display:grid;gap:var(--space-3); }.diff-files { display:flex;gap:var(--space-2);overflow:auto; }.diff-files button { padding:var(--space-1) var(--space-2);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-sm); }.diff-files button.active { border-color:var(--color-accent); }.message { padding:var(--space-3);border-radius:var(--radius-md);background:var(--color-accent-soft); }
.build-section { padding: var(--space-4); display: grid; gap: var(--space-3); }
.build-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.build-row,.release-row { display: grid; width: 100%; gap: var(--space-1); padding: var(--space-2); margin-bottom: var(--space-2); border: var(--border-width) solid var(--color-border); border-radius: var(--radius-sm); background: transparent; color: var(--color-text); text-align: left; }
.build-row.active { border-color: var(--color-accent); background: var(--color-accent-soft); }
.build-row code,.release-row code,.release-row small { color: var(--color-text-muted); }
.build-log { grid-column: 1 / -1; max-height: 280px; overflow: auto; margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: #101820; color: #d8e2e8; font-size: 12px; white-space: pre-wrap; }
.runtime-section { padding: var(--space-4); display: grid; gap: var(--space-3); }
.runtime-section header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.runtime-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-3); }
.runtime-grid form { display: grid; gap: var(--space-2); align-content: start; }
.runtime-grid label { display: grid; gap: var(--space-1); }
.runtime-grid input,.runtime-grid textarea { padding: var(--space-2); border: var(--border-width) solid var(--color-border); border-radius: var(--radius-sm); }
.runtime-grid textarea { min-height: 100px; font-family: ui-monospace, monospace; }
.run-row { display: grid; gap: var(--space-1); padding: var(--space-2); margin-bottom: var(--space-2); border: var(--border-width) solid var(--color-border); border-radius: var(--radius-sm); }
.run-row span,.run-row code,.run-row small { color: var(--color-text-muted); }
.runtime-log { min-height: 180px; max-height: 300px; overflow: auto; margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: #101820; color: #d8e2e8; white-space: pre-wrap; }
@media(max-width:1100px){.ide-shell{grid-template-columns:220px 1fr}.material-panel{grid-column:1/-1}.runtime-grid{grid-template-columns:1fr}.page-heading{align-items:flex-start;flex-direction:column}}@media(max-width:720px){.ide-shell{grid-template-columns:1fr}.create-form,.actions{align-items:stretch;flex-direction:column}}
</style>
