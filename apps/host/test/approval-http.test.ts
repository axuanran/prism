import { systemCallContext } from "@prismengine/contracts-data";
import { ChangeApprovalCapabilityToken } from "@prismengine/contracts-governance";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import { createEngine, definePlugin } from "@prismengine/kernel";
import { changeApprovalPlugin } from "@prismengine/plugin-governance-approval";
import {
  HttpCapabilityToken,
  HttpRouteExtensionPoint,
  createHttpPlugin,
  type HttpAuthorizationPolicy,
} from "@prismengine/plugin-http-fastify";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { expect, it } from "vitest";
import { createSeparationOfDutiesPolicy } from "../src/policy.js";

it("propagates an exact approved request into the mutation audit record", async () => {
  let engine = createEngine({ plugins: [] });
  let loadedUpdatedAt = "";
  const routeWithStorage = definePlugin({
    id: "test-approved-storage-mutation",
    version: "0.1.0",
    engineRange: "^0.1.20",
    requires: { storage: StorageCapabilityToken },
    register(context) {
      context.extensions.contribute(HttpRouteExtensionPoint, {
        method: "POST",
        path: "/approved/:id",
        access: { kind: "permission", permission: "pipeline.publish" },
        changeReason: "required",
        handler: async (request) => {
          if (
            typeof request.params !== "object" ||
            request.params === null ||
            !("id" in request.params) ||
            typeof request.params.id !== "string"
          ) {
            throw new Error("Route params are malformed");
          }
          if (
            typeof request.body === "object" &&
            request.body !== null &&
            "revision" in request.body &&
            request.body.revision === 999
          ) {
            throw new Error("simulated mutation failure");
          }
          return {
            status: 200,
            body: await context.dependencies.storage.resources.saveDraft(request.call, {
              kind: "project.visual-pipeline",
              id: `${request.params.id}:visual-pipeline`,
              name: "Pipeline",
              spec: { value: 2 },
              expectedUpdatedAt: loadedUpdatedAt,
            }),
          };
        },
      });
    },
  });
  let policy: HttpAuthorizationPolicy | undefined;
  const http = createHttpPlugin({
    port: 0,
    inspection: () => engine.inspect(),
    principalProvider: ({ headers }) => {
      const id = headers.authorization?.toString().replace("Bearer ", "") ?? "";
      return id ? { id, roles: [], permissions: ["pipeline.publish"] } : null;
    },
    authorizationPolicy: async (request) => {
      policy ??= createSeparationOfDutiesPolicy(
        engine.capability(StorageCapabilityToken).audit,
        engine.capability(ChangeApprovalCapabilityToken),
      );
      return policy(request);
    },
  });
  engine = createEngine({
    plugins: [storageMemoryPlugin, changeApprovalPlugin(), routeWithStorage, http],
  });
  try {
    await engine.start();
    const storage = engine.capability(StorageCapabilityToken);
    const approvals = engine.capability(ChangeApprovalCapabilityToken);
    const author = {
      ...systemCallContext({ correlationId: "approved-author" }),
      principal: { id: "author", roles: [], permissions: [] },
    };
    const draft = await storage.resources.saveDraft(author, {
      kind: "project.visual-pipeline",
      id: "project-a:visual-pipeline",
      name: "Pipeline",
      spec: { value: 1 },
      expectedUpdatedAt: null,
    });
    loadedUpdatedAt = draft.updatedAt;
    const changeReason = "Publish exact approved mutation";
    const target = {
      permission: "pipeline.publish",
      method: "POST" as const,
      path: "/approved/:id",
      params: { id: "project-a" },
      body: { revision: 1 },
      changeReason,
    };
    const pending = await approvals.request(author, target, changeReason);
    const approved = await approvals.review(
      {
        ...systemCallContext({ correlationId: "approved-reviewer" }),
        principal: { id: "reviewer", roles: [], permissions: [] },
      },
      pending.id,
      pending.version,
      "APPROVE",
      "Reviewed",
    );
    const address = engine.capability(HttpCapabilityToken).address();
    if (address === null) throw new Error("HTTP server did not bind");
    const response = await fetch(`${address}/approved/project-a`, {
      method: "POST",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "x-change-reason": changeReason,
        "x-approval-id": approved.id,
      },
      body: JSON.stringify({ revision: 1 }),
    });
    const responseBody: unknown = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    const replay = await fetch(`${address}/approved/project-a`, {
      method: "POST",
      headers: {
        authorization: "Bearer publisher",
        "content-type": "application/json",
        "x-change-reason": changeReason,
        "x-approval-id": approved.id,
      },
      body: JSON.stringify({ revision: 1 }),
    });
    expect(replay.status).toBe(403);
    await expect(approvals.get(author, approved.id)).resolves.toMatchObject({
      status: "CONSUMED",
      executionOutcome: "SUCCEEDED",
      publisherId: "publisher",
    });
    const records = await storage.audit.list(author, {
      targetKind: "project.visual-pipeline",
      targetId: "project-a:visual-pipeline",
    });
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({
      principalId: "publisher",
      approvalId: approved.id,
      reason: changeReason,
    });
    const failedTarget = {
      ...target,
      body: { revision: 999 },
      changeReason: "Attempt exact failing mutation",
    };
    const failedPending = await approvals.request(
      {
        ...systemCallContext({ correlationId: "failed-requester" }),
        principal: { id: "publisher", roles: [], permissions: [] },
      },
      failedTarget,
      failedTarget.changeReason,
    );
    const failedApproved = await approvals.review(
      {
        ...systemCallContext({ correlationId: "failed-reviewer" }),
        principal: { id: "reviewer-2", roles: [], permissions: [] },
      },
      failedPending.id,
      failedPending.version,
      "APPROVE",
      "Failure path reviewed",
    );
    const failedResponse = await fetch(`${address}/approved/project-a`, {
      method: "POST",
      headers: {
        authorization: "Bearer publisher-2",
        "content-type": "application/json",
        "x-change-reason": failedTarget.changeReason,
        "x-approval-id": failedApproved.id,
      },
      body: JSON.stringify({ revision: 999 }),
    });
    expect(failedResponse.status).toBe(500);
    await expect(approvals.get(author, failedApproved.id)).resolves.toMatchObject({
      status: "CONSUMED",
      executionOutcome: "FAILED",
      publisherId: "publisher-2",
    });
  } finally {
    await engine.stop();
  }
});
