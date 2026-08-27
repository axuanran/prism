import { mockApi } from '../mocks/engine';
import type {
  Assignment,
  ActiveProjectRelease,
  CodeProjectSpec,
  DatasetPayload,
  Diagnostic,
  DraftMaterialCatalogItem,
  EngineInspection,
  OperationDescriptor,
  OrganizationUnit,
  Person,
  PipelineExecutionResponse,
  PipelineSpec,
  ProjectBuildRequest,
  ProjectActionRun,
  ProjectReleaseDefinition,
  ProjectReleaseRef,
  ProjectReleaseMaterialCatalogItem,
  ProjectRuntimeLog,
  ProjectSourceDiff,
  ProjectSourceDraft,
  ProjectSourceFile,
  PublishedProjectSource,
  Resource,
  ResourceStatus,
  ResourceTypeDescriptor,
  StudioApi,
} from './types';

const DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = {
  RESOURCE_TYPE_UNKNOWN: '未找到这种配置类型。',
  RESOURCE_NOT_FOUND: '未找到该配置，可能已被删除。',
  RESOURCE_REVISION_NOT_FOUND: '未找到指定版本。',
  RESOURCE_REVISION_CONFLICT: '配置已被他人更新，请刷新后重试。',
  RESOURCE_IMMUTABLE: '已发布版本不可修改，请先复制为草稿。',
  VALIDATION_FAILED: '填写内容未通过校验，请检查标记字段。',
  SCHEMA_VALIDATION_FAILED: '填写内容不符合配置要求。',
  RESOURCE_SCHEMA_VIOLATION: '填写内容不符合配置要求，请检查标记字段。',
  ORGANIZATION_DUPLICATE_EMPLOYEE_NUMBER: '该工号已经存在。',
  ORGANIZATION_INVALID_EFFECTIVE_PERIOD: '失效日期必须晚于生效日期。',
  ORGANIZATION_PERSON_NOT_FOUND: '未找到所选人员。',
  ORGANIZATION_UNIT_NOT_FOUND: '未找到所选机构。',
  PIPELINE_NODE_UNKNOWN_OPERATION: '流水线中有不可用的步骤。',
  OPERATION_UNKNOWN: '流水线中有不可用的步骤。',
  PIPELINE_PORT_UNCONNECTED: '流水线还有必填端口未连接。',
  PIPELINE_SCHEMA_MISMATCH: '流水线步骤之间的数据结构不匹配。',
  EXPRESSION_PARSE_ERROR: '表达式语法有误。',
  EXPRESSION_UNKNOWN_IDENTIFIER: '表达式引用了未知字段。',
  EXPRESSION_UNKNOWN_FIELD: '表达式引用了未知字段。',
  EXPRESSION_UNKNOWN_FUNCTION: '表达式使用了未知函数。',
  EXPRESSION_TYPE_ERROR: '表达式返回类型不符合要求。',
};


function isDiagnostic(value: unknown): value is Diagnostic {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof value.code === 'string'
    && 'message' in value
    && typeof value.message === 'string'
    && 'severity' in value
    && (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error');
}

export function localizeDiagnostic(diagnostic: Diagnostic): string {
  return DIAGNOSTIC_MESSAGES[diagnostic.code] ?? diagnostic.message;
}

export class ApiError extends Error {
  readonly status: number;
  readonly diagnostics: readonly Diagnostic[];

  constructor(status: number, diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(localizeDiagnostic).join('；') || `请求失败（${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

function correlationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

class LiveStudioApi implements StudioApi {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('x-correlation-id', correlationId());
    headers.set('x-principal-id', 'studio-builder');
    headers.set('x-principal-roles', 'BUILDER,USER');
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new ApiError(0, [{
        code: 'NETWORK_UNAVAILABLE',
        severity: 'error',
        message: '无法连接服务，请确认 Prism Engine 已启动。',
      }]);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body: unknown = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      const rawDiagnostics = typeof body === 'object' && body !== null && 'diagnostics' in body && Array.isArray(body.diagnostics) ? body.diagnostics : [];
      const diagnostics = rawDiagnostics.filter(isDiagnostic);
      throw new ApiError(response.status, diagnostics.length > 0 ? diagnostics : [{
        code: 'HTTP_REQUEST_FAILED',
        severity: 'error',
        message: `请求失败（${response.status}）。`,
      }]);
    }
    return body as T;
  }

  health(): Promise<{ readonly status: 'ok' }> {
    return this.#request('/health');
  }

  inspectEngine(): Promise<EngineInspection> {
    return this.#request('/api/engine/inspection');
  }

  listResourceTypes(): Promise<readonly ResourceTypeDescriptor[]> {
    return this.#request('/api/resource-types');
  }

  listResources(query: { readonly kind?: string; readonly status?: ResourceStatus } = {}): Promise<readonly Resource[]> {
    const search = new URLSearchParams();
    if (query.kind) search.set('kind', query.kind);
    if (query.status) search.set('status', query.status);
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.#request(`/api/resources${suffix}`);
  }

  getResource(kind: string, id: string): Promise<Resource> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  }

  listResourceRevisions(kind: string, id: string): Promise<readonly Resource[]> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/revisions`);
  }

  createResource(kind: string, body: { readonly id?: string; readonly name: string; readonly spec: unknown }): Promise<Resource> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  publishResource(kind: string, id: string, revision: number): Promise<Resource> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    });
  }

  cloneResource(kind: string, id: string, revision?: number): Promise<Resource> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
      body: JSON.stringify(revision === undefined ? {} : { revision }),
    });
  }

  archiveResource(kind: string, id: string): Promise<{ readonly status: 'archived' }> {
    return this.#request(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  }

  listPeople(): Promise<readonly Person[]> {
    return this.#request('/api/organization/people');
  }

  createPerson(body: { readonly employeeNumber: string; readonly displayName: string; readonly title?: string }): Promise<Person> {
    return this.#request('/api/organization/people', {
      method: 'POST',
      body: JSON.stringify({ ...body, title: optionalString(body.title) }),
    });
  }

  listUnits(): Promise<readonly OrganizationUnit[]> {
    return this.#request('/api/organization/units');
  }

  createUnit(body: { readonly code: string; readonly name: string; readonly parentId?: string; readonly from: string; readonly through?: string }): Promise<OrganizationUnit> {
    return this.#request('/api/organization/units', {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        parentId: optionalString(body.parentId),
        through: optionalString(body.through),
      }),
    });
  }

  listAssignments(): Promise<readonly Assignment[]> {
    return this.#request('/api/organization/assignments');
  }

  createAssignment(body: { readonly personId: string; readonly organizationUnitId: string; readonly positionId?: string; readonly kind: 'primary' | 'secondary'; readonly from: string; readonly through?: string }): Promise<Assignment> {
    return this.#request('/api/organization/assignments', {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        positionId: optionalString(body.positionId),
        through: optionalString(body.through),
      }),
    });
  }

  listOperations(): Promise<readonly OperationDescriptor[]> {
    return this.#request('/api/calculation/operations');
  }

  validatePipeline(spec: PipelineSpec): Promise<{ readonly valid: boolean; readonly diagnostics: readonly Diagnostic[] }> {
    return this.#request('/api/calculation/pipelines/validate', {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
  }

  executePipeline(spec: PipelineSpec, inputs?: Readonly<Record<string, DatasetPayload>>): Promise<PipelineExecutionResponse> {
    return this.#request('/api/calculation/pipelines/execute', {
      method: 'POST',
      body: JSON.stringify(inputs === undefined ? { spec } : { spec, inputs }),
    });
  }

  listCodeProjects(): Promise<readonly Resource<CodeProjectSpec>[]> {
    return this.#request('/api/code-projects');
  }

  createCodeProject(body: { readonly id?: string; readonly slug: string; readonly name: string; readonly description?: string }): Promise<{ readonly project: Resource<CodeProjectSpec>; readonly draft: ProjectSourceDraft }> {
    return this.#request('/api/code-projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  getProjectSourceDraft(projectId: string): Promise<ProjectSourceDraft> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/draft`);
  }

  saveProjectSourceDraft(projectId: string, draftVersion: number, files: readonly ProjectSourceFile[]): Promise<ProjectSourceDraft> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/draft/${draftVersion}`, {
      method: 'PUT',
      body: JSON.stringify({ files }),
    });
  }

  listDraftMaterials(projectId: string): Promise<readonly DraftMaterialCatalogItem[]> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/draft/materials`);
  }

  publishProjectSource(projectId: string, draftVersion: number): Promise<Resource<PublishedProjectSource>> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/draft/${draftVersion}/publish`, {
      method: 'POST',
    });
  }

  listProjectSourceRevisions(projectId: string): Promise<readonly Resource<PublishedProjectSource>[]> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/source/revisions`);
  }

  diffProjectSource(projectId: string, from: number | 'draft', to: number | 'draft'): Promise<ProjectSourceDiff> {
    const search = new URLSearchParams({ from: String(from), to: String(to) });
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/source/diff?${search.toString()}`);
  }
  buildProject(projectId: string, sourceRevision: number): Promise<ProjectBuildRequest> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/builds`, {
      method: 'POST',
      body: JSON.stringify({ sourceRevision }),
    });
  }

  listProjectBuilds(projectId: string): Promise<readonly ProjectBuildRequest[]> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/builds`);
  }

  async getProjectBuildLog(buildId: string): Promise<readonly string[]> {
    const response = await this.#request<{ readonly lines: readonly string[] }>(
      `/api/project-builds/${encodeURIComponent(buildId)}/log`,
    );
    return response.lines;
  }

  listProjectReleases(projectId: string): Promise<readonly Resource<ProjectReleaseDefinition>[]> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/releases`);
  }
  getActiveProjectRelease(projectId: string): Promise<ActiveProjectRelease | null> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/active-release`);
  }

  activateProjectRelease(projectId: string, releaseRevision: number, expectedActiveRelease: ProjectReleaseRef | null): Promise<ActiveProjectRelease> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/active-release`, {
      method: 'POST',
      body: JSON.stringify({ releaseRevision, expectedActiveRelease }),
    });
  }

  invokeProjectAction(projectId: string, release: ProjectReleaseRef, actionId: string, input: unknown): Promise<ProjectActionRun> {
    return this.#request(`/api/runtime/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`, {
      method: 'POST',
      body: JSON.stringify({ release, input }),
    });
  }

  listProjectActionRuns(projectId: string): Promise<readonly ProjectActionRun[]> {
    return this.#request(`/api/runtime/${encodeURIComponent(projectId)}/runs`);
  }

  listProjectRuntimeLogs(projectId: string): Promise<readonly ProjectRuntimeLog[]> {
    return this.#request(`/api/runtime/${encodeURIComponent(projectId)}/logs`);
  }

  listProjectReleaseMaterials(projectId: string, revision: number): Promise<readonly ProjectReleaseMaterialCatalogItem[]> {
    return this.#request(`/api/code-projects/${encodeURIComponent(projectId)}/releases/${revision}/materials`);
  }
  executeProjectMaterial(projectId: string, release: ProjectReleaseRef, materialId: string, version: string, input: unknown, configuration: unknown = null): Promise<unknown> {
    return this.#request(`/api/runtime/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/${encodeURIComponent(version)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ release, input, configuration }),
    });
  }
}

const useMock = import.meta.env.VITE_USE_MOCKS === 'true';
const baseUrl = import.meta.env.VITE_API_BASE ?? '';

export const api: StudioApi = useMock ? mockApi : new LiveStudioApi(baseUrl);

export function inspectEngine(): Promise<EngineInspection> {
  return api.inspectEngine();
}
