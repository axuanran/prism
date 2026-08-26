import type { CallContext, Dataset } from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";
import type {
  Assignment,
  AssignmentQuery,
  OrganizationUnit,
  OrganizationUnitId,
  Person,
  PersonId,
  PersonQuery,
  OrganizationUnitQuery,
  PositionQuery,
  Position,
  PositionId,
} from "./domain.js";

/**
 * Organization capability.
 *
 * Two access shapes on purpose:
 *   - point lookups for UI and single-subject explanation;
 *   - `Dataset` for batch work.
 *
 * A monthly close touching 10k people through `getPerson` would be an N+1
 * across a module boundary; a UI form fed by a `Dataset` would be absurd.
 * Both shapes are first-class, and the batch one is not an afterthought.
 *
 * `CallContext.asOf.validAt` selects the effective-dated view. Methods do not
 * take a separate date parameter: mixing per-call dates inside one run is how
 * a payout ends up reading two different org structures.
 */
export interface OrganizationCapability {
  getPerson(context: CallContext, id: PersonId): Promise<Person | null>;
  getPeople(
    context: CallContext,
    ids: readonly PersonId[],
  ): Promise<ReadonlyMap<PersonId, Person>>;
  findPeople(context: CallContext, query: PersonQuery): Promise<readonly Person[]>;

  getUnit(
    context: CallContext,
    id: OrganizationUnitId,
  ): Promise<OrganizationUnit | null>;
  getPosition(context: CallContext, id: PositionId): Promise<Position | null>;

  /**
   * All units effective at `context.asOf.validAt`, optionally filtered.
   * The dataset surface projects only the columns pipelines join on, so this
   * is the only way to read a unit's effective period as an entity.
   */
  findUnits(
    context: CallContext,
    query?: OrganizationUnitQuery,
  ): Promise<readonly OrganizationUnit[]>;
  findPositions(
    context: CallContext,
    query?: PositionQuery,
  ): Promise<readonly Position[]>;

  /** Units below `rootId`, effective at `context.asOf.validAt`. */
  descendantUnits(
    context: CallContext,
    rootId: OrganizationUnitId,
  ): Promise<readonly OrganizationUnit[]>;
  ancestorUnits(
    context: CallContext,
    unitId: OrganizationUnitId,
  ): Promise<readonly OrganizationUnit[]>;

  findAssignments(
    context: CallContext,
    query: AssignmentQuery,
  ): Promise<readonly Assignment[]>;

  /** Batch surface. Column names are part of the contract; see datasets.ts. */
  readonly datasets: OrganizationDatasets;
}

/**
 * Dataset names and columns are contract, not implementation detail: pipelines
 * reference these column names, so renaming one breaks stored configuration.
 */
export interface OrganizationDatasets {
  /** Columns: personId, employeeNumber, displayName, title, status. */
  people(context: CallContext, query?: PersonQuery): Dataset;
  /** Columns: unitId, code, name, parentId. */
  units(context: CallContext): Dataset;
  /** Columns: assignmentId, personId, unitId, positionId, kind, from, through. */
  assignments(context: CallContext, query?: AssignmentQuery): Dataset;
}

export interface CreatePersonCommand {
  readonly employeeNumber: string;
  readonly displayName: string;
  readonly title?: string;
}

export interface DefineUnitCommand {
  readonly code: string;
  readonly name: string;
  readonly parentId?: OrganizationUnitId;
  readonly from: string;
  readonly through?: string;
}

export interface DefinePositionCommand {
  readonly code: string;
  readonly name: string;
  readonly organizationUnitId: OrganizationUnitId;
  readonly from: string;
  readonly through?: string;
}

export interface AssignPersonCommand {
  readonly personId: PersonId;
  readonly organizationUnitId: OrganizationUnitId;
  readonly positionId?: PositionId;
  readonly kind: "primary" | "secondary";
  readonly from: string;
  readonly through?: string;
}

/**
 * Mutation is a separate capability from reads. Performance needs stable query
 * semantics; it has no business creating employees, and the type system should
 * say so.
 */
export interface OrganizationAdministration {
  createPerson(context: CallContext, command: CreatePersonCommand): Promise<Person>;
  updatePerson(
    context: CallContext,
    id: PersonId,
    changes: Partial<CreatePersonCommand> & { readonly status?: Person["status"] },
  ): Promise<Person>;
  defineUnit(context: CallContext, command: DefineUnitCommand): Promise<OrganizationUnit>;
  definePosition(
    context: CallContext,
    command: DefinePositionCommand,
  ): Promise<Position>;
  assignPerson(context: CallContext, command: AssignPersonCommand): Promise<Assignment>;
  endAssignment(context: CallContext, id: Assignment["id"], through: string): Promise<void>;
}

export const OrganizationCapabilityToken = defineCapability<OrganizationCapability>({
  id: "organization",
  version: "1.0.0",
});

export const OrganizationAdministrationToken =
  defineCapability<OrganizationAdministration>({
    id: "organization.administration",
    version: "1.0.0",
  });

export const OrganizationEventType = {
  PersonCreated: "organization.person.created",
  PersonUpdated: "organization.person.updated",
  UnitDefined: "organization.unit.defined",
  PositionDefined: "organization.position.defined",
  AssignmentStarted: "organization.assignment.started",
  AssignmentEnded: "organization.assignment.ended",
} as const;
