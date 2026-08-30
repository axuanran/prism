import { randomUUID } from "node:crypto";
import {
  PrismError,
  assertJsonValue,
  type CallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  ChangeApprovalCapabilityToken,
  approvalTargetFingerprint,
  validateChangeApprovalTarget,
  type ChangeApproval,
  type ChangeApprovalCapability,
  type ChangeApprovalStatus,
  type ChangeApprovalTarget,
} from "@prismengine/contracts-governance";
import {
  AtomicWriteCapabilityToken,
  StorageCapabilityToken,
  type AtomicDocument,
  type AtomicWriteCapability,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import { definePlugin } from "@prismengine/kernel";
import { HttpRouteExtensionPoint, type HttpRoute } from "@prismengine/plugin-http-fastify";

const APPROVAL_COLLECTION = "governance.change-approvals";

export interface ChangeApprovalPluginOptions {
  readonly defaultExpiresInSeconds?: number;
  readonly maximumExpiresInSeconds?: number;
}

export function changeApprovalPlugin(options: ChangeApprovalPluginOptions = {}) {
  return definePlugin({
    id: "governance.approval",
    version: "0.1.20",
    engineRange: "^0.1.20",
    requires: {
      storage: StorageCapabilityToken,
      atomicWrite: AtomicWriteCapabilityToken,
    },
    provides: [ChangeApprovalCapabilityToken],
    register(context) {
      const capability = new DefaultChangeApprovalCapability(
        context.dependencies.storage,
        context.dependencies.atomicWrite,
        options.defaultExpiresInSeconds ?? 86_400,
        options.maximumExpiresInSeconds ?? 604_800,
      );
      context.provide(ChangeApprovalCapabilityToken, capability);
      for (const route of approvalRoutes(capability)) {
        context.extensions.contribute(HttpRouteExtensionPoint, route);
      }
    },
  });
}

class DefaultChangeApprovalCapability implements ChangeApprovalCapability {
  private readonly approvals;

  constructor(
    storage: StorageCapability,
    private readonly atomicWrite: AtomicWriteCapability,
    private readonly defaultExpiresInSeconds: number,
    private readonly maximumExpiresInSeconds: number,
  ) {
    if (
      !Number.isSafeInteger(defaultExpiresInSeconds) ||
      defaultExpiresInSeconds < 60 ||
      !Number.isSafeInteger(maximumExpiresInSeconds) ||
      maximumExpiresInSeconds < defaultExpiresInSeconds
    ) {
      throw PrismError.of(
        "APPROVAL_CONFIGURATION_INVALID",
        "Approval expiry configuration is invalid.",
      );
    }
    this.approvals = storage.collection<ChangeApproval>(APPROVAL_COLLECTION);
  }

  async request(
    context: CallContext,
    target: ChangeApprovalTarget,
    reason: string,
    expiresInSeconds = this.defaultExpiresInSeconds,
  ): Promise<ChangeApproval> {
    const requestReason = boundedReason(reason, "Approval request reason");
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > this.maximumExpiresInSeconds
    ) {
      throw PrismError.of(
        "APPROVAL_EXPIRY_INVALID",
        "Approval expiry is outside the configured range.",
      );
    }
    validateChangeApprovalTarget(target);
    const now = new Date();
    const approval: ChangeApproval = {
      id: randomUUID(),
      target: {
        permission: target.permission,
        method: target.method,
        path: target.path,
        fingerprint: approvalTargetFingerprint(target),
      },
      requesterId: context.principal.id,
      status: "PENDING",
      version: 1,
      requestReason,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
    };
    await this.atomicWrite.execute(context, {
      requestId: `create-approval:${approval.id}`,
      preconditions: [
        {
          kind: "document-absent",
          collection: APPROVAL_COLLECTION,
          id: approval.id,
        },
      ],
      operations: [put(approval, "create")],
    });
    return approval;
  }

  async review(
    context: CallContext,
    id: string,
    expectedVersion: number,
    decision: "APPROVE" | "REJECT",
    reason: string,
  ): Promise<ChangeApproval> {
    const current = await this.required(context, id);
    if (current.status !== "PENDING" || current.version !== expectedVersion) {
      throw PrismError.of("APPROVAL_CONFLICT", "Approval changed after it was loaded.", {
        id,
        expectedVersion,
        actualVersion: current.version,
        status: current.status,
      });
    }
    if (current.requesterId === context.principal.id) {
      throw PrismError.of(
        "APPROVAL_SELF_REVIEW_FORBIDDEN",
        "Approval requester cannot review the same change.",
        { id },
      );
    }
    if (decision === "APPROVE" && Date.parse(current.expiresAt) <= Date.now()) {
      throw PrismError.of("APPROVAL_EXPIRED", "Expired approval cannot be approved.", {
        id,
      });
    }
    const next: ChangeApproval = {
      ...current,
      reviewerId: context.principal.id,
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      version: current.version + 1,
      reviewReason: boundedReason(reason, "Approval review reason"),
      reviewedAt: new Date().toISOString(),
    };
    await this.atomicWrite.execute(context, {
      requestId: `review-approval:${id}:${next.version}`,
      preconditions: [
        {
          kind: "document-present",
          collection: APPROVAL_COLLECTION,
          id,
          fields: { status: "PENDING", version: expectedVersion },
        },
      ],
      operations: [put(next, "replace")],
    });
    return next;
  }

  get(context: CallContext, id: string): Promise<ChangeApproval | null> {
    return this.approvals.get(context, id);
  }

  list(
    context: CallContext,
    status?: ChangeApprovalStatus,
  ): Promise<readonly ChangeApproval[]> {
    return this.approvals.find(context, {
      ...(status === undefined ? {} : { where: { status } }),
      orderBy: [{ field: "createdAt", direction: "desc" }],
      limit: 500,
    });
  }

  async consume(
    context: CallContext,
    approvalId: string,
    target: ChangeApprovalTarget,
    publisherId: string,
    expectedRequesterId?: string,
  ): Promise<ChangeApproval> {
    validateChangeApprovalTarget(target);
    const approval = await this.required(context, approvalId);
    if (context.principal.id !== publisherId) {
      throw PrismError.of(
        "APPROVAL_PUBLISHER_MISMATCH",
        "Approval publisher identity is invalid.",
      );
    }
    if (approval.status !== "APPROVED" || approval.reviewerId === undefined) {
      throw PrismError.of(
        "APPROVAL_NOT_APPROVED",
        "Change requires an approved, unused governance request.",
        { approvalId, status: approval.status },
      );
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      throw PrismError.of("APPROVAL_EXPIRED", "Change approval has expired.", {
        approvalId,
      });
    }
    if (approval.target.fingerprint !== approvalTargetFingerprint(target)) {
      throw PrismError.of(
        "APPROVAL_TARGET_MISMATCH",
        "Approval does not match the exact requested change.",
        { approvalId },
      );
    }
    if (expectedRequesterId !== undefined && approval.requesterId !== expectedRequesterId) {
      throw PrismError.of(
        "APPROVAL_REQUESTER_MISMATCH",
        "Approval requester is not the durable author of this change.",
        { approvalId },
      );
    }
    if (
      publisherId === approval.requesterId ||
      publisherId === approval.reviewerId ||
      approval.requesterId === approval.reviewerId
    ) {
      throw PrismError.of(
        "APPROVAL_SEPARATION_REQUIRED",
        "Requester, reviewer, and publisher must be distinct principals.",
        { approvalId },
      );
    }
    const consumed: ChangeApproval = {
      ...approval,
      publisherId,
      status: "CONSUMED",
      version: approval.version + 1,
      executionCorrelationId: context.correlationId,
      executionOutcome: "PENDING",
      consumedAt: new Date().toISOString(),
    };
    await this.atomicWrite.execute(context, {
      requestId: `consume-approval:${approvalId}:${consumed.version}`,
      preconditions: [
        {
          kind: "document-present",
          collection: APPROVAL_COLLECTION,
          id: approvalId,
          fields: { status: "APPROVED", version: approval.version },
        },
      ],
      operations: [put(consumed, "replace")],
    });
    return consumed;
  }

  async complete(
    context: CallContext,
    approvalId: string,
    expectedVersion: number,
    outcome: "SUCCEEDED" | "FAILED",
  ): Promise<ChangeApproval> {
    const current = await this.required(context, approvalId);
    if (
      current.status !== "CONSUMED" ||
      current.version !== expectedVersion ||
      current.executionOutcome !== "PENDING" ||
      current.publisherId !== context.principal.id
    ) {
      throw PrismError.of(
        "APPROVAL_COMPLETION_CONFLICT",
        "Approval execution outcome changed after it was loaded.",
        { approvalId, expectedVersion, actualVersion: current.version },
      );
    }
    const completed: ChangeApproval = {
      ...current,
      version: current.version + 1,
      executionOutcome: outcome,
    };
    await this.atomicWrite.execute(context, {
      requestId: `complete-approval:${approvalId}:${completed.version}`,
      preconditions: [
        {
          kind: "document-present",
          collection: APPROVAL_COLLECTION,
          id: approvalId,
          fields: {
            status: "CONSUMED",
            version: expectedVersion,
            executionOutcome: "PENDING",
            publisherId: context.principal.id,
          },
        },
      ],
      operations: [put(completed, "replace")],
    });
    return completed;
  }

  private async required(context: CallContext, id: string): Promise<ChangeApproval> {
    const approval = await this.approvals.get(context, id);
    if (approval === null) {
      throw PrismError.of("APPROVAL_NOT_FOUND", "Change approval was not found.", { id });
    }
    return approval;
  }
}

function approvalRoutes(capability: ChangeApprovalCapability): readonly HttpRoute[] {
  return [
    {
      method: "GET",
      path: "/api/approvals",
      access: { kind: "permission", permission: "approval.read" },
      summary: "List durable change approvals",
      handler: async (request) => ({
        status: 200,
        body: await capability.list(
          request.call,
          approvalStatus(optionalRecord(request.query).status),
        ),
      }),
    },
    {
      method: "GET",
      path: "/api/approvals/:id",
      access: { kind: "permission", permission: "approval.read" },
      summary: "Read one durable change approval",
      handler: async (request) => {
        const id = string(record(request.params).id);
        const approval = await capability.get(request.call, id);
        if (approval === null) {
          throw PrismError.of("APPROVAL_NOT_FOUND", "Change approval was not found.", {
            id,
          });
        }
        return { status: 200, body: approval };
      },
    },
    {
      method: "POST",
      path: "/api/approvals",
      access: { kind: "permission", permission: "approval.request" },
      summary: "Request approval for an exact mutation fingerprint",
      handler: async (request) => {
        const body = record(request.body);
        return {
          status: 201,
          body: await capability.request(
            request.call,
            approvalTarget(body.target),
            string(body.reason),
            optionalPositiveInteger(body.expiresInSeconds),
          ),
        };
      },
    },
    {
      method: "POST",
      path: "/api/approvals/:id/review",
      access: { kind: "permission", permission: "approval.review" },
      changeReason: "required",
      summary: "Approve or reject a pending exact mutation",
      handler: async (request) => {
        const body = record(request.body);
        return {
          status: 200,
          body: await capability.review(
            request.call,
            string(record(request.params).id),
            positiveInteger(body.expectedVersion),
            reviewDecision(body.decision),
            string(body.reason),
          ),
        };
      },
    },
  ];
}

function approvalTarget(value: unknown): ChangeApprovalTarget {
  const target = record(value);
  const method = string(target.method);
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") {
    throw PrismError.of("APPROVAL_TARGET_INVALID", "Approval target method is invalid.");
  }
  const params = target.params ?? null;
  const body = target.body ?? null;
  return {
    permission: string(target.permission),
    method,
    path: string(target.path),
    params: jsonValue(params, "/target/params"),
    body: jsonValue(body, "/target/body"),
    changeReason: string(target.changeReason),
  };
}

function jsonValue(value: unknown, path: string): JsonValue {
  assertJsonValue(value, path);
  return value as JsonValue;
}

function boundedReason(value: string, label: string): string {
  const reason = value.trim();
  if (!reason || reason.length > 500) {
    throw PrismError.of(
      "APPROVAL_REASON_INVALID",
      `${label} must contain 1-500 characters.`,
    );
  }
  return reason;
}

function put(approval: ChangeApproval, mode: "create" | "replace") {
  return {
    kind: "put-document" as const,
    collection: APPROVAL_COLLECTION,
    document: approval as unknown as AtomicDocument,
    mode,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw PrismError.of("APPROVAL_REQUEST_INVALID", "Expected object request.");
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : record(value);
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw PrismError.of("APPROVAL_REQUEST_INVALID", "Expected non-empty string.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw PrismError.of("APPROVAL_REQUEST_INVALID", "Expected positive integer.");
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : positiveInteger(value);
}

function reviewDecision(value: unknown): "APPROVE" | "REJECT" {
  if (value !== "APPROVE" && value !== "REJECT") {
    throw PrismError.of("APPROVAL_REQUEST_INVALID", "Review decision is invalid.");
  }
  return value;
}

function approvalStatus(value: unknown): ChangeApprovalStatus | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "PENDING" &&
    value !== "APPROVED" &&
    value !== "REJECTED" &&
    value !== "CONSUMED"
  ) {
    throw PrismError.of("APPROVAL_REQUEST_INVALID", "Approval status is invalid.");
  }
  return value;
}
