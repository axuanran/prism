export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly nodeId?: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface JsonSchema {
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly definitions?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly format?: string;
  readonly default?: unknown;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly editor?: string;
  readonly semantic?: string;
  readonly annotations?: Readonly<{ semantic?: string }>;
  readonly 'x-prism-decimal'?: boolean;
  readonly 'x-prism-semantic'?: string;
  readonly 'x-prism-reference'?: string | Readonly<{ kind?: string }>;
  readonly [key: string]: unknown;
}

export interface FieldPresentation {
  readonly label?: string;
  readonly help?: string;
  readonly placeholder?: string;
  readonly group?: string;
  readonly order?: number;
  readonly widget?: string;
  readonly editor?: string;
  readonly hidden?: boolean;
  readonly readonly?: boolean;
  readonly editorOptions?: Readonly<Record<string, unknown>>;
}

export interface PresentationGroup {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly order?: number;
  readonly collapsed?: boolean;
}

export interface PresentationSpec {
  readonly title?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly groups?: readonly PresentationGroup[];
  readonly fields?: Readonly<Record<string, FieldPresentation>>;
  readonly editor?: string;
}

export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly provides: readonly string[];
  readonly requires: readonly {
    readonly key: string;
    readonly capabilityId: string;
    readonly range: string;
    readonly optional: boolean;
    readonly resolvedTo?: string;
  }[];
  readonly resourceKinds: readonly string[];
}

export interface EngineInspection {
  readonly phase: string;
  readonly engineVersion: string;
  readonly startOrder: readonly string[];
  readonly plugins: readonly PluginInfo[];
  readonly capabilities: readonly {
    readonly id: string;
    readonly version: string;
    readonly providedBy: string;
  }[];
  readonly resourceTypes: readonly {
    readonly kind: string;
    readonly title: string;
    readonly description?: string;
  }[];
  readonly extensionPoints: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ResourceStatus = 'draft' | 'published' | 'archived';

export interface Resource<TSpec = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly revision: number;
  readonly status: ResourceStatus;
  readonly spec: TSpec;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResourceTypeDescriptor {
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly schema: JsonSchema;
  readonly presentation?: PresentationSpec;
  readonly exposure: Readonly<Record<string, boolean | undefined>>;
}

export interface Person {
  readonly id: string;
  readonly employeeNumber: string;
  readonly displayName: string;
  readonly status: 'active' | 'inactive';
  readonly title?: string;
}

export interface OrganizationUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId?: string;
  readonly effectivePeriod: { readonly from: string; readonly through?: string };
}

export interface Assignment {
  readonly id: string;
  readonly personId: string;
  readonly organizationUnitId: string;
  readonly positionId?: string;
  readonly kind: 'primary' | 'secondary';
  readonly effectivePeriod: { readonly from: string; readonly through?: string };
}

export interface PortDefinition {
  readonly name: string;
  readonly kind: 'table' | 'scalar';
  readonly required: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface OperationDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly inputs: readonly PortDefinition[];
  readonly outputs: readonly PortDefinition[];
  readonly configSchema: JsonSchema;
  readonly presentation?: PresentationSpec;
}

export interface TableType {
  readonly kind: 'table';
  readonly columns: readonly {
    readonly name: string;
    readonly type: Readonly<Record<string, unknown>>;
  }[];
}

export interface PipelineSpec {
  readonly id: string;
  readonly inputs: readonly {
    readonly name: string;
    readonly schema: TableType;
    readonly description?: string;
  }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly operation: string;
    readonly config: unknown;
    readonly label?: string;
    readonly position?: { readonly x: number; readonly y: number };
  }[];
  readonly edges: readonly {
    readonly fromNode: string;
    readonly fromPort: string;
    readonly toNode: string;
    readonly toPort: string;
  }[];
  readonly outputs: readonly {
    readonly name: string;
    readonly fromNode: string;
    readonly fromPort: string;
    readonly description?: string;
  }[];
}

export interface DatasetPayload {
  readonly columns: readonly { readonly name: string; readonly kind: string }[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly truncated?: boolean;
}

export interface NodeTrace {
  readonly nodeId: string;
  readonly operation: string;
  readonly label?: string;
  readonly phase: 'ok' | 'skipped' | 'error';
  readonly inputRows: number;
  readonly outputRows: number;
  readonly durationMs: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ExecutionTrace {
  readonly level: 'none' | 'errors' | 'summary' | 'full';
  readonly nodes: readonly NodeTrace[];
  readonly totalDurationMs: number;
}

export interface PipelineExecutionResponse {
  readonly status: 'success' | 'failed';
  readonly outputs: Readonly<Record<string, DatasetPayload>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly trace: ExecutionTrace;
  readonly planHash: string;
}

export interface CodeProjectSpec {
  readonly slug: string;
  readonly name: string;
  readonly sourceId: string;
  readonly description?: string;
}

export interface ProjectSourceFile {
  readonly path: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface ProjectSourceDraft {
  readonly id: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly baseSourceRevision: number | null;
  readonly draftVersion: number;
  readonly files: readonly ProjectSourceFile[];
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface PublishedProjectSource {
  readonly projectId: string;
  readonly fingerprint: string;
  readonly files: readonly ProjectSourceFile[];
}

export interface DraftMaterialCatalogItem {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
    readonly kind: string;
    readonly authoringMode: 'CODE';
    readonly displayName: string;
    readonly category: string;
    readonly runtimeTarget: string;
    readonly entry: string;
    readonly exportName: string;
  };
  readonly status: 'DECLARED';
  readonly buildStatus: 'NOT_BUILT';
}

export interface ProjectSourceDiff {
  readonly projectId: string;
  readonly from: number | 'draft';
  readonly to: number | 'draft';
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly materialChanges: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
}

export interface ProjectBuildRequest {
  readonly id: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly releaseId?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectArtifactDescriptor {
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
  readonly storageKey: string;
}

export interface ProjectReleaseDefinition {
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly packageJsonHash: string;
  readonly dependencyLockHash: string;
  readonly builderVersion: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly clientArtifact: ProjectArtifactDescriptor;
  readonly serverArtifact: ProjectArtifactDescriptor;
  readonly buildManifestArtifact: ProjectArtifactDescriptor;
  readonly testResult: {
    readonly passed: boolean;
    readonly total: number;
    readonly failed: number;
    readonly reportHash: string;
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly reproducibility: 'DETERMINISTIC' | 'BEST_EFFORT' | 'NON_DETERMINISTIC';
  readonly materials: readonly unknown[];
}

export interface StudioApi {
  health(): Promise<{ readonly status: 'ok' }>;
  inspectEngine(): Promise<EngineInspection>;
  listResourceTypes(): Promise<readonly ResourceTypeDescriptor[]>;
  listResources(query?: { readonly kind?: string; readonly status?: ResourceStatus }): Promise<readonly Resource[]>;
  getResource(kind: string, id: string): Promise<Resource>;
  listResourceRevisions(kind: string, id: string): Promise<readonly Resource[]>;
  createResource(kind: string, body: { readonly id?: string; readonly name: string; readonly spec: unknown }): Promise<Resource>;
  publishResource(kind: string, id: string, revision: number): Promise<Resource>;
  cloneResource(kind: string, id: string, revision?: number): Promise<Resource>;
  archiveResource(kind: string, id: string): Promise<{ readonly status: 'archived' }>;
  listPeople(): Promise<readonly Person[]>;
  createPerson(body: { readonly employeeNumber: string; readonly displayName: string; readonly title?: string }): Promise<Person>;
  listUnits(): Promise<readonly OrganizationUnit[]>;
  createUnit(body: { readonly code: string; readonly name: string; readonly parentId?: string; readonly from: string; readonly through?: string }): Promise<OrganizationUnit>;
  listAssignments(): Promise<readonly Assignment[]>;
  createAssignment(body: { readonly personId: string; readonly organizationUnitId: string; readonly positionId?: string; readonly kind: 'primary' | 'secondary'; readonly from: string; readonly through?: string }): Promise<Assignment>;
  listOperations(): Promise<readonly OperationDescriptor[]>;
  validatePipeline(spec: PipelineSpec): Promise<{ readonly valid: boolean; readonly diagnostics: readonly Diagnostic[] }>;
  executePipeline(spec: PipelineSpec, inputs?: Readonly<Record<string, DatasetPayload>>): Promise<PipelineExecutionResponse>;
  listCodeProjects(): Promise<readonly Resource<CodeProjectSpec>[]>;
  createCodeProject(body: { readonly id?: string; readonly slug: string; readonly name: string; readonly description?: string }): Promise<{ readonly project: Resource<CodeProjectSpec>; readonly draft: ProjectSourceDraft }>;
  getProjectSourceDraft(projectId: string): Promise<ProjectSourceDraft>;
  saveProjectSourceDraft(projectId: string, draftVersion: number, files: readonly ProjectSourceFile[]): Promise<ProjectSourceDraft>;
  listDraftMaterials(projectId: string): Promise<readonly DraftMaterialCatalogItem[]>;
  publishProjectSource(projectId: string, draftVersion: number): Promise<Resource<PublishedProjectSource>>;
  listProjectSourceRevisions(projectId: string): Promise<readonly Resource<PublishedProjectSource>[]>;
  diffProjectSource(projectId: string, from: number | 'draft', to: number | 'draft'): Promise<ProjectSourceDiff>;
  buildProject(projectId: string, sourceRevision: number): Promise<ProjectBuildRequest>;
  listProjectBuilds(projectId: string): Promise<readonly ProjectBuildRequest[]>;
  getProjectBuildLog(buildId: string): Promise<readonly string[]>;
  listProjectReleases(projectId: string): Promise<readonly Resource<ProjectReleaseDefinition>[]>;
}
