/**
 * Organization domain model.
 *
 * Kept as real domain concepts rather than a generic entity bag: "Person" and
 * "Assignment" carry meaning that a `GenericObject` would throw away, and the
 * engine is generic enough already.
 */

export type PersonId = string & { readonly __brand: "PersonId" };
export type OrganizationUnitId = string & { readonly __brand: "OrganizationUnitId" };
export type PositionId = string & { readonly __brand: "PositionId" };
export type AssignmentId = string & { readonly __brand: "AssignmentId" };

/**
 * Business validity window, half-open: `[from, through)` when `through` is
 * set. Half-open removes the classic off-by-one where a transfer on the last
 * day of the month is counted twice.
 */
export interface EffectivePeriod {
  /** ISO date, inclusive. */
  readonly from: string;
  /** ISO date, exclusive. Absent means open-ended. */
  readonly through?: string;
}

export type PersonStatus = "active" | "inactive";

export interface Person {
  readonly id: PersonId;
  /** Organization-assigned person number. Unique and business-visible. */
  readonly employeeNumber: string;
  readonly displayName: string;
  readonly status: PersonStatus;
  /** Professional title, e.g. "主任医师". Drives coefficient lookups. */
  readonly title?: string;
}

export interface OrganizationUnit {
  readonly id: OrganizationUnitId;
  readonly code: string;
  readonly name: string;
  readonly parentId?: OrganizationUnitId;
  readonly effectivePeriod: EffectivePeriod;
}

export interface Position {
  readonly id: PositionId;
  readonly code: string;
  readonly name: string;
  readonly organizationUnitId: OrganizationUnitId;
  readonly effectivePeriod: EffectivePeriod;
}

export type AssignmentKind = "primary" | "secondary";

export interface Assignment {
  readonly id: AssignmentId;
  readonly personId: PersonId;
  readonly organizationUnitId: OrganizationUnitId;
  readonly positionId?: PositionId;
  readonly kind: AssignmentKind;
  readonly effectivePeriod: EffectivePeriod;
}

export interface PersonQuery {
  readonly status?: PersonStatus;
  readonly nameContains?: string;
  readonly employeeNumbers?: readonly string[];
  readonly limit?: number;
}

export interface AssignmentQuery {
  readonly personIds?: readonly PersonId[];
  readonly organizationUnitIds?: readonly OrganizationUnitId[];
  /** Include units below the given ones in the hierarchy. */
  readonly includeDescendants?: boolean;
  readonly kind?: AssignmentKind;
}

export interface OrganizationUnitQuery {
  readonly parentId?: OrganizationUnitId;
  /** Only root units. Mutually exclusive with `parentId`. */
  readonly rootsOnly?: boolean;
  readonly nameContains?: string;
  readonly codes?: readonly string[];
}

export interface PositionQuery {
  readonly organizationUnitIds?: readonly OrganizationUnitId[];
  readonly codes?: readonly string[];
}

/** True when `date` (ISO) falls inside the half-open period. */
export function isEffectiveOn(period: EffectivePeriod, date: string): boolean {
  if (date < period.from) return false;
  return period.through === undefined || date < period.through;
}
