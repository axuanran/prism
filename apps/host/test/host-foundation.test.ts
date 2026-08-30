import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemCallContext } from "@prismengine/contracts-data";
import { ChangeApprovalCapabilityToken } from "@prismengine/contracts-governance";
import { StorageCapabilityToken } from "@prismengine/contracts-storage";
import { createEngine } from "@prismengine/kernel";
import { changeApprovalPlugin } from "@prismengine/plugin-governance-approval";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { describe, expect, it } from "vitest";
import {
  loadProductionHostConfig,
  safeConfigurationSummary,
} from "../src/configuration.js";
import { loadExternalEvidence, requiredExternalEvidence } from "../src/evidence.js";
import { createSeparationOfDutiesPolicy } from "../src/policy.js";

function environment(): Record<string, string> {
  return {
    PRISM_DATABASE_URL:
      "postgresql://prism:database-password@db.example:5432/prism?sslmode=verify-full",
    PRISM_DEPLOYMENT_ID: "hospital-a",
    PRISM_DEPLOYMENT_ENVIRONMENT: "production",
    PRISM_OIDC_ISSUER: "https://identity.example",
    PRISM_OIDC_AUDIENCE: "prism",
    PRISM_OIDC_JWKS_URI: "https://identity.example/.well-known/jwks.json",
    PRISM_S3_REGION: "region-1",
    PRISM_ARTIFACT_BUCKET: "artifact-bucket",
    PRISM_AUDIT_BUCKET: "audit-bucket",
    PRISM_VAULT_ADDRESS: "https://vault.example",
    PRISM_VAULT_AUTH: "token",
    PRISM_VAULT_TOKEN: "vault-token",
    PRISM_WORKER_IMAGE: `registry.example/prism-worker@sha256:${"a".repeat(64)}`,
    PRISM_DOCKER_REMOTE_URL: "https://worker-node.example:2376",
    PRISM_DOCKER_CA_FILE: "/secrets/docker/ca.pem",
    PRISM_DOCKER_CERT_FILE: "/secrets/docker/cert.pem",
    PRISM_DOCKER_KEY_FILE: "/secrets/docker/key.pem",
    PRISM_OTEL_TRACE_ENDPOINT: "https://otel.example/v1/traces",
    PRISM_OTEL_METRIC_ENDPOINT: "https://otel.example/v1/metrics",
    PRISM_OTEL_HEALTH_URL: "https://otel.example/health",
    PRISM_OTEL_HEADERS_JSON: JSON.stringify({ authorization: "otel-secret" }),
    PRISM_EXTERNAL_EVIDENCE_FILES: "/evidence/production.json",
    PRISM_EXTERNAL_EVIDENCE_SHA256: "b".repeat(64),
  };
}

describe("Production Host foundation", () => {
  it("parses strict TLS/digest configuration without exposing boot secrets", () => {
    const config = loadProductionHostConfig(environment());
    expect(config.worker.image).toContain("@sha256:");
    expect(config.vault.authentication).toEqual({ kind: "token" });
    expect(config.telemetry.headers.authorization).toBe("otel-secret");
    const summary = JSON.stringify(safeConfigurationSummary(config));
    expect(summary).not.toContain("database-password");
    expect(summary).not.toContain("vault-token");
    expect(summary).not.toContain("otel-secret");

    expect(() =>
      loadProductionHostConfig({
        ...environment(),
        PRISM_WORKER_IMAGE: "registry.example/prism-worker:latest",
      }),
    ).toThrow("must be pinned by sha256 digest");
    expect(() =>
      loadProductionHostConfig({
        ...environment(),
        PRISM_DATABASE_URL: "postgresql://db/prism?sslmode=disable",
      }),
    ).toThrow("must require TLS");
  });

  it("loads hash-pinned, current external evidence and rejects tampering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-host-evidence-"));
    const path = join(directory, "evidence.json");
    const verifiedAt = new Date().toISOString();
    const checks = [
      "deployment.single-tenant",
      "worker-node.dedicated",
      "rpo-rto.approved",
      "backup-restore.verified",
      "sbom-signature.verified",
    ].map((id) => ({ id, passed: true, verifiedAt, evidence: `verified:${id}` }));
    const content = `${JSON.stringify({ checks })}\n`;
    await writeFile(path, content, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    try {
      const loaded = await loadExternalEvidence([path], [hash], 90);
      expect(requiredExternalEvidence(loaded)).toHaveLength(5);
      await expect(loadExternalEvidence([path], ["0".repeat(64)], 90)).rejects.toThrow(
        "SHA-256 mismatch",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces approved three-person publication from durable attribution", async () => {
    const engine = createEngine({
      plugins: [storageMemoryPlugin, changeApprovalPlugin()],
    });
    await engine.start();
    try {
      const storage = engine.capability(StorageCapabilityToken);
      const approvals = engine.capability(ChangeApprovalCapabilityToken);
      const author = {
        ...systemCallContext({ correlationId: "author" }),
        principal: { id: "author", roles: [], permissions: ["pipeline.draft.write"] },
      };
      await storage.resources.saveDraft(author, {
        kind: "project.visual-pipeline",
        id: "project-a:visual-pipeline",
        name: "Pipeline",
        spec: { value: 1 },
        expectedUpdatedAt: null,
      });
      const changeReason = "Publish reviewed pipeline";
      const target = {
        permission: "pipeline.publish",
        method: "POST" as const,
        path: "/api/code-projects/:id/visual-pipeline/publish",
        params: { id: "project-a" },
        body: {},
        changeReason,
      };
      const pending = await approvals.request(author, target, "Review pipeline");
      const approved = await approvals.review(
        {
          ...systemCallContext({ correlationId: "reviewer" }),
          principal: { id: "reviewer", roles: [], permissions: ["approval.review"] },
        },
        pending.id,
        pending.version,
        "APPROVE",
        "Exact target reviewed",
      );
      const policy = createSeparationOfDutiesPolicy(storage.audit, approvals);
      const request = {
        ...target,
        headers: { "x-approval-id": approved.id },
        correlationId: "publish-request",
        requiresChangeReason: true,
      };
      await expect(
        policy({
          ...request,
          principal: { id: "author", roles: [], permissions: ["pipeline.publish"] },
        }),
      ).rejects.toThrow("APPROVAL_SEPARATION_REQUIRED");
      await expect(
        policy({
          ...request,
          principal: { id: "reviewer", roles: [], permissions: ["pipeline.publish"] },
        }),
      ).rejects.toThrow("APPROVAL_SEPARATION_REQUIRED");
      const decision = await policy({
        ...request,
        principal: { id: "publisher", roles: [], permissions: ["pipeline.publish"] },
      });
      if (typeof decision === "boolean")
        throw new Error("Expected approval completion hooks");
      expect(decision.allowed).toBe(true);
      await decision.onSuccess?.();
      await expect(approvals.get(author, approved.id)).resolves.toMatchObject({
        status: "CONSUMED",
        executionOutcome: "SUCCEEDED",
      });
    } finally {
      await engine.stop();
    }
  });
});
