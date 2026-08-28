import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  PrismError,
  diagnostic,
  hasErrors,
  type CallContext,
  type Diagnostic,
} from "@prismengine/contracts-data";
import { validateMaterialManifest } from "@prismengine/contracts-project";
import type {
  CodeProjectDefinition,
  DeclaredCodeMaterialManifest,
  DraftMaterialCatalogItem,
  ProjectSourceDefinition,
  ProjectSourceDraft,
  ProjectSourceFile,
} from "@prismengine/contracts-project";
import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
  StorageDiagnosticCode,
  type AtomicDocument,
  type AtomicWriteCapability,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import {
  defineCapability,
  definePlugin,
  type Resource,
  type ResourceTypeDefinition,
} from "@prismengine/kernel";
import {
  HttpRouteExtensionPoint,
  type HttpRoute,
} from "@prismengine/plugin-http-fastify";

export const CODE_PROJECT_KIND = "project.code-project";
export const PROJECT_SOURCE_KIND = "project.source";
const SOURCE_DRAFT_COLLECTION = "project.source-drafts";
const ALLOWED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".sql", ".yaml", ".yml",
]);

const CodeProjectSchema = Type.Object({
  slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  name: Type.String({ minLength: 1 }),
  sourceId: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
}, { additionalProperties: false });

const ProjectSourceSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  fingerprint: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  files: Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }),
    mediaType: Type.String({ minLength: 1 }),
    content: Type.String(),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export interface PublishedProjectSource extends ProjectSourceDefinition {
  readonly fingerprint: string;
}

export const CodeProjectResource: ResourceTypeDefinition<CodeProjectDefinition> = {
  kind: CODE_PROJECT_KIND,
  title: "Code Project",
  description: "Programmable Studio project identity.",
  config: { schema: CodeProjectSchema },
  exposure: { configuration: false, frontend: true },
};

export const ProjectSourceResource: ResourceTypeDefinition<PublishedProjectSource> = {
  kind: PROJECT_SOURCE_KIND,
  title: "Published Project Source",
  description: "Immutable canonical UTF-8 source tree revision.",
  config: {
    schema: ProjectSourceSchema,
    validate(spec) {
      const result = validateFiles(spec.files);
      return {
        valid: result.valid && fingerprintFiles(spec.projectId, result.files) === spec.fingerprint,
        diagnostics: result.valid && fingerprintFiles(spec.projectId, result.files) !== spec.fingerprint
          ? [diagnostic(
              "PROJECT_SOURCE_FINGERPRINT_MISMATCH",
              "Published source fingerprint does not match its canonical tree.",
              { path: "/fingerprint" },
            )]
          : result.diagnostics,
      };
    },
  },
  exposure: { configuration: false, frontend: true },
};

export interface CreateCodeProjectCommand {
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly files?: readonly ProjectSourceFile[];
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

export interface CodeProjectCapability {
  list(context: CallContext): Promise<readonly Resource<CodeProjectDefinition>[]>;
  get(context: CallContext, id: string): Promise<Resource<CodeProjectDefinition> | null>;
  getBySlug(context: CallContext, slug: string): Promise<Resource<CodeProjectDefinition> | null>;
  create(
    context: CallContext,
    command: CreateCodeProjectCommand,
  ): Promise<{
    readonly project: Resource<CodeProjectDefinition>;
    readonly draft: ProjectSourceDraft;
  }>;
  draft(context: CallContext, projectId: string): Promise<ProjectSourceDraft>;
  saveDraft(
    context: CallContext,
    projectId: string,
    expectedDraftVersion: number,
    files: readonly ProjectSourceFile[],
  ): Promise<ProjectSourceDraft>;
  draftMaterials(
    context: CallContext,
    projectId: string,
  ): Promise<readonly DraftMaterialCatalogItem[]>;
  publishDraft(
    context: CallContext,
    projectId: string,
    expectedDraftVersion: number,
  ): Promise<Resource<PublishedProjectSource>>;
  source(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<PublishedProjectSource> | null>;
  sourceRevisions(
    context: CallContext,
    projectId: string,
  ): Promise<readonly Resource<PublishedProjectSource>[]>;
  diff(
    context: CallContext,
    projectId: string,
    from: number | "draft",
    to: number | "draft",
  ): Promise<ProjectSourceDiff>;
}

export const CodeProjectCapabilityToken = defineCapability<CodeProjectCapability>({
  id: "project.code",
  version: "1.0.0",
});

export const codeProjectPlugin = definePlugin({
  id: "project.code",
  version: "0.1.19",
  requires: {
    storage: StorageCapabilityToken,
    atomicWrite: AtomicWriteCapabilityToken,
  },
  provides: [CodeProjectCapabilityToken],
  register(context) {
    context.resources.define(CodeProjectResource);
    context.resources.define(ProjectSourceResource);
    const capability = new DefaultCodeProjectCapability(
      context.dependencies.storage,
      context.dependencies.atomicWrite,
    );
    context.provide(CodeProjectCapabilityToken, capability);
    for (const route of codeProjectRoutes(capability)) {
      context.extensions.contribute(HttpRouteExtensionPoint, route);
    }
  },
});

class DefaultCodeProjectCapability implements CodeProjectCapability {
  private readonly drafts;

  constructor(
    private readonly storage: StorageCapability,
    private readonly atomicWrite: AtomicWriteCapability,
  ) {
    this.drafts = storage.collection<ProjectSourceDraft>(SOURCE_DRAFT_COLLECTION);
  }

  async list(context: CallContext): Promise<readonly Resource<CodeProjectDefinition>[]> {
    return await this.storage.resources.list(context, {
      kind: CODE_PROJECT_KIND,
      status: "published",
    }) as readonly Resource<CodeProjectDefinition>[];
  }

  async get(
    context: CallContext,
    id: string,
  ): Promise<Resource<CodeProjectDefinition> | null> {
    return this.storage.resources.getPublished(context, CODE_PROJECT_KIND, id);
  }

  async getBySlug(
    context: CallContext,
    slug: string,
  ): Promise<Resource<CodeProjectDefinition> | null> {
    return (await this.list(context)).find((project) => project.spec.slug === slug) ?? null;
  }

  async create(
    context: CallContext,
    command: CreateCodeProjectCommand,
  ): Promise<{
    readonly project: Resource<CodeProjectDefinition>;
    readonly draft: ProjectSourceDraft;
  }> {
    if ((await this.getBySlug(context, command.slug)) !== null) {
      throw PrismError.of(
        "CODE_PROJECT_SLUG_DUPLICATE",
        `Code Project slug ${command.slug} already exists.`,
        { slug: command.slug },
      );
    }
    const projectId = command.id ?? crypto.randomUUID();
    const sourceId = `${projectId}:source`;
    const projectDraft = await this.storage.resources.saveDraft<CodeProjectDefinition>(context, {
      kind: CODE_PROJECT_KIND,
      id: projectId,
      name: command.name,
      spec: {
        slug: command.slug,
        name: command.name,
        sourceId,
        ...(command.description === undefined ? {} : { description: command.description }),
      },
    });
    const project = await this.storage.resources.publish<CodeProjectDefinition>(
      context,
      CODE_PROJECT_KIND,
      projectId,
      projectDraft.revision,
    );
    const normalized = requireValidFiles(command.files ?? defaultFiles(command));
    const now = new Date().toISOString();
    const draft: ProjectSourceDraft = {
      id: projectId,
      projectId,
      sourceId,
      baseSourceRevision: null,
      draftVersion: 1,
      files: normalized,
      updatedAt: now,
      updatedBy: context.principal.id,
    };
    await this.atomicWrite.execute(context, {
      requestId: `create-project-draft:${projectId}`,
      preconditions: [{
        kind: "document-absent",
        collection: SOURCE_DRAFT_COLLECTION,
        id: projectId,
      }],
      operations: [putDraft(draft, "create")],
    });
    return { project, draft };
  }

  async draft(context: CallContext, projectId: string): Promise<ProjectSourceDraft> {
    await this.requiredProject(context, projectId);
    const draft = await this.drafts.get(context, projectId);
    if (draft === null) {
      throw PrismError.of(
        "PROJECT_SOURCE_DRAFT_NOT_FOUND",
        "Project Source draft does not exist.",
        { projectId },
      );
    }
    return draft;
  }

  async saveDraft(
    context: CallContext,
    projectId: string,
    expectedDraftVersion: number,
    files: readonly ProjectSourceFile[],
  ): Promise<ProjectSourceDraft> {
    const current = await this.draft(context, projectId);
    const next: ProjectSourceDraft = {
      ...current,
      draftVersion: expectedDraftVersion + 1,
      files: requireValidFiles(files),
      updatedAt: new Date().toISOString(),
      updatedBy: context.principal.id,
    };
    try {
      await this.atomicWrite.execute(context, {
        requestId: `save-project-draft:${projectId}:${next.draftVersion}`,
        preconditions: [{
          kind: "document-present",
          collection: SOURCE_DRAFT_COLLECTION,
          id: projectId,
          fields: { draftVersion: expectedDraftVersion },
        }],
        operations: [putDraft(next, "replace")],
      });
    } catch (error) {
      if (
        error instanceof PrismError &&
        error.diagnostics.some((item) =>
          item.code === StorageDiagnosticCode.ATOMIC_WRITE_PRECONDITION_FAILED)
      ) {
        throw PrismError.of(
          "PROJECT_SOURCE_DRAFT_CONFLICT",
          "Project Source draft was changed by another editor.",
          { projectId, expectedDraftVersion },
        );
      }
      throw error;
    }
    return next;
  }

  async draftMaterials(
    context: CallContext,
    projectId: string,
  ): Promise<readonly DraftMaterialCatalogItem[]> {
    return parseDeclaredMaterials((await this.draft(context, projectId)).files).map(
      (manifest) => ({ manifest, status: "DECLARED", buildStatus: "NOT_BUILT" }),
    );
  }

  async publishDraft(
    context: CallContext,
    projectId: string,
    expectedDraftVersion: number,
  ): Promise<Resource<PublishedProjectSource>> {
    const project = await this.requiredProject(context, projectId);
    const draft = await this.draft(context, projectId);
    if (draft.draftVersion !== expectedDraftVersion) {
      throw PrismError.of(
        "PROJECT_SOURCE_DRAFT_CONFLICT",
        "Project Source draft was changed before publication.",
        { projectId, expectedDraftVersion, actualDraftVersion: draft.draftVersion },
      );
    }
    const files = requireValidFiles(draft.files);
    parseProjectManifest(files);
    parseDeclaredMaterials(files);
    const sourceDraft = await this.storage.resources.saveDraft<PublishedProjectSource>(context, {
      kind: PROJECT_SOURCE_KIND,
      id: project.spec.sourceId,
      name: `${project.spec.name} Source`,
      spec: {
        projectId,
        files,
        fingerprint: fingerprintFiles(projectId, files),
      },
    });
    const published = await this.storage.resources.publish<PublishedProjectSource>(
      context,
      PROJECT_SOURCE_KIND,
      sourceDraft.id,
      sourceDraft.revision,
    );
    const next: ProjectSourceDraft = {
      ...draft,
      baseSourceRevision: published.revision,
      draftVersion: draft.draftVersion + 1,
      files,
      updatedAt: new Date().toISOString(),
      updatedBy: context.principal.id,
    };
    await this.atomicWrite.execute(context, {
      requestId: `publish-project-source:${projectId}:${published.revision}`,
      preconditions: [{
        kind: "document-present",
        collection: SOURCE_DRAFT_COLLECTION,
        id: projectId,
        fields: { draftVersion: expectedDraftVersion },
      }],
      operations: [putDraft(next, "replace")],
    });
    return published;
  }

  async source(
    context: CallContext,
    projectId: string,
    revision: number,
  ): Promise<Resource<PublishedProjectSource> | null> {
    const project = await this.requiredProject(context, projectId);
    return this.storage.resources.get(
      context,
      PROJECT_SOURCE_KIND,
      project.spec.sourceId,
      revision,
    );
  }

  async sourceRevisions(
    context: CallContext,
    projectId: string,
  ): Promise<readonly Resource<PublishedProjectSource>[]> {
    const project = await this.requiredProject(context, projectId);
    return await this.storage.resources.listRevisions(
      context,
      PROJECT_SOURCE_KIND,
      project.spec.sourceId,
    ) as readonly Resource<PublishedProjectSource>[];
  }

  async diff(
    context: CallContext,
    projectId: string,
    from: number | "draft",
    to: number | "draft",
  ): Promise<ProjectSourceDiff> {
    const [left, right] = await Promise.all([
      this.filesAt(context, projectId, from),
      this.filesAt(context, projectId, to),
    ]);
    const a = new Map(left.map((file) => [file.path, file.content]));
    const b = new Map(right.map((file) => [file.path, file.content]));
    const added = [...b.keys()].filter((path) => !a.has(path));
    const removed = [...a.keys()].filter((path) => !b.has(path));
    const changed = [...b.keys()].filter((path) =>
      a.has(path) && a.get(path) !== b.get(path));
    const leftMaterials = new Map(parseDeclaredMaterials(left).map((item) => [
      `${item.id}@${item.version}`,
      JSON.stringify(item),
    ]));
    const rightMaterials = new Map(parseDeclaredMaterials(right).map((item) => [
      `${item.id}@${item.version}`,
      JSON.stringify(item),
    ]));
    return {
      projectId,
      from,
      to,
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
      materialChanges: {
        added: [...rightMaterials.keys()].filter((id) => !leftMaterials.has(id)).sort(),
        removed: [...leftMaterials.keys()].filter((id) => !rightMaterials.has(id)).sort(),
        changed: [...rightMaterials.keys()].filter((id) =>
          leftMaterials.has(id) && leftMaterials.get(id) !== rightMaterials.get(id)).sort(),
      },
    };
  }

  private async filesAt(
    context: CallContext,
    projectId: string,
    identity: number | "draft",
  ): Promise<readonly ProjectSourceFile[]> {
    if (identity === "draft") return (await this.draft(context, projectId)).files;
    const source = await this.source(context, projectId, identity);
    if (source === null) {
      throw PrismError.of(
        "PROJECT_SOURCE_REVISION_NOT_FOUND",
        "Published Project Source revision does not exist.",
        { projectId, revision: identity },
      );
    }
    return source.spec.files;
  }

  private async requiredProject(
    context: CallContext,
    projectId: string,
  ): Promise<Resource<CodeProjectDefinition>> {
    const project = await this.get(context, projectId);
    if (project === null) {
      throw PrismError.of(
        "CODE_PROJECT_NOT_FOUND",
        `Code Project ${projectId} does not exist.`,
        { projectId },
      );
    }
    return project;
  }
}

function validateFiles(files: readonly ProjectSourceFile[]): {
  readonly valid: boolean;
  readonly files: readonly ProjectSourceFile[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const canonical: ProjectSourceFile[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const [index, file] of files.entries()) {
    const path = file.path.normalize("NFC");
    const extensionIndex = path.lastIndexOf(".");
    const extension = extensionIndex < 0 ? "" : path.slice(extensionIndex).toLowerCase();
    if (
      path === "" || path.startsWith("/") || path.includes("\\") ||
      path.includes("\u0000") || path.split("/").includes("..") ||
      path !== file.path || !ALLOWED_EXTENSIONS.has(extension)
    ) {
      diagnostics.push(diagnostic(
        "PROJECT_SOURCE_PATH_INVALID",
        `Project file path ${file.path} is invalid or unsupported.`,
        { path: `/files/${index}/path` },
      ));
    }
    const lower = path.toLocaleLowerCase("en-US");
    if (exact.has(path) || folded.has(lower)) {
      diagnostics.push(diagnostic(
        "PROJECT_SOURCE_PATH_CONFLICT",
        `Project file path ${file.path} conflicts with another path.`,
        { path: `/files/${index}/path` },
      ));
    }
    exact.add(path);
    folded.add(lower);
    canonical.push({
      path,
      mediaType: file.mediaType,
      content: file.content.replace(/\r\n?/g, "\n"),
    });
  }
  canonical.sort((left, right) => left.path.localeCompare(right.path));
  return { valid: diagnostics.length === 0, files: canonical, diagnostics };
}

function requireValidFiles(
  files: readonly ProjectSourceFile[],
): readonly ProjectSourceFile[] {
  const result = validateFiles(files);
  if (!result.valid) throw new PrismError(result.diagnostics);
  return result.files;
}

export function fingerprintFiles(
  projectId: string,
  files: readonly ProjectSourceFile[],
): string {
  const canonical = requireValidFiles(files);
  return createHash("sha256").update(JSON.stringify({ projectId, files: canonical })).digest("hex");
}

function parseProjectManifest(files: readonly ProjectSourceFile[]): void {
  const file = files.find((item) => item.path === "prism.project.json");
  if (file === undefined) {
    throw PrismError.of(
      "PROJECT_MANIFEST_MISSING",
      "prism.project.json is required.",
      { path: "/files" },
    );
  }
  const value = parseJson(file.content, "prism.project.json");
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== "1.0.0"
  ) {
    throw PrismError.of(
      "PROJECT_MANIFEST_INVALID",
      "prism.project.json must declare schemaVersion 1.0.0.",
      { path: "/files/prism.project.json" },
    );
  }
}

function parseDeclaredMaterials(
  files: readonly ProjectSourceFile[],
): readonly DeclaredCodeMaterialManifest[] {
  const file = files.find((item) => item.path === "prism.materials.json");
  if (file === undefined) {
    throw PrismError.of(
      "PROJECT_MATERIAL_MANIFEST_MISSING",
      "prism.materials.json is required.",
      { path: "/files" },
    );
  }
  const value = parseJson(file.content, "prism.materials.json");
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== "1.0.0" ||
    !("materials" in value) || !Array.isArray(value.materials)
  ) {
    throw PrismError.of(
      "PROJECT_MATERIAL_MANIFEST_INVALID",
      "prism.materials.json must contain schemaVersion 1.0.0 and materials[].",
      { path: "/files/prism.materials.json" },
    );
  }
  const identities = new Set<string>();
  return value.materials.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw PrismError.of(
        "PROJECT_MATERIAL_MANIFEST_INVALID",
        "Material declaration must be an object.",
        { path: `/materials/${index}` },
      );
    }
    const manifest = item as unknown as DeclaredCodeMaterialManifest;
    const validation = validateMaterialManifest(manifest);
    if (hasErrors(validation.diagnostics)) throw new PrismError(validation.diagnostics);
    if (
      manifest.authoringMode !== "CODE" ||
      typeof manifest.entry !== "string" ||
      !/^[A-Za-z_$][\w$]*$/.test(manifest.exportName)
    ) {
      throw PrismError.of(
        "PROJECT_MATERIAL_DECLARATION_INVALID",
        "Code Material requires authoringMode CODE, entry and a valid exportName.",
        { path: `/materials/${index}` },
      );
    }
    if (!files.some((candidate) => candidate.path === manifest.entry)) {
      throw PrismError.of(
        "PROJECT_MATERIAL_ENTRY_NOT_FOUND",
        `Material entry ${manifest.entry} does not exist.`,
        { path: `/materials/${index}/entry` },
      );
    }
    const identity = `${manifest.id}\u0000${manifest.version}`;
    if (identities.has(identity)) {
      throw PrismError.of(
        "PROJECT_SOURCE_MATERIAL_DUPLICATE",
        "Project Source contains a duplicate Material identity.",
        { path: `/materials/${index}` },
      );
    }
    identities.add(identity);
    return manifest;
  });
}

function parseJson(content: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw PrismError.of(
      "PROJECT_JSON_INVALID",
      `${path} is not valid JSON.`,
      { path: `/files/${path}` },
    );
  }
}

function putDraft(
  draft: ProjectSourceDraft,
  mode: "create" | "replace",
) {
  return {
    kind: "put-document" as const,
    collection: SOURCE_DRAFT_COLLECTION,
    document: draft as unknown as AtomicDocument,
    mode,
  };
}

function codeProjectRoutes(capability: CodeProjectCapability): readonly HttpRoute[] {
  return [
    {
      method: "GET",
      path: "/api/code-projects",
      summary: "List Code Projects",
      handler: async (request) => ({ status: 200, body: await capability.list(request.call) }),
    },
    {
      method: "POST",
      path: "/api/code-projects",
      summary: "Create a Code Project and source draft",
      handler: async (request) => {
        requireBuilder(request.call);
        const body = record(request.body, "/body");
        return {
          status: 201,
          body: await capability.create(request.call, {
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            slug: string(body.slug, "/body/slug"),
            name: string(body.name, "/body/name"),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
          }),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/draft",
      summary: "Load autosaved source draft",
      handler: async (request) => ({
        status: 200,
        body: await capability.draft(
          request.call,
          string(record(request.params, "/params").id, "/params/id"),
        ),
      }),
    },
    {
      method: "PUT",
      path: "/api/code-projects/:id/draft/:version",
      summary: "CAS autosave source draft",
      handler: async (request) => {
        requireBuilder(request.call);
        const params = record(request.params, "/params");
        const body = record(request.body, "/body");
        return {
          status: 200,
          body: await capability.saveDraft(
            request.call,
            string(params.id, "/params/id"),
            positiveInteger(params.version, "/params/version"),
            files(body.files, "/body/files"),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/draft/materials",
      summary: "Project-scoped declared, not-built Material catalog",
      handler: async (request) => ({
        status: 200,
        body: await capability.draftMaterials(
          request.call,
          string(record(request.params, "/params").id, "/params/id"),
        ),
      }),
    },
    {
      method: "POST",
      path: "/api/code-projects/:id/draft/:version/publish",
      summary: "Publish immutable canonical Project Source revision",
      handler: async (request) => {
        requireBuilder(request.call);
        const params = record(request.params, "/params");
        return {
          status: 200,
          body: await capability.publishDraft(
            request.call,
            string(params.id, "/params/id"),
            positiveInteger(params.version, "/params/version"),
          ),
        };
      },
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/source/revisions",
      summary: "List published source revisions",
      handler: async (request) => ({
        status: 200,
        body: await capability.sourceRevisions(
          request.call,
          string(record(request.params, "/params").id, "/params/id"),
        ),
      }),
    },
    {
      method: "GET",
      path: "/api/code-projects/:id/source/diff",
      summary: "Diff published or draft source identities",
      handler: async (request) => {
        const params = record(request.params, "/params");
        const query = record(request.query, "/query");
        return {
          status: 200,
          body: await capability.diff(
            request.call,
            string(params.id, "/params/id"),
            sourceIdentity(query.from, "/query/from"),
            sourceIdentity(query.to, "/query/to"),
          ),
        };
      },
    },
  ];
}

function requireBuilder(context: CallContext): void {
  if (!context.principal.roles.includes("BUILDER") && !context.principal.roles.includes("system")) {
    throw PrismError.of(
      "PROJECT_BUILDER_REQUIRED",
      "Code Project mutation requires the BUILDER role.",
      { principalId: context.principal.id },
    );
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw PrismError.of("PROJECT_REQUEST_INVALID", "Expected an object.", { path });
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw PrismError.of("PROJECT_REQUEST_INVALID", "Expected a non-empty string.", { path });
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw PrismError.of("PROJECT_REQUEST_INVALID", "Expected a positive integer.", { path });
  }
  return parsed;
}

function sourceIdentity(value: unknown, path: string): number | "draft" {
  return value === "draft" ? "draft" : positiveInteger(value, path);
}

function files(value: unknown, path: string): readonly ProjectSourceFile[] {
  if (!Array.isArray(value)) {
    throw PrismError.of("PROJECT_REQUEST_INVALID", "Expected files array.", { path });
  }
  return value.map((item, index) => {
    const file = record(item, `${path}/${index}`);
    return {
      path: string(file.path, `${path}/${index}/path`),
      mediaType: string(file.mediaType, `${path}/${index}/mediaType`),
      content: typeof file.content === "string"
        ? file.content
        : (() => { throw PrismError.of("PROJECT_REQUEST_INVALID", "Expected text content.", { path: `${path}/${index}/content` }); })(),
    };
  });
}

function defaultFiles(command: CreateCodeProjectCommand): readonly ProjectSourceFile[] {
  const project = JSON.stringify({
    schemaVersion: "1.0.0",
    id: command.id ?? command.slug,
    slug: command.slug,
    name: command.name,
  }, null, 2);
  return [
    textFile("package.json", JSON.stringify({
      name: command.slug,
      private: true,
      type: "module",
      dependencies: {},
    }, null, 2), "application/json"),
    textFile("pnpm-lock.yaml", [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"), "application/yaml"),
    textFile("prism.project.json", project, "application/json"),
    textFile("prism.materials.json", JSON.stringify({
      schemaVersion: "1.0.0",
      materials: [],
    }, null, 2), "application/json"),
    textFile("src/client/index.tsx", [
      "export async function mount(context: { root: HTMLElement }): Promise<void> {",
      `  context.root.textContent = ${JSON.stringify(command.name)};`,
      "}",
      "",
    ].join("\n"), "text/typescript-jsx"),
    textFile("src/server/index.ts", "export const actions = {};\n", "text/typescript"),
    textFile("tests/project.test.ts", "export default async () => ({ passed: true });\n", "text/typescript"),
  ];
}

function textFile(path: string, content: string, mediaType: string): ProjectSourceFile {
  return { path, content, mediaType };
}
