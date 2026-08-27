import { fork } from "node:child_process";
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
  type CallContext,
} from "@prismengine/contracts-data";
import {
  ProjectBuildCapabilityToken,
  PROJECT_RUNTIME_ABI_VERSION,
  validateProjectReleaseManifest,
  type DeclaredCodeMaterialManifest,
  type ProjectArtifactDescriptor,
  type ProjectBuildCapability,
  type ProjectBuildRequest,
  type ProjectMaterialRef,
  type ProjectReleaseDefinition,
  type ProjectTestResult,
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
  definePlugin,
  type Resource,
  type ResourceTypeDefinition,
} from "@prismengine/kernel";
import {
  CodeProjectCapabilityToken,
  type CodeProjectCapability,
  type PublishedProjectSource,
} from "@prismengine/plugin-code-project";
import {
  HttpRouteExtensionPoint,
  type HttpRoute,
} from "@prismengine/plugin-http-fastify";
import type {
  BuildWorkerRequest,
  BuildWorkerResponse,
  BuildWorkerSuccess,
} from "./protocol.js";

export const PROJECT_RELEASE_KIND = "project.release";
const BUILD_COLLECTION = "project.build-requests";
const BUILD_LOG_COLLECTION = "project.build-logs";
const ARTIFACT_COLLECTION = "project.artifacts";
const BUILDER_VERSION = "0.1.14";

const ProjectReleaseSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  materials: Type.Array(Type.Any()),
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
}, { additionalProperties: false });

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
  readonly testResult: ProjectTestResult;
  readonly materials: readonly {
    readonly manifest: DeclaredCodeMaterialManifest;
    readonly artifact: ArtifactRef;
  }[];
  readonly descriptors: readonly ArtifactRef[];
}

export function projectBuildPlugin() {
  return definePlugin({
    id: "project.build",
    version: BUILDER_VERSION,
    requires: {
      storage: StorageCapabilityToken,
      atomicWrite: AtomicWriteCapabilityToken,
      artifacts: ArtifactStoreCapabilityToken,
      codeProjects: CodeProjectCapabilityToken,
    },
    provides: [ProjectBuildCapabilityToken],
    register(context) {
      context.resources.define(ProjectReleaseResource);
      const capability = new DefaultProjectBuildCapability(
        context.dependencies.storage,
        context.dependencies.atomicWrite,
        context.dependencies.artifacts,
        context.dependencies.codeProjects,
      );
      context.provide(ProjectBuildCapabilityToken, capability);
      for (const route of buildRoutes(capability)) {
        context.extensions.contribute(HttpRouteExtensionPoint, route);
      }
    },
  });
}

class DefaultProjectBuildCapability implements ProjectBuildCapability {
  private readonly builds;
  private readonly logs;

  constructor(
    private readonly storage: StorageCapability,
    private readonly atomicWrite: AtomicWriteCapability,
    private readonly artifacts: ArtifactStoreCapability,
    private readonly codeProjects: CodeProjectCapability,
  ) {
    this.builds = storage.collection<ProjectBuildRequest>(BUILD_COLLECTION);
    this.logs = storage.collection<BuildLogDocument>(BUILD_LOG_COLLECTION);
  }

  async build(
    context: CallContext,
    projectId: string,
    sourceRevision: number,
  ): Promise<ProjectBuildRequest> {
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
      preconditions: [{
        kind: "document-absent",
        collection: BUILD_COLLECTION,
        id: buildId,
      }],
      operations: [put(BUILD_COLLECTION, queued, "create")],
    });
    const running: ProjectBuildRequest = {
      ...queued,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    await this.replaceBuild(context, queued, running);
    const response = await runBuildWorker({
      type: "build",
      buildId,
      projectId,
      sourceRevision,
      sourceFingerprint: source.spec.fingerprint,
      files: source.spec.files,
      materials: parseMaterials(source),
      builderVersion: BUILDER_VERSION,
    });
    if (response.type === "failure") {
      const failed: ProjectBuildRequest = {
        ...running,
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        diagnostics: [diagnostic(
          "PROJECT_BUILD_FAILED",
          response.message,
          { details: { buildId } },
        )],
      };
      await this.finishBuild(context, running, failed, response.logs, []);
      return failed;
    }
    const stored = await this.storeArtifacts(context, source, response);
    const release = await this.publishRelease(context, source, response, stored);
    const success: ProjectBuildRequest = {
      ...running,
      status: "SUCCESS",
      releaseId: `${release.id}@${release.revision}`,
      finishedAt: new Date().toISOString(),
      diagnostics: [],
    };
    await this.finishBuild(
      context,
      running,
      success,
      response.logs,
      stored.descriptors,
    );
    return success;
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
    return await this.storage.resources.listRevisions(
      context,
      PROJECT_RELEASE_KIND,
      releaseResourceId(projectId),
    ) as readonly Resource<ProjectReleaseDefinition>[];
  }

  async buildLog(
    context: CallContext,
    buildId: string,
  ): Promise<readonly string[]> {
    return (await this.logs.get(context, buildId))?.lines ?? [];
  }

  private async storeArtifacts(
    context: CallContext,
    source: Resource<PublishedProjectSource>,
    response: BuildWorkerSuccess,
  ): Promise<StoredBuildArtifacts> {
    const [client, server, testReport] = await Promise.all([
      this.artifacts.putImmutable(context, response.clientArtifact),
      this.artifacts.putImmutable(context, response.serverArtifact),
      this.artifacts.putImmutable(context, response.testReportArtifact),
    ]);
    const materials = await Promise.all(response.materials.map(async (item) => ({
      manifest: item.manifest,
      artifact: await this.artifacts.putImmutable(context, item.artifact),
    })));
    const testResult: ProjectTestResult = {
      ...response.testSummary,
      reportHash: testReport.hash,
    };
    const manifestContent = new TextEncoder().encode(JSON.stringify({
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
      clientEntryExport: "mount",
      serverEntryExport: "actions",
      client,
      server,
      testResult,
      actionIds: response.actionIds,
      materials,
    }, null, 2));
    const buildManifest = await this.artifacts.putImmutable(context, {
      contentType: "application/json",
      files: [{ path: "build-manifest.json", content: manifestContent }],
    });
    return {
      client,
      server,
      testReport,
      buildManifest,
      testResult,
      materials,
      descriptors: [
        client,
        server,
        testReport,
        buildManifest,
        ...materials.map((item) => item.artifact),
      ],
    };
  }

  private async publishRelease(
    context: CallContext,
    source: Resource<PublishedProjectSource>,
    response: BuildWorkerSuccess,
    stored: StoredBuildArtifacts,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    const materials: ProjectMaterialRef[] = stored.materials.map((item) => ({
      materialId: item.manifest.id,
      materialVersion: item.manifest.version,
      source: {
        authoringMode: "CODE",
        module: {
          projectId: source.spec.projectId,
          sourceRevision: source.revision,
          sourceFingerprint: source.spec.fingerprint,
          artifactHash: item.artifact.hash,
          dependencyLockHash: response.dependencyLockHash,
        },
      },
    }));
    const spec: ProjectReleaseDefinition = {
      projectId: source.spec.projectId,
      materials,
      sourceRevision: source.revision,
      sourceFingerprint: source.spec.fingerprint,
      packageJsonHash: response.packageJsonHash,
      dependencyLockHash: response.dependencyLockHash,
      builderVersion: BUILDER_VERSION,
      nodeVersion: process.version,
      pnpmVersion: response.pnpmVersion,
      runtimeAbiVersion: PROJECT_RUNTIME_ABI_VERSION,
      clientEntryExport: "mount",
      actionIds: response.actionIds,
      serverEntryExport: "actions",
      clientArtifact: stored.client,
      serverArtifact: stored.server,
      buildManifestArtifact: stored.buildManifest,
      materialArtifacts: stored.materials.map((item) => item.artifact),
      materialManifests: stored.materials.map((item) => item.manifest),
      testResult: stored.testResult,
      diagnostics: [],
      buildReproducibility: "DETERMINISTIC",
      runtimeReproducibility: "UNKNOWN",
    };
    const validation = validateProjectReleaseManifest(spec);
    if (validation.diagnostics.length > 0) throw new PrismError(validation.diagnostics);
    const id = releaseResourceId(source.spec.projectId);
    const draft = await this.storage.resources.saveDraft(context, {
      kind: PROJECT_RELEASE_KIND,
      id,
      name: `${source.spec.projectId} Release`,
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
      preconditions: [{
        kind: "document-present",
        collection: BUILD_COLLECTION,
        id: prior.id,
        fields: { status: prior.status },
      }],
      operations: [put(BUILD_COLLECTION, next, "replace")],
    });
  }

  private async finishBuild(
    context: CallContext,
    prior: ProjectBuildRequest,
    next: ProjectBuildRequest,
    lines: readonly string[],
    descriptors: readonly ProjectArtifactDescriptor[],
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
    ];
    await this.atomicWrite.execute(context, {
      requestId: `finish-project-build:${next.id}:${next.status}`,
      preconditions: [{
        kind: "document-present",
        collection: BUILD_COLLECTION,
        id: prior.id,
        fields: { status: prior.status },
      }],
      operations,
    });
  }
}

async function runBuildWorker(request: BuildWorkerRequest): Promise<BuildWorkerResponse> {
  const child = fork(fileURLToPath(new URL("./builder-worker.js", import.meta.url)), [], {
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
  });
  const { promise, resolve } = Promise.withResolvers<BuildWorkerResponse>();
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.once("message", (message: BuildWorkerResponse) => resolve(message));
  child.once("exit", (code) => {
    if (code !== 0) {
      resolve({
        type: "failure",
        message: `Build Worker exited ${code ?? "without code"}.`,
        logs: stderr,
      });
    }
  });
  child.send(request);
  const result = await promise;
  if (child.connected) child.disconnect();
  return result;
}

function parseMaterials(
  source: Resource<PublishedProjectSource>,
): readonly DeclaredCodeMaterialManifest[] {
  const file = source.spec.files.find((item) => item.path === "prism.materials.json");
  if (file === undefined) return [];
  const parsed = JSON.parse(file.content) as { readonly materials?: readonly DeclaredCodeMaterialManifest[] };
  return parsed.materials ?? [];
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

function buildRoutes(capability: ProjectBuildCapability): readonly HttpRoute[] {
  return [
    {
      method: "POST",
      path: "/api/code-projects/:id/builds",
      summary: "Build an exact published Project Source revision",
      handler: async (request) => {
        requireBuilder(request.call);
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
      summary: "List Project Builds",
      handler: async (request) => ({
        status: 200,
        body: await capability.listBuilds(
          request.call,
          string(record(request.params).id),
        ),
      }),
    },
    {
      method: "GET",
      path: "/api/project-builds/:id/log",
      summary: "Read structured Build Worker log lines",
      handler: async (request) => ({
        status: 200,
        body: { lines: await capability.buildLog(request.call, string(record(request.params).id)) },
      }),
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/releases",
      summary: "List immutable Project Releases",
      handler: async (request) => ({
        status: 200,
        body: await capability.releases(
          request.call,
          string(record(request.params).id),
        ),
      }),
    },
  ];
}

function requireBuilder(context: CallContext): void {
  if (!context.principal.roles.includes("BUILDER") && !context.principal.roles.includes("system")) {
    throw PrismError.of("PROJECT_BUILDER_REQUIRED", "Project build requires BUILDER role.");
  }
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
