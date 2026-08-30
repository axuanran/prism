import { Type } from "@sinclair/typebox";
import {
  datasetFromRows,
  diagnostic,
  PrismError,
  tableType,
} from "@prismengine/contracts-data";
import type { CallContext, Dataset, Row, TableType } from "@prismengine/contracts-data";
import {
  isEffectiveOn,
  OrganizationAdministrationToken,
  OrganizationCapabilityToken,
  OrganizationEventType,
} from "@prismengine/contracts-organization";
import type {
  Assignment,
  AssignmentId,
  AssignmentQuery,
  DefinePositionCommand,
  DefineUnitCommand,
  OrganizationAdministration,
  OrganizationCapability,
  OrganizationUnit,
  OrganizationUnitId,
  Person,
  PersonId,
  PersonQuery,
  Position,
  PositionId,
} from "@prismengine/contracts-organization";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import type { DocumentCollection, StorageCapability } from "@prismengine/contracts-storage";
import { definePlugin } from "@prismengine/kernel";
import type {
  DiagnosticsSink,
  EventBus,
  ResourceTypeDefinition,
} from "@prismengine/kernel";

export const OrganizationPluginDiagnosticCode = {
  PERSON_NOT_FOUND: "ORGANIZATION_PERSON_NOT_FOUND",
  UNIT_NOT_FOUND: "ORGANIZATION_UNIT_NOT_FOUND",
  POSITION_NOT_FOUND: "ORGANIZATION_POSITION_NOT_FOUND",
  ASSIGNMENT_NOT_FOUND: "ORGANIZATION_ASSIGNMENT_NOT_FOUND",
  DUPLICATE_EMPLOYEE_NUMBER: "ORGANIZATION_DUPLICATE_EMPLOYEE_NUMBER",
  INVALID_EFFECTIVE_PERIOD: "ORGANIZATION_INVALID_EFFECTIVE_PERIOD",
  INVALID_UNIT_QUERY: "ORGANIZATION_INVALID_UNIT_QUERY",
  HIERARCHY_CYCLE: "ORGANIZATION_HIERARCHY_CYCLE",
} as const;

const PEOPLE_SCHEMA = tableType([
  { name: "personId", type: { kind: "string", annotations: { key: true } } },
  { name: "employeeNumber", type: { kind: "string" } },
  { name: "displayName", type: { kind: "string" } },
  { name: "title", type: { kind: "string", nullable: true } },
  { name: "status", type: { kind: "string" } },
]);

const UNITS_SCHEMA = tableType([
  { name: "unitId", type: { kind: "string", annotations: { key: true } } },
  { name: "code", type: { kind: "string" } },
  { name: "name", type: { kind: "string" } },
  { name: "parentId", type: { kind: "string", nullable: true } },
]);

const ASSIGNMENTS_SCHEMA = tableType([
  { name: "assignmentId", type: { kind: "string", annotations: { key: true } } },
  { name: "personId", type: { kind: "string" } },
  { name: "unitId", type: { kind: "string" } },
  { name: "positionId", type: { kind: "string", nullable: true } },
  { name: "kind", type: { kind: "string" } },
  { name: "from", type: { kind: "date" } },
  { name: "through", type: { kind: "date", nullable: true } },
]);

interface Collections {
  readonly people: DocumentCollection<Person>;
  readonly units: DocumentCollection<OrganizationUnit>;
  readonly positions: DocumentCollection<Position>;
  readonly assignments: DocumentCollection<Assignment>;
}

function organizationCollections(storage: StorageCapability): Collections {
  return {
    people: storage.collection<Person>("organization.people"),
    units: storage.collection<OrganizationUnit>("organization.units"),
    positions: storage.collection<Position>("organization.positions"),
    assignments: storage.collection<Assignment>("organization.assignments"),
  };
}

function pluginError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PrismError {
  return PrismError.of(code, message, details);
}

function assertPeriod(from: string, through: string | undefined): void {
  if (through !== undefined && through < from) {
    throw pluginError(
      OrganizationPluginDiagnosticCode.INVALID_EFFECTIVE_PERIOD,
      "Effective period ends before it starts.",
      { from, through },
    );
  }
}

function reportCycle(
  diagnostics: DiagnosticsSink,
  direction: "ancestor" | "descendant",
  unitId: OrganizationUnitId,
): void {
  diagnostics.report(
    diagnostic(
      OrganizationPluginDiagnosticCode.HIERARCHY_CYCLE,
      "Organization hierarchy contains a cycle.",
      { details: { direction, unitId } },
    ),
  );
}

function effectiveUnits(
  units: readonly OrganizationUnit[],
  validAt: string,
): readonly OrganizationUnit[] {
  return units.filter((unit) => isEffectiveOn(unit.effectivePeriod, validAt));
}

function descendantIds(
  units: readonly OrganizationUnit[],
  rootId: OrganizationUnitId,
  diagnostics: DiagnosticsSink,
): readonly OrganizationUnitId[] {
  if (!units.some((unit) => unit.id === rootId)) return [];
  const byParent = new Map<OrganizationUnitId, OrganizationUnit[]>();
  for (const unit of units) {
    if (unit.parentId === undefined) continue;
    const children = byParent.get(unit.parentId) ?? [];
    children.push(unit);
    byParent.set(unit.parentId, children);
  }

  const result: OrganizationUnitId[] = [];
  const pending: OrganizationUnitId[] = [rootId];
  const visited = new Set<OrganizationUnitId>([rootId]);
  let cycleReported = false;
  for (let offset = 0; offset < pending.length; offset += 1) {
    const parentId = pending[offset];
    if (parentId === undefined) continue;
    for (const child of byParent.get(parentId) ?? []) {
      if (visited.has(child.id)) {
        if (!cycleReported) {
          reportCycle(diagnostics, "descendant", rootId);
          cycleReported = true;
        }
        continue;
      }
      visited.add(child.id);
      result.push(child.id);
      pending.push(child.id);
    }
  }
  return result;
}

function deferredDataset(
  name: string,
  schema: TableType,
  loadRows: () => Promise<readonly Row[]>,
): Dataset {
  let snapshot: Promise<Dataset> | undefined;
  const materialize = (): Promise<Dataset> => {
    snapshot ??= Promise.resolve()
      .then(loadRows)
      .then((rows) => datasetFromRows(name, schema, rows));
    return snapshot;
  };

  return {
    name,
    schema,
    async *stream(context: CallContext) {
      context.signal?.throwIfAborted();
      const materialized = await materialize();
      context.signal?.throwIfAborted();
      for await (const batch of materialized.stream(context)) yield batch;
    },
  };
}

function personRows(people: readonly Person[]): readonly Row[] {
  return people.map((person) => ({
    personId: person.id,
    employeeNumber: person.employeeNumber,
    displayName: person.displayName,
    title: person.title ?? null,
    status: person.status,
  }));
}

function unitRows(units: readonly OrganizationUnit[]): readonly Row[] {
  return units.map((unit) => ({
    unitId: unit.id,
    code: unit.code,
    name: unit.name,
    parentId: unit.parentId ?? null,
  }));
}

function assignmentRows(assignments: readonly Assignment[]): readonly Row[] {
  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    personId: assignment.personId,
    unitId: assignment.organizationUnitId,
    positionId: assignment.positionId ?? null,
    kind: assignment.kind,
    from: assignment.effectivePeriod.from,
    through: assignment.effectivePeriod.through ?? null,
  }));
}

function createOrganizationCapability(
  collections: Collections,
  diagnostics: DiagnosticsSink,
): OrganizationCapability {
  const capability: OrganizationCapability = {
    async getPerson(context, id) {
      context.signal?.throwIfAborted();
      return collections.people.get(context, id);
    },

    async getPeople(context, ids) {
      context.signal?.throwIfAborted();
      const people = await collections.people.getMany(context, ids);
      return new Map(people.map((person) => [person.id, person]));
    },

    async findPeople(context, query) {
      context.signal?.throwIfAborted();
      const employeeNumbers =
        query.employeeNumbers === undefined ? undefined : new Set(query.employeeNumbers);
      const people = await collections.people.find(context);
      const filtered = people.filter(
        (person) =>
          (query.status === undefined || person.status === query.status) &&
          (query.nameContains === undefined ||
            person.displayName.includes(query.nameContains)) &&
          (employeeNumbers === undefined || employeeNumbers.has(person.employeeNumber)),
      );
      return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
    },

    async getUnit(context, id) {
      context.signal?.throwIfAborted();
      const unit = await collections.units.get(context, id);
      return unit !== null && isEffectiveOn(unit.effectivePeriod, context.asOf.validAt)
        ? unit
        : null;
    },

    async getPosition(context, id) {
      context.signal?.throwIfAborted();
      const position = await collections.positions.get(context, id);
      return position !== null &&
        isEffectiveOn(position.effectivePeriod, context.asOf.validAt)
        ? position
        : null;
    },

    async findUnits(context, query = {}) {
      context.signal?.throwIfAborted();
      if (query.parentId !== undefined && query.rootsOnly === true) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.INVALID_UNIT_QUERY,
          "Unit query cannot specify both parentId and rootsOnly.",
          { parentId: query.parentId, rootsOnly: query.rootsOnly },
        );
      }
      const codes = query.codes === undefined ? undefined : new Set(query.codes);
      const units = effectiveUnits(
        await collections.units.find(context),
        context.asOf.validAt,
      );
      return units.filter(
        (unit) =>
          (query.parentId === undefined || unit.parentId === query.parentId) &&
          (query.rootsOnly !== true || unit.parentId === undefined) &&
          (query.nameContains === undefined || unit.name.includes(query.nameContains)) &&
          (codes === undefined || codes.has(unit.code)),
      );
    },

    async findPositions(context, query = {}) {
      context.signal?.throwIfAborted();
      const unitIds =
        query.organizationUnitIds === undefined
          ? undefined
          : new Set(query.organizationUnitIds);
      const codes = query.codes === undefined ? undefined : new Set(query.codes);
      const positions = await collections.positions.find(context);
      return positions.filter(
        (position) =>
          isEffectiveOn(position.effectivePeriod, context.asOf.validAt) &&
          (unitIds === undefined || unitIds.has(position.organizationUnitId)) &&
          (codes === undefined || codes.has(position.code)),
      );
    },

    async descendantUnits(context, rootId) {
      context.signal?.throwIfAborted();
      const units = await capability.findUnits(context);
      const ids = new Set(descendantIds(units, rootId, diagnostics));
      return units.filter((unit) => ids.has(unit.id));
    },

    async ancestorUnits(context, unitId) {
      context.signal?.throwIfAborted();
      const units = await capability.findUnits(context);
      const byId = new Map(units.map((unit) => [unit.id, unit]));
      const start = byId.get(unitId);
      if (start === undefined) return [];

      const result: OrganizationUnit[] = [];
      const visited = new Set<OrganizationUnitId>([unitId]);
      let current = start;
      while (current.parentId !== undefined) {
        if (visited.has(current.parentId)) {
          reportCycle(diagnostics, "ancestor", unitId);
          break;
        }
        visited.add(current.parentId);
        const parent = byId.get(current.parentId);
        if (parent === undefined) break;
        result.push(parent);
        current = parent;
      }
      return result;
    },

    async findAssignments(context, query) {
      context.signal?.throwIfAborted();
      const personIds =
        query.personIds === undefined ? undefined : new Set(query.personIds);
      const unitIds =
        query.organizationUnitIds === undefined
          ? undefined
          : new Set(query.organizationUnitIds);

      if (unitIds !== undefined && query.includeDescendants === true) {
        const units = await capability.findUnits(context);
        for (const rootId of query.organizationUnitIds ?? []) {
          for (const id of descendantIds(units, rootId, diagnostics)) unitIds.add(id);
        }
      }

      const assignments = await collections.assignments.find(context);
      return assignments.filter(
        (assignment) =>
          isEffectiveOn(assignment.effectivePeriod, context.asOf.validAt) &&
          (personIds === undefined || personIds.has(assignment.personId)) &&
          (unitIds === undefined || unitIds.has(assignment.organizationUnitId)) &&
          (query.kind === undefined || query.kind === assignment.kind),
      );
    },

    datasets: {
      people(context, query: PersonQuery = {}) {
        return deferredDataset("organization.people", PEOPLE_SCHEMA, async () =>
          personRows(await capability.findPeople(context, query)),
        );
      },
      units(context) {
        return deferredDataset("organization.units", UNITS_SCHEMA, async () =>
          unitRows(await capability.findUnits(context)),
        );
      },
      assignments(context, query: AssignmentQuery = {}) {
        return deferredDataset("organization.assignments", ASSIGNMENTS_SCHEMA, async () =>
          assignmentRows(await capability.findAssignments(context, query)),
        );
      },
    },
  };

  return capability;
}

function createOrganizationAdministration(
  collections: Collections,
  events: EventBus,
): OrganizationAdministration {
  const publish = async (
    context: CallContext,
    type: (typeof OrganizationEventType)[keyof typeof OrganizationEventType],
    payload: unknown,
  ): Promise<void> => {
    await events.publish(type, payload, { correlationId: context.correlationId });
  };

  return {
    async createPerson(context, command) {
      context.signal?.throwIfAborted();
      const duplicate = await collections.people.find(context, {
        where: { employeeNumber: command.employeeNumber },
        limit: 1,
      });
      if (duplicate.length > 0) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.DUPLICATE_EMPLOYEE_NUMBER,
          "Employee number already exists.",
          { employeeNumber: command.employeeNumber },
        );
      }
      const person: Person = {
        id: crypto.randomUUID() as PersonId,
        employeeNumber: command.employeeNumber,
        displayName: command.displayName,
        status: "active",
        ...(command.title === undefined ? {} : { title: command.title }),
      };
      await collections.people.put(context, person);
      await publish(context, OrganizationEventType.PersonCreated, person);
      return person;
    },

    async updatePerson(context, id, changes) {
      context.signal?.throwIfAborted();
      const current = await collections.people.get(context, id);
      if (current === null) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.PERSON_NOT_FOUND,
          "Person does not exist.",
          { personId: id },
        );
      }
      if (
        changes.employeeNumber !== undefined &&
        changes.employeeNumber !== current.employeeNumber
      ) {
        const duplicate = await collections.people.find(context, {
          where: { employeeNumber: changes.employeeNumber },
          limit: 1,
        });
        if (duplicate.length > 0) {
          throw pluginError(
            OrganizationPluginDiagnosticCode.DUPLICATE_EMPLOYEE_NUMBER,
            "Employee number already exists.",
            { employeeNumber: changes.employeeNumber },
          );
        }
      }
      const person: Person = {
        ...current,
        ...changes,
      };
      await collections.people.put(context, person);
      await publish(context, OrganizationEventType.PersonUpdated, person);
      return person;
    },

    async defineUnit(context, command: DefineUnitCommand) {
      context.signal?.throwIfAborted();
      assertPeriod(command.from, command.through);
      if (
        command.parentId !== undefined &&
        (await collections.units.get(context, command.parentId)) === null
      ) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.UNIT_NOT_FOUND,
          "Parent organization unit does not exist.",
          { parentId: command.parentId },
        );
      }
      const unit: OrganizationUnit = {
        id: crypto.randomUUID() as OrganizationUnitId,
        code: command.code,
        name: command.name,
        effectivePeriod: {
          from: command.from,
          ...(command.through === undefined ? {} : { through: command.through }),
        },
        ...(command.parentId === undefined ? {} : { parentId: command.parentId }),
      };
      await collections.units.put(context, unit);
      await publish(context, OrganizationEventType.UnitDefined, unit);
      return unit;
    },

    async definePosition(context, command: DefinePositionCommand) {
      context.signal?.throwIfAborted();
      assertPeriod(command.from, command.through);
      if ((await collections.units.get(context, command.organizationUnitId)) === null) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.UNIT_NOT_FOUND,
          "Position organization unit does not exist.",
          { organizationUnitId: command.organizationUnitId },
        );
      }
      const position: Position = {
        id: crypto.randomUUID() as PositionId,
        code: command.code,
        name: command.name,
        organizationUnitId: command.organizationUnitId,
        effectivePeriod: {
          from: command.from,
          ...(command.through === undefined ? {} : { through: command.through }),
        },
      };
      await collections.positions.put(context, position);
      await publish(context, OrganizationEventType.PositionDefined, position);
      return position;
    },

    async assignPerson(context, command) {
      context.signal?.throwIfAborted();
      assertPeriod(command.from, command.through);
      if ((await collections.people.get(context, command.personId)) === null) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.PERSON_NOT_FOUND,
          "Assigned person does not exist.",
          { personId: command.personId },
        );
      }
      if ((await collections.units.get(context, command.organizationUnitId)) === null) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.UNIT_NOT_FOUND,
          "Assigned organization unit does not exist.",
          { organizationUnitId: command.organizationUnitId },
        );
      }
      if (
        command.positionId !== undefined &&
        (await collections.positions.get(context, command.positionId)) === null
      ) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.POSITION_NOT_FOUND,
          "Assigned position does not exist.",
          { positionId: command.positionId },
        );
      }
      const assignment: Assignment = {
        id: crypto.randomUUID() as AssignmentId,
        personId: command.personId,
        organizationUnitId: command.organizationUnitId,
        kind: command.kind,
        effectivePeriod: {
          from: command.from,
          ...(command.through === undefined ? {} : { through: command.through }),
        },
        ...(command.positionId === undefined ? {} : { positionId: command.positionId }),
      };
      await collections.assignments.put(context, assignment);
      await publish(context, OrganizationEventType.AssignmentStarted, assignment);
      return assignment;
    },

    async endAssignment(context, id, through) {
      context.signal?.throwIfAborted();
      const current = await collections.assignments.get(context, id);
      if (current === null) {
        throw pluginError(
          OrganizationPluginDiagnosticCode.ASSIGNMENT_NOT_FOUND,
          "Assignment does not exist.",
          { assignmentId: id },
        );
      }
      assertPeriod(current.effectivePeriod.from, through);
      const ended: Assignment = {
        ...current,
        effectivePeriod: { ...current.effectivePeriod, through },
      };
      await collections.assignments.put(context, ended);
      await publish(context, OrganizationEventType.AssignmentEnded, {
        assignmentId: id,
        through,
      });
    },
  };
}

const NON_EMPTY_STRING = { minLength: 1 } as const;
const DATE_STRING = { minLength: 10, format: "date" } as const;

const ORGANIZATION_RESOURCE_TYPES: readonly ResourceTypeDefinition[] = [
  {
    kind: "organization.person",
    title: "人员",
    config: {
      schema: Type.Object(
        {
          employeeNumber: Type.String(NON_EMPTY_STRING),
          displayName: Type.String(NON_EMPTY_STRING),
          title: Type.Optional(Type.String()),
          status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
        },
        { additionalProperties: false },
      ),
      defaults: { status: "active" },
    },
    presentation: {
      fields: {
        employeeNumber: { label: "工号", order: 1 },
        displayName: { label: "姓名", order: 2 },
        title: { label: "职称", order: 3 },
        status: { label: "状态", order: 4 },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.unit",
    title: "组织机构",
    config: {
      schema: Type.Object(
        {
          code: Type.String(NON_EMPTY_STRING),
          name: Type.String(NON_EMPTY_STRING),
          parentId: Type.Optional(Type.String()),
          from: Type.String(DATE_STRING),
          through: Type.Optional(Type.String(DATE_STRING)),
        },
        { additionalProperties: false },
      ),
    },
    presentation: {
      fields: {
        code: { label: "机构编码", order: 1 },
        name: { label: "机构名称", order: 2 },
        parentId: { label: "上级机构", order: 3 },
        from: { label: "生效日期", order: 4 },
        through: { label: "失效日期", order: 5 },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.position",
    title: "岗位",
    config: {
      schema: Type.Object(
        {
          code: Type.String(NON_EMPTY_STRING),
          name: Type.String(NON_EMPTY_STRING),
          organizationUnitId: Type.String(NON_EMPTY_STRING),
          from: Type.String(DATE_STRING),
          through: Type.Optional(Type.String(DATE_STRING)),
        },
        { additionalProperties: false },
      ),
    },
    presentation: {
      fields: {
        code: { label: "岗位编码", order: 1 },
        name: { label: "岗位名称", order: 2 },
        organizationUnitId: { label: "所属机构", order: 3 },
        from: { label: "生效日期", order: 4 },
        through: { label: "失效日期", order: 5 },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
  {
    kind: "organization.assignment",
    title: "人员归属",
    config: {
      schema: Type.Object(
        {
          personId: Type.String(NON_EMPTY_STRING),
          organizationUnitId: Type.String(NON_EMPTY_STRING),
          positionId: Type.Optional(Type.String()),
          kind: Type.Union([Type.Literal("primary"), Type.Literal("secondary")]),
          from: Type.String(DATE_STRING),
          through: Type.Optional(Type.String(DATE_STRING)),
        },
        { additionalProperties: false },
      ),
    },
    presentation: {
      fields: {
        personId: { label: "人员", order: 1 },
        organizationUnitId: { label: "所属机构", order: 2 },
        positionId: { label: "岗位", order: 3 },
        kind: { label: "归属类型", order: 4 },
        from: { label: "生效日期", order: 5 },
        through: { label: "失效日期", order: 6 },
      },
    },
    exposure: { configuration: true, frontend: true },
  },
];

export const organizationPlugin = definePlugin({
  id: "organization.basic",
  version: "0.1.0",
  engineRange: "^0.1.20",
  description: "Effective-dated organization directory and administration.",
  requires: { storage: StorageCapabilityToken },
  provides: [OrganizationCapabilityToken, OrganizationAdministrationToken],
  register(ctx) {
    const collections = organizationCollections(ctx.dependencies.storage);
    ctx.provide(
      OrganizationCapabilityToken,
      createOrganizationCapability(collections, ctx.diagnostics),
    );
    ctx.provide(
      OrganizationAdministrationToken,
      createOrganizationAdministration(collections, ctx.events),
    );
    for (const resourceType of ORGANIZATION_RESOURCE_TYPES) {
      ctx.resources.define(resourceType);
    }
  },
});
