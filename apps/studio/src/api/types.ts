export type DiagnosticSeverity = "info" | "warning" | "error";

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
  readonly "x-prism-decimal"?: boolean;
  readonly "x-prism-semantic"?: string;
  readonly "x-prism-reference"?: string | Readonly<{ kind?: string }>;
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

export type ResourceStatus = "draft" | "published" | "archived";

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
  readonly status: "active" | "inactive";
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
  readonly kind: "primary" | "secondary";
  readonly effectivePeriod: { readonly from: string; readonly through?: string };
}

export interface PortDefinition {
  readonly name: string;
  readonly kind: "table" | "scalar";
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
  readonly kind: "table";
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
  readonly phase: "ok" | "skipped" | "error";
  readonly inputRows: number;
  readonly outputRows: number;
  readonly durationMs: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ExecutionTrace {
  readonly level: "none" | "errors" | "summary" | "full";
  readonly nodes: readonly NodeTrace[];
  readonly totalDurationMs: number;
}

export interface PipelineExecutionResponse {
  readonly status: "success" | "failed";
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
    readonly authoringMode: "CODE";
    readonly displayName: string;
    readonly category: string;
    readonly runtimeTarget: string;
    readonly entry: string;
    readonly exportName: string;
  };
  readonly status: "DECLARED";
  readonly buildStatus: "NOT_BUILT";
}

export interface ProjectSourceDiff {
  readonly projectId: string;
  readonly from: number | "draft";
  readonly to: number | "draft";
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
  readonly status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly releaseId?: string;
  readonly diagnostics: readonly Diagnostic[];
}
export interface ExactProjectMaterialRef {
  readonly projectId: string;
  readonly buildId: string;
  readonly buildFingerprint: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly dependencyLockHash: string;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly artifactHash: string;
  readonly manifestFingerprint: string;
}

export interface VisualOperatorContract {
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly configurationSchema: unknown;
  readonly editorSchema?: unknown;
  readonly executionModel: string;
  readonly cardinality: string;
  readonly grainEffect: string;
  readonly supportedBackends: readonly string[];
}

export interface CodeMaterialManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly authoringMode: "CODE";
  readonly displayName: string;
  readonly category: string;
  readonly runtimeTarget: string;
  readonly entry: string;
  readonly exportName: string;
  readonly visualOperator?: VisualOperatorContract;
}

export interface VisualMaterialManifest extends CodeMaterialManifest {
  readonly visualOperator: VisualOperatorContract;
}

export type VisualPropertyControl =
  | "string"
  | "boolean"
  | "enum"
  | "integer"
  | "decimal-string"
  | "field-reference"
  | "dataset-reference"
  | "material-reference"
  | "array"
  | "object";

export interface VisualPropertyField {
  readonly path: string;
  readonly label: string;
  readonly control: VisualPropertyControl;
  readonly required: boolean;
  readonly enumValues?: readonly unknown[];
}

export interface VisualMaterialCatalogItem {
  readonly manifest: VisualMaterialManifest;
  readonly exactRef: ExactProjectMaterialRef;
  readonly visualPropertyFields: readonly VisualPropertyField[];
}

export interface VisualPipelineInput {
  readonly name: string;
  readonly schema: unknown;
}

export type VisualInputBinding =
  | { readonly kind: "PIPELINE_INPUT"; readonly input: string }
  | { readonly kind: "NODE_OUTPUT"; readonly nodeId: string; readonly output: string };

export interface VisualPipelineNode {
  readonly nodeId: string;
  readonly material: ExactProjectMaterialRef;
  readonly configuration: unknown;
  readonly inputBindings: Readonly<Record<string, VisualInputBinding>>;
  readonly outputAliases?: Readonly<Record<string, string>>;
}

export interface VisualPipelineOutput {
  readonly name: string;
  readonly binding: VisualInputBinding;
}

export interface VisualPipelineSpec {
  readonly schemaVersion: "1.0.0";
  readonly code: string;
  readonly name: string;
  readonly inputs: readonly VisualPipelineInput[];
  readonly nodes: readonly VisualPipelineNode[];
  readonly outputs: readonly VisualPipelineOutput[];
}

export interface PublishedVisualPipeline extends VisualPipelineSpec {
  readonly configurationFingerprint: string;
  readonly fingerprint: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface VisualPipelineState {
  readonly current: Resource<PublishedVisualPipeline> | null;
  readonly published: Resource<PublishedVisualPipeline> | null;
}

export interface VisualPipelineDraftResponse {
  readonly resource: Resource<PublishedVisualPipeline>;
  readonly validation: ValidationResult;
}

export interface VisualPipelineDiff {
  readonly id: string;
  readonly draftRevision: number | null;
  readonly publishedRevision: number | null;
  readonly draftFingerprint: string | null;
  readonly publishedFingerprint: string | null;
  readonly changedSections: readonly ("code" | "name" | "inputs" | "nodes" | "outputs")[];
  readonly addedNodes: readonly string[];
  readonly removedNodes: readonly string[];
  readonly changedNodes: readonly string[];
}

export interface ProjectArtifactDescriptor {
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
  readonly fileCount: number;
}
export interface ProjectRuntimeProfileIdentity {
  readonly profileId: string;
  readonly contractVersion: string;
  readonly semanticVersion: string;
  readonly pluginIdentities: readonly {
    readonly pluginId: string;
    readonly semanticVersion: string;
    readonly implementationVersion?: string;
  }[];
  readonly sdkTypesFingerprint: string;
  readonly profileFingerprint: string;
}

export interface ProjectBuildArtifactSet {
  readonly id: string;
  readonly buildId: string;
  readonly buildFingerprint: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly packageJsonHash: string;
  readonly dependencyLockHash: string;
  readonly builderVersion: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly typescriptVersion: string;
  readonly runtimeAbiVersion: string;
  readonly runtimeProfile: ProjectRuntimeProfileIdentity;
  readonly sdkTypesArtifact: ProjectArtifactDescriptor;
  readonly clientEntryExport: string;
  readonly serverEntryExport: string;
  readonly actionIds: readonly string[];
  readonly clientArtifact: ProjectArtifactDescriptor;
  readonly serverArtifact: ProjectArtifactDescriptor;
  readonly buildManifestArtifact: ProjectArtifactDescriptor;
  readonly materialManifests: readonly CodeMaterialManifest[];
  readonly materialArtifacts: readonly ProjectArtifactDescriptor[];
  readonly testResult: {
    readonly passed: boolean;
    readonly total: number;
    readonly failed: number;
    readonly reportHash: string;
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly buildReproducibility: "DETERMINISTIC" | "BEST_EFFORT";
  readonly runtimeReproducibility:
    "UNKNOWN" | "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
  readonly artifactSetFingerprint: string;
}

export interface ProjectVisualResourceRef {
  readonly kind: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface ProjectReleaseDefinition {
  readonly projectId: string;
  readonly materials: readonly unknown[];
  readonly buildArtifactSet: ProjectBuildArtifactSet;
  readonly visualResources: readonly ProjectVisualResourceRef[];
  readonly runtimeProfile: ProjectRuntimeProfileIdentity;
  readonly releaseFingerprint: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly packageJsonHash: string;
  readonly dependencyLockHash: string;
  readonly builderVersion: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly runtimeAbiVersion: string;
  readonly clientEntryExport: string;
  readonly actionIds: readonly string[];
  readonly serverEntryExport: string;
  readonly clientArtifact: ProjectArtifactDescriptor;
  readonly serverArtifact: ProjectArtifactDescriptor;
  readonly materialManifests: readonly CodeMaterialManifest[];
  readonly buildManifestArtifact: ProjectArtifactDescriptor;
  readonly materialArtifacts: readonly ProjectArtifactDescriptor[];
  readonly testResult: {
    readonly passed: boolean;
    readonly total: number;
    readonly failed: number;
    readonly reportHash: string;
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly buildReproducibility: "DETERMINISTIC" | "BEST_EFFORT";
  readonly runtimeReproducibility:
    "UNKNOWN" | "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
}
export interface VisualPipelinePublishResponse {
  readonly pipeline: Resource<PublishedVisualPipeline>;
  readonly release: Resource<ProjectReleaseDefinition>;
  readonly validation: ValidationResult;
}

export interface ProjectReleaseMaterialCatalogItem {
  readonly manifest: CodeMaterialManifest;
  readonly artifact: ProjectArtifactDescriptor;
  readonly status: "BUILT";
}

export interface ProjectReleaseRef {
  readonly resourceId: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface ActiveProjectRelease {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly releaseIdentity: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
}

export interface ProjectActionRun {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly actionId: string;
  readonly status: "SUCCESS" | "FAILED";
  readonly inputFingerprint: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly pin: Readonly<Record<string, unknown>>;
  readonly reproducibility: "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
  readonly createdAt: string;
}

export interface ProjectRuntimeLog {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly timestamp: string;
}

export interface ApprovalTarget {
  readonly permission: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly changeReason: string;
}

export interface ChangeApproval {
  readonly id: string;
  readonly target: {
    readonly permission: string;
    readonly method: "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly fingerprint: string;
  };
  readonly requesterId: string;
  readonly reviewerId?: string;
  readonly publisherId?: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED";
  readonly version: number;
  readonly requestReason: string;
  readonly reviewReason?: string;
  readonly executionCorrelationId?: string;
  readonly executionOutcome?: "PENDING" | "SUCCEEDED" | "FAILED";
  readonly createdAt: string;
  readonly reviewedAt?: string;
  readonly consumedAt?: string;
  readonly expiresAt: string;
}

export interface StudioApi {
  listApprovals(status?: ChangeApproval["status"]): Promise<readonly ChangeApproval[]>;
  requestApproval(
    target: ApprovalTarget,
    reason: string,
    expiresInSeconds?: number,
  ): Promise<ChangeApproval>;
  reviewApproval(
    id: string,
    expectedVersion: number,
    decision: "APPROVE" | "REJECT",
    reason: string,
  ): Promise<ChangeApproval>;
  health(): Promise<{ readonly status: "ok" }>;
  inspectEngine(): Promise<EngineInspection>;
  listResourceTypes(): Promise<readonly ResourceTypeDescriptor[]>;
  listResources(query?: {
    readonly kind?: string;
    readonly status?: ResourceStatus;
  }): Promise<readonly Resource[]>;
  getResource(kind: string, id: string): Promise<Resource>;
  listResourceRevisions(kind: string, id: string): Promise<readonly Resource[]>;
  createResource(
    kind: string,
    body: { readonly id?: string; readonly name: string; readonly spec: unknown },
  ): Promise<Resource>;
  publishResource(
    kind: string,
    id: string,
    revision: number,
    changeReason: string,
    approvalId: string,
  ): Promise<Resource>;
  cloneResource(kind: string, id: string, revision?: number): Promise<Resource>;
  archiveResource(
    kind: string,
    id: string,
    changeReason: string,
    approvalId: string,
  ): Promise<{ readonly status: "archived" }>;
  listPeople(): Promise<readonly Person[]>;
  createPerson(
    body: {
      readonly employeeNumber: string;
      readonly displayName: string;
      readonly title?: string;
    },
    changeReason: string,
    approvalId: string,
  ): Promise<Person>;
  listUnits(): Promise<readonly OrganizationUnit[]>;
  createUnit(
    body: {
      readonly code: string;
      readonly name: string;
      readonly parentId?: string;
      readonly from: string;
      readonly through?: string;
    },
    changeReason: string,
    approvalId: string,
  ): Promise<OrganizationUnit>;
  listAssignments(): Promise<readonly Assignment[]>;
  createAssignment(
    body: {
      readonly personId: string;
      readonly organizationUnitId: string;
      readonly positionId?: string;
      readonly kind: "primary" | "secondary";
      readonly from: string;
      readonly through?: string;
    },
    changeReason: string,
    approvalId: string,
  ): Promise<Assignment>;
  listOperations(): Promise<readonly OperationDescriptor[]>;
  validatePipeline(
    spec: PipelineSpec,
  ): Promise<{ readonly valid: boolean; readonly diagnostics: readonly Diagnostic[] }>;
  executePipeline(
    spec: PipelineSpec,
    inputs?: Readonly<Record<string, DatasetPayload>>,
  ): Promise<PipelineExecutionResponse>;
  listCodeProjects(): Promise<readonly Resource<CodeProjectSpec>[]>;
  createCodeProject(body: {
    readonly id?: string;
    readonly slug: string;
    readonly name: string;
    readonly description?: string;
  }): Promise<{
    readonly project: Resource<CodeProjectSpec>;
    readonly draft: ProjectSourceDraft;
  }>;
  getProjectSourceDraft(projectId: string): Promise<ProjectSourceDraft>;
  saveProjectSourceDraft(
    projectId: string,
    draftVersion: number,
    files: readonly ProjectSourceFile[],
  ): Promise<ProjectSourceDraft>;
  listDraftMaterials(projectId: string): Promise<readonly DraftMaterialCatalogItem[]>;
  publishProjectSource(
    projectId: string,
    draftVersion: number,
    changeReason: string,
    approvalId: string,
  ): Promise<Resource<PublishedProjectSource>>;
  listProjectSourceRevisions(
    projectId: string,
  ): Promise<readonly Resource<PublishedProjectSource>[]>;
  diffProjectSource(
    projectId: string,
    from: number | "draft",
    to: number | "draft",
  ): Promise<ProjectSourceDiff>;
  buildProject(projectId: string, sourceRevision: number): Promise<ProjectBuildRequest>;
  listProjectBuilds(projectId: string): Promise<readonly ProjectBuildRequest[]>;
  getProjectBuildLog(buildId: string): Promise<readonly string[]>;
  listProjectReleases(
    projectId: string,
  ): Promise<readonly Resource<ProjectReleaseDefinition>[]>;
  composeProjectRelease(
    projectId: string,
    buildId: string,
    changeReason: string,
    approvalId: string,
  ): Promise<Resource<ProjectReleaseDefinition>>;
  listVisualMaterials(
    buildId: string,
    signal?: AbortSignal,
  ): Promise<readonly VisualMaterialCatalogItem[]>;
  getVisualPipeline(projectId: string, signal?: AbortSignal): Promise<VisualPipelineState>;
  validateVisualPipeline(
    buildId: string,
    spec: VisualPipelineSpec,
    signal?: AbortSignal,
  ): Promise<ValidationResult>;
  saveVisualPipelineDraft(
    projectId: string,
    buildId: string,
    spec: VisualPipelineSpec,
    expectedUpdatedAt: string | null,
    signal?: AbortSignal,
  ): Promise<VisualPipelineDraftResponse>;
  diffVisualPipeline(projectId: string, signal?: AbortSignal): Promise<VisualPipelineDiff>;
  publishVisualPipeline(
    projectId: string,
    buildId: string,
    revision: number,
    expectedUpdatedAt: string,
    expectedPipelineFingerprint: string,
    changeReason: string,
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<VisualPipelinePublishResponse>;
  getActiveProjectRelease(projectId: string): Promise<ActiveProjectRelease | null>;
  activateProjectRelease(
    projectId: string,
    releaseRevision: number,
    expectedActiveRelease: ProjectReleaseRef | null,
    changeReason: string,
    approvalId: string,
  ): Promise<ActiveProjectRelease>;
  invokeProjectAction(
    projectId: string,
    release: ProjectReleaseRef,
    actionId: string,
    input: unknown,
  ): Promise<ProjectActionRun>;
  listProjectActionRuns(projectId: string): Promise<readonly ProjectActionRun[]>;
  listProjectRuntimeLogs(projectId: string): Promise<readonly ProjectRuntimeLog[]>;
  listProjectReleaseMaterials(
    projectId: string,
    revision: number,
  ): Promise<readonly ProjectReleaseMaterialCatalogItem[]>;
  executeProjectMaterial(
    projectId: string,
    release: ProjectReleaseRef,
    materialId: string,
    version: string,
    input: unknown,
    configuration?: unknown,
  ): Promise<unknown>;
}
