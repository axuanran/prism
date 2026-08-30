import { EngineDiagnosticCode, PrismError } from "@prismengine/contracts-data";
import semver from "semver";
import type { AnyCapabilityToken, RequirementSpec } from "./capability.js";
import type { AnyPluginDefinition } from "./plugin.js";

export const KERNEL_ID_MAX_LENGTH = 128;
export const KERNEL_VERSION_MAX_LENGTH = 64;
export const KERNEL_RANGE_MAX_LENGTH = 256;
export const KERNEL_DESCRIPTION_MAX_LENGTH = 512;
export const KERNEL_REQUIREMENT_KEY_MAX_LENGTH = 128;
export const KERNEL_MIGRATION_ID_MAX_LENGTH = 128;
export const KERNEL_MIGRATION_EXTERNAL_EFFECTS_MAX = 16;
export const KERNEL_MIGRATION_EXTERNAL_EFFECT_MAX_LENGTH = 256;
const KERNEL_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;
const REQUIREMENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function assertKernelId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > KERNEL_ID_MAX_LENGTH ||
    !KERNEL_ID.test(value)
  ) {
    throw identityInvalid(field);
  }
}

export function assertKernelVersion(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > KERNEL_VERSION_MAX_LENGTH ||
    semver.valid(value) === null
  ) {
    throw identityInvalid(field);
  }
}

export function assertPluginDefinition(
  value: unknown,
): asserts value is AnyPluginDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw identityInvalid("plugin");
  }
  const plugin = value as Readonly<Record<string, unknown>>;
  assertKernelId(plugin.id, "id");
  assertKernelVersion(plugin.version, "version");
  if (plugin.description !== undefined) {
    if (
      typeof plugin.description !== "string" ||
      plugin.description.length > KERNEL_DESCRIPTION_MAX_LENGTH ||
      CONTROL.test(plugin.description)
    ) {
      throw identityInvalid("description");
    }
  }
  if (plugin.engineRange !== undefined) {
    assertKernelRange(plugin.engineRange, "engineRange");
  }
  if (plugin.provides !== undefined) {
    if (!Array.isArray(plugin.provides)) throw identityInvalid("provides");
    for (const token of plugin.provides) assertCapabilityToken(token, "provides");
  }
  if (plugin.requires !== undefined) {
    if (
      typeof plugin.requires !== "object" ||
      plugin.requires === null ||
      Array.isArray(plugin.requires)
    ) {
      throw identityInvalid("requires");
    }
    for (const [key, requirement] of Object.entries(plugin.requires)) {
      if (key.length > KERNEL_REQUIREMENT_KEY_MAX_LENGTH || !REQUIREMENT_KEY.test(key)) {
        throw identityInvalid("requirementKey");
      }
      assertRequirement(requirement as RequirementSpec, "requires");
    }
  }
  if (plugin.migrations !== undefined) {
    assertMigrations(plugin.migrations);
  }
}

export function assertCapabilityToken(
  value: unknown,
  field: string,
): asserts value is AnyCapabilityToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw identityInvalid(field);
  }
  const token = value as Readonly<Record<string, unknown>>;
  assertKernelId(token.id, `${field}.id`);
  assertKernelVersion(token.version, `${field}.version`);
}

export function kernelIdentityField(error: unknown): string {
  if (!(error instanceof PrismError)) return "plugin";
  const field = error.diagnostics[0]?.details?.field;
  return typeof field === "string" ? field : "plugin";
}

function assertRequirement(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw identityInvalid(field);
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if ("token" in candidate) {
    assertCapabilityToken(candidate.token, `${field}.token`);
    if (candidate.range !== undefined) assertKernelRange(candidate.range, `${field}.range`);
    if (candidate.optional !== undefined && typeof candidate.optional !== "boolean") {
      throw identityInvalid(`${field}.optional`);
    }
    return;
  }
  assertCapabilityToken(candidate, field);
}

function assertMigrations(value: unknown): void {
  if (!Array.isArray(value)) throw identityInvalid("migrations");
  const ids = new Set<string>();
  for (const migration of value) {
    if (typeof migration !== "object" || migration === null || Array.isArray(migration)) {
      throw identityInvalid("migrations");
    }
    const candidate = migration as Readonly<Record<string, unknown>>;
    assertKernelId(candidate.id, "migration.id");
    if (
      (candidate.id as string).length > KERNEL_MIGRATION_ID_MAX_LENGTH ||
      ids.has(candidate.id as string)
    ) {
      throw identityInvalid("migration.id");
    }
    ids.add(candidate.id as string);
    if (
      typeof candidate.checksum !== "string" ||
      !/^[0-9a-f]{64}$/u.test(candidate.checksum)
    ) {
      throw identityInvalid("migration.checksum");
    }
    if (
      candidate.risk !== "low" &&
      candidate.risk !== "medium" &&
      candidate.risk !== "high"
    ) {
      throw identityInvalid("migration.risk");
    }
    if (typeof candidate.requiresBackup !== "boolean") {
      throw identityInvalid("migration.requiresBackup");
    }
    if (
      !Array.isArray(candidate.externalEffects) ||
      candidate.externalEffects.length > KERNEL_MIGRATION_EXTERNAL_EFFECTS_MAX
    ) {
      throw identityInvalid("migration.externalEffects");
    }
    for (const effect of candidate.externalEffects) {
      if (
        typeof effect !== "string" ||
        effect.length < 1 ||
        effect.length > KERNEL_MIGRATION_EXTERNAL_EFFECT_MAX_LENGTH ||
        CONTROL.test(effect)
      ) {
        throw identityInvalid("migration.externalEffects");
      }
    }
    if (candidate.preflight !== undefined && typeof candidate.preflight !== "function") {
      throw identityInvalid("migration.preflight");
    }
    if (typeof candidate.up !== "function") throw identityInvalid("migration.up");
  }
}

function assertKernelRange(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > KERNEL_RANGE_MAX_LENGTH ||
    semver.validRange(value) === null
  ) {
    throw identityInvalid(field);
  }
}

function identityInvalid(field: string): PrismError {
  return PrismError.of(
    EngineDiagnosticCode.KERNEL_IDENTITY_INVALID,
    "Kernel identity metadata is invalid.",
    { field },
  );
}
