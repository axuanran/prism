import { canonicalJsonText, systemCallContext } from "@prismengine/contracts-data";
import {
  APPROVAL_TARGET_CHANGE_REASON_MAX_LENGTH,
  APPROVAL_TARGET_JSON_MAX_BYTES,
  APPROVAL_TARGET_PATH_MAX_LENGTH,
  APPROVAL_TARGET_PERMISSION_MAX_LENGTH,
  ChangeApprovalCapabilityToken,
  type ChangeApprovalTarget,
} from "@prismengine/contracts-governance";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import { createEngine } from "@prismengine/kernel";
import { changeApprovalPlugin } from "@prismengine/plugin-governance-approval";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { describe, expect, it } from "vitest";

const call = (id: string) => ({
  ...systemCallContext({ correlationId: `approval-${id}` }),
  principal: { id, roles: [], permissions: [] },
});
const target: ChangeApprovalTarget = {
  permission: "pipeline.publish",
  method: "POST",
  path: "/api/code-projects/:id/visual-pipeline/publish",
  params: { id: "project-a" },
  body: {
    buildId: "build-a",
    revision: 2,
    expectedPipelineFingerprint: "a".repeat(64),
  },
  changeReason: "Publish reviewed visual pipeline",
};
const sensitiveTarget: ChangeApprovalTarget = {
  ...target,
  body: {
    buildId: "build-a",
    revision: 2,
    expectedPipelineFingerprint: "a".repeat(64),
    secretValue: "never-persist",
  },
};

describe("Durable change approval", () => {
  it("stores only a target fingerprint and enforces three distinct principals", async () => {
    const engine = createEngine({
      plugins: [storageMemoryPlugin, changeApprovalPlugin()],
    });
    await engine.start();
    try {
      const approvals = engine.capability(ChangeApprovalCapabilityToken);
      const pending = await approvals.request(
        call("author"),
        sensitiveTarget,
        "Please review",
      );
      expect(JSON.stringify(pending)).not.toContain("never-persist");
      expect(pending.target.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      await expect(
        approvals.review(
          call("author"),
          pending.id,
          pending.version,
          "APPROVE",
          "self review",
        ),
      ).rejects.toThrow("APPROVAL_SELF_REVIEW_FORBIDDEN");
      const approved = await approvals.review(
        call("reviewer"),
        pending.id,
        pending.version,
        "APPROVE",
        "Reviewed exact target",
      );
      await expect(
        approvals.consume(call("author"), approved.id, sensitiveTarget, "author", "author"),
      ).rejects.toThrow("APPROVAL_SEPARATION_REQUIRED");
      await expect(
        approvals.consume(
          call("reviewer"),
          approved.id,
          sensitiveTarget,
          "reviewer",
          "author",
        ),
      ).rejects.toThrow("APPROVAL_SEPARATION_REQUIRED");
      await expect(
        approvals.consume(
          call("publisher"),
          approved.id,
          { ...target, body: { buildId: "other" } },
          "publisher",
          "author",
        ),
      ).rejects.toThrow("APPROVAL_TARGET_MISMATCH");
      const consumed = await approvals.consume(
        call("publisher"),
        approved.id,
        sensitiveTarget,
        "publisher",
        "author",
      );
      expect(consumed).toMatchObject({
        status: "CONSUMED",
        executionOutcome: "PENDING",
        publisherId: "publisher",
      });
      const completed = await approvals.complete(
        call("publisher"),
        approved.id,
        consumed.version,
        "SUCCEEDED",
      );
      expect(completed.executionOutcome).toBe("SUCCEEDED");
      await expect(
        approvals.consume(
          call("publisher-2"),
          approved.id,
          sensitiveTarget,
          "publisher-2",
          "author",
        ),
      ).rejects.toThrow("APPROVAL_NOT_APPROVED");
    } finally {
      await engine.stop();
    }
  });

  it("bounds exact targets before fingerprinting or persistence", async () => {
    const engine = createEngine({
      plugins: [storageMemoryPlugin, changeApprovalPlugin()],
    });
    await engine.start();
    try {
      const approvals = engine.capability(ChangeApprovalCapabilityToken);
      const storage = engine.capability(StorageCapabilityToken);
      const auditBefore = await storage.audit.list(call("auditor"));
      const permission = "p".repeat(APPROVAL_TARGET_PERMISSION_MAX_LENGTH);
      const path = `/${"a".repeat(APPROVAL_TARGET_PATH_MAX_LENGTH - 1)}`;
      const changeReason = "r".repeat(APPROVAL_TARGET_CHANGE_REASON_MAX_LENGTH);
      const emptyCanonicalBytes = Buffer.byteLength(
        canonicalJsonText({ params: null, body: { data: "" } }),
        "utf8",
      );
      const data = "x".repeat(APPROVAL_TARGET_JSON_MAX_BYTES - emptyCanonicalBytes);
      const boundary: ChangeApprovalTarget = {
        permission,
        method: "POST",
        path,
        params: null,
        body: { data },
        changeReason,
      };
      expect(
        Buffer.byteLength(
          canonicalJsonText({ params: boundary.params, body: boundary.body }),
          "utf8",
        ),
      ).toBe(APPROVAL_TARGET_JSON_MAX_BYTES);

      const invalidTargets: ChangeApprovalTarget[] = [
        {
          ...boundary,
          permission: "p".repeat(APPROVAL_TARGET_PERMISSION_MAX_LENGTH + 1),
        },
        { ...boundary, permission: "invalid permission" },
        {
          ...boundary,
          path: `/${"a".repeat(APPROVAL_TARGET_PATH_MAX_LENGTH)}`,
        },
        { ...boundary, path: "/invalid\npath" },
        {
          ...boundary,
          changeReason: "r".repeat(APPROVAL_TARGET_CHANGE_REASON_MAX_LENGTH + 1),
        },
        { ...boundary, body: { data: `${data}x` } },
      ];
      for (const invalid of invalidTargets) {
        await expect(approvals.request(call("author"), invalid, "Review")).rejects.toThrow(
          "APPROVAL_TARGET_INVALID",
        );
      }
      await expect(approvals.list(call("author"))).resolves.toEqual([]);
      expect(await storage.audit.list(call("auditor"))).toEqual(auditBefore);

      const pending = await approvals.request(
        call("author"),
        boundary,
        "Review exact boundary",
      );
      const approved = await approvals.review(
        call("reviewer"),
        pending.id,
        pending.version,
        "APPROVE",
        "Approved",
      );
      await expect(
        approvals.consume(
          call("publisher"),
          approved.id,
          { ...boundary, body: { data: `${data}x` } },
          "publisher",
          "author",
        ),
      ).rejects.toThrow("APPROVAL_TARGET_INVALID");
      await expect(approvals.get(call("author"), approved.id)).resolves.toMatchObject({
        status: "APPROVED",
        version: approved.version,
      });
      const consumed = await approvals.consume(
        call("publisher"),
        approved.id,
        boundary,
        "publisher",
        "author",
      );
      expect(consumed).toMatchObject({
        status: "CONSUMED",
        publisherId: "publisher",
      });
    } finally {
      await engine.stop();
    }
  });

  it("CAS-allows only one reviewer decision", async () => {
    const engine = createEngine({
      plugins: [storageMemoryPlugin, changeApprovalPlugin()],
    });
    await engine.start();
    try {
      const approvals = engine.capability(ChangeApprovalCapabilityToken);
      const pending = await approvals.request(call("author"), target, "Review", 300);
      const results = await Promise.allSettled([
        approvals.review(call("reviewer-a"), pending.id, 1, "APPROVE", "approve"),
        approvals.review(call("reviewer-b"), pending.id, 1, "REJECT", "reject"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  });
});
