import {
  canonicalJsonHash,
  canonicalJsonText,
  PrismError,
  type CallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";

export type ChangeApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED";

export interface ChangeApprovalTarget {
  readonly permission: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly params: JsonValue;
  readonly body: JsonValue;
  readonly changeReason: string;
}

export const APPROVAL_TARGET_PERMISSION_MAX_LENGTH = 128;
export const APPROVAL_TARGET_PATH_MAX_LENGTH = 512;
export const APPROVAL_TARGET_CHANGE_REASON_MAX_LENGTH = 500;
export const APPROVAL_TARGET_JSON_MAX_BYTES = 1_048_576;
const TARGET_CONTROL = /[\u0000-\u001f\u007f]/u;
const TARGET_PERMISSION = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;

export function validateChangeApprovalTarget(target: ChangeApprovalTarget): void {
  if (
    target.permission.length < 1 ||
    target.permission.length > APPROVAL_TARGET_PERMISSION_MAX_LENGTH ||
    !TARGET_PERMISSION.test(target.permission) ||
    target.path.length < 1 ||
    target.path.length > APPROVAL_TARGET_PATH_MAX_LENGTH ||
    !target.path.startsWith("/") ||
    TARGET_CONTROL.test(target.path) ||
    target.changeReason.trim().length < 1 ||
    target.changeReason.length > APPROVAL_TARGET_CHANGE_REASON_MAX_LENGTH ||
    TARGET_CONTROL.test(target.changeReason) ||
    (target.method !== "POST" && target.method !== "PUT" && target.method !== "DELETE")
  ) {
    throw invalidApprovalTarget();
  }
  let canonical: string;
  try {
    canonical = canonicalJsonText({ params: target.params, body: target.body });
  } catch {
    throw invalidApprovalTarget();
  }
  if (Buffer.byteLength(canonical, "utf8") > APPROVAL_TARGET_JSON_MAX_BYTES) {
    throw invalidApprovalTarget();
  }
}

export interface StoredChangeApprovalTarget {
  readonly permission: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly fingerprint: string;
}

export interface ChangeApproval {
  readonly id: string;
  readonly target: StoredChangeApprovalTarget;
  readonly requesterId: string;
  readonly reviewerId?: string;
  readonly publisherId?: string;
  readonly status: ChangeApprovalStatus;
  readonly version: number;
  readonly requestReason: string;
  readonly reviewReason?: string;
  readonly executionCorrelationId?: string;
  readonly executionOutcome?: "PENDING" | "SUCCEEDED" | "FAILED";
  readonly createdAt: string;
  readonly reviewedAt?: string;
  readonly consumedAt?: string;
  readonly expiresAt: string;
}

export interface ChangeApprovalCapability {
  request(
    context: CallContext,
    target: ChangeApprovalTarget,
    reason: string,
    expiresInSeconds?: number,
  ): Promise<ChangeApproval>;
  review(
    context: CallContext,
    id: string,
    expectedVersion: number,
    decision: "APPROVE" | "REJECT",
    reason: string,
  ): Promise<ChangeApproval>;
  get(context: CallContext, id: string): Promise<ChangeApproval | null>;
  list(
    context: CallContext,
    status?: ChangeApprovalStatus,
  ): Promise<readonly ChangeApproval[]>;
  consume(
    context: CallContext,
    approvalId: string,
    target: ChangeApprovalTarget,
    publisherId: string,
    expectedRequesterId?: string,
  ): Promise<ChangeApproval>;
  complete(
    context: CallContext,
    approvalId: string,
    expectedVersion: number,
    outcome: "SUCCEEDED" | "FAILED",
  ): Promise<ChangeApproval>;
}

export const ChangeApprovalCapabilityToken = defineCapability<ChangeApprovalCapability>({
  id: "governance.approval",
  version: "1.0.0",
});

export function approvalTargetFingerprint(target: ChangeApprovalTarget): string {
  return canonicalJsonHash({
    schemaVersion: "1.0.0",
    permission: target.permission,
    method: target.method,
    path: target.path,
    params: target.params,
    body: target.body,
    changeReason: target.changeReason,
  });
}

function invalidApprovalTarget(): PrismError {
  return PrismError.of(
    "APPROVAL_TARGET_INVALID",
    "Approval target is invalid or exceeds platform limits.",
  );
}
