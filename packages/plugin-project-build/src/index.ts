import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import {
  ArtifactStoreCapabilityToken,
  type ArtifactRef,
  type ArtifactStoreCapability,
} from "@prismengine/contracts-artifact";
import {
  PrismError,
  diagnostic,
  hasErrors,
  systemCallContext,
  type CallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  ProjectBuildCapabilityToken,
  PROJECT_RUNTIME_ABI_VERSION,
  validateProjectReleaseManifest,
  validateVisualPipelineSpec,
  visualPropertyFields,
  type DeclaredCodeMaterialManifest,
  type ProjectArtifactDescriptor,
  type ProjectBuildArtifactSet,
  type ProjectBuildCapability,
  type ProjectBuildRequest,
  type ProjectMaterialRef,
  type ProjectReleaseDefinition,
  type ProjectRuntimeProfileIdentity,
  type ProjectTestResult,
  type ProjectRuntimeProfileSdkTypes,
  type ProjectVisualResourceRef,
  type VisualPipelineSpec,
  type VisualMaterialCatalogItem,
} from "@prismengine/contracts-project";
import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
  type AtomicDocument,
  type AtomicWriteCapability,
  type AtomicWriteOperation,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import {
  WorkerLauncherCapabilityToken,
  createWorkerStderrCollector,
  type WorkerLauncherCapability,
} from "@prismengine/contracts-worker";
import {
  definePlugin,
  type Resource,
  type ResourceTypeDefinition,
  type ValidationResult,
} from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  VISUAL_PIPELINE_KIND,
  fingerprintVisualConfiguration,
  fingerprintVisualPipeline,
  type CodeProjectCapability,
  type PublishedProjectSource,
  type PublishedVisualPipeline,
} from "@prismengine/plugin-code-project";
import { HttpRouteExtensionPoint, type HttpRoute } from "@prismengine/plugin-http-fastify";
import { boundBuildWorkerResponse } from "./build-limits.js";
import type {
  BuildWorkerRequest,
  BuildWorkerResponse,
  BuildWorkerSuccess,
} from "./protocol.js";

export const PROJECT_RELEASE_KIND = "project.release";
const BUILD_WORKER_TIMEOUT_MS = 15 * 60_000;
const BUILD_WORKER_MAX_OLD_SPACE_MB = 1_024;
const BUILD_COLLECTION = "project.build-requests";
const BUILD_LOG_COLLECTION = "project.build-logs";
const ARTIFACT_SET_COLLECTION = "project.build-artifact-sets";
const ARTIFACT_COLLECTION = "project.artifacts";
const BUILDER_VERSION = "0.1.20";

const ProjectReleaseSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    materials: Type.Array(Type.Any()),
    buildArtifactSet: Type.Any(),
    visualResources: Type.Array(Type.Any()),
    runtimeProfile: Type.Any(),
    releaseFingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sourceRevision: Type.Integer({ minimum: 1 }),
    sourceFingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    packageJsonHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    dependencyLockHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    builderVersion: Type.String({ minLength: 1 }),
    nodeVersion: Type.String({ minLength: 1 }),
    pnpmVersion: Type.String({ minLength: 1 }),
    runtimeAbiVersion: Type.String({ minLength: 1 }),
    clientEntryExport: Type.String({ minLength: 1 }),
    actionIds: Type.Array(Type.String()),
    serverEntryExport: Type.String({ minLength: 1 }),
    clientArtifact: Type.Any(),
    serverArtifact: Type.Any(),
    buildManifestArtifact: Type.Any(),
    materialArtifacts: Type.Array(Type.Any()),
    materialManifests: Type.Array(Type.Any()),
    testResult: Type.Any(),
    diagnostics: Type.Array(Type.Any()),
    buildReproducibility: Type.Union([
      Type.Literal("DETERMINISTIC"),
      Type.Literal("BEST_EFFORT"),
    ]),
    runtimeReproducibility: Type.Union([
      Type.Literal("UNKNOWN"),
      Type.Literal("DETERMINISTIC"),
      Type.Literal("BEST_EFFORT"),
      Type.Literal("NON_DETERMINISTIC"),
    ]),
  },
  { additionalProperties: false },
);

export const ProjectReleaseResource: ResourceTypeDefinition<ProjectReleaseDefinition> = {
  kind: PROJECT_RELEASE_KIND,
  title: "Project Release",
  description: "Immutable tested source, toolchain and content-addressed artifacts.",
  config: {
    schema: ProjectReleaseSchema,
    validate: validateProjectReleaseManifest,
  },
  exposure: { configuration: false, frontend: true },
};

interface BuildLogDocument {
  readonly id: string;
  readonly lines: readonly string[];
}

interface ArtifactDocument extends ProjectArtifactDescriptor {
  readonly id: string;
  readonly createdAt: string;
}

interface StoredBuildArtifacts {
  readonly client: ArtifactRef;
  readonly server: ArtifactRef;
  readonly testReport: ArtifactRef;
  readonly buildManifest: ArtifactRef;
  readonly sdkTypes: ArtifactRef;
  readonly testResult: ProjectTestResult;
  readonly materials: readonly {
    readonly manifest: DeclaredCodeMaterialManifest;
    readonly artifact: ArtifactRef;
  }[];
  readonly descriptors: readonly ArtifactRef[];
}

export function projectBuildPlugin(
  options: {
    readonly runtimeProfile?: ProjectRuntimeProfileIdentity;
    readonly sdkTypes?: string;
  } = {},
) {
  return definePlugin({
    id: "project.build",
    version: BUILDER_VERSION,
    engineRange: "^0.1.20",
    requires: {
      storage: StorageCapabilityToken,
      atomicWrite: AtomicWriteCapabilityToken,
      artifacts: ArtifactStoreCapabilityToken,
      codeProjects: CodeProjectCapabilityToken,
      workerLauncher: WorkerLauncherCapabilityToken,
    },
    provides: [ProjectBuildCapabilityToken],
    register(context) {
      context.resources.define(ProjectReleaseResource);
      const capability = new DefaultProjectBuildCapability(
        context.dependencies.storage,
        context.dependencies.atomicWrite,
        context.dependencies.artifacts,
        context.dependencies.codeProjects,
        context.dependencies.workerLauncher,
        options.runtimeProfile ?? defaultRuntimeProfile(),
        options.sdkTypes ?? "",
      );
      context.provide(ProjectBuildCapabilityToken, capability);
      for (const route of buildRoutes(capability, context.dependencies.storage)) {
        context.extensions.contribute(HttpRouteExtensionPoint, route);
      }
    },
  });
}

class DefaultProjectBuildCapability implements ProjectBuildCapability {
  private readonly builds;
  private readonly logs;
  private readonly artifactSets;

  constructor(
    private readonly storage: StorageCapability,
    private readonly atomicWrite: AtomicWriteCapability,
    private readonly artifacts: ArtifactStoreCapability,
    private readonly codeProjects: CodeProjectCapability,
    private readonly workerLauncher: WorkerLauncherCapability,
    private readonly runtimeProfile: ProjectRuntimeProfileIdentity,
    private readonly sdkTypes: string,
  ) {
    this.builds = storage.collection<ProjectBuildRequest>(BUILD_COLLECTION);
    this.logs = storage.collection<BuildLogDocument>(BUILD_LOG_COLLECTION);
    this.artifactSets =
      storage.collection<ProjectBuildArtifactSet>(ARTIFACT_SET_COLLECTION);
  }

  async build(
    context: CallContext,
    projectId: string,
    sourceRevision: number,
  ): Promise<ProjectBuildRequest> {
    context.signal?.throwIfAborted();
    const source = await this.codeProjects.source(context, projectId, sourceRevision);
    if (source === null || source.status !== "published") {
      throw PrismError.of(
        "PROJECT_BUILD_SOURCE_NOT_PUBLISHED",
        "Build requires an exact published Project Source revision.",
        { projectId, sourceRevision },
      );
    }
    const buildId = crypto.randomUUID();
    const queued: ProjectBuildRequest = {
      id: buildId,
      projectId,
      sourceRevision,
      sourceFingerprint: source.spec.fingerprint,
      status: "QUEUED",
      requestedBy: context.principal.id,
      createdAt: new Date().toISOString(),
      diagnostics: [],
    };
    await this.atomicWrite.execute(context, {
      requestId: `queue-project-build:${buildId}`,
      preconditions: [
        {
          kind: "document-absent",
          collection: BUILD_COLLECTION,
          id: buildId,
        },
      ],
      operations: [put(BUILD_COLLECTION, queued, "create")],
    });
    const running: ProjectBuildRequest = {
      ...queued,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    await this.replaceBuild(context, queued, running);
    let response: BuildWorkerResponse;
    try {
      response = await runBuildWorker(context, this.workerLauncher, {
        type: "build",
        buildId,
        projectId,
        sourceRevision,
        sourceFingerprint: source.spec.fingerprint,
        files: source.spec.files,
        materials: parseMaterials(source),
        builderVersion: BUILDER_VERSION,
        sdkTypes: this.sdkTypes,
        sdkTypesFingerprint: this.runtimeProfile.sdkTypesFingerprint,
      });
    } catch (error) {
      const cancelled =
        context.signal?.aborted === true || isWorkerLaunchCancellation(error);
      return this.failRunningBuild(
        terminalContext(context),
        running,
        cancelled ? "PROJECT_BUILD_CANCELLED" : "PROJECT_BUILD_FAILED",
        cancelled
          ? "Project Build was cancelled."
          : "Project Build Worker could not be started.",
        [],
      );
    }
    if (context.signal?.aborted === true) {
      return this.failRunningBuild(
        terminalContext(context),
        running,
        "PROJECT_BUILD_CANCELLED",
        "Project Build was cancelled.",
        response.logs,
      );
    }
    if (response.type === "failure") {
      return this.failRunningBuild(
        context,
        running,
        response.message.startsWith("PROJECT_SDK_TYPES_MISMATCH")
          ? "PROJECT_SDK_TYPES_MISMATCH"
          : response.message.startsWith("PROJECT_BUILD_OUTPUT_TOO_LARGE")
            ? "PROJECT_BUILD_OUTPUT_TOO_LARGE"
            : "PROJECT_BUILD_FAILED",
        response.message,
        response.logs,
      );
    }
    try {
      const stored = await this.storeArtifacts(context, source, response);
      const artifactSet = this.createArtifactSet(buildId, source, response, stored);
      const success: ProjectBuildRequest = {
        ...running,
        status: "SUCCESS",
        artifactSetId: artifactSet.id,
        finishedAt: new Date().toISOString(),
        diagnostics: [],
      };
      await this.finishBuild(
        context,
        running,
        success,
        response.logs,
        stored.descriptors,
        artifactSet,
      );
      return success;
    } catch {
      return this.failRunningBuild(
        terminalContext(context),
        running,
        "PROJECT_BUILD_FINALIZATION_FAILED",
        "Project Build finalization failed.",
        response.logs,
      );
    }
  }

  async getBuild(
    context: CallContext,
    buildId: string,
  ): Promise<ProjectBuildRequest | null> {
    return this.builds.get(context, buildId);
  }

  async listBuilds(
    context: CallContext,
    projectId: string,
  ): Promise<readonly ProjectBuildRequest[]> {
    return this.builds.find(context, {
      where: { projectId },
      orderBy: [{ field: "createdAt", direction: "desc" }],
    });
  }
  async artifactSet(
    context: CallContext,
    buildId: string,
  ): Promise<ProjectBuildArtifactSet | null> {
    return this.artifactSets.get(context, buildId);
  }
  async visualMaterialCatalog(
    context: CallContext,
    buildId: string,
  ): Promise<readonly VisualMaterialCatalogItem[]> {
    const artifactSet = await this.artifactSets.get(context, buildId);
    if (artifactSet === null) {
      throw PrismError.of(
        "VISUAL_PIPELINE_BUILD_UNAVAILABLE",
        "Visual Pipeline requires an exact successful Build Artifact Set.",
        { buildId },
      );
    }
    return artifactSet.materialManifests.flatMap((manifest, index) => {
      const artifact = artifactSet.materialArtifacts[index];
      const visualOperator = manifest.visualOperator;
      if (artifact === undefined || visualOperator === undefined) return [];
      return [
        {
          manifest,
          exactRef: {
            projectId: artifactSet.projectId,
            buildId: artifactSet.buildId,
            buildFingerprint: artifactSet.buildFingerprint,
            sourceRevision: artifactSet.sourceRevision,
            sourceFingerprint: artifactSet.sourceFingerprint,
            dependencyLockHash: artifactSet.dependencyLockHash,
            materialId: manifest.id,
            materialVersion: manifest.version,
            artifactHash: artifact.hash,
            manifestFingerprint: contentHash(manifest),
          },
          visualPropertyFields: visualPropertyFields(
            visualOperator.configurationSchema,
            visualOperator.editorSchema,
          ),
        },
      ];
    });
  }

  async validateVisualPipeline(
    context: CallContext,
    buildId: string,
    pipeline: VisualPipelineSpec,
  ): Promise<ValidationResult> {
    const structural = validateVisualPipelineSpec(pipeline);
    if (!structural.valid) return structural;
    const artifactSet = await this.artifactSets.get(context, buildId);
    if (artifactSet === null) {
      return {
        valid: false,
        diagnostics: [
          diagnostic(
            "VISUAL_PIPELINE_BUILD_UNAVAILABLE",
            "Visual Pipeline requires an exact successful Build Artifact Set.",
          ),
        ],
      };
    }
    const diagnostics = pipeline.nodes.flatMap((node, index) => {
      const materialIndex = artifactSet.materialManifests.findIndex(
        (manifest) =>
          manifest.id === node.material.materialId &&
          manifest.version === node.material.materialVersion,
      );
      const manifest = artifactSet.materialManifests[materialIndex];
      const artifact = artifactSet.materialArtifacts[materialIndex];
      if (manifest === undefined || artifact === undefined) {
        return [
          diagnostic(
            "VISUAL_PIPELINE_MATERIAL_UNAVAILABLE",
            "Visual Pipeline Material is unavailable in the exact Build.",
            { path: `/nodes/${index}/material` },
          ),
        ];
      }
      if (
        node.material.projectId !== artifactSet.projectId ||
        node.material.buildId !== artifactSet.buildId ||
        node.material.buildFingerprint !== artifactSet.buildFingerprint ||
        node.material.sourceRevision !== artifactSet.sourceRevision ||
        node.material.sourceFingerprint !== artifactSet.sourceFingerprint ||
        node.material.dependencyLockHash !== artifactSet.dependencyLockHash ||
        node.material.artifactHash !== artifact.hash ||
        node.material.manifestFingerprint !== contentHash(manifest)
      ) {
        return [
          diagnostic(
            "VISUAL_PIPELINE_MATERIAL_IDENTITY_MISMATCH",
            "Visual Pipeline Material identity does not match the exact Build Artifact.",
            { path: `/nodes/${index}/material` },
          ),
        ];
      }
      if (manifest.visualOperator === undefined) {
        return [
          diagnostic(
            "VISUAL_PIPELINE_MATERIAL_NOT_VISUAL",
            "Code Material does not declare a Visual Operator Contract.",
            { path: `/nodes/${index}/material` },
          ),
        ];
      }
      if (
        !validateConfigurationSchema(
          manifest.visualOperator.configurationSchema,
          node.configuration,
        )
      ) {
        return [
          diagnostic(
            "VISUAL_PIPELINE_CONFIGURATION_INVALID",
            "Visual Pipeline node configuration does not match the Material schema.",
            { path: `/nodes/${index}/configuration` },
          ),
        ];
      }
      return [];
    });
    return { valid: diagnostics.length === 0, diagnostics };
  }

  async profileSdkTypes(context: CallContext): Promise<ProjectRuntimeProfileSdkTypes> {
    const artifact = await this.artifacts.putImmutable(context, {
      contentType: "text/typescript",
      files: [
        {
          path: "profile-sdk.d.ts",
          content: new TextEncoder().encode(this.sdkTypes),
        },
      ],
    });
    if (shaText(this.sdkTypes) !== this.runtimeProfile.sdkTypesFingerprint) {
      throw PrismError.of(
        "PROJECT_SDK_TYPES_MISMATCH",
        "Runtime Profile SDK Types Artifact does not match its declared fingerprint.",
      );
    }
    return { identity: this.runtimeProfile, artifact, content: this.sdkTypes };
  }
  async composeRelease(
    context: CallContext,
    projectId: string,
    buildId: string,
    visualResources: readonly ProjectVisualResourceRef[],
    runtimeProfile: ProjectRuntimeProfileIdentity,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    const artifactSet = await this.artifactSets.get(context, buildId);
    if (artifactSet === null || artifactSet.projectId !== projectId) {
      throw PrismError.of(
        "PROJECT_BUILD_ARTIFACT_SET_UNAVAILABLE",
        "Release composition requires an exact successful Build Artifact Set.",
        { projectId, buildId },
      );
    }
    if (
      runtimeProfile.profileFingerprint !== artifactSet.runtimeProfile.profileFingerprint
    ) {
      throw PrismError.of(
        "PROJECT_BUILD_RUNTIME_PROFILE_MISMATCH",
        "Project Release Runtime Profile must match the Build Artifact Set.",
        { projectId, buildId },
      );
    }
    await validateVisualResources(this.storage, context, visualResources);
    const releaseFingerprint = contentHash({
      schemaVersion: "1.0.0",
      projectId,
      artifactSetId: artifactSet.id,
      artifactSetFingerprint: artifactSet.artifactSetFingerprint,
      runtimeProfileFingerprint: runtimeProfile.profileFingerprint,
      visualResources: canonicalVisualResources(visualResources),
    });
    const prior = await this.releases(context, projectId);
    const existing = prior.find(
      (item) => item.spec.releaseFingerprint === releaseFingerprint,
    );
    if (existing !== undefined) return existing;
    return this.publishRelease(
      context,
      artifactSet,
      canonicalVisualResources(visualResources),
      runtimeProfile,
      releaseFingerprint,
    );
  }

  async release(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<ProjectReleaseDefinition> | null> {
    return this.storage.resources.get(
      context,
      PROJECT_RELEASE_KIND,
      releaseResourceId(projectId),
      revision,
    );
  }

  async releases(
    context: CallContext,
    projectId: string,
  ): Promise<readonly Resource<ProjectReleaseDefinition>[]> {
    return (await this.storage.resources.listRevisions(
      context,
      PROJECT_RELEASE_KIND,
      releaseResourceId(projectId),
    )) as readonly Resource<ProjectReleaseDefinition>[];
  }

  async buildLog(context: CallContext, buildId: string): Promise<readonly string[]> {
    return (await this.logs.get(context, buildId))?.lines ?? [];
  }

  private async storeArtifacts(
    context: CallContext,
    source: Resource<PublishedProjectSource>,
    response: BuildWorkerSuccess,
  ): Promise<StoredBuildArtifacts> {
    const stored = await allSettledOrThrow([
      this.artifacts.putImmutable(context, response.clientArtifact),
      this.artifacts.putImmutable(context, response.serverArtifact),
      this.artifacts.putImmutable(context, response.testReportArtifact),
      this.artifacts.putImmutable(context, {
        contentType: "text/typescript",
        files: [
          {
            path: "profile-sdk.d.ts",
            content: new TextEncoder().encode(this.sdkTypes),
          },
        ],
      }),
    ]);
    const client = stored[0]!;
    const server = stored[1]!;
    const testReport = stored[2]!;
    const sdkTypes = stored[3]!;
    const materials = await allSettledOrThrow(
      response.materials.map(async (item) => ({
        manifest: item.manifest,
        artifact: await this.artifacts.putImmutable(context, item.artifact),
      })),
    );
    const testResult: ProjectTestResult = {
      ...response.testSummary,
      reportHash: testReport.hash,
    };
    const manifestContent = new TextEncoder().encode(
      JSON.stringify(
        {
          schemaVersion: "1.0.0",
          projectId: source.spec.projectId,
          sourceRevision: source.revision,
          sourceFingerprint: source.spec.fingerprint,
          packageJsonHash: response.packageJsonHash,
          dependencyLockHash: response.dependencyLockHash,
          builderVersion: BUILDER_VERSION,
          nodeVersion: process.version,
          pnpmVersion: response.pnpmVersion,
          runtimeAbiVersion: PROJECT_RUNTIME_ABI_VERSION,
          runtimeProfile: this.runtimeProfile,
          sdkTypes,
          clientEntryExport: "mount",
          serverEntryExport: "actions",
          client,
          server,
          testResult,
          actionIds: response.actionIds,
          materials,
        },
        null,
        2,
      ),
    );
    const buildManifest = await this.artifacts.putImmutable(context, {
      contentType: "application/json",
      files: [{ path: "build-manifest.json", content: manifestContent }],
    });
    return {
      client,
      server,
      testReport,
      sdkTypes,
      buildManifest,
      testResult,
      materials,
      descriptors: [
        client,
        server,
        sdkTypes,
        testReport,
        buildManifest,
        ...materials.map((item) => item.artifact),
      ],
    };
  }

  private createArtifactSet(
    buildId: string,
    source: Resource<PublishedProjectSource>,
    response: BuildWorkerSuccess,
    stored: StoredBuildArtifacts,
  ): ProjectBuildArtifactSet {
    const identity = {
      buildId,
      projectId: source.spec.projectId,
      sourceRevision: source.revision,
      sourceFingerprint: source.spec.fingerprint,
      packageJsonHash: response.packageJsonHash,
      dependencyLockHash: response.dependencyLockHash,
      builderVersion: BUILDER_VERSION,
      nodeVersion: process.version,
      pnpmVersion: response.pnpmVersion,
      typescriptVersion: "7.0.0",
      runtimeAbiVersion: PROJECT_RUNTIME_ABI_VERSION,
      runtimeProfile: this.runtimeProfile,
      sdkTypesArtifact: stored.sdkTypes,
      clientEntryExport: "mount",
      serverEntryExport: "actions",
      actionIds: response.actionIds,
      clientArtifact: stored.client,
      serverArtifact: stored.server,
      buildManifestArtifact: stored.buildManifest,
      materialManifests: stored.materials.map((item) => item.manifest),
      materialArtifacts: stored.materials.map((item) => item.artifact),
      testResult: stored.testResult,
      diagnostics: [],
      buildReproducibility: "DETERMINISTIC" as const,
      runtimeReproducibility: "UNKNOWN" as const,
    };
    const artifactSetFingerprint = contentHash(identity);
    const artifactSet: ProjectBuildArtifactSet = {
      id: buildId,
      ...identity,
      buildFingerprint: artifactSetFingerprint,
      artifactSetFingerprint,
    };
    return artifactSet;
  }

  private async publishRelease(
    context: CallContext,
    artifactSet: ProjectBuildArtifactSet,
    visualResources: readonly ProjectVisualResourceRef[],
    runtimeProfile: ProjectRuntimeProfileIdentity,
    releaseFingerprint: string,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    const materials: ProjectMaterialRef[] = artifactSet.materialManifests.map(
      (manifest, index) => ({
        materialId: manifest.id,
        materialVersion: manifest.version,
        source: {
          authoringMode: "CODE",
          module: {
            projectId: artifactSet.projectId,
            sourceRevision: artifactSet.sourceRevision,
            sourceFingerprint: artifactSet.sourceFingerprint,
            artifactHash: artifactSet.materialArtifacts[index]!.hash,
            dependencyLockHash: artifactSet.dependencyLockHash,
          },
        },
      }),
    );
    const spec: ProjectReleaseDefinition = {
      projectId: artifactSet.projectId,
      materials,
      buildArtifactSet: artifactSet,
      visualResources,
      runtimeProfile,
      releaseFingerprint,
      sourceRevision: artifactSet.sourceRevision,
      sourceFingerprint: artifactSet.sourceFingerprint,
      packageJsonHash: artifactSet.packageJsonHash,
      dependencyLockHash: artifactSet.dependencyLockHash,
      builderVersion: artifactSet.builderVersion,
      nodeVersion: artifactSet.nodeVersion,
      pnpmVersion: artifactSet.pnpmVersion,
      runtimeAbiVersion: artifactSet.runtimeAbiVersion,
      clientEntryExport: artifactSet.clientEntryExport,
      actionIds: artifactSet.actionIds,
      serverEntryExport: artifactSet.serverEntryExport,
      clientArtifact: artifactSet.clientArtifact,
      serverArtifact: artifactSet.serverArtifact,
      buildManifestArtifact: artifactSet.buildManifestArtifact,
      materialArtifacts: artifactSet.materialArtifacts,
      materialManifests: artifactSet.materialManifests,
      testResult: artifactSet.testResult,
      diagnostics: artifactSet.diagnostics,
      buildReproducibility: artifactSet.buildReproducibility,
      runtimeReproducibility: artifactSet.runtimeReproducibility,
    };
    const validation = validateProjectReleaseManifest(spec);
    if (validation.diagnostics.length > 0) throw new PrismError(validation.diagnostics);
    const id = releaseResourceId(artifactSet.projectId);
    const draft = await this.storage.resources.saveDraft(context, {
      kind: PROJECT_RELEASE_KIND,
      id,
      name: `${artifactSet.projectId} Release`,
      spec,
    });
    return this.storage.resources.publish(
      context,
      PROJECT_RELEASE_KIND,
      id,
      draft.revision,
    );
  }

  private async replaceBuild(
    context: CallContext,
    prior: ProjectBuildRequest,
    next: ProjectBuildRequest,
  ): Promise<void> {
    await this.atomicWrite.execute(context, {
      requestId: `transition-project-build:${next.id}:${next.status}`,
      preconditions: [
        {
          kind: "document-present",
          collection: BUILD_COLLECTION,
          id: prior.id,
          fields: { status: prior.status },
        },
      ],
      operations: [put(BUILD_COLLECTION, next, "replace")],
    });
  }

  private async failRunningBuild(
    context: CallContext,
    running: ProjectBuildRequest,
    code: string,
    message: string,
    lines: readonly string[],
  ): Promise<ProjectBuildRequest> {
    const failed: ProjectBuildRequest = {
      ...running,
      status: "FAILED",
      finishedAt: new Date().toISOString(),
      diagnostics: [
        diagnostic(code, message, {
          details: { buildId: running.id },
        }),
      ],
    };
    await this.finishBuild(context, running, failed, lines, []);
    return failed;
  }

  private async finishBuild(
    context: CallContext,
    prior: ProjectBuildRequest,
    next: ProjectBuildRequest,
    lines: readonly string[],
    descriptors: readonly ProjectArtifactDescriptor[],
    artifactSet?: ProjectBuildArtifactSet,
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const artifactDocuments: ArtifactDocument[] = descriptors.map((descriptor) => ({
      id: descriptor.hash,
      ...descriptor,
      createdAt,
    }));
    const operations: AtomicWriteOperation[] = [
      put(BUILD_COLLECTION, next, "replace"),
      put(BUILD_LOG_COLLECTION, { id: next.id, lines }, "upsert"),
      ...artifactDocuments.map((artifact) => put(ARTIFACT_COLLECTION, artifact, "upsert")),
      ...(artifactSet === undefined
        ? []
        : [put(ARTIFACT_SET_COLLECTION, artifactSet, "create")]),
    ];
    await this.atomicWrite.execute(context, {
      requestId: `finish-project-build:${next.id}:${next.status}`,
      preconditions: [
        {
          kind: "document-present",
          collection: BUILD_COLLECTION,
          id: prior.id,

          fields: { status: prior.status },
        },
        ...(artifactSet === undefined
          ? []
          : [
              {
                kind: "document-absent" as const,
                collection: ARTIFACT_SET_COLLECTION,
                id: artifactSet.id,
              },
            ]),
      ],
      operations,
    });
  }
}

async function allSettledOrThrow<T>(
  promises: readonly Promise<T>[],
): Promise<readonly T[]> {
  const results = await Promise.allSettled(promises);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

function terminalContext(context: CallContext): CallContext {
  if (context.signal?.aborted !== true) return context;
  return systemCallContext({
    correlationId: context.correlationId,
    asOf: context.asOf,
    changeReason: "Terminalize interrupted Project Build.",
  });
}

function isWorkerLaunchCancellation(error: unknown): boolean {
  return (
    error instanceof PrismError &&
    error.diagnostics.some((item) => item.code === "WORKER_LAUNCH_CANCELLED")
  );
}

async function runBuildWorker(
  context: CallContext,
  launcher: WorkerLauncherCapability,
  request: BuildWorkerRequest,
): Promise<BuildWorkerResponse> {
  const child = await launcher.launch(context, {
    kind: "project-build",
    entryPath: fileURLToPath(new URL("./builder-worker.js", import.meta.url)),
    serialization: "advanced",
    execArgv: [`--max-old-space-size=${BUILD_WORKER_MAX_OLD_SPACE_MB}`],
    environment: workerEnvironment(),
  });
  const { promise, resolve } = Promise.withResolvers<BuildWorkerResponse>();
  const stderr = createWorkerStderrCollector();
  let settled = false;
  const settle = (response: BuildWorkerResponse): void => {
    if (settled) return;
    settled = true;
    resolve(response);
  };
  const failure = (message: string): BuildWorkerResponse => ({
    type: "failure",
    message,
    logs: stderr.lines(),
  });
  const kill = (): void => {
    try {
      child.kill();
    } catch {
      // Cleanup must not replace the sanitized lifecycle result.
    }
  };
  const removeStderr = child.onStderr((chunk) => stderr.append(chunk));
  const removeMessage = child.onMessage((message) => {
    settle(
      isBuildWorkerResponse(message)
        ? boundBuildWorkerResponse(message)
        : failure("Build Worker returned a malformed response."),
    );
  });
  const removeError = child.onError(() => settle(failure("Build Worker process failed.")));
  const removeExit = child.onExit((code) => {
    settle(
      failure(
        code === 0
          ? "Build Worker exited before returning a response."
          : `Build Worker exited ${code ?? "without code"}.`,
      ),
    );
  });
  const timer = setTimeout(() => {
    settle(failure(`Build Worker exceeded ${BUILD_WORKER_TIMEOUT_MS}ms.`));
    kill();
  }, BUILD_WORKER_TIMEOUT_MS);

  try {
    try {
      child.send(request);
    } catch {
      settle(failure("Build Worker could not accept the request."));
      kill();
    }
    return await promise;
  } finally {
    clearTimeout(timer);
    removeMessage();
    removeStderr();
    removeError();
    removeExit();
    try {
      child.disconnect();
    } catch {
      // Listener/timer cleanup already completed; disconnect is best effort.
    }
  }
}

function isBuildWorkerResponse(value: unknown): value is BuildWorkerResponse {
  if (
    !isWorkerRecord(value) ||
    !Array.isArray(value.logs) ||
    !value.logs.every((item) => typeof item === "string")
  ) {
    return false;
  }
  if (value.type === "failure") return typeof value.message === "string";
  if (value.type !== "success") return false;
  return (
    isBuildArtifactPayload(value.clientArtifact) &&
    isBuildArtifactPayload(value.serverArtifact) &&
    isBuildArtifactPayload(value.testReportArtifact) &&
    isWorkerRecord(value.testSummary) &&
    typeof value.testSummary.passed === "boolean" &&
    typeof value.testSummary.total === "number" &&
    typeof value.testSummary.failed === "number" &&
    typeof value.packageJsonHash === "string" &&
    typeof value.dependencyLockHash === "string" &&
    typeof value.pnpmVersion === "string" &&
    Array.isArray(value.materials) &&
    value.materials.every(
      (item) =>
        isWorkerRecord(item) &&
        isWorkerRecord(item.manifest) &&
        typeof item.manifest.id === "string" &&
        typeof item.manifest.version === "string" &&
        isBuildArtifactPayload(item.artifact),
    ) &&
    Array.isArray(value.actionIds) &&
    value.actionIds.every((item) => typeof item === "string")
  );
}

function isBuildArtifactPayload(
  value: unknown,
): value is BuildWorkerSuccess["clientArtifact"] {
  return (
    isWorkerRecord(value) &&
    typeof value.contentType === "string" &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isWorkerRecord(file) &&
        typeof file.path === "string" &&
        file.content instanceof Uint8Array,
    )
  );
}

function isWorkerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const exact = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMSPEC",
    "PATHEXT",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ]);
  const environment: NodeJS.ProcessEnv = { CI: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (exact.has(key.toUpperCase()) ||
        key.startsWith("NPM_CONFIG_") ||
        key.startsWith("PNPM_"))
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

function parseMaterials(
  source: Resource<PublishedProjectSource>,
): readonly DeclaredCodeMaterialManifest[] {
  const file = source.spec.files.find((item) => item.path === "prism.materials.json");
  if (file === undefined) return [];
  const parsed = JSON.parse(file.content) as {
    readonly materials?: readonly DeclaredCodeMaterialManifest[];
  };
  return parsed.materials ?? [];
}

function defaultRuntimeProfile(): ProjectRuntimeProfileIdentity {
  const base = {
    profileId: "prism-default",
    contractVersion: "1.0.0",
    semanticVersion: "1.0.0",
    pluginIdentities: [],
    sdkTypesFingerprint: shaText(""),
  };
  return { ...base, profileFingerprint: contentHash(base) };
}
function validateConfigurationSchema(schema: JsonValue, value: JsonValue): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const definition = schema as Record<string, JsonValue>;
  if (Array.isArray(definition.enum)) return definition.enum.some((item) => item === value);
  switch (definition.type) {
    case "string":
      return (
        typeof value === "string" &&
        (definition.format !== "decimal-string" ||
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return (
        Array.isArray(value) &&
        (definition.items === undefined ||
          value.every((item) => validateConfigurationSchema(definition.items!, item)))
      );
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const object = value as Record<string, JsonValue>;
      const required = Array.isArray(definition.required)
        ? definition.required.filter((item): item is string => typeof item === "string")
        : [];
      if (required.some((key) => !(key in object))) return false;
      const properties = definition.properties;
      if (
        typeof properties !== "object" ||
        properties === null ||
        Array.isArray(properties)
      )
        return true;
      return Object.entries(properties).every(
        ([key, child]) =>
          object[key] === undefined || validateConfigurationSchema(child, object[key]),
      );
    }
    default:
      return false;
  }
}

async function validateVisualResources(
  storage: StorageCapability,
  context: CallContext,
  resources: readonly ProjectVisualResourceRef[],
): Promise<void> {
  const identities = new Set<string>();
  for (const resource of resources) {
    const identity = `${resource.kind}\u0000${resource.resourceId}`;
    if (identities.has(identity)) {
      throw PrismError.of(
        "PROJECT_RELEASE_DUPLICATE_VISUAL_RESOURCE",
        "Project Release contains a duplicate Visual Resource identity.",
        { identity },
      );
    }
    identities.add(identity);
    if (resource.revision < 1 || !/^[0-9a-f]{64}$/.test(resource.fingerprint)) {
      throw PrismError.of(
        "PROJECT_RELEASE_VISUAL_RESOURCE_INVALID",
        "Visual Resources must reference exact published revisions with SHA-256 fingerprints.",
        { identity },
      );
    }
    const published = await storage.resources.get(
      context,
      resource.kind,
      resource.resourceId,
      resource.revision,
    );
    const publishedSpec = published?.spec;
    const actualFingerprint =
      publishedSpec !== null &&
      typeof publishedSpec === "object" &&
      !Array.isArray(publishedSpec) &&
      typeof (publishedSpec as Record<string, unknown>).fingerprint === "string"
        ? (publishedSpec as Record<string, string>).fingerprint
        : contentHash(publishedSpec);
    if (
      published === null ||
      published.status !== "published" ||
      actualFingerprint !== resource.fingerprint
    ) {
      throw PrismError.of(
        "PROJECT_RELEASE_VISUAL_RESOURCE_UNAVAILABLE",
        "Visual Resource must reference an exact published revision and fingerprint.",
        { identity, revision: resource.revision },
      );
    }
  }
}

function canonicalVisualResources(
  resources: readonly ProjectVisualResourceRef[],
): readonly ProjectVisualResourceRef[] {
  return [...resources].sort((left, right) =>
    `${left.kind}\u0000${left.resourceId}\u0000${left.revision}`.localeCompare(
      `${right.kind}\u0000${right.resourceId}\u0000${right.revision}`,
    ),
  );
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function shaText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function put<T extends { readonly id: string }>(
  collection: string,
  document: T,
  mode: "create" | "replace" | "upsert",
): AtomicWriteOperation {
  return {
    kind: "put-document",
    collection,
    document: document as unknown as AtomicDocument,
    mode,
  };
}

function releaseResourceId(projectId: string): string {
  return `${projectId}:release`;
}

function buildRoutes(
  capability: ProjectBuildCapability,
  storage: StorageCapability,
): readonly HttpRoute[] {
  return [
    {
      method: "POST",
      path: "/api/code-projects/:id/builds",
      access: { kind: "permission", permission: "project.build" },
      summary: "Build an exact published Project Source revision",
      handler: async (request) => {
        const params = record(request.params);
        const body = record(request.body);
        return {
          status: 201,
          body: await capability.build(
            request.call,
            string(params.id),
            integer(body.sourceRevision),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/builds",
      access: { kind: "permission", permission: "project.read" },
      summary: "List Project Builds",
      handler: async (request) => ({
        status: 200,
        body: await capability.listBuilds(request.call, string(record(request.params).id)),
      }),
    },
    {
      method: "GET",
      path: "/api/project-builds/:id/log",
      access: { kind: "permission", permission: "project.build.read" },
      summary: "Read structured Build Worker log lines",
      handler: async (request) => ({
        status: 200,
        body: {
          lines: await capability.buildLog(request.call, string(record(request.params).id)),
        },
      }),
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/releases",
      access: { kind: "permission", permission: "project.read" },
      summary: "List immutable Project Releases",
      handler: async (request) => ({
        status: 200,
        body: await capability.releases(request.call, string(record(request.params).id)),
      }),
    },
    {
      method: "GET",
      path: "/api/project-builds/:id/artifact-set",
      access: { kind: "permission", permission: "project.build.read" },
      summary: "Read immutable Project Build Artifact Set",
      handler: async (request) => {
        const artifactSet = await capability.artifactSet(
          request.call,
          string(record(request.params).id),
        );
        return { status: artifactSet === null ? 404 : 200, body: artifactSet };
      },
    },
    {
      method: "GET",
      path: "/api/project-builds/:id/visual-materials",
      access: { kind: "permission", permission: "pipeline.read" },
      summary: "List exact Visual Materials from a successful Build",
      handler: async (request) => {
        return {
          status: 200,
          body: await capability.visualMaterialCatalog(
            request.call,
            string(record(request.params).id),
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/project-builds/:id/visual-pipelines/validate",
      access: { kind: "permission", permission: "pipeline.validate" },
      summary: "Validate a Visual Pipeline against an exact Build",
      handler: async (request) => {
        return {
          status: 200,
          body: await capability.validateVisualPipeline(
            request.call,
            string(record(request.params).id),
            visualPipeline(record(request.body).spec),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/visual-pipeline",
      access: { kind: "permission", permission: "pipeline.read" },
      summary: "Read the current and published Visual Pipeline",
      handler: async (request) => {
        const projectId = string(record(request.params).id);
        const id = visualPipelineResourceId(projectId);
        const [current, published] = await Promise.all([
          storage.resources.get<PublishedVisualPipeline>(
            request.call,
            VISUAL_PIPELINE_KIND,
            id,
          ),
          storage.resources.getPublished<PublishedVisualPipeline>(
            request.call,
            VISUAL_PIPELINE_KIND,
            id,
          ),
        ]);
        return { status: 200, body: { current, published } };
      },
    },
    {
      method: "POST",
      path: "/api/code-projects/:id/visual-pipeline/draft",
      access: { kind: "permission", permission: "pipeline.draft.write" },
      summary: "Validate and save the project Visual Pipeline Draft",
      handler: async (request) => {
        const projectId = string(record(request.params).id);
        const body = record(request.body);
        const buildId = string(body.buildId);
        const input = visualPipeline(body.spec);
        const structural = validateVisualPipelineSpec(input);
        if (hasErrors(structural.diagnostics)) throw new PrismError(structural.diagnostics);
        const validation = await capability.validateVisualPipeline(
          request.call,
          buildId,
          input,
        );
        const unsafeDiagnostics = validation.diagnostics.filter(
          (item) => item.code !== "VISUAL_PIPELINE_CONFIGURATION_INVALID",
        );
        if (hasErrors(unsafeDiagnostics)) throw new PrismError(unsafeDiagnostics);
        const spec: PublishedVisualPipeline = {
          ...input,
          configurationFingerprint: fingerprintVisualConfiguration(input),
          fingerprint: fingerprintVisualPipeline(input),
        };
        const resource = await storage.resources.saveDraft(request.call, {
          kind: VISUAL_PIPELINE_KIND,
          id: visualPipelineResourceId(projectId),
          name: input.name,
          spec,
          expectedUpdatedAt: nullableString(body.expectedUpdatedAt),
        });
        return { status: 201, body: { resource, validation } };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/visual-pipeline/diff",
      access: { kind: "permission", permission: "pipeline.read" },
      summary: "Diff the saved Visual Pipeline Draft against its published revision",
      handler: async (request) => {
        const projectId = string(record(request.params).id);
        const id = visualPipelineResourceId(projectId);
        const [current, published] = await Promise.all([
          storage.resources.get<PublishedVisualPipeline>(
            request.call,
            VISUAL_PIPELINE_KIND,
            id,
          ),
          storage.resources.getPublished<PublishedVisualPipeline>(
            request.call,
            VISUAL_PIPELINE_KIND,
            id,
          ),
        ]);
        return {
          status: 200,
          body: visualPipelineDiff(
            id,
            current?.status === "draft" ? current : null,
            published,
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/code-projects/:id/visual-pipeline/publish",
      access: { kind: "permission", permission: "pipeline.publish" },
      changeReason: "required",
      summary: "Publish the validated Visual Pipeline and compose an immutable Release",
      handler: async (request) => {
        const projectId = string(record(request.params).id);
        const body = record(request.body);
        const buildId = string(body.buildId);
        const revision = integer(body.revision);
        const expectedUpdatedAt = string(body.expectedUpdatedAt);
        const expectedPipelineFingerprint = string(body.expectedPipelineFingerprint);
        const id = visualPipelineResourceId(projectId);
        const current = await storage.resources.get<PublishedVisualPipeline>(
          request.call,
          VISUAL_PIPELINE_KIND,
          id,
        );
        if (current === null) {
          throw PrismError.of(
            "RESOURCE_NOT_FOUND",
            "Visual Pipeline Draft was not found.",
            { projectId, id },
          );
        }
        if (
          current.revision !== revision ||
          current.spec.fingerprint !== expectedPipelineFingerprint
        ) {
          throw PrismError.of(
            "VISUAL_PIPELINE_PUBLISH_CONFLICT",
            "Visual Pipeline changed after it was loaded.",
            {
              expectedRevision: revision,
              actualRevision: current.revision,
              expectedPipelineFingerprint,
              actualPipelineFingerprint: current.spec.fingerprint,
            },
          );
        }
        const validation = await capability.validateVisualPipeline(
          request.call,
          buildId,
          current.spec,
        );
        if (hasErrors(validation.diagnostics)) throw new PrismError(validation.diagnostics);
        const retried = current.status === "published";
        if (current.status === "archived") {
          throw PrismError.of(
            "VISUAL_PIPELINE_PUBLISH_INVALID",
            "Archived Visual Pipeline cannot be published.",
          );
        }
        const pipeline = retried
          ? current
          : await storage.resources.publish<PublishedVisualPipeline>(
              request.call,
              VISUAL_PIPELINE_KIND,
              id,
              revision,
              expectedUpdatedAt,
            );
        const artifactSet = await capability.artifactSet(request.call, buildId);
        if (artifactSet === null) {
          throw PrismError.of(
            "VISUAL_PIPELINE_BUILD_UNAVAILABLE",
            "Visual Pipeline requires an exact successful Build Artifact Set.",
            { projectId, buildId },
          );
        }
        const release = await capability.composeRelease(
          request.call,
          projectId,
          buildId,
          [
            {
              kind: VISUAL_PIPELINE_KIND,
              resourceId: pipeline.id,
              revision: pipeline.revision,
              fingerprint: pipeline.spec.fingerprint,
            },
          ],
          artifactSet.runtimeProfile,
        );
        return {
          status: retried ? 200 : 201,
          body: { pipeline, release, validation },
        };
      },
    },
    {
      method: "POST",
      path: "/api/code-projects/:id/releases",
      access: { kind: "permission", permission: "project.release.publish" },
      changeReason: "required",
      summary: "Compose immutable Project Release from successful Build",
      handler: async (request) => {
        const body = record(request.body);
        const buildId = string(body.buildId);
        const artifactSet = await capability.artifactSet(request.call, buildId);
        if (artifactSet === null) {
          throw PrismError.of(
            "PROJECT_BUILD_ARTIFACT_SET_UNAVAILABLE",
            "Release composition requires an exact successful Build Artifact Set.",
            { buildId },
          );
        }
        return {
          status: 201,
          body: await capability.composeRelease(
            request.call,
            string(record(request.params).id),
            buildId,
            [],
            artifactSet.runtimeProfile,
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/project-runtime-profile/sdk-types",
      access: { kind: "permission", permission: "project.build.read" },
      summary: "Read exact Project Runtime Profile SDK Types",
      handler: async (request) => ({
        status: 200,
        body: await capability.profileSdkTypes(request.call),
      }),
    },
  ];
}

function visualPipelineResourceId(projectId: string): string {
  return `${projectId}:visual-pipeline`;
}

function visualPipeline(value: unknown): VisualPipelineSpec {
  const candidate = record(value);
  if (
    candidate.schemaVersion !== "1.0.0" ||
    typeof candidate.code !== "string" ||
    candidate.code.length === 0 ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    !Array.isArray(candidate.inputs) ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.outputs)
  ) {
    throw PrismError.of(
      "VISUAL_PIPELINE_REQUEST_INVALID",
      "Visual Pipeline request does not match the 1.0.0 structure.",
    );
  }
  for (const input of candidate.inputs) {
    const item = record(input);
    string(item.name);
  }
  for (const node of candidate.nodes) {
    const item = record(node);
    string(item.nodeId);
    record(item.material);
    record(item.inputBindings);
    if (!Object.hasOwn(item, "configuration")) {
      throw PrismError.of(
        "VISUAL_PIPELINE_REQUEST_INVALID",
        "Visual Pipeline node configuration is required.",
      );
    }
  }
  for (const output of candidate.outputs) {
    const item = record(output);
    string(item.name);
    record(item.binding);
  }
  return candidate as unknown as VisualPipelineSpec;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function visualPipelineDiff(
  id: string,
  draft: Resource<PublishedVisualPipeline> | null,
  published: Resource<PublishedVisualPipeline> | null,
) {
  if (draft === null) {
    return {
      id,
      draftRevision: null,
      publishedRevision: published?.revision ?? null,
      draftFingerprint: null,
      publishedFingerprint: published?.spec.fingerprint ?? null,
      changedSections: [],
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
    };
  }
  const priorNodes = new Map(
    (published?.spec.nodes ?? []).map((node) => [node.nodeId, node]),
  );
  const draftNodes = new Map(draft.spec.nodes.map((node) => [node.nodeId, node]));
  const addedNodes = [...draftNodes.keys()].filter((id) => !priorNodes.has(id)).sort();
  const removedNodes = [...priorNodes.keys()].filter((id) => !draftNodes.has(id)).sort();
  const changedNodes = [...draftNodes.keys()]
    .filter((nodeId) => {
      const prior = priorNodes.get(nodeId);
      const next = draftNodes.get(nodeId);
      return (
        prior !== undefined &&
        next !== undefined &&
        contentHash(prior) !== contentHash(next)
      );
    })
    .sort();
  const changedSections = (["code", "name", "inputs", "nodes", "outputs"] as const).filter(
    (section) =>
      contentHash(published?.spec[section] ?? null) !== contentHash(draft.spec[section]),
  );
  return {
    id,
    draftRevision: draft.revision,
    publishedRevision: published?.revision ?? null,
    draftFingerprint: draft.spec.fingerprint,
    publishedFingerprint: published?.spec.fingerprint ?? null,
    changedSections,
    addedNodes,
    removedNodes,
    changedNodes,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw PrismError.of("PROJECT_BUILD_REQUEST_INVALID", "Expected object request.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw PrismError.of("PROJECT_BUILD_REQUEST_INVALID", "Expected string.");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw PrismError.of("PROJECT_BUILD_REQUEST_INVALID", "Expected positive integer.");
  }
  return value;
}
