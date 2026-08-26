import type { SnapshotRef, TemporalContext } from "./call-context.js";

/**
 * Run reproducibility.
 *
 *   Run = Definition + Input Snapshot + Effective Time + Engine/Operator Versions
 *
 * Any run that cannot answer all four cannot be replayed, and a payout that
 * cannot be replayed cannot be explained or audited. This is engine semantics,
 * not a future feature: the fields are required from V0.1 even though the
 * V0.1 storage behind them is minimal.
 *
 * Given a complete pin, "why is this number what it is?" is answered by
 * deterministic re-execution of a single subject, which is also why the engine
 * does not need to persist full traces for the whole population.
 */

/**
 * Which definition revision executed. Published revisions are immutable.
 *
 * Kept alongside `RunPin.definitionFingerprint` because the two do different
 * jobs: a reference LOCATES the revision to load for a replay, a fingerprint
 * VERIFIES that what was loaded is what ran. A fingerprint cannot be reversed
 * into "which scheme, which revision", which is exactly what `explainResult`
 * needs in order to reload anything at all.
 */
export interface DefinitionRef {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
}

export interface DatasetFingerprint {
  readonly name: string;
  /** Content hash over the batch stream. */
  readonly fingerprint: string;
  readonly rowCount: number;
}

/**
 * A bound scalar, hashed rather than stored.
 *
 * Parameter DECLARATIONS live in the plan and so affect the plan hash, but
 * the bound VALUES do not. Without hashing them, a run at a point value of 10
 * and a run at 20 share an input fingerprint and therefore a run identity,
 * while producing entirely different payouts. Hashed rather than kept in the
 * clear because a pin is stored and a parameter may carry sensitive data.
 */
export interface ParameterFingerprint {
  readonly name: string;
  readonly fingerprint: string;
}

export interface InputSnapshot {
  /** Aggregate over every dataset AND parameter below. */
  readonly ref: SnapshotRef;
  readonly datasets: readonly DatasetFingerprint[];
  readonly parameters: readonly ParameterFingerprint[];
}

/**
 * Code identity.
 *
 * An operator bug fix changes results; so does swapping the execution
 * backend, which is the entire reason the backend seam exists. Business
 * components above calculation can also transform final payouts.
 */
export interface VersionStamp {
  readonly engine: string;
  /** Operation id -> operation version, for every operation the plan used. */
  readonly operations: Readonly<Record<string, string>>;
  /** Which backend executed the plan, and at which version. */
  readonly backend: BackendStamp;
  /**
   * Business components that transform results after backend execution.
   * Calculation cannot stamp these: performance grouping/rounding happens
   * above it, but can still change a payout and therefore belongs to run
   * identity.
   */
  readonly components: Readonly<Record<string, string>>;
}

export interface BackendStamp {
  readonly id: string;
  readonly version: string;
}

export interface RunPin {
  /** Locates the revision to reload for a replay. */
  readonly definition: DefinitionRef;
  /**
   * Verifies that the reloaded revision is byte-identical to the one that
   * ran. Published revisions are immutable by contract, but a pin whose only
   * evidence is "revision 3" trusts that contract instead of checking it.
   */
  readonly definitionFingerprint: string;
  readonly input: InputSnapshot;
  readonly effective: TemporalContext;
  readonly versions: VersionStamp;
  /** Hash of the compiled plan. Equal pins must produce equal plan hashes. */
  readonly planHash: string;
}

/** True when two runs are expected to produce byte-identical results. */
export function isSameRunPin(a: RunPin, b: RunPin): boolean {
  return (
    a.planHash === b.planHash &&
    a.input.ref.fingerprint === b.input.ref.fingerprint &&
    a.effective.validAt === b.effective.validAt &&
    a.effective.knownAs?.fingerprint === b.effective.knownAs?.fingerprint &&
    a.definition.kind === b.definition.kind &&
    a.definition.id === b.definition.id &&
    a.definition.revision === b.definition.revision &&
    a.definitionFingerprint === b.definitionFingerprint &&
    // Same inputs on a different backend is not the same run: that is the
    // one difference a backend swap is allowed to make visible.
    a.versions.engine === b.versions.engine &&
    a.versions.backend.id === b.versions.backend.id &&
    a.versions.backend.version === b.versions.backend.version &&
    sameOperationVersions(a.versions.operations, b.versions.operations) &&
    sameOperationVersions(a.versions.components, b.versions.components)
  );
}

function sameOperationVersions(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;
  return names.every((name) => a[name] === b[name]);
}
