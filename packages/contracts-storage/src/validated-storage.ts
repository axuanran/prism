import { hasErrors, PrismError } from "@prismengine/contracts-data";
import type { CallContext } from "@prismengine/contracts-data";
import {
  validateResourceSpec,
  type Resource,
  type ResourceQuery,
  type ResourceTypeDefinition,
  type ResourceTypeRegistry,
  type ValidationContext,
} from "@prismengine/kernel";
import {
  StorageDiagnosticCode,
  type DocumentCollection,
  type ResourceStore,
  type SaveDraftCommand,
  type StorageCapability,
} from "./capability.js";

function validationContext(resources: ResourceStore, call: CallContext): ValidationContext {
  return {
    resolveResource: async (kind, id) => {
      const resource = await resources.getPublished(call, kind, id);
      return resource === null ? null : { id: resource.id, spec: resource.spec };
    },
  };
}

async function assertValid(
  resources: ResourceStore,
  resourceTypes: ResourceTypeRegistry,
  call: CallContext,
  kind: string,
  spec: unknown,
): Promise<void> {
  const definition: ResourceTypeDefinition | undefined = resourceTypes.get(kind);
  if (definition === undefined) return;

  const result = await validateResourceSpec(
    definition,
    spec,
    validationContext(resources, call),
  );
  if (!result.valid || hasErrors(result.diagnostics)) {
    throw new PrismError(result.diagnostics);
  }
}

class ValidatingResourceStore implements ResourceStore {
  constructor(
    private readonly delegate: ResourceStore,
    private readonly resourceTypes: ResourceTypeRegistry,
  ) {}

  get<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec> | null> {
    return this.delegate.get<TSpec>(context, kind, id, revision);
  }

  getPublished<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
  ): Promise<Resource<TSpec> | null> {
    return this.delegate.getPublished<TSpec>(context, kind, id);
  }

  list(context: CallContext, query: ResourceQuery): Promise<readonly Resource[]> {
    return this.delegate.list(context, query);
  }

  listRevisions(
    context: CallContext,
    kind: string,
    id: string,
  ): Promise<readonly Resource[]> {
    return this.delegate.listRevisions(context, kind, id);
  }

  async saveDraft<TSpec>(
    context: CallContext,
    command: SaveDraftCommand<TSpec>,
  ): Promise<Resource<TSpec>> {
    await assertValid(
      this.delegate,
      this.resourceTypes,
      context,
      command.kind,
      command.spec,
    );
    return this.delegate.saveDraft(context, command);
  }

  async publish<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision: number,
    expectedUpdatedAt?: string,
  ): Promise<Resource<TSpec>> {
    const definition = this.resourceTypes.get(kind);
    if (definition === undefined) {
      return this.delegate.publish<TSpec>(context, kind, id, revision, expectedUpdatedAt);
    }

    const draft = await this.delegate.get(context, kind, id, revision);
    if (draft === null || draft.status !== "draft") {
      return this.delegate.publish<TSpec>(context, kind, id, revision, expectedUpdatedAt);
    }

    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== draft.updatedAt) {
      throw PrismError.of(
        StorageDiagnosticCode.RESOURCE_CONFLICT,
        `Resource ${kind}/${id} changed after it was loaded.`,
        {
          kind,
          id,
          expectedUpdatedAt,
          actualUpdatedAt: draft.updatedAt,
        },
      );
    }

    await assertValid(this.delegate, this.resourceTypes, context, kind, draft.spec);
    return this.delegate.publish<TSpec>(context, kind, id, revision, draft.updatedAt);
  }

  clone<TSpec>(
    context: CallContext,
    kind: string,
    id: string,
    revision?: number,
  ): Promise<Resource<TSpec>> {
    return this.delegate.clone<TSpec>(context, kind, id, revision);
  }

  archive(context: CallContext, kind: string, id: string): Promise<void> {
    return this.delegate.archive(context, kind, id);
  }
}

/**
 * Adds registered Resource schema and semantic validation to a raw provider.
 * Unknown kinds remain available for provider-level contracts and migrations.
 */
export function withResourceValidation(
  storage: StorageCapability,
  resourceTypes: ResourceTypeRegistry,
): StorageCapability {
  const resources = new ValidatingResourceStore(storage.resources, resourceTypes);
  return {
    resources,
    audit: storage.audit,
    productionReadiness: (context) => storage.productionReadiness(context),
    collection<TDocument extends { readonly id: string }>(
      name: string,
    ): DocumentCollection<TDocument> {
      return storage.collection<TDocument>(name);
    },
  };
}
