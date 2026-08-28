import type { ArtifactRef } from "@prismengine/contracts-artifact";
import {
  diagnostic,
  type Diagnostic,
  type CallContext,
  type JsonValue,
  type RunPin,
} from "@prismengine/contracts-data";
import {
  defineCapability,
  defineExtensionPoint,
  type Engine,
  type Resource,
  type ValidationResult,
} from "@prismengine/kernel";

/** Authority of the definition only; CODE materials remain usable by visual builders. */
export type MaterialAuthoringMode = "VISUAL" | "CODE";

export type MaterialKind =
  | "formula"
  | "operator"
  | "action"
  | "data-source"
  | "report"
  | "page-component"
  | "field-component";

export type MaterialRuntimeTarget = "client" | "server" | "pipeline";

export interface MaterialManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: MaterialKind;
  readonly authoringMode: MaterialAuthoringMode;
  readonly displayName: string;
  readonly category: string;
  readonly runtimeTarget: MaterialRuntimeTarget;
  readonly inputSchema?: JsonValue;
  readonly outputSchema?: JsonValue;
  readonly configurationSchema?: JsonValue;
  readonly editorSchema?: JsonValue;
  readonly traceProjection?: JsonValue;
  readonly visualOperator?: VisualOperatorContract;
}

export interface CodeProjectDefinition {
  readonly slug: string;
  readonly name: string;
  readonly sourceId: string;
  readonly description?: string;
}

export interface ProjectSourceFile {
  /** NFC-normalized, project-relative POSIX path. */
  readonly path: string;
  readonly mediaType: string;
  /** UTF-8 text normalized to LF before publication. */
  readonly content: string;
}

export interface DeclaredCodeMaterialManifest extends MaterialManifest {
  readonly authoringMode: "CODE";
  readonly entry: string;
  readonly exportName: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface ProjectSourceDefinition {
  readonly projectId: string;
  readonly files: readonly ProjectSourceFile[];
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

export interface DraftMaterialCatalogItem {
  readonly manifest: DeclaredCodeMaterialManifest;
  readonly status: "DECLARED";
  readonly buildStatus: "NOT_BUILT";
}

export type ProjectBuildStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED";

export interface ProjectBuildRequest {
  readonly id: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly status: ProjectBuildStatus;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly releaseId?: string;
  readonly artifactSetId?: string;

  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectTestResult {
  readonly passed: boolean;
  readonly total: number;
  readonly failed: number;
  readonly reportHash: string;
}
export interface ProjectRuntimePluginIdentity {
  readonly pluginId: string;
  readonly semanticVersion: string;
  readonly implementationVersion?: string;
}

export interface ProjectRuntimeProfileIdentity {
  readonly profileId: string;
  readonly contractVersion: string;
  readonly semanticVersion: string;
  readonly pluginIdentities: readonly ProjectRuntimePluginIdentity[];
  readonly sdkTypesFingerprint: string;
  readonly profileFingerprint: string;
}
export interface ProjectRuntimeProfileSdkTypes {
  readonly identity: ProjectRuntimeProfileIdentity;
  readonly artifact: ProjectArtifactDescriptor;
  readonly content: string;
}

export interface ProjectVisualResourceRef {
  readonly kind: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly fingerprint: string;
}
export type VisualExecutionModel = "ROW_MAP" | "FILTER" | "FLAT_MAP" | "AGGREGATE";
export type VisualCardinality =
  | "ONE_TO_ONE"
  | "ONE_TO_ZERO_OR_ONE"
  | "ONE_TO_MANY"
  | "MANY_TO_ONE";
export type VisualGrainEffect = "PRESERVE" | "FILTER_ONLY" | "DECLARE_OUTPUT";

export interface VisualOperatorContract {
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
  readonly configurationSchema: JsonValue;
  readonly editorSchema?: JsonValue;
  readonly executionModel: VisualExecutionModel;
  readonly cardinality: VisualCardinality;
  readonly grainEffect: VisualGrainEffect;
  readonly supportedBackends: readonly string[];
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

export interface VisualPipelineInput {
  readonly name: string;
  readonly schema: JsonValue;
}

export type VisualInputBinding =
  | { readonly kind: "PIPELINE_INPUT"; readonly input: string }
  | { readonly kind: "NODE_OUTPUT"; readonly nodeId: string; readonly output: string };

export interface VisualPipelineNode {
  readonly nodeId: string;
  readonly material: ExactProjectMaterialRef;
  readonly configuration: JsonValue;
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
  readonly materialManifests: readonly DeclaredCodeMaterialManifest[];
  readonly materialArtifacts: readonly ProjectArtifactDescriptor[];
  readonly testResult: ProjectTestResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly buildReproducibility: "DETERMINISTIC" | "BEST_EFFORT";
  readonly runtimeReproducibility: "UNKNOWN" | "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
  readonly artifactSetFingerprint: string;
}


export type ProjectArtifactDescriptor = ArtifactRef;

export interface ProjectReleaseDefinition extends ProjectReleaseManifest {
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
  readonly serverEntryExport: string;
  readonly actionIds: readonly string[];
  readonly clientArtifact: ProjectArtifactDescriptor;
  readonly serverArtifact: ProjectArtifactDescriptor;
  readonly buildManifestArtifact: ProjectArtifactDescriptor;
  readonly materialManifests: readonly DeclaredCodeMaterialManifest[];
  readonly testResult: ProjectTestResult;
  readonly materialArtifacts: readonly ProjectArtifactDescriptor[];
  readonly diagnostics: readonly Diagnostic[];
  readonly buildReproducibility: "DETERMINISTIC" | "BEST_EFFORT";
  readonly runtimeReproducibility: "UNKNOWN" | "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
}

export interface ProjectBuildCapability {
  build(
    context: CallContext,
    projectId: string,
    sourceRevision: number,
  ): Promise<ProjectBuildRequest>;
  getBuild(
    context: CallContext,
    buildId: string,
  ): Promise<ProjectBuildRequest | null>;
  listBuilds(
    context: CallContext,
    projectId: string,
  ): Promise<readonly ProjectBuildRequest[]>;
  artifactSet(
    context: CallContext,
    buildId: string,
  ): Promise<ProjectBuildArtifactSet | null>;
  composeRelease(
    context: CallContext,
    projectId: string,
    buildId: string,
    visualResources: readonly ProjectVisualResourceRef[],
    runtimeProfile: ProjectRuntimeProfileIdentity,
  ): Promise<Resource<ProjectReleaseDefinition>>;
  profileSdkTypes(context: CallContext): Promise<ProjectRuntimeProfileSdkTypes>;

  release(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<ProjectReleaseDefinition> | null>;
  releases(
    context: CallContext,
    projectId: string,
  ): Promise<readonly Resource<ProjectReleaseDefinition>[]>;
  buildLog(
    context: CallContext,
    buildId: string,
  ): Promise<readonly string[]>;
  validateVisualPipeline(
    context: CallContext,
    buildId: string,
    pipeline: VisualPipelineSpec,
  ): Promise<ValidationResult>;
}

export const ProjectBuildCapabilityToken = defineCapability<ProjectBuildCapability>({
  id: "project.build",
  version: "1.0.0",
});
export const PROJECT_RUNTIME_ABI_VERSION = "1.0.0";

export interface ProjectReleaseRef {
  readonly resourceId: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface ProjectClientRuntimeContext<TRoot = unknown> {
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly root: TRoot;
  readonly actions: {
    call(actionId: string, input: JsonValue): Promise<JsonValue>;
  };
  readonly logger: {
    info(value: unknown): void;
    warn(value: unknown): void;
    error(value: unknown): void;
  };
}

export interface ProjectClientModule<TRoot = unknown> {
  mount(context: ProjectClientRuntimeContext<TRoot>): void | Promise<void>;
}

export interface ProjectPrincipal {
  readonly id: string;
  readonly roles: readonly string[];
}

export interface ProjectMaterialRuntimeContext {
  readonly engine: Engine;
  readonly signal?: AbortSignal;
  readonly logger: {
    info(value: unknown): void;
    warn(value: unknown): void;
    error(value: unknown): void;
  };
}

export type ProjectCodeMaterial = (
  input: JsonValue,
  configuration: JsonValue,
  context: ProjectMaterialRuntimeContext,
) => JsonValue | Promise<JsonValue>;

export interface ProjectReleaseMaterialCatalogItem {
  readonly manifest: DeclaredCodeMaterialManifest;
  readonly artifact: ProjectArtifactDescriptor;
  readonly status: "BUILT";
}

export interface ProjectActionContext {
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly principal: ProjectPrincipal;
  readonly engine: Engine;
  readonly signal?: AbortSignal;
  readonly logger: {
    info(value: unknown): void;
    warn(value: unknown): void;
    error(value: unknown): void;
  };
  readonly materials: {
    execute(
      id: string,
      version: string,
      input: JsonValue,
      configuration?: JsonValue,
    ): Promise<JsonValue>;
  };
}

export type ProjectAction = (
  input: JsonValue,
  context: ProjectActionContext,
) => JsonValue | Promise<JsonValue>;

export interface ProjectServerModule {
  readonly actions: Readonly<Record<string, ProjectAction>>;
}


export interface ActiveProjectRelease {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly releaseIdentity: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
}

export interface ProjectReleaseActivation {
  readonly id: string;
  readonly projectId: string;
  readonly previousRelease: ProjectReleaseRef | null;
  readonly nextRelease: ProjectReleaseRef;
  readonly activatedBy: string;
  readonly activatedAt: string;
  readonly reason?: string;
}

export type ProjectRuntimeInstanceStatus =
  | "STARTING"
  | "READY"
  | "DRAINING"
  | "FAILED"
  | "STOPPED";

export interface ProjectRuntimeInstance {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly workerPid: number;
  readonly status: ProjectRuntimeInstanceStatus;
  readonly runtimeProfileFingerprint: string;

  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly stoppedAt?: string;
  readonly exitCode?: number;
  readonly restartCount: number;
  readonly lastError?: string;
}

export interface ProjectActionRun {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly actionId: string;
  readonly runtimeProfileFingerprint: string;

  readonly status: "SUCCESS" | "FAILED";
  readonly inputFingerprint: string;
  readonly result?: JsonValue;
  readonly error?: string;
  readonly pin: RunPin;
  readonly reproducibility: "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
  readonly createdAt: string;
}

export interface ProjectRuntimeLog {
  readonly id: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly sourceFile?: string;
  readonly line?: number;
  readonly column?: number;
  readonly timestamp: string;
}

export interface ProjectRuntimeCapability {
  active(context: CallContext, projectId: string): Promise<ActiveProjectRelease | null>;
  activate(
    context: CallContext,
    projectId: string,
    releaseRevision: number,
    expectedActiveRelease: ProjectReleaseRef | null,
    reason?: string,
  ): Promise<ActiveProjectRelease>;
  invoke(
    context: CallContext,
    projectId: string,
    release: ProjectReleaseRef,
    actionId: string,
    input: JsonValue,
  ): Promise<ProjectActionRun>;
  releaseMaterials(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<readonly ProjectReleaseMaterialCatalogItem[]>;
  executeMaterial(
    context: CallContext,
    projectId: string,
    release: ProjectReleaseRef,
    materialId: string,
    materialVersion: string,
    input: JsonValue,
    configuration?: JsonValue,
  ): Promise<JsonValue>;
  getRun(context: CallContext, runId: string): Promise<ProjectActionRun | null>;
  logs(context: CallContext, projectId: string): Promise<readonly ProjectRuntimeLog[]>;
  listRuns(context: CallContext, projectId: string): Promise<readonly ProjectActionRun[]>;
}

export const ProjectRuntimeCapabilityToken = defineCapability<ProjectRuntimeCapability>({
  id: "project.runtime",
  version: "1.0.0",
});

export interface VisualMaterialSource {
  readonly authoringMode: "VISUAL";
  readonly resource: {
    readonly kind: string;
    readonly id: string;
    readonly revision: number;
    readonly fingerprint: string;
  };
}

export interface CodeMaterialSource {
  readonly authoringMode: "CODE";
  readonly module: {
    readonly projectId: string;
    readonly sourceRevision: number;
    readonly sourceFingerprint: string;
    readonly artifactHash: string;
    readonly dependencyLockHash: string;
  };
}

export type MaterialSource = VisualMaterialSource | CodeMaterialSource;

export interface ProjectMaterialRef {
  readonly materialId: string;
  readonly materialVersion: string;
  readonly source: MaterialSource;
}

export interface ProjectReleaseManifest {
  readonly projectId: string;
  readonly materials: readonly ProjectMaterialRef[];
}

/** Installed Plugin catalog only. Draft and Release catalogs are project-scoped. */
export const MaterialExtensionPoint = defineExtensionPoint<MaterialManifest>({
  id: "project.materials",
  version: "1.0.0",
});

export interface MaterialRegistryCapability {
  /** Design-time browsing; absent version resolves the highest installed version. */
  list(): readonly MaterialManifest[];
  get(id: string, version?: string): MaterialManifest | null;
}

export const MaterialRegistryCapabilityToken =
  defineCapability<MaterialRegistryCapability>({
    id: "project.material-registry",
    version: "1.0.0",
  });

export function validateMaterialManifest(
  manifest: MaterialManifest,
): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  for (const [field, value] of [
    ["id", manifest.id],
    ["version", manifest.version],
    ["displayName", manifest.displayName],
    ["category", manifest.category],
  ] as const) {
    if (value.trim() === "") {
      diagnostics.push(diagnostic(
        "MATERIAL_FIELD_REQUIRED",
        `Material ${field} is required.`,
        { path: `/${field}` },
      ));
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    diagnostics.push(diagnostic(
      "MATERIAL_VERSION_INVALID",
      "Material version must be an exact semantic version.",
      { path: "/version" },
    ));
  }
  if (manifest.visualOperator !== undefined) {
    const visual = manifest.visualOperator;
    if (
      visual.executionModel !== "ROW_MAP" ||
      visual.cardinality !== "ONE_TO_ONE" ||
      visual.grainEffect !== "PRESERVE" ||
      !visual.supportedBackends.includes("calculation.memory")
    ) {
      diagnostics.push(diagnostic(
        "MATERIAL_VISUAL_OPERATOR_UNSUPPORTED",
        "Visual Operator V1 requires ROW_MAP, ONE_TO_ONE, PRESERVE, and calculation.memory.",
        { path: "/visualOperator" },
      ));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
export function validateVisualPipelineSpec(
  pipeline: VisualPipelineSpec,
): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const inputs = new Set(pipeline.inputs.map((input) => input.name));
  const nodes = new Map<string, VisualPipelineNode>();
  pipeline.nodes.forEach((node, index) => {
    if (nodes.has(node.nodeId)) {
      diagnostics.push(diagnostic(
        "VISUAL_PIPELINE_DUPLICATE_NODE",
        "Visual Pipeline nodeId must be unique.",
        { path: `/nodes/${index}/nodeId` },
      ));
    }
    nodes.set(node.nodeId, node);
    const exact = node.material;
    if ([
      exact.buildFingerprint,
      exact.sourceFingerprint,
      exact.dependencyLockHash,
      exact.artifactHash,
      exact.manifestFingerprint,
    ].some((value) => !/^[0-9a-f]{64}$/.test(value))) {
      diagnostics.push(diagnostic(
        "VISUAL_PIPELINE_MATERIAL_REF_INVALID",
        "Visual Pipeline Material references must use exact SHA-256 identities.",
        { path: `/nodes/${index}/material` },
      ));
    }
  });
  const dependencies = new Map<string, Set<string>>();
  pipeline.nodes.forEach((node, index) => {
    const refs = new Set<string>();
    for (const binding of Object.values(node.inputBindings)) {
      if (binding.kind === "PIPELINE_INPUT") {
        if (!inputs.has(binding.input)) {
          diagnostics.push(diagnostic(
            "VISUAL_PIPELINE_INPUT_UNAVAILABLE",
            "Visual Pipeline binding references an unknown input.",
            { path: `/nodes/${index}/inputBindings` },
          ));
        }
      } else {
        refs.add(binding.nodeId);
        if (!nodes.has(binding.nodeId)) {
          diagnostics.push(diagnostic(
            "VISUAL_PIPELINE_NODE_UNAVAILABLE",
            "Visual Pipeline binding references an unknown node.",
            { path: `/nodes/${index}/inputBindings` },
          ));
        }
      }
    }
    dependencies.set(node.nodeId, refs);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if ([...nodes.keys()].some(visit)) {
    diagnostics.push(diagnostic(
      "VISUAL_PIPELINE_CYCLE",
      "Visual Pipeline graph must be acyclic.",
      { path: "/nodes" },
    ));
  }
  return { valid: diagnostics.length === 0, diagnostics };
}


export function validateProjectReleaseManifest(
  release: ProjectReleaseManifest,
): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const identities = new Set<string>();
  release.materials.forEach((material, index) => {
    const identity = `${material.materialId}\u0000${material.materialVersion}`;
    if (identities.has(identity)) {
      diagnostics.push(diagnostic(
        "PROJECT_RELEASE_DUPLICATE_MATERIAL",
        "Project Release contains a duplicate Material identity.",
        { path: `/materials/${index}` },
      ));
    }
    identities.add(identity);
    const fingerprints = material.source.authoringMode === "VISUAL"
      ? [material.source.resource.fingerprint]
      : [
          material.source.module.sourceFingerprint,
          material.source.module.artifactHash,
          material.source.module.dependencyLockHash,
        ];
    if (fingerprints.some((value) => !/^[0-9a-f]{64}$/.test(value))) {
      diagnostics.push(diagnostic(
        "PROJECT_RELEASE_FINGERPRINT_INVALID",
        "Project Material references must use SHA-256 fingerprints.",
        { path: `/materials/${index}/source` },
      ));
    }
  });
  return { valid: diagnostics.length === 0, diagnostics };
}
