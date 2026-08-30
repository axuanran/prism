import {
  PrismError,
  assertJsonValue,
  systemCallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import type {
  ChangeApprovalCapability,
  ChangeApprovalTarget,
} from "@prismengine/contracts-governance";
import type { AuditJournal } from "@prismengine/contracts-storage";
import type {
  HttpAuthorizationPolicy,
  HttpAuthorizationRequest,
} from "@prismengine/plugin-http-fastify";

const APPROVAL_HEADER = "x-approval-id";
const criticalPermissions = new Set([
  "resource.publish",
  "resource.archive",
  "organization.write",
  "project.source.publish",
  "pipeline.publish",
  "project.release.publish",
  "runtime.activate",
]);

export function createSeparationOfDutiesPolicy(
  audit: AuditJournal,
  approvals: ChangeApprovalCapability,
): HttpAuthorizationPolicy {
  return async (request) => {
    if (!criticalPermissions.has(request.permission)) return true;
    const approvalId = firstHeader(request.headers[APPROVAL_HEADER])?.trim();
    if (!approvalId) {
      throw PrismError.of(
        "APPROVAL_REQUIRED",
        "Critical change requires an approved governance request.",
      );
    }
    if (!request.changeReason) return false;
    let target: ChangeApprovalTarget;
    let expectedRequesterId: string | undefined;
    try {
      target = approvalTarget(request);
      const authorTarget = durableAuthorTarget(
        request.permission,
        request.params,
        request.body,
      );
      if (authorTarget !== null) {
        expectedRequesterId =
          (await latestActor(audit, authorTarget.kind, authorTarget.id)) ?? undefined;
        if (expectedRequesterId === undefined) return false;
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw PrismError.of(
        "APPROVAL_TARGET_INVALID",
        "Critical change could not be mapped to an exact approval target.",
      );
    }
    const context = {
      ...systemCallContext({ correlationId: request.correlationId }),
      principal: request.principal,
      changeReason: request.changeReason,
      approvalId,
    };
    const consumed = await approvals.consume(
      context,
      approvalId,
      target,
      request.principal.id,
      expectedRequesterId,
    );
    return {
      allowed: true,
      onSuccess: () =>
        approvals
          .complete(context, approvalId, consumed.version, "SUCCEEDED")
          .then(() => undefined),
      onFailure: () =>
        approvals
          .complete(context, approvalId, consumed.version, "FAILED")
          .then(() => undefined),
    };
  };
}

function approvalTarget(request: HttpAuthorizationRequest): ChangeApprovalTarget {
  if (
    request.method !== "POST" &&
    request.method !== "PUT" &&
    request.method !== "DELETE"
  ) {
    throw new Error("Critical approval target requires a mutation method.");
  }
  return {
    permission: request.permission,
    method: request.method,
    path: request.path,
    params: jsonValue(request.params ?? null, "/params"),
    body: jsonValue(request.body ?? null, "/body"),
    changeReason: request.changeReason ?? "",
  };
}

function durableAuthorTarget(
  permission: string,
  params: unknown,
  body: unknown,
): { readonly kind: string; readonly id: string } | null {
  const routeParams = record(params);
  if (permission === "organization.write") return null;
  if (permission === "resource.publish" || permission === "resource.archive") {
    return {
      kind: stringField(routeParams, "kind"),
      id: stringField(routeParams, "id"),
    };
  }
  if (permission === "project.source.publish") {
    return { kind: "project.source-drafts", id: stringField(routeParams, "id") };
  }
  if (permission === "pipeline.publish") {
    const projectId = stringField(routeParams, "id");
    return { kind: "project.visual-pipeline", id: `${projectId}:visual-pipeline` };
  }
  if (permission === "project.release.publish") {
    return { kind: "project.build-requests", id: stringField(record(body), "buildId") };
  }
  if (permission === "runtime.activate") {
    const projectId = stringField(routeParams, "id");
    return { kind: "project.release", id: `${projectId}:release` };
  }
  return null;
}

async function latestActor(
  audit: AuditJournal,
  targetKind: string,
  targetId: string,
): Promise<string | null> {
  let afterSequence = 0;
  let actor: string | null = null;
  while (true) {
    const records = await audit.list(systemAuditContext, {
      afterSequence,
      limit: 1_000,
      targetKind,
      targetId,
    });
    if (records.length === 0) return actor;
    const latest = records.at(-1)!;
    actor = latest.principalId;
    afterSequence = latest.sequence;
    if (records.length < 1_000) return actor;
  }
}
const systemAuditContext = Object.freeze({
  principal: Object.freeze({
    id: "system",
    roles: Object.freeze(["system"]),
    permissions: Object.freeze(["*"]),
  }),
  correlationId: "production-authorization-policy",
  asOf: Object.freeze({ validAt: "1970-01-01T00:00:00.000Z" }),
});

function jsonValue(value: unknown, path: string): JsonValue {
  let projected: unknown;
  try {
    projected = JSON.parse(JSON.stringify(value));
  } catch {
    throw PrismError.of(
      "APPROVAL_TARGET_INVALID",
      "Critical change is not representable as canonical JSON.",
    );
  }
  assertJsonValue(projected, path);
  return projected;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Authorization policy expected an object request boundary.");
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: Record<string, unknown>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || !item) {
    throw new Error(`Authorization policy expected ${field}.`);
  }
  return item;
}
