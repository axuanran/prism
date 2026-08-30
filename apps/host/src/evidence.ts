import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import type { ProductionReadinessCheck } from "@prismengine/plugin-http-fastify";

export interface ExternalEvidence extends ProductionReadinessCheck {
  readonly verifiedAt: string;
}

export async function loadExternalEvidence(
  files: readonly string[],
  expectedHashes: readonly string[],
  maxAgeDays: number,
  now = Date.now(),
): Promise<readonly ExternalEvidence[]> {
  if (files.length !== expectedHashes.length) {
    throw new Error("External evidence files and hashes must have equal length.");
  }
  const checks: ExternalEvidence[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const path = files[index];
    const expectedHash = expectedHashes[index];
    if (path === undefined || expectedHash === undefined) {
      throw new Error("External evidence configuration is incomplete.");
    }
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1_048_576) {
      throw new Error("External evidence file is invalid or exceeds 1 MiB.");
    }
    const bytes = await readFile(path);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`External evidence SHA-256 mismatch: ${path}`);
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const entries = evidenceEntries(value);
    for (const entry of entries) checks.push(parseEvidence(entry, path, maxAgeDays, now));
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`Duplicate external evidence id: ${check.id}`);
    ids.add(check.id);
  }
  return checks;
}

function evidenceEntries(value: unknown): readonly unknown[] {
  if (
    typeof value === "object" &&
    value !== null &&
    "checks" in value &&
    Array.isArray(value.checks)
  ) {
    return value.checks;
  }
  return [value];
}

function parseEvidence(
  value: unknown,
  path: string,
  maxAgeDays: number,
  now: number,
): ExternalEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !("passed" in value) ||
    value.passed !== true ||
    !("evidence" in value) ||
    typeof value.evidence !== "string" ||
    !value.evidence.trim() ||
    !("verifiedAt" in value) ||
    typeof value.verifiedAt !== "string"
  ) {
    throw new Error(`External evidence entry is malformed: ${path}`);
  }
  const verifiedAt = Date.parse(value.verifiedAt);
  const maximumAge = maxAgeDays * 86_400_000;
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now + 300_000 ||
    now - verifiedAt > maximumAge
  ) {
    throw new Error(`External evidence is expired or future-dated: ${value.id}`);
  }
  return Object.freeze({
    id: value.id,
    passed: true,
    evidence: value.evidence,
    verifiedAt: new Date(verifiedAt).toISOString(),
  });
}

export function requiredExternalEvidence(
  checks: readonly ExternalEvidence[],
): readonly ProductionReadinessCheck[] {
  const required = [
    "deployment.single-tenant",
    "worker-node.dedicated",
    "rpo-rto.approved",
    "backup-restore.verified",
    "sbom-signature.verified",
  ];
  const byId = new Map(checks.map((check) => [check.id, check]));
  return required.map((id) => {
    const check = byId.get(id);
    return check ?? { id, passed: false, evidence: "missing-external-evidence" };
  });
}
