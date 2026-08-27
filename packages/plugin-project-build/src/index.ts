import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import {
  PrismError,
  diagnostic,
  type CallContext,
} from "@prismengine/contracts-data";
import {
  ProjectBuildCapabilityToken,
  validateProjectReleaseManifest,
  type DeclaredCodeMaterialManifest,
  type ProjectArtifactDescriptor,
  type ProjectBuildCapability,
  type ProjectBuildRequest,
  type ProjectMaterialRef,
  type ProjectReleaseDefinition,
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
const BUILDER_VERSION = "0.1.8";

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
  clientArtifact: Type.Any(),
  serverArtifact: Type.Any(),
  buildManifestArtifact: Type.Any(),
  testResult: Type.Any(),
  diagnostics: Type.Array(Type.Any()),
  reproducibility: Type.Union([
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

export interface ProjectBuildPluginOptions {
  readonly artifactRoot: string;
}

interface BuildLogDocument {
  readonly id: string;
  readonly lines: readonly string[];
}

interface ArtifactDocument extends ProjectArtifactDescriptor {
  readonly id: string;
  readonly createdAt: string;
}

export function projectBuildPlugin(options: ProjectBuildPluginOptions) {
  return definePlugin({
    id: "project.build",
    version: BUILDER_VERSION,
    requires: {
      storage: StorageCapabilityToken,
      atomicWrite: AtomicWriteCapabilityToken,
      codeProjects: CodeProjectCapabilityToken,
    },
    provides: [ProjectBuildCapabilityToken],
    register(context) {
      context.resources.define(ProjectReleaseResource);
      const capability = new DefaultProjectBuildCapability(
        context.dependencies.storage,
        context.dependencies.atomicWrite,
        context.dependencies.codeProjects,
        options.artifactRoot,
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
    private readonly codeProjects: CodeProjectCapability,
    private readonly artifactRoot: string,
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
      artifactRoot: this.artifactRoot,
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
    const release = await this.publishRelease(context, source, response);
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
      artifacts(response),
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

  private async publishRelease(
    context: CallContext,
    source: Resource<PublishedProjectSource>,
    response: BuildWorkerSuccess,
  ): Promise<Resource<ProjectReleaseDefinition>> {
    const materials: ProjectMaterialRef[] = response.materials.map((item) => ({
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
      clientArtifact: response.clientArtifact,
      serverArtifact: response.serverArtifact,
      buildManifestArtifact: response.buildManifestArtifact,
      testResult: response.testResult,
      diagnostics: [],
      reproducibility: "DETERMINISTIC",
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

function artifacts(response: BuildWorkerSuccess): readonly ProjectArtifactDescriptor[] {
  return [
    response.clientArtifact,
    response.serverArtifact,
    response.buildManifestArtifact,
    response.testReportArtifact,
    ...response.materials.map((item) => item.artifact),
  ];
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
