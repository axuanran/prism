import type {
  Assignment,
  Diagnostic,
  OperationDescriptor,
  OrganizationUnit,
  Person,
  PipelineExecutionResponse,
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
  async executePipeline(): Promise<PipelineExecutionResponse> {
    return { status: 'success', outputs: {}, diagnostics: [], trace: emptyTrace, planHash: 'offline' };
  },
};

export type { Diagnostic, ResourceStatus };
