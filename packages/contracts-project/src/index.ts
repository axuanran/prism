import {
  diagnostic,
  type Diagnostic,
  type CallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  defineCapability,
  defineExtensionPoint,
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
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectTestResult {
  readonly passed: boolean;
  readonly total: number;
  readonly failed: number;
  readonly reportHash: string;
}

export interface ProjectArtifactDescriptor {
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
  readonly storageKey: string;
}

export interface ProjectReleaseDefinition extends ProjectReleaseManifest {
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
  readonly testResult: ProjectTestResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly reproducibility: "DETERMINISTIC" | "BEST_EFFORT" | "NON_DETERMINISTIC";
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
}

export const ProjectBuildCapabilityToken = defineCapability<ProjectBuildCapability>({
  id: "project.build",
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
