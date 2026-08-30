import {
  CalculationCapabilityToken,
  type CalculationCapability,
  type PipelineSpec,
} from "@prismengine/contracts-calculation";
import {
  D,
  Decimal,
  collectRows,
  datasetFromRows,
  type Dataset,
  type Row,
  type RowValue,
  type TableType,
  type ValueType,
} from "@prismengine/contracts-data";
import {
  OrganizationAdministrationToken,
  OrganizationCapabilityToken,
  type OrganizationAdministration,
  type OrganizationCapability,
  type OrganizationUnitId,
  type PersonId,
  type PositionId,
} from "@prismengine/contracts-organization";
import {
  StorageCapabilityToken,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import { PrismError } from "@prismengine/contracts-data";
import {
  definePlugin,
  type ResourceTypeDefinition,
  type ResourceTypeRegistry,
} from "@prismengine/kernel";
import {
  HttpRouteExtensionPoint,
  publicDiagnostics,
  type HttpRoute,
} from "@prismengine/plugin-http-fastify";

export const studioApiPlugin = definePlugin({
  id: "studio.api",
  version: "0.1.20",
  engineRange: "^0.1.20",
  requires: {
    storage: StorageCapabilityToken,
    calculation: CalculationCapabilityToken,
    organization: OrganizationCapabilityToken,
    organizationAdministration: OrganizationAdministrationToken,
  },
  register(context) {
    const services = {
      storage: context.dependencies.storage,
      calculation: context.dependencies.calculation,
      organization: context.dependencies.organization,
      organizationAdministration: context.dependencies.organizationAdministration,
      resourceTypes: context.resources,
    };
    for (const route of studioRoutes(services)) {
      context.extensions.contribute(HttpRouteExtensionPoint, route);
    }
  },
});

interface StudioServices {
  readonly storage: StorageCapability;
  readonly calculation: CalculationCapability;
  readonly organization: OrganizationCapability;
  readonly organizationAdministration: OrganizationAdministration;
  readonly resourceTypes: ResourceTypeRegistry;
}

function studioRoutes(services: StudioServices): readonly HttpRoute[] {
  return [
    ...resourceRoutes(services.storage, services.resourceTypes),
    ...organizationRoutes(services.organization, services.organizationAdministration),
    ...calculationRoutes(services.calculation),
  ];
}

function resourceRoutes(
  storage: StorageCapability,
  resourceTypes: ResourceTypeRegistry,
): readonly HttpRoute[] {
  const configurable = (): readonly ResourceTypeDefinition[] =>
    resourceTypes.list().filter((definition) => definition.exposure.configuration === true);
  const definition = (kind: string): ResourceTypeDefinition => {
    const found = resourceTypes.get(kind);
    if (found === undefined || found.exposure.configuration !== true) {
      throw PrismError.of(
        "RESOURCE_NOT_FOUND",
        "Configurable Resource type was not found.",
        {
          kind,
        },
      );
    }
    return found;
  };
  return [
    {
      method: "GET",
      path: "/api/resource-types",
      access: { kind: "permission", permission: "resource.read" },
      summary: "List Resource types exposed to generic Studio configuration",
      handler: async () => ({
        status: 200,
        body: configurable().map((item) => ({
          kind: item.kind,
          title: item.title,
          ...(item.description ? { description: item.description } : {}),
          schema: item.config.schema,
          ...(item.presentation ? { presentation: item.presentation } : {}),
          exposure: item.exposure,
        })),
      }),
    },
    {
      method: "GET",
      path: "/api/resources",
      access: { kind: "permission", permission: "resource.read" },
      summary: "List generic configurable Resources",
      handler: async (request) => {
        const query = optionalRecord(request.query);
        const kind = optionalString(query.kind);
        const status = resourceStatus(query.status);
        if (kind !== undefined) definition(kind);
        const allowed = new Set(configurable().map((item) => item.kind));
        const resources = await storage.resources.list(request.call, {
          ...(kind === undefined ? {} : { kind }),
          ...(status === undefined ? {} : { status }),
        });
        return {
          status: 200,
          body: resources.filter((resource) => allowed.has(resource.kind)),
        };
      },
    },
    {
      method: "GET",
      path: "/api/resources/:kind/:id",
      access: { kind: "permission", permission: "resource.read" },
      summary: "Read the latest generic configurable Resource revision",
      handler: async (request) => {
        const params = record(request.params);
        const kind = string(params.kind);
        definition(kind);
        const resource = await storage.resources.get(request.call, kind, string(params.id));
        if (resource === null) throw resourceMissing(kind, string(params.id));
        return { status: 200, body: resource };
      },
    },
    {
      method: "GET",
      path: "/api/resources/:kind/:id/revisions",
      access: { kind: "permission", permission: "resource.read" },
      summary: "List generic configurable Resource revisions",
      handler: async (request) => {
        const params = record(request.params);
        const kind = string(params.kind);
        definition(kind);
        return {
          status: 200,
          body: await storage.resources.listRevisions(
            request.call,
            kind,
            string(params.id),
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/resources/:kind",
      access: { kind: "permission", permission: "resource.write" },
      summary: "Create a validated generic Resource Draft",
      handler: async (request) => {
        const kind = string(record(request.params).kind);
        definition(kind);
        const body = record(request.body);
        const id = optionalString(body.id);
        return {
          status: 201,
          body: await storage.resources.saveDraft(request.call, {
            kind,
            ...(id === undefined ? {} : { id, expectedUpdatedAt: null }),
            name: string(body.name),
            spec: body.spec,
          }),
        };
      },
    },
    {
      method: "POST",
      path: "/api/resources/:kind/:id/publish",
      access: { kind: "permission", permission: "resource.publish" },
      changeReason: "required",
      summary: "Validate and publish a generic Resource Draft",
      handler: async (request) => {
        const params = record(request.params);
        const body = record(request.body);
        const kind = string(params.kind);
        const id = string(params.id);
        definition(kind);
        const revision = positiveInteger(body.revision);
        return {
          status: 201,
          body: await storage.resources.publish(request.call, kind, id, revision),
        };
      },
    },
    {
      method: "POST",
      path: "/api/resources/:kind/:id/clone",
      access: { kind: "permission", permission: "resource.write" },
      summary: "Clone a generic Resource revision into a Draft",
      handler: async (request) => {
        const params = record(request.params);
        const body = optionalRecord(request.body);
        const kind = string(params.kind);
        definition(kind);
        const revision =
          body.revision === undefined ? undefined : positiveInteger(body.revision);
        return {
          status: 201,
          body: await storage.resources.clone(
            request.call,
            kind,
            string(params.id),
            revision,
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/resources/:kind/:id/archive",
      access: { kind: "permission", permission: "resource.archive" },
      changeReason: "required",
      summary: "Archive every revision of a generic Resource",
      handler: async (request) => {
        const params = record(request.params);
        const kind = string(params.kind);
        const id = string(params.id);
        definition(kind);
        await storage.resources.archive(request.call, kind, id);
        return { status: 200, body: { status: "archived" } };
      },
    },
  ];
}

function organizationRoutes(
  organization: OrganizationCapability,
  administration: OrganizationAdministration,
): readonly HttpRoute[] {
  return [
    {
      method: "GET",
      path: "/api/organization/people",
      access: { kind: "permission", permission: "organization.read" },
      summary: "List effective People",
      handler: async (request) => ({
        status: 200,
        body: await organization.findPeople(request.call, {}),
      }),
    },
    {
      method: "POST",
      path: "/api/organization/people",
      access: { kind: "permission", permission: "organization.write" },
      changeReason: "required",
      summary: "Create a Person",
      handler: async (request) => {
        const body = record(request.body);
        const title = optionalString(body.title);
        return {
          status: 201,
          body: await administration.createPerson(request.call, {
            employeeNumber: string(body.employeeNumber),
            displayName: string(body.displayName),
            ...(title === undefined ? {} : { title }),
          }),
        };
      },
    },
    {
      method: "GET",
      path: "/api/organization/units",
      access: { kind: "permission", permission: "organization.read" },
      summary: "List effective Organization Units",
      handler: async (request) => ({
        status: 200,
        body: await organization.findUnits(request.call),
      }),
    },
    {
      method: "POST",
      path: "/api/organization/units",
      access: { kind: "permission", permission: "organization.write" },
      changeReason: "required",
      summary: "Define an Organization Unit",
      handler: async (request) => {
        const body = record(request.body);
        const parent = optionalString(body.parentId);
        const through = optionalString(body.through);
        // Boundary has validated the opaque id before branding it for the contract.
        const parentId = parent as OrganizationUnitId | undefined;
        return {
          status: 201,
          body: await administration.defineUnit(request.call, {
            code: string(body.code),
            name: string(body.name),
            ...(parentId === undefined ? {} : { parentId }),
            from: string(body.from),
            ...(through === undefined ? {} : { through }),
          }),
        };
      },
    },
    {
      method: "GET",
      path: "/api/organization/assignments",
      access: { kind: "permission", permission: "organization.read" },
      summary: "List effective Assignments",
      handler: async (request) => ({
        status: 200,
        body: await organization.findAssignments(request.call, {}),
      }),
    },
    {
      method: "POST",
      path: "/api/organization/assignments",
      access: { kind: "permission", permission: "organization.write" },
      changeReason: "required",
      summary: "Assign a Person to an Organization Unit",
      handler: async (request) => {
        const body = record(request.body);
        // Boundary has validated opaque ids before branding them for the contract.
        const personId = string(body.personId) as PersonId;
        const organizationUnitId = string(body.organizationUnitId) as OrganizationUnitId;
        const position = optionalString(body.positionId);
        const positionId = position as PositionId | undefined;
        const kind = assignmentKind(body.kind);
        const through = optionalString(body.through);
        return {
          status: 201,
          body: await administration.assignPerson(request.call, {
            personId,
            organizationUnitId,
            ...(positionId === undefined ? {} : { positionId }),
            kind,
            from: string(body.from),
            ...(through === undefined ? {} : { through }),
          }),
        };
      },
    },
  ];
}

function calculationRoutes(calculation: CalculationCapability): readonly HttpRoute[] {
  return [
    {
      method: "GET",
      path: "/api/calculation/operations",
      access: { kind: "permission", permission: "calculation.read" },
      summary: "List Studio-visible Calculation Operations",
      handler: async (request) => ({
        status: 200,
        body: calculation.listOperations(request.call),
      }),
    },
    {
      method: "POST",
      path: "/api/calculation/pipelines/validate",
      access: { kind: "permission", permission: "calculation.validate" },
      summary: "Validate a Calculation Pipeline",
      handler: async (request) => {
        const result = await calculation.validatePipeline(
          request.call,
          pipelineSpec(record(request.body).spec),
        );
        return {
          status: 200,
          body: { ...result, diagnostics: publicDiagnostics(result.diagnostics) },
        };
      },
    },
    {
      method: "POST",
      path: "/api/calculation/pipelines/execute",
      access: { kind: "permission", permission: "calculation.execute" },
      summary: "Compile and preview a Calculation Pipeline",
      handler: async (request) => {
        const body = record(request.body);
        const spec = pipelineSpec(body.spec);
        const compiled = await calculation.compilePipeline(request.call, spec);
        const inputs = datasetInputs(body.inputs);
        const result = await calculation.executePipeline(
          request.call,
          compiled,
          { datasets: inputs },
          { traceLevel: "summary", previewRowLimit: 1_000, timeoutMs: 30_000 },
        );
        const outputs = Object.fromEntries(
          await Promise.all(
            Object.entries(result.outputs).map(async ([name, dataset]) => [
              name,
              { type: dataset.schema, rows: await collectRows(dataset, request.call) },
            ]),
          ),
        );
        const publicResult = {
          ...result,
          outputs,
          diagnostics: publicDiagnostics(result.diagnostics),
          trace: {
            ...result.trace,
            nodes: result.trace.nodes.map((node) => ({
              ...node,
              diagnostics: publicDiagnostics(node.diagnostics),
            })),
          },
        };
        return {
          status: 200,
          body: jsonProjection(publicResult),
        };
      },
    },
  ];
}

function pipelineSpec(value: unknown): PipelineSpec {
  const candidate = record(value);
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    !Array.isArray(candidate.inputs) ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.edges) ||
    !Array.isArray(candidate.outputs)
  ) {
    throw PrismError.of(
      "CALCULATION_REQUEST_INVALID",
      "Pipeline specification is malformed.",
    );
  }
  // Calculation performs the complete semantic validation after this envelope check.
  return candidate as unknown as PipelineSpec;
}

function datasetInputs(value: unknown): Readonly<Record<string, Dataset>> {
  if (value === undefined) return {};
  const input = record(value);
  let rows = 0;
  return Object.fromEntries(
    Object.entries(input).map(([name, payload]) => {
      const item = record(payload);
      const schema = tableType(item.type);
      if (!Array.isArray(item.rows) || item.rows.length > 10_000) {
        throw PrismError.of(
          "CALCULATION_INPUT_INVALID",
          "Dataset input rows are invalid.",
          {
            input: name,
          },
        );
      }
      rows += item.rows.length;
      if (rows > 20_000) {
        throw PrismError.of(
          "CALCULATION_INPUT_INVALID",
          "Dataset input exceeds the preview limit.",
        );
      }
      const decoded = item.rows.map((row, index) => decodeRow(schema, row, index));
      return [name, datasetFromRows(name, schema, decoded)];
    }),
  );
}

function tableType(value: unknown): TableType {
  if (!isValueType(value) || value.kind !== "table") {
    throw PrismError.of("CALCULATION_INPUT_INVALID", "Dataset type must be a table.");
  }
  return value;
}

function isValueType(value: unknown): value is ValueType {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (
    ["null", "boolean", "int", "string", "date", "datetime"].includes(String(value.kind))
  ) {
    return true;
  }
  if (value.kind === "decimal") {
    return (
      "precision" in value &&
      Number.isInteger(value.precision) &&
      "scale" in value &&
      Number.isInteger(value.scale)
    );
  }
  if (value.kind === "object" || value.kind === "table") {
    const fields =
      value.kind === "object"
        ? "fields" in value
          ? value.fields
          : undefined
        : "columns" in value
          ? value.columns
          : undefined;
    if (!Array.isArray(fields)) return false;
    return fields.every(
      (field) =>
        typeof field === "object" &&
        field !== null &&
        "name" in field &&
        typeof field.name === "string" &&
        "type" in field &&
        isValueType(field.type),
    );
  }
  return false;
}

function decodeRow(schema: TableType, value: unknown, rowIndex: number): Row {
  const input = record(value);
  return Object.fromEntries(
    schema.columns.map((field) => [
      field.name,
      decodeValue(field.type, input[field.name], `/rows/${rowIndex}/${field.name}`),
    ]),
  );
}

function decodeValue(type: ValueType, value: unknown, path: string): RowValue {
  if (value === null && type.nullable === true) return null;
  if (type.kind === "decimal") {
    if (typeof value !== "string") {
      throw PrismError.of("CALCULATION_INPUT_INVALID", "Decimal input must be a string.", {
        path,
      });
    }
    return D(value);
  }
  if (type.kind === "object") {
    const input = record(value);
    return Object.fromEntries(
      type.fields.map((field) => [
        field.name,
        decodeValue(field.type, input[field.name], `${path}/${field.name}`),
      ]),
    );
  }
  if (type.kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw PrismError.of("CALCULATION_INPUT_INVALID", "Integer input is invalid.", {
        path,
      });
    }
    return value;
  }
  if (type.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw PrismError.of("CALCULATION_INPUT_INVALID", "Boolean input is invalid.", {
        path,
      });
    }
    return value;
  }
  if (type.kind === "string" || type.kind === "date" || type.kind === "datetime") {
    if (typeof value !== "string") {
      throw PrismError.of("CALCULATION_INPUT_INVALID", "String/date input is invalid.", {
        path,
      });
    }
    return value;
  }
  if (type.kind === "null") {
    if (value !== null)
      throw PrismError.of("CALCULATION_INPUT_INVALID", "Null input is invalid.", { path });
    return null;
  }
  throw PrismError.of("CALCULATION_INPUT_INVALID", "Nested table input is unsupported.", {
    path,
  });
}

function jsonProjection(value: unknown): unknown {
  if (Decimal.isDecimal(value)) return value.toFixed();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonProjection);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonProjection(item)]),
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw PrismError.of("STUDIO_API_REQUEST_INVALID", "Expected an object request.");
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : record(value);
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw PrismError.of("STUDIO_API_REQUEST_INVALID", "Expected a non-empty string.");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return string(value);
}

function positiveInteger(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw PrismError.of("STUDIO_API_REQUEST_INVALID", "Expected a positive integer.");
  }
  return number;
}

function resourceStatus(value: unknown): "draft" | "published" | "archived" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "draft" || value === "published" || value === "archived") return value;
  throw PrismError.of("STUDIO_API_REQUEST_INVALID", "Resource status is invalid.");
}

function assignmentKind(value: unknown): "primary" | "secondary" {
  if (value === "primary" || value === "secondary") return value;
  throw PrismError.of("STUDIO_API_REQUEST_INVALID", "Assignment kind is invalid.");
}

function resourceMissing(kind: string, id: string): PrismError {
  return PrismError.of("RESOURCE_NOT_FOUND", `Resource ${kind}/${id} was not found.`, {
    kind,
    id,
  });
}
