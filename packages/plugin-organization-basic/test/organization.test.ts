import { describe, expect, it } from "vitest";
import {
  collectRows,
  countRows,
  PrismError,
  systemCallContext,
} from "@prism/contracts-data";
import type { CallContext } from "@prism/contracts-data";
import {
  OrganizationAdministrationToken,
  OrganizationCapabilityToken,
  OrganizationEventType,
} from "@prism/contracts-organization";
import type {
  Assignment,
  OrganizationAdministration,
  OrganizationCapability,
  OrganizationUnit,
  OrganizationUnitId,
  PersonId,
} from "@prism/contracts-organization";
import { StorageCapabilityToken } from "@prism/contracts-storage";
import type { StorageCapability } from "@prism/contracts-storage";
import { createEngine, definePlugin } from "@prism/kernel";
import type { Engine } from "@prism/kernel";
import { storageMemoryPlugin } from "@prism/plugin-storage-memory";
import {
  organizationPlugin,
  OrganizationPluginDiagnosticCode,
} from "@prism/plugin-organization-basic";

interface Harness {
  readonly engine: Engine;
  readonly organization: OrganizationCapability;
  readonly administration: OrganizationAdministration;
  readonly storage: StorageCapability;
}

const CONTEXT: CallContext = systemCallContext({
  asOf: { validAt: "2025-01-15" },
  correlationId: "organization-test",
});

async function createHarness(): Promise<Harness> {
  let organization: OrganizationCapability | undefined;
  let administration: OrganizationAdministration | undefined;
  let storage: StorageCapability | undefined;
  const capturePlugin = definePlugin({
    id: "test.organization.capture",
    version: "0.1.0",
    requires: {
      organization: OrganizationCapabilityToken,
      administration: OrganizationAdministrationToken,
      storage: StorageCapabilityToken,
    },
    start(ctx) {
      organization = ctx.dependencies.organization;
      administration = ctx.dependencies.administration;
      storage = ctx.dependencies.storage;
    },
  });
  const engine = createEngine({
    plugins: [storageMemoryPlugin, organizationPlugin, capturePlugin],
  });
  await engine.start();
  if (
    organization === undefined
    || administration === undefined
    || storage === undefined
  ) {
    throw new Error("Organization test capabilities were not captured after engine start.");
  }
  return { engine, organization, administration, storage };
}

describe("organization plugin", () => {
  it("creates and queries a person, then rejects a duplicate employee number", async () => {
    const { organization, administration } = await createHarness();
    const person = await administration.createPerson(CONTEXT, {
      employeeNumber: "E-001",
      displayName: "张三",
      title: "主任医师",
    });

    await expect(organization.getPerson(CONTEXT, person.id)).resolves.toEqual(person);
    await expect(organization.findPeople(CONTEXT, {
      employeeNumbers: ["E-001"],
    })).resolves.toEqual([person]);

    await expect(administration.createPerson(CONTEXT, {
      employeeNumber: "E-001",
      displayName: "重复人员",
    })).rejects.toMatchObject({
      diagnostics: [{ code: OrganizationPluginDiagnosticCode.DUPLICATE_EMPLOYEE_NUMBER }],
    });
  });

  it("queries effective units and positions, then walks the hierarchy", async () => {
    const { organization, administration } = await createHarness();
    const root = await administration.defineUnit(CONTEXT, {
      code: "ROOT",
      name: "总部",
      from: "2020-01-01",
    });
    const department = await administration.defineUnit(CONTEXT, {
      code: "DEPT",
      name: "内科",
      parentId: root.id,
      from: "2020-01-01",
    });
    const ward = await administration.defineUnit(CONTEXT, {
      code: "WARD",
      name: "一病区",
      parentId: department.id,
      from: "2020-01-01",
    });
    await administration.defineUnit(CONTEXT, {
      code: "EXPIRED",
      name: "已撤销病区",
      parentId: department.id,
      from: "2020-01-01",
      through: "2024-01-01",
    });
    const activePosition = await administration.definePosition(CONTEXT, {
      code: "ACTIVE-POSITION",
      name: "在岗岗位",
      organizationUnitId: department.id,
      from: "2020-01-01",
    });
    await administration.definePosition(CONTEXT, {
      code: "EXPIRED-POSITION",
      name: "已撤销岗位",
      organizationUnitId: department.id,
      from: "2020-01-01",
      through: "2024-01-01",
    });

    const allUnits = await organization.findUnits(CONTEXT);
    expect(allUnits).toEqual([root, department, ward]);
    await expect(organization.findUnits(CONTEXT, {
      parentId: department.id,
    })).resolves.toEqual([ward]);
    await expect(organization.findUnits(CONTEXT, {
      rootsOnly: true,
    })).resolves.toEqual([root]);
    await expect(organization.findPositions(CONTEXT)).resolves.toEqual([
      activePosition,
    ]);

    const datasetUnits = await collectRows(
      organization.datasets.units(CONTEXT),
      CONTEXT,
    );
    expect(new Set(datasetUnits.map((row) => row.unitId))).toEqual(
      new Set(allUnits.map((unit) => unit.id)),
    );

    await expect(organization.descendantUnits(CONTEXT, root.id)).resolves.toEqual([
      department,
      ward,
    ]);
    await expect(organization.ancestorUnits(CONTEXT, ward.id)).resolves.toEqual([
      department,
      root,
    ]);
  });

  it("terminates malformed hierarchy cycles and reports diagnostics", async () => {
    const { engine, organization, storage } = await createHarness();
    const firstId = "cycle-a" as OrganizationUnitId;
    const secondId = "cycle-b" as OrganizationUnitId;
    const units = storage.collection<OrganizationUnit>("organization.units");
    const first: OrganizationUnit = {
      id: firstId,
      code: "CYCLE-A",
      name: "循环甲",
      parentId: secondId,
      effectivePeriod: { from: "2020-01-01" },
    };
    const second: OrganizationUnit = {
      id: secondId,
      code: "CYCLE-B",
      name: "循环乙",
      parentId: firstId,
      effectivePeriod: { from: "2020-01-01" },
    };
    await units.putMany(CONTEXT, [first, second]);

    await expect(organization.descendantUnits(CONTEXT, firstId)).resolves.toEqual([
      second,
    ]);
    await expect(organization.ancestorUnits(CONTEXT, firstId)).resolves.toEqual([
      second,
    ]);
    expect(engine.inspect().diagnostics.some((item) =>
      item.code === OrganizationPluginDiagnosticCode.HIERARCHY_CYCLE
    )).toBe(true);
  });

  it("excludes an assignment ended before validAt", async () => {
    const { organization, administration } = await createHarness();
    const person = await administration.createPerson(CONTEXT, {
      employeeNumber: "E-002",
      displayName: "李四",
    });
    const unit = await administration.defineUnit(CONTEXT, {
      code: "DEPT",
      name: "内科",
      from: "2020-01-01",
    });
    const assignment = await administration.assignPerson(CONTEXT, {
      personId: person.id,
      organizationUnitId: unit.id,
      kind: "primary",
      from: "2020-01-01",
    });
    await administration.endAssignment(CONTEXT, assignment.id, "2024-12-31");

    await expect(organization.findAssignments(CONTEXT, {
      personIds: [person.id],
    })).resolves.toEqual([]);
    await expect(countRows(
      organization.datasets.assignments(CONTEXT, { personIds: [person.id] }),
      CONTEXT,
    )).resolves.toBe(0);
  });

  async function seedReferenceOrganization(
    administration: OrganizationAdministration,
  ): Promise<{
    readonly unit: OrganizationUnit;
    readonly assignments: readonly [Assignment, Assignment, Assignment];
  }> {
    const unit = await administration.defineUnit(CONTEXT, {
      code: "REFERENCE",
      name: "示例业务单元",
      from: "2020-01-01",
    });
    const people = await Promise.all(
      ["REF-001", "REF-002", "REF-003"].map((employeeNumber, index) =>
        administration.createPerson(CONTEXT, {
          employeeNumber,
          displayName: `示例人员${index + 1}`,
        }),
      ),
    );
    const assignments = await Promise.all(
      people.map((person) =>
        administration.assignPerson(CONTEXT, {
          personId: person.id,
          organizationUnitId: unit.id,
          kind: "primary",
          from: "2020-01-01",
        }),
      ),
    ) as [Assignment, Assignment, Assignment];
    return { unit, assignments };
  }

  it("returns re-iterable datasets with exact columns and point-query parity", async () => {
    const { organization, administration } = await createHarness();
    const seed = await seedReferenceOrganization(administration);
    const ended = seed.assignments[2];
    await administration.endAssignment(CONTEXT, ended.id, "2024-01-01");

    const peopleDataset = organization.datasets.people(CONTEXT);
    const unitDataset = organization.datasets.units(CONTEXT);
    const assignmentDataset = organization.datasets.assignments(CONTEXT);

    expect(peopleDataset.schema.columns.map((column) => column.name)).toEqual([
      "personId",
      "employeeNumber",
      "displayName",
      "title",
      "status",
    ]);
    expect(unitDataset.schema.columns.map((column) => column.name)).toEqual([
      "unitId",
      "code",
      "name",
      "parentId",
    ]);
    expect(assignmentDataset.schema.columns.map((column) => column.name)).toEqual([
      "assignmentId",
      "personId",
      "unitId",
      "positionId",
      "kind",
      "from",
      "through",
    ]);

    const pointPeople = await organization.findPeople(CONTEXT, {});
    const pointAssignments = await organization.findAssignments(CONTEXT, {});
    const pointUnits = await Promise.all([
      organization.getUnit(CONTEXT, seed.unit.id),
    ]);
    expect(await countRows(peopleDataset, CONTEXT)).toBe(pointPeople.length);
    expect(await countRows(assignmentDataset, CONTEXT)).toBe(pointAssignments.length);
    expect(await countRows(unitDataset, CONTEXT)).toBe(
      pointUnits.filter((unit) => unit !== null).length,
    );
    expect(await collectRows(peopleDataset, CONTEXT)).toEqual(
      await collectRows(peopleDataset, CONTEXT),
    );
  });

  it("rejects invalid references and assignment end dates", async () => {
    const { administration } = await createHarness();
    const unknownUnit = "missing-unit" as OrganizationUnitId;
    await expect(administration.defineUnit(CONTEXT, {
      code: "ORPHAN",
      name: "孤立机构",
      parentId: unknownUnit,
      from: "2020-01-01",
    })).rejects.toBeInstanceOf(PrismError);

    const unit = await administration.defineUnit(CONTEXT, {
      code: "VALID",
      name: "有效机构",
      from: "2020-01-01",
    });
    await expect(administration.assignPerson(CONTEXT, {
      personId: "missing-person" as PersonId,
      organizationUnitId: unit.id,
      kind: "primary",
      from: "2020-01-01",
    })).rejects.toMatchObject({
      diagnostics: [{ code: OrganizationPluginDiagnosticCode.PERSON_NOT_FOUND }],
    });

    const person = await administration.createPerson(CONTEXT, {
      employeeNumber: "E-003",
      displayName: "王五",
    });
    const assignment = await administration.assignPerson(CONTEXT, {
      personId: person.id,
      organizationUnitId: unit.id,
      kind: "primary",
      from: "2024-01-01",
    });
    await expect(administration.endAssignment(
      CONTEXT,
      assignment.id,
      "2023-12-31",
    )).rejects.toMatchObject({
      diagnostics: [{ code: OrganizationPluginDiagnosticCode.INVALID_EFFECTIVE_PERIOD }],
    });
  });

  it("emits organization events for administration mutations", async () => {
    const { engine, administration } = await createHarness();
    const eventTypes: string[] = [];
    const unsubscribes = Object.values(OrganizationEventType).map((type) =>
      engine.eventBus.subscribe(type, (event) => {
        eventTypes.push(event.type);
      })
    );

    const unit = await administration.defineUnit(CONTEXT, {
      code: "EVENT-DEPT",
      name: "事件科室",
      from: "2020-01-01",
    });
    const person = await administration.createPerson(CONTEXT, {
      employeeNumber: "EVENT-001",
      displayName: "事件人员",
    });
    await administration.updatePerson(CONTEXT, person.id, { title: "医师" });
    const position = await administration.definePosition(CONTEXT, {
      code: "DOCTOR",
      name: "医生",
      organizationUnitId: unit.id,
      from: "2020-01-01",
    });
    const assignment = await administration.assignPerson(CONTEXT, {
      personId: person.id,
      organizationUnitId: unit.id,
      positionId: position.id,
      kind: "primary",
      from: "2020-01-01",
    });
    await administration.endAssignment(CONTEXT, assignment.id, "2026-01-01");
    for (const unsubscribe of unsubscribes) unsubscribe();

    expect(eventTypes).toEqual([
      OrganizationEventType.UnitDefined,
      OrganizationEventType.PersonCreated,
      OrganizationEventType.PersonUpdated,
      OrganizationEventType.PositionDefined,
      OrganizationEventType.AssignmentStarted,
      OrganizationEventType.AssignmentEnded,
    ]);
  });

  it("registers generic-studio organization resource types", async () => {
    const { engine } = await createHarness();
    const resources = engine.inspect().resourceTypes.filter((resource) =>
      resource.kind.startsWith("organization.")
    );

    expect(resources.map((resource) => resource.kind)).toEqual([
      "organization.person",
      "organization.unit",
      "organization.position",
      "organization.assignment",
    ]);
    expect(resources.map((resource) => resource.title)).toEqual([
      "人员",
      "组织机构",
      "岗位",
      "人员归属",
    ]);
    for (const resource of resources) {
      expect(resource.exposure).toEqual({ configuration: true, frontend: true });
      expect(Object.keys(resource.presentation?.fields ?? {}).length).toBeGreaterThan(0);
    }
  });
});
