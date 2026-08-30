import type {
  ApprovalTarget,
  Assignment,
  ActiveProjectRelease,
  CodeProjectSpec,
  ChangeApproval,
  DraftMaterialCatalogItem,
  Diagnostic,
  OperationDescriptor,
  OrganizationUnit,
  Person,
  PipelineExecutionResponse,
  ProjectBuildArtifactSet,
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
  PublishedVisualPipeline,
  ValidationResult,
  VisualMaterialCatalogItem,
  VisualPipelineDiff,
  VisualPipelineSpec,
} from "../api/types";

const now = new Date().toISOString();
const people: Person[] = [
  {
    id: "person-zhang",
    employeeNumber: "P001",
    displayName: "张三",
    title: "主任医师",
    status: "active",
  },
  {
    id: "person-li",
    employeeNumber: "P002",
    displayName: "李四",
    title: "主治医师",
    status: "active",
  },
  { id: "person-wang", employeeNumber: "P003", displayName: "王五", status: "active" },
];
const units: OrganizationUnit[] = [];
const assignments: Assignment[] = [];

let codeProject: Resource<CodeProjectSpec> | null = null;
let sourceDraft: ProjectSourceDraft | null = null;
const sourceRevisions: Resource<PublishedProjectSource>[] = [];
const projectArtifactSets = new Map<string, ProjectBuildArtifactSet>();
const projectBuilds: ProjectBuildRequest[] = [];
const projectReleases: Resource<ProjectReleaseDefinition>[] = [];
let activeRelease: ActiveProjectRelease | null = null;
const actionRuns: ProjectActionRun[] = [];
const runtimeLogs: ProjectRuntimeLog[] = [];
let visualDraft: Resource<PublishedVisualPipeline> | null = null;
let visualPublished: Resource<PublishedVisualPipeline> | null = null;
const changeApprovals: ChangeApproval[] = [];

// Domain-neutral mock data. Hospital-specific resources live in the private
// Solution repository; Core Studio exercises only the generic Resource model.
const resources: Resource[] = [
  {
    id: "example-setting",
    kind: "example.setting",
    name: "示例配置",
    revision: 1,
    status: "published",
    createdAt: now,
    updatedAt: now,
    spec: {
      enabled: true,
      description: "用于离线演示 Generic Renderer",
    },
  },
];

const resourceTypes: readonly ResourceTypeDescriptor[] = [
  {
    kind: "example.setting",
    title: "示例配置",
    description: "验证通用资源、修订与配置表单，不包含行业语义",
    schema: {
      type: "object",
      required: ["enabled", "description"],
      properties: {
        enabled: { type: "boolean", title: "启用", default: true },
        description: { type: "string", title: "说明", minLength: 1 },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.person",
    title: "人员",
    description: "通用人员目录",
    schema: {
      type: "object",
      required: ["employeeNumber", "displayName"],
      properties: {
        employeeNumber: { type: "string", title: "工号", minLength: 1 },
        displayName: { type: "string", title: "姓名", minLength: 1 },
        title: { type: "string", title: "职称" },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.unit",
    title: "机构",
    description: "通用组织机构",
    schema: {
      type: "object",
      required: ["code", "name", "from"],
      properties: {
        code: { type: "string", title: "机构编码", minLength: 1 },
        name: { type: "string", title: "机构名称", minLength: 1 },
        parentId: { type: "string", title: "上级机构" },
        from: { type: "string", title: "生效日期", format: "date" },
        through: { type: "string", title: "失效日期", format: "date" },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.assignment",
    title: "人员归属",
    description: "人员与机构的生效期关系",
    schema: {
      type: "object",
      required: ["personId", "organizationUnitId", "kind", "from"],
      properties: {
        personId: { type: "string", title: "人员" },
        organizationUnitId: { type: "string", title: "机构" },
        positionId: { type: "string", title: "职位" },
        kind: {
          type: "string",
          title: "归属类型",
          enum: ["primary", "secondary"],
          default: "primary",
        },
        from: { type: "string", title: "生效日期", format: "date" },
        through: { type: "string", title: "失效日期", format: "date" },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
];

const emptyTrace = {
  level: "summary" as const,
  nodes: [],
  totalDurationMs: 0,
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
function mockFingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let seed = 0;
  for (let index = 0; index < text.length; index += 1) {
    seed = (seed * 31 + text.charCodeAt(index)) >>> 0;
  }
  return seed.toString(16).padStart(8, "0").repeat(8);
}

function visualCatalog(buildId: string): readonly VisualMaterialCatalogItem[] {
  const build = projectBuilds.find(
    (item) => item.id === buildId && item.status === "SUCCESS",
  );
  if (!build) return [];
  const manifest = {
    id: "project.expression",
    version: "1.0.0",
    kind: "operator",
    authoringMode: "CODE" as const,
    displayName: "表达式转换",
    category: "项目",
    runtimeTarget: "pipeline",
    entry: "src/materials/expression.ts",
    exportName: "default",
    visualOperator: {
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      configurationSchema: {
        type: "object",
        required: ["expression"],
        properties: {
          expression: { type: "string" },
          enabled: { type: "boolean" },
        },
      },
      editorSchema: {
        properties: {
          expression: { label: "表达式" },
          enabled: { label: "启用" },
        },
      },
      executionModel: "ROW_MAP",
      cardinality: "ONE_TO_ONE",
      grainEffect: "PRESERVE",
      supportedBackends: ["calculation.memory"],
    },
  };
  const artifactHash = mockFingerprint({ buildId, material: manifest.id });
  return [
    {
      manifest,
      exactRef: {
        projectId: build.projectId,
        buildId,
        buildFingerprint: mockFingerprint(build),
        sourceRevision: build.sourceRevision,
        sourceFingerprint: build.sourceFingerprint,
        dependencyLockHash: mockFingerprint({ buildId, lock: true }),
        materialId: manifest.id,
        materialVersion: manifest.version,
        artifactHash,
        manifestFingerprint: mockFingerprint(manifest),
      },
      visualPropertyFields: [
        { path: "/expression", label: "表达式", control: "string", required: true },
        { path: "/enabled", label: "启用", control: "boolean", required: false },
      ],
    },
  ];
}

function validateVisual(spec: VisualPipelineSpec): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  if (!spec.code.trim()) {
    diagnostics.push({
      code: "VISUAL_PIPELINE_CODE_REQUIRED",
      severity: "error",
      message: "Pipeline code不能为空。",
      path: "/code",
    });
  }
  spec.nodes.forEach((node, index) => {
    const configuration =
      typeof node.configuration === "object" &&
      node.configuration !== null &&
      !Array.isArray(node.configuration)
        ? (node.configuration as Record<string, unknown>)
        : {};
    if (typeof configuration.expression !== "string" || !configuration.expression.trim()) {
      diagnostics.push({
        code: "VISUAL_PIPELINE_CONFIGURATION_INVALID",
        severity: "error",
        message: "表达式不能为空。",
        path: `/nodes/${index}/configuration/expression`,
      });
    }
  });

  return { valid: diagnostics.length === 0, diagnostics };
}
function consumeMockApproval(approvalId: string): void {
  const index = changeApprovals.findIndex((approval) => approval.id === approvalId);
  const approval = changeApprovals[index];
  if (!approval || approval.status !== "APPROVED") {
    throw new Error("APPROVAL_NOT_APPROVED");
  }
  changeApprovals[index] = {
    ...approval,
    status: "CONSUMED",
    version: approval.version + 1,
    publisherId: "mock-publisher",
    executionCorrelationId: nextId("correlation"),
    executionOutcome: "SUCCEEDED",
    consumedAt: new Date().toISOString(),
  };
}

export const mockApi: StudioApi = {
  async listApprovals(status) {
    return cloneValue(
      status === undefined
        ? changeApprovals
        : changeApprovals.filter((approval) => approval.status === status),
    );
  },
  async requestApproval(target: ApprovalTarget, reason: string, expiresInSeconds = 86_400) {
    const createdAt = new Date();
    const approval: ChangeApproval = {
      id: nextId("approval"),
      target: {
        permission: target.permission,
        method: target.method,
        path: target.path,
        fingerprint: mockFingerprint(target),
      },
      requesterId: "mock-requester",
      status: "PENDING",
      version: 1,
      requestReason: reason,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + expiresInSeconds * 1_000).toISOString(),
    };
    changeApprovals.unshift(approval);
    return cloneValue(approval);
  },
  async reviewApproval(id, expectedVersion, decision, reason) {
    const index = changeApprovals.findIndex((approval) => approval.id === id);
    const current = changeApprovals[index];
    if (!current || current.version !== expectedVersion || current.status !== "PENDING") {
      throw new Error("APPROVAL_CONFLICT");
    }
    const reviewed: ChangeApproval = {
      ...current,
      reviewerId: "mock-reviewer",
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      version: current.version + 1,
      reviewReason: reason,
      reviewedAt: new Date().toISOString(),
    };
    changeApprovals[index] = reviewed;
    return cloneValue(reviewed);
  },
  async health() {
    return { status: "ok" };
  },
  async inspectEngine() {
    // Mirrors the live engine: same phase vocabulary, same plugin ids. A mock
    // that drifts from the real payload teaches the UI to render a shape the
    // backend never sends.
    return {
      phase: "started",
      engineVersion: "0.1.0",
      startOrder: [
        "storage.memory",
        "calculation.memory",
        "organization.basic",
        "http.fastify",
      ],
      plugins: [],
      capabilities: [],
      resourceTypes: resourceTypes.map(({ kind, title, description }) => ({
        kind,
        title,
        ...(description ? { description } : {}),
      })),
      extensionPoints: [],
      diagnostics: [],
    };
  },
  async listResourceTypes() {
    return cloneValue(resourceTypes);
  },
  async listResources(query = {}) {
    return cloneValue(
      resources.filter(
        (resource) =>
          (query.kind === undefined || resource.kind === query.kind) &&
          (query.status === undefined || resource.status === query.status),
      ),
    );
  },
  async getResource(kind, id) {
    const found = resources.find(
      (resource) => resource.kind === kind && resource.id === id,
    );
    if (!found) throw new Error("未找到该配置。");
    return cloneValue(found);
  },
  async listResourceRevisions(kind, id) {
    return cloneValue(
      resources.filter((resource) => resource.kind === kind && resource.id === id),
    );
  },
  async createResource(kind, body) {
    const id = body.id ?? nextId("draft");
    const previous = resources.filter(
      (resource) => resource.kind === kind && resource.id === id,
    );
    const created: Resource = {
      id,
      kind,
      name: body.name,
      revision: Math.max(0, ...previous.map((resource) => resource.revision)) + 1,
      status: "draft",
      spec: cloneValue(body.spec),
      createdAt: previous[0]?.createdAt ?? now,
      updatedAt: new Date().toISOString(),
    };
    resources.push(created);
    return cloneValue(created);
  },
  async publishResource(kind, id, revision, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    const source = resources.find(
      (resource) =>
        resource.kind === kind && resource.id === id && resource.revision === revision,
    );
    if (!source) throw new Error("未找到指定版本。");
    const published: Resource = {
      ...source,
      status: "published",
      updatedAt: new Date().toISOString(),
    };
    const index = resources.indexOf(source);
    resources[index] = published;
    return cloneValue(published);
  },
  async cloneResource(kind, id, revision) {
    const candidates = resources.filter(
      (resource) => resource.kind === kind && resource.id === id,
    );
    const source =
      revision === undefined
        ? candidates.sort((left, right) => right.revision - left.revision)[0]
        : candidates.find((resource) => resource.revision === revision);
    if (!source) throw new Error("未找到指定版本。");
    return this.createResource(kind, { id, name: source.name, spec: source.spec });
  },
  async archiveResource(kind, id, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      if (resource?.kind === kind && resource.id === id) {
        resources[index] = { ...resource, status: "archived" };
      }
    }
    return { status: "archived" };
  },
  async listPeople() {
    return cloneValue(people);
  },
  async createPerson(body, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    const created: Person = { id: nextId("person"), status: "active", ...body };
    people.push(created);
    return cloneValue(created);
  },
  async listUnits() {
    return cloneValue(units);
  },
  async createUnit(body, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    const created: OrganizationUnit = {
      id: nextId("unit"),
      code: body.code,
      name: body.name,
      ...(body.parentId ? { parentId: body.parentId } : {}),
      effectivePeriod: {
        from: body.from,
        ...(body.through ? { through: body.through } : {}),
      },
    };
    units.push(created);
    return cloneValue(created);
  },
  async listAssignments() {
    return cloneValue(assignments);
  },
  async createAssignment(body, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    const created: Assignment = {
      id: nextId("assignment"),
      personId: body.personId,
      organizationUnitId: body.organizationUnitId,
      ...(body.positionId ? { positionId: body.positionId } : {}),
      kind: body.kind,
      effectivePeriod: {
        from: body.from,
        ...(body.through ? { through: body.through } : {}),
      },
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
      kind: "project.code-project",
      name: body.name,
      revision: 1,
      status: "published",
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
      {
        path: "package.json",
        mediaType: "application/json",
        content: '{\\n  \"private\": true\\n}\\n',
      },
      {
        path: "prism.project.json",
        mediaType: "application/json",
        content: '{\\n  \"schemaVersion\": \"1.0.0\"\\n}\\n',
      },
      {
        path: "prism.materials.json",
        mediaType: "application/json",
        content: '{\\n  \"schemaVersion\": \"1.0.0\",\\n  \"materials\": []\\n}\\n',
      },
      {
        path: "src/client/index.tsx",
        mediaType: "text/typescript-jsx",
        content: "export async function mount() {}\\n",
      },
      {
        path: "src/server/index.ts",
        mediaType: "text/typescript",
        content: "export default {};\\n",
      },
      {
        path: "tests/project.test.ts",
        mediaType: "text/typescript",
        content: "export default async () => ({ passed: true });\\n",
      },
    ];
    sourceDraft = {
      id,
      projectId: id,
      sourceId: `${id}:source`,
      baseSourceRevision: null,
      draftVersion: 1,
      files,
      updatedAt: now,
      updatedBy: "studio-builder",
    };
    return { project: cloneValue(codeProject), draft: cloneValue(sourceDraft) };
  },
  async getProjectSourceDraft() {
    if (sourceDraft === null) throw new Error("Project draft not found.");
    return cloneValue(sourceDraft);
  },
  async saveProjectSourceDraft(_projectId, draftVersion, files) {
    if (sourceDraft === null || sourceDraft.draftVersion !== draftVersion) {
      throw new Error("PROJECT_SOURCE_DRAFT_CONFLICT");
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
    const source = sourceDraft.files.find((file) => file.path === "prism.materials.json");
    if (!source) return [];
    const parsed = JSON.parse(source.content) as {
      materials?: DraftMaterialCatalogItem["manifest"][];
    };
    return (parsed.materials ?? []).map((manifest) => ({
      manifest,
      status: "DECLARED",
      buildStatus: "NOT_BUILT",
    }));
  },
  async publishProjectSource(_projectId, _draftVersion, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    if (codeProject === null || sourceDraft === null)
      throw new Error("Project draft not found.");
    const revision = sourceRevisions.length + 1;
    const published: Resource<PublishedProjectSource> = {
      id: codeProject.spec.sourceId,
      kind: "project.source",
      name: `${codeProject.name} Source`,
      revision,
      status: "published",
      spec: {
        projectId: codeProject.id,
        files: cloneValue(sourceDraft.files),
        fingerprint: String(revision).padStart(64, "0"),
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
    const filesAt = (identity: number | "draft") =>
      identity === "draft"
        ? (sourceDraft?.files ?? [])
        : (sourceRevisions.find((item) => item.revision === identity)?.spec.files ?? []);
    const left = new Map(filesAt(from).map((file) => [file.path, file.content]));
    const right = new Map(filesAt(to).map((file) => [file.path, file.content]));
    return {
      projectId,
      from,
      to,
      added: [...right.keys()].filter((path) => !left.has(path)),
      removed: [...left.keys()].filter((path) => !right.has(path)),
      changed: [...right.keys()].filter(
        (path) => left.has(path) && left.get(path) !== right.get(path),
      ),
      materialChanges: { added: [], removed: [], changed: [] },
    };
  },
  async buildProject(projectId, sourceRevision) {
    const source = sourceRevisions.find((item) => item.revision === sourceRevision);
    if (!source) throw new Error("Published source not found.");
    const id = nextId("build");
    const hash = String(sourceRevision).padStart(64, "a");
    const descriptor = {
      hash,
      size: 1,
      contentType: "application/octet-stream",
      fileCount: 1,
    };
    const runtimeProfile = {
      profileId: "mock-runtime",
      contractVersion: "1.0.0",
      semanticVersion: "0.1.20",
      pluginIdentities: [],
      sdkTypesFingerprint: hash,
      profileFingerprint: hash,
    };
    const buildArtifactSet = {
      id,
      buildId: id,
      buildFingerprint: mockFingerprint({ id, sourceRevision }),
      projectId,
      sourceRevision,
      sourceFingerprint: source.spec.fingerprint,
      packageJsonHash: hash,
      dependencyLockHash: hash,
      builderVersion: "offline",
      nodeVersion: "offline",
      pnpmVersion: "offline",
      typescriptVersion: "offline",
      runtimeAbiVersion: "1.0.0",
      runtimeProfile,
      sdkTypesArtifact: descriptor,
      clientEntryExport: "mount",
      serverEntryExport: "actions",
      actionIds: [],
      clientArtifact: descriptor,
      serverArtifact: descriptor,
      buildManifestArtifact: descriptor,
      materialManifests: [],
      materialArtifacts: [],
      testResult: { passed: true, total: 1, failed: 0, reportHash: hash },
      diagnostics: [],
      buildReproducibility: "DETERMINISTIC" as const,
      runtimeReproducibility: "UNKNOWN" as const,
      artifactSetFingerprint: mockFingerprint({ id, artifacts: true }),
    };
    projectArtifactSets.set(id, buildArtifactSet);
    const build: ProjectBuildRequest = {
      id,
      projectId,
      sourceRevision,
      sourceFingerprint: source.spec.fingerprint,
      status: "SUCCESS",
      requestedBy: "studio-builder",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      diagnostics: [],
    };
    projectBuilds.push(build);
    return cloneValue(build);
  },
  async listProjectBuilds(projectId) {
    return cloneValue(projectBuilds.filter((item) => item.projectId === projectId));
  },
  async getProjectBuildLog() {
    return [
      "pnpm install PASS",
      "TS7 typecheck PASS",
      "Vitest PASS",
      "Vite client build PASS",
      "esbuild server build PASS",
    ];
  },
  async listProjectReleases(projectId) {
    return cloneValue(projectReleases.filter((item) => item.spec.projectId === projectId));
  },
  async composeProjectRelease(projectId, buildId, _changeReason, approvalId) {
    consumeMockApproval(approvalId);
    const existing = projectReleases.find(
      (release) =>
        release.spec.projectId === projectId &&
        release.spec.buildArtifactSet.buildId === buildId &&
        release.spec.visualResources.length === 0,
    );
    if (existing) return cloneValue(existing);
    const buildArtifactSet = projectArtifactSets.get(buildId);
    if (!buildArtifactSet || buildArtifactSet.projectId !== projectId) {
      throw new Error("PROJECT_BUILD_ARTIFACT_SET_UNAVAILABLE");
    }
    const release: Resource<ProjectReleaseDefinition> = {
      id: `${projectId}:release`,
      kind: "project.release",
      name: `${projectId} Release`,
      revision:
        projectReleases.filter((item) => item.spec.projectId === projectId).length + 1,
      status: "published",
      spec: {
        projectId,
        materials: [],
        buildArtifactSet,
        visualResources: [],
        runtimeProfile: buildArtifactSet.runtimeProfile,
        releaseFingerprint: mockFingerprint({ buildId, visualResources: [] }),
        sourceRevision: buildArtifactSet.sourceRevision,
        sourceFingerprint: buildArtifactSet.sourceFingerprint,
        packageJsonHash: buildArtifactSet.packageJsonHash,
        dependencyLockHash: buildArtifactSet.dependencyLockHash,
        builderVersion: buildArtifactSet.builderVersion,
        nodeVersion: buildArtifactSet.nodeVersion,
        pnpmVersion: buildArtifactSet.pnpmVersion,
        runtimeAbiVersion: buildArtifactSet.runtimeAbiVersion,
        clientEntryExport: buildArtifactSet.clientEntryExport,
        serverEntryExport: buildArtifactSet.serverEntryExport,
        actionIds: buildArtifactSet.actionIds,
        clientArtifact: buildArtifactSet.clientArtifact,
        serverArtifact: buildArtifactSet.serverArtifact,
        buildManifestArtifact: buildArtifactSet.buildManifestArtifact,
        materialManifests: buildArtifactSet.materialManifests,
        materialArtifacts: buildArtifactSet.materialArtifacts,
        testResult: buildArtifactSet.testResult,
        diagnostics: buildArtifactSet.diagnostics,
        buildReproducibility: buildArtifactSet.buildReproducibility,
        runtimeReproducibility: buildArtifactSet.runtimeReproducibility,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    projectReleases.push(release);
    return cloneValue(release);
  },
  async listVisualMaterials(buildId) {
    return cloneValue(visualCatalog(buildId));
  },
  async getVisualPipeline() {
    return cloneValue({
      current: visualDraft ?? visualPublished,
      published: visualPublished,
    });
  },
  async validateVisualPipeline(buildId, spec) {
    const validation = validateVisual(spec);
    const catalog = visualCatalog(buildId);
    const diagnostics = [...validation.diagnostics];
    spec.nodes.forEach((node, index) => {
      if (
        !catalog.some(
          (item) =>
            item.exactRef.materialId === node.material.materialId &&
            item.exactRef.manifestFingerprint === node.material.manifestFingerprint,
        )
      ) {
        diagnostics.push({
          code: "VISUAL_PIPELINE_MATERIAL_IDENTITY_MISMATCH",
          severity: "error",
          message: "节点Material不属于当前Build。",
          path: `/nodes/${index}/material`,
        });
      }
    });
    return { valid: diagnostics.length === 0, diagnostics };
  },
  async saveVisualPipelineDraft(_projectId, buildId, spec, expectedUpdatedAt) {
    const current = visualDraft ?? visualPublished;
    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) {
      throw new Error("RESOURCE_CONFLICT");
    }
    const validation = await mockApi.validateVisualPipeline(buildId, spec);
    const unsafe = validation.diagnostics.filter(
      (item) => item.code !== "VISUAL_PIPELINE_CONFIGURATION_INVALID",
    );
    if (unsafe.some((item) => item.severity === "error")) {
      throw new Error(unsafe.map((item) => item.code).join(","));
    }
    const timestamp = new Date().toISOString();
    const publishedSpec: PublishedVisualPipeline = {
      ...cloneValue(spec),
      configurationFingerprint: mockFingerprint(
        spec.nodes.map((node) => ({
          nodeId: node.nodeId,
          configuration: node.configuration,
        })),
      ),
      fingerprint: mockFingerprint(spec),
    };
    visualDraft = {
      id: `${spec.nodes[0]?.material.projectId ?? "project"}:visual-pipeline`,
      kind: "project.visual-pipeline",
      name: spec.name,
      revision: visualDraft?.revision ?? (visualPublished?.revision ?? 0) + 1,
      status: "draft",
      spec: publishedSpec,
      createdAt: visualDraft?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return cloneValue({ resource: visualDraft, validation });
  },
  async diffVisualPipeline(): Promise<VisualPipelineDiff> {
    const draftNodes = new Map(
      (visualDraft?.spec.nodes ?? []).map((node) => [node.nodeId, node]),
    );
    const publishedNodes = new Map(
      (visualPublished?.spec.nodes ?? []).map((node) => [node.nodeId, node]),
    );
    return {
      id: visualDraft?.id ?? visualPublished?.id ?? "visual-pipeline",
      draftRevision: visualDraft?.revision ?? null,
      publishedRevision: visualPublished?.revision ?? null,
      draftFingerprint: visualDraft?.spec.fingerprint ?? null,
      publishedFingerprint: visualPublished?.spec.fingerprint ?? null,
      changedSections: visualDraft ? ["code", "name", "inputs", "nodes", "outputs"] : [],
      addedNodes: [...draftNodes.keys()].filter((id) => !publishedNodes.has(id)),
      removedNodes: [...publishedNodes.keys()].filter((id) => !draftNodes.has(id)),
      changedNodes: [...draftNodes.keys()].filter(
        (id) =>
          publishedNodes.has(id) &&
          mockFingerprint(draftNodes.get(id)) !== mockFingerprint(publishedNodes.get(id)),
      ),
    };
  },
  async publishVisualPipeline(
    projectId,
    buildId,
    revision,
    expectedUpdatedAt,
    expectedPipelineFingerprint,
    _changeReason,
    approvalId,
  ) {
    consumeMockApproval(approvalId);
    if (
      visualDraft === null ||
      visualDraft.revision !== revision ||
      visualDraft.updatedAt !== expectedUpdatedAt ||
      visualDraft.spec.fingerprint !== expectedPipelineFingerprint
    ) {
      throw new Error("VISUAL_PIPELINE_PUBLISH_CONFLICT");
    }
    const validation = await mockApi.validateVisualPipeline(buildId, visualDraft.spec);
    if (!validation.valid)
      throw new Error(validation.diagnostics.map((item) => item.code).join(","));
    const timestamp = new Date().toISOString();
    visualPublished = {
      ...visualDraft,
      status: "published",
      updatedAt: timestamp,
    };
    visualDraft = null;
    const baseRelease = [...projectReleases]
      .reverse()
      .find((item) => item.spec.projectId === projectId);
    if (!baseRelease) throw new Error("PROJECT_BUILD_ARTIFACT_SET_UNAVAILABLE");
    const visualResources = [
      {
        kind: visualPublished.kind,
        resourceId: visualPublished.id,
        revision: visualPublished.revision,
        fingerprint: visualPublished.spec.fingerprint,
      },
    ];
    const release: Resource<ProjectReleaseDefinition> = {
      ...baseRelease,
      revision:
        projectReleases.filter((item) => item.spec.projectId === projectId).length + 1,
      spec: {
        ...baseRelease.spec,
        visualResources,
        releaseFingerprint: mockFingerprint({
          buildId,
          visualResources,
        }),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    projectReleases.push(release);
    return cloneValue({ pipeline: visualPublished, release, validation });
  },
  async getActiveProjectRelease() {
    return cloneValue(activeRelease);
  },
  async activateProjectRelease(projectId, releaseRevision, _expected, _reason, approvalId) {
    consumeMockApproval(approvalId);
    const release = {
      resourceId: `${projectId}:release`,
      revision: releaseRevision,
      fingerprint: String(releaseRevision).padStart(64, "f"),
    };
    activeRelease = {
      id: projectId,
      projectId,
      release,
      releaseIdentity: `${release.resourceId}@${release.revision}:${release.fingerprint}`,
      activatedAt: new Date().toISOString(),
      activatedBy: "studio-builder",
    };
    return cloneValue(activeRelease);
  },
  async invokeProjectAction(projectId, release, actionId, input) {
    const run: ProjectActionRun = {
      id: nextId("run"),
      projectId,
      release,
      actionId,
      status: "SUCCESS",
      inputFingerprint: "i".repeat(64),
      result: input,
      pin: {},
      reproducibility: "DETERMINISTIC",
      createdAt: new Date().toISOString(),
    };
    actionRuns.push(run);
    return cloneValue(run);
  },
  async listProjectReleaseMaterials(projectId, revision) {
    const release = projectReleases.find(
      (item) => item.spec.projectId === projectId && item.revision === revision,
    );
    if (!release) return [];
    return release.spec.materialManifests.flatMap((manifest, index) => {
      const artifact = release.spec.materialArtifacts[index];
      return artifact ? [{ manifest, artifact, status: "BUILT" as const }] : [];
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
    return {
      status: "success",
      outputs: {},
      diagnostics: [],
      trace: emptyTrace,
      planHash: "offline",
    };
  },
};

export type { Diagnostic, ResourceStatus };
