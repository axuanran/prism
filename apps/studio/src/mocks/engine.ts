import type {
  Assignment,
  ActiveProjectRelease,
  CodeProjectSpec,
  DraftMaterialCatalogItem,
  Diagnostic,
  OperationDescriptor,
  OrganizationUnit,
  Person,
  PipelineExecutionResponse,
  ProjectBuildRequest,
  ProjectActionRun,
  ProjectReleaseDefinition,
  ProjectSourceDiff,
  ProjectRuntimeLog,
  ProjectSourceDraft,
  ProjectSourceFile,
  PublishedProjectSource,
  Resource,
  ResourceStatus,
  ResourceTypeDescriptor,
  StudioApi,
} from '../api/types';

const now = new Date().toISOString();
const people: Person[] = [
  { id: 'person-zhang', employeeNumber: 'P001', displayName: '张三', title: '主任医师', status: 'active' },
  { id: 'person-li', employeeNumber: 'P002', displayName: '李四', title: '主治医师', status: 'active' },
  { id: 'person-wang', employeeNumber: 'P003', displayName: '王五', status: 'active' },
];
const units: OrganizationUnit[] = [];
const assignments: Assignment[] = [];

let codeProject: Resource<CodeProjectSpec> | null = null;
let sourceDraft: ProjectSourceDraft | null = null;
const sourceRevisions: Resource<PublishedProjectSource>[] = [];
const projectBuilds: ProjectBuildRequest[] = [];
const projectReleases: Resource<ProjectReleaseDefinition>[] = [];
let activeRelease: ActiveProjectRelease | null = null;
const actionRuns: ProjectActionRun[] = [];
const runtimeLogs: ProjectRuntimeLog[] = [];

// Domain-neutral mock data. Hospital-specific resources live in the private
// Solution repository; Core Studio exercises only the generic Resource model.
const resources: Resource[] = [{
  id: 'example-setting',
  kind: 'example.setting',
  name: '示例配置',
  revision: 1,
  status: 'published',
  createdAt: now,
  updatedAt: now,
  spec: {
    enabled: true,
    description: '用于离线演示 Generic Renderer',
  },
}];

const resourceTypes: readonly ResourceTypeDescriptor[] = [{
  kind: 'example.setting',
  title: '示例配置',
  description: '验证通用资源、修订与配置表单，不包含行业语义',
  schema: {
    type: 'object',
    required: ['enabled', 'description'],
    properties: {
      enabled: { type: 'boolean', title: '启用', default: true },
      description: { type: 'string', title: '说明', minLength: 1 },
    },
  },
  exposure: { configuration: true, frontend: true },
}];

const emptyTrace = {
  level: 'summary' as const,
  nodes: [],
  totalDurationMs: 0,
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export const mockApi: StudioApi = {
  async health() {
    return { status: 'ok' };
  },
  async inspectEngine() {
    // Mirrors the live engine: same phase vocabulary, same plugin ids. A mock
    // that drifts from the real payload teaches the UI to render a shape the
    // backend never sends.
    return {
      phase: 'started',
      engineVersion: '0.1.0',
      startOrder: [
        'storage.memory',
        'calculation.memory',
        'organization.basic',
        'http.fastify',
      ],
      plugins: [],
      capabilities: [],
      resourceTypes: resourceTypes.map(({ kind, title, description }) => ({ kind, title, ...(description ? { description } : {}) })),
      extensionPoints: [],
      diagnostics: [],
    };
  },
  async listResourceTypes() {
    return cloneValue(resourceTypes);
  },
  async listResources(query = {}) {
    return cloneValue(resources.filter((resource) =>
      (query.kind === undefined || resource.kind === query.kind)
      && (query.status === undefined || resource.status === query.status)));
  },
  async getResource(kind, id) {
    const found = resources.find((resource) => resource.kind === kind && resource.id === id);
    if (!found) throw new Error('未找到该配置。');
    return cloneValue(found);
  },
  async listResourceRevisions(kind, id) {
    return cloneValue(resources.filter((resource) => resource.kind === kind && resource.id === id));
  },
  async createResource(kind, body) {
    const id = body.id ?? nextId('draft');
    const previous = resources.filter((resource) => resource.kind === kind && resource.id === id);
    const created: Resource = {
      id,
      kind,
      name: body.name,
      revision: Math.max(0, ...previous.map((resource) => resource.revision)) + 1,
      status: 'draft',
      spec: cloneValue(body.spec),
      createdAt: previous[0]?.createdAt ?? now,
      updatedAt: new Date().toISOString(),
    };
    resources.push(created);
    return cloneValue(created);
  },
  async publishResource(kind, id, revision) {
    const source = resources.find((resource) => resource.kind === kind && resource.id === id && resource.revision === revision);
    if (!source) throw new Error('未找到指定版本。');
    const published: Resource = { ...source, status: 'published', updatedAt: new Date().toISOString() };
    const index = resources.indexOf(source);
    resources[index] = published;
    return cloneValue(published);
  },
  async cloneResource(kind, id, revision) {
    const candidates = resources.filter((resource) => resource.kind === kind && resource.id === id);
    const source = revision === undefined
      ? candidates.sort((left, right) => right.revision - left.revision)[0]
      : candidates.find((resource) => resource.revision === revision);
    if (!source) throw new Error('未找到指定版本。');
    return this.createResource(kind, { id, name: source.name, spec: source.spec });
  },
  async archiveResource(kind, id) {
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      if (resource?.kind === kind && resource.id === id) {
        resources[index] = { ...resource, status: 'archived' };
      }
    }
    return { status: 'archived' };
  },
  async listPeople() {
    return cloneValue(people);
  },
  async createPerson(body) {
    const created: Person = { id: nextId('person'), status: 'active', ...body };
    people.push(created);
    return cloneValue(created);
  },
  async listUnits() {
    return cloneValue(units);
  },
  async createUnit(body) {
    const created: OrganizationUnit = {
      id: nextId('unit'),
      code: body.code,
      name: body.name,
      ...(body.parentId ? { parentId: body.parentId } : {}),
      effectivePeriod: { from: body.from, ...(body.through ? { through: body.through } : {}) },
    };
    units.push(created);
    return cloneValue(created);
  },
  async listAssignments() {
    return cloneValue(assignments);
  },
  async createAssignment(body) {
    const created: Assignment = {
      id: nextId('assignment'),
      personId: body.personId,
      organizationUnitId: body.organizationUnitId,
      ...(body.positionId ? { positionId: body.positionId } : {}),
      kind: body.kind,
      effectivePeriod: { from: body.from, ...(body.through ? { through: body.through } : {}) },
    };
    assignments.push(created);
    return cloneValue(created);
  },
  async listOperations(): Promise<readonly OperationDescriptor[]> {
    return [];
  },
  async validatePipeline() {
    return { valid: true, diagnostics: [] };
  },
  async listCodeProjects() {
    return codeProject === null ? [] : [cloneValue(codeProject)];
  },
  async createCodeProject(body) {
    const id = body.id ?? body.slug;
    codeProject = {
      id,
      kind: 'project.code-project',
      name: body.name,
      revision: 1,
      status: 'published',
      spec: {
        slug: body.slug,
        name: body.name,
        sourceId: `${id}:source`,
        ...(body.description ? { description: body.description } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
    const files: readonly ProjectSourceFile[] = [
      { path: 'package.json', mediaType: 'application/json', content: '{\\n  \"private\": true\\n}\\n' },
      { path: 'prism.project.json', mediaType: 'application/json', content: '{\\n  \"schemaVersion\": \"1.0.0\"\\n}\\n' },
      { path: 'prism.materials.json', mediaType: 'application/json', content: '{\\n  \"schemaVersion\": \"1.0.0\",\\n  \"materials\": []\\n}\\n' },
      { path: 'src/client/index.tsx', mediaType: 'text/typescript-jsx', content: 'export async function mount() {}\\n' },
      { path: 'src/server/index.ts', mediaType: 'text/typescript', content: 'export default {};\\n' },
      { path: 'tests/project.test.ts', mediaType: 'text/typescript', content: 'export default async () => ({ passed: true });\\n' },
    ];
    sourceDraft = {
      id,
      projectId: id,
      sourceId: `${id}:source`,
      baseSourceRevision: null,
      draftVersion: 1,
      files,
      updatedAt: now,
      updatedBy: 'studio-builder',
    };
    return { project: cloneValue(codeProject), draft: cloneValue(sourceDraft) };
  },
  async getProjectSourceDraft() {
    if (sourceDraft === null) throw new Error('Project draft not found.');
    return cloneValue(sourceDraft);
  },
  async saveProjectSourceDraft(_projectId, draftVersion, files) {
    if (sourceDraft === null || sourceDraft.draftVersion !== draftVersion) {
      throw new Error('PROJECT_SOURCE_DRAFT_CONFLICT');
    }
    sourceDraft = {
      ...sourceDraft,
      draftVersion: draftVersion + 1,
      files: cloneValue(files),
      updatedAt: new Date().toISOString(),
    };
    return cloneValue(sourceDraft);
  },
  async listDraftMaterials(): Promise<readonly DraftMaterialCatalogItem[]> {
    if (sourceDraft === null) return [];
    const source = sourceDraft.files.find((file) => file.path === 'prism.materials.json');
    if (!source) return [];
    const parsed = JSON.parse(source.content) as { materials?: DraftMaterialCatalogItem['manifest'][] };
    return (parsed.materials ?? []).map((manifest) => ({
      manifest,
      status: 'DECLARED',
      buildStatus: 'NOT_BUILT',
    }));
  },
  async publishProjectSource() {
    if (codeProject === null || sourceDraft === null) throw new Error('Project draft not found.');
    const revision = sourceRevisions.length + 1;
    const published: Resource<PublishedProjectSource> = {
      id: codeProject.spec.sourceId,
      kind: 'project.source',
      name: `${codeProject.name} Source`,
      revision,
      status: 'published',
      spec: {
        projectId: codeProject.id,
        files: cloneValue(sourceDraft.files),
        fingerprint: String(revision).padStart(64, '0'),
      },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };
    sourceRevisions.push(published);
    sourceDraft = {
      ...sourceDraft,
      baseSourceRevision: revision,
      draftVersion: sourceDraft.draftVersion + 1,
    };
    return cloneValue(published);
  },
  async listProjectSourceRevisions() {
    return cloneValue(sourceRevisions);
  },
  async diffProjectSource(projectId, from, to): Promise<ProjectSourceDiff> {
    const filesAt = (identity: number | 'draft') => identity === 'draft'
      ? sourceDraft?.files ?? []
      : sourceRevisions.find((item) => item.revision === identity)?.spec.files ?? [];
    const left = new Map(filesAt(from).map((file) => [file.path, file.content]));
    const right = new Map(filesAt(to).map((file) => [file.path, file.content]));
    return {
      projectId,
      from,
      to,
      added: [...right.keys()].filter((path) => !left.has(path)),
      removed: [...left.keys()].filter((path) => !right.has(path)),
      changed: [...right.keys()].filter((path) => left.has(path) && left.get(path) !== right.get(path)),
      materialChanges: { added: [], removed: [], changed: [] },
    };
  },
  async buildProject(projectId, sourceRevision) {
    const source = sourceRevisions.find((item) => item.revision === sourceRevision);
    if (!source) throw new Error('Published source not found.');
    const id = nextId('build');
    const hash = String(sourceRevision).padStart(64, 'a');
    const descriptor = {
      hash,
      size: 1,
      contentType: 'application/octet-stream',
      fileCount: 1,
    };
    const release: Resource<ProjectReleaseDefinition> = {
      id: `${projectId}:release`,
      kind: 'project.release',
      name: `${projectId} Release`,
      revision: projectReleases.length + 1,
      status: 'published',
      spec: {
        projectId,
        sourceRevision,
        sourceFingerprint: source.spec.fingerprint,
        packageJsonHash: hash,
        dependencyLockHash: hash,
        builderVersion: 'offline',
        nodeVersion: 'offline',
        pnpmVersion: 'offline',
        runtimeAbiVersion: '1.0.0',
        clientEntryExport: 'mount',
        serverEntryExport: 'actions',
        actionIds: [],
        clientArtifact: descriptor,
        serverArtifact: descriptor,
        buildManifestArtifact: descriptor,
        materialManifests: [],
        materialArtifacts: [],
        testResult: { passed: true, total: 1, failed: 0, reportHash: hash },
        diagnostics: [],
        buildReproducibility: 'DETERMINISTIC',
        runtimeReproducibility: 'UNKNOWN',
        materials: [],
      },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };
    projectReleases.push(release);
    const build: ProjectBuildRequest = {
      id,
      projectId,
      sourceRevision,
      sourceFingerprint: source.spec.fingerprint,
      status: 'SUCCESS',
      requestedBy: 'studio-builder',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      releaseId: `${release.id}@${release.revision}`,
      diagnostics: [],
    };
    projectBuilds.push(build);
    return cloneValue(build);
  },
  async listProjectBuilds(projectId) {
    return cloneValue(projectBuilds.filter((item) => item.projectId === projectId));
  },
  async getProjectBuildLog() {
    return ['pnpm install PASS', 'TS7 typecheck PASS', 'Vitest PASS', 'Vite client build PASS', 'esbuild server build PASS'];
  },
  async listProjectReleases(projectId) {
    return cloneValue(projectReleases.filter((item) => item.spec.projectId === projectId));
  },
  async getActiveProjectRelease() {
    return cloneValue(activeRelease);
  },
  async activateProjectRelease(projectId, releaseRevision) {
    const release = {
      resourceId: `${projectId}:release`,
      revision: releaseRevision,
      fingerprint: String(releaseRevision).padStart(64, 'f'),
    };
    activeRelease = {
      id: projectId,
      projectId,
      release,
      releaseIdentity: `${release.resourceId}@${release.revision}:${release.fingerprint}`,
      activatedAt: new Date().toISOString(),
      activatedBy: 'studio-builder',
    };
    return cloneValue(activeRelease);
  },
  async invokeProjectAction(projectId, release, actionId, input) {
    const run: ProjectActionRun = {
      id: nextId('run'),
      projectId,
      release,
      actionId,
      status: 'SUCCESS',
      inputFingerprint: 'i'.repeat(64),
      result: input,
      pin: {},
      reproducibility: 'DETERMINISTIC',
      createdAt: new Date().toISOString(),
    };
    actionRuns.push(run);
    return cloneValue(run);
  },
  async listProjectReleaseMaterials(projectId, revision) {
    const release = projectReleases.find((item) =>
      item.spec.projectId === projectId && item.revision === revision);
    if (!release) return [];
    return release.spec.materialManifests.flatMap((manifest, index) => {
      const artifact = release.spec.materialArtifacts[index];
      return artifact ? [{ manifest, artifact, status: 'BUILT' as const }] : [];
    });
  },
  async executeProjectMaterial(_projectId, _release, _materialId, _version, input) {
    return input;
  },
  async listProjectActionRuns(projectId) {
    return cloneValue(actionRuns.filter((run) => run.projectId === projectId));
  },
  async listProjectRuntimeLogs(projectId) {
    return cloneValue(runtimeLogs.filter((log) => log.projectId === projectId));
  },
  async executePipeline(): Promise<PipelineExecutionResponse> {
    return { status: 'success', outputs: {}, diagnostics: [], trace: emptyTrace, planHash: 'offline' };
  },
};

export type { Diagnostic, ResourceStatus };
