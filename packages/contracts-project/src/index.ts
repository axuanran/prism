import {
  diagnostic,
  type Diagnostic,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  defineCapability,
  defineExtensionPoint,
  type ValidationResult,
} from "@prismengine/kernel";

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

/** Plugins contribute executable or visual materials through one registry. */
export const MaterialExtensionPoint = defineExtensionPoint<MaterialManifest>({
  id: "project.materials",
  version: "1.0.0",
});

export interface MaterialRegistryCapability {
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
