/**
 * Call context.
 *
 * Every capability method takes a `CallContext` as its first parameter.
 * The cost is verbosity; the payoff is that authorization, call attribution,
 * cancellation and temporal pinning are all visible in the signature.
 * An ambient/service-locator principal hides all four, and retrofitting the
 * parameter later touches every capability method in the system.
 *
 * Deliberately absent in V0.1: `tenantId`. Single-deployment operation is the
 * V0.1 target, and adding one required field to this interface later is a
 * single edit here plus compiler-guided fixes - which is exactly why the
 * context object exists rather than loose parameters.
 */

export interface Principal {
  readonly id: string;
  readonly displayName?: string;
  readonly roles: readonly string[];
}

export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  id: "system",
  displayName: "System",
  roles: Object.freeze(["system"]),
});

/** Opaque handle to a pinned version of input data. */
export interface SnapshotRef {
  /** Storage-assigned id, when the snapshot was materialized. */
  readonly id?: string;
  /** Content hash of the inputs. Always present, even without materialization. */
  readonly fingerprint: string;
  readonly capturedAt: string;
}

/**
 * Two independent time axes:
 *   - `validAt`  business effective time: which org structure, which scheme.
 *   - `knownAs`  transaction time: which version of the data was read.
 *
 * Without `knownAs`, re-running a March payout in June silently picks up
 * June's corrections and the result stops being reproducible. V0.1 does not
 * implement a full bitemporal store; it only requires that a run records the
 * pin, so the semantics are not lost at the contract level.
 */
export interface TemporalContext {
  /** ISO-8601 date or datetime. */
  readonly validAt: string;
  readonly knownAs?: SnapshotRef;
}

export interface CallContext {
  readonly principal: Principal;
  readonly asOf: TemporalContext;
  /** Ties every log line, event and diagnostic of one request together. */
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  /** BCP-47 tag used to localize diagnostics at the presentation edge. */
  readonly locale?: string;
}

/**
 * Context for engine-internal work (bootstrap, seeding, scheduled runs).
 * Not a shortcut for user-initiated calls: those must carry a real principal.
 */
export function systemCallContext(
  overrides: Partial<CallContext> = {},
): CallContext {
  return {
    principal: SYSTEM_PRINCIPAL,
    asOf: { validAt: new Date().toISOString() },
    correlationId: crypto.randomUUID(),
    ...overrides,
  };
}
