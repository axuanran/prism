import {
  assertJsonValue,
  systemCallContext,
  type JsonValue,
} from "@prismengine/contracts-data";
import {
  ChangeApprovalCapabilityToken,
  type ChangeApprovalTarget,
} from "@prismengine/contracts-governance";
import { createEngine } from "@prismengine/kernel";
import { prismPlatform } from "@prismengine/platform";
import { changeApprovalPlugin } from "@prismengine/plugin-governance-approval";
import { createHttpPlugin } from "@prismengine/plugin-http-fastify";
import { organizationPlugin } from "@prismengine/plugin-organization-basic";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { studioApiPlugin } from "@prismengine/plugin-studio-api";
const permissions: Readonly<Record<string, readonly string[]>> = {
  author: [
    "inspection.read",
    "resource.read",
    "organization.read",
    "organization.write",
    "approval.read",
    "approval.request",
  ],
  reviewer: [
    "inspection.read",
    "resource.read",
    "organization.read",
    "approval.read",
    "approval.review",
  ],
  publisher: [
    "inspection.read",
    "resource.read",
    "organization.read",
    "organization.write",
    "approval.read",
  ],
};
let engine = createEngine({ plugins: [] });
const http = createHttpPlugin({
  port: 3000,
  inspection: () => engine.inspect(),
  principalProvider: ({ headers }) => {
    const cookie = firstHeader(headers.cookie) ?? "";
    const principalId = cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("prism-test-principal="))
      ?.slice("prism-test-principal=".length);
    if (!principalId || permissions[principalId] === undefined) return null;
    return { id: principalId, roles: [], permissions: permissions[principalId] };
  },
  authorizationPolicy: async (request) => {
    if (request.permission !== "organization.write") return true;
    const approvalId = firstHeader(request.headers["x-approval-id"])?.trim();
    if (!approvalId || !request.changeReason) return false;
    const approvals = engine.capability(ChangeApprovalCapabilityToken);
    const context = {
      ...systemCallContext({ correlationId: request.correlationId }),
      principal: request.principal,
      changeReason: request.changeReason,
      approvalId,
    };
    const target: ChangeApprovalTarget = {
      permission: request.permission,
      method: "POST",
      path: request.path,
      params: jsonValue(request.params ?? null),
      body: jsonValue(request.body ?? null),
      changeReason: request.changeReason,
    };
    const consumed = await approvals.consume(
      context,
      approvalId,
      target,
      request.principal.id,
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
  },
});
engine = createEngine({
  plugins: [
    storageMemoryPlugin,
    ...prismPlatform({ storage: false }),
    organizationPlugin,
    changeApprovalPlugin(),
    studioApiPlugin,
    http,
  ],
});
await engine.start();
process.stdout.write("E2E host ready\n");

const stop = async (): Promise<void> => {
  await engine.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function jsonValue(value: unknown): JsonValue {
  const projected: unknown = JSON.parse(JSON.stringify(value));
  assertJsonValue(projected);
  return projected;
}
