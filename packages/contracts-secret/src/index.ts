import { PrismError, type CallContext } from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";

/** Persistable reference only. Secret values must never enter Resource specs or diagnostics. */
export interface SecretRef {
  readonly provider: string;
  readonly key: string;
  readonly version?: string;
  /** Field inside a structured provider value, e.g. Vault KV v2 data. */
  readonly field?: string;
}

export const SECRET_PROVIDER_MAX_LENGTH = 64;
export const SECRET_KEY_MAX_LENGTH = 512;
export const SECRET_VERSION_MAX_LENGTH = 128;
export const SECRET_FIELD_MAX_LENGTH = 128;
const SECRET_CONTROL = /[\u0000-\u001f\u007f]/u;
const SECRET_PROVIDER = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u;

export function validateSecretProviderId(provider: string): void {
  if (typeof provider !== "string") throw invalidSecretRef();
  if (
    provider.length < 1 ||
    provider.length > SECRET_PROVIDER_MAX_LENGTH ||
    !SECRET_PROVIDER.test(provider)
  ) {
    throw invalidSecretRef();
  }
}

export function validateSecretRef(ref: SecretRef): void {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    throw invalidSecretRef();
  }
  if (
    typeof ref.provider !== "string" ||
    typeof ref.key !== "string" ||
    (ref.version !== undefined && typeof ref.version !== "string") ||
    (ref.field !== undefined && typeof ref.field !== "string")
  ) {
    throw invalidSecretRef();
  }
  validateSecretProviderId(ref.provider);
  if (!boundedSecretText(ref.key, SECRET_KEY_MAX_LENGTH)) throw invalidSecretRef();
  if (
    ref.version !== undefined &&
    !boundedSecretText(ref.version, SECRET_VERSION_MAX_LENGTH)
  ) {
    throw invalidSecretRef();
  }
  if (ref.field !== undefined && !boundedSecretText(ref.field, SECRET_FIELD_MAX_LENGTH)) {
    throw invalidSecretRef();
  }
}

function boundedSecretText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !SECRET_CONTROL.test(value);
}

function invalidSecretRef(): PrismError {
  return PrismError.of("SECRET_REF_INVALID", "Secret reference is invalid.");
}

export interface ResolvedSecret {
  readonly value: string;
  readonly version?: string;
  readonly expiresAt?: string;
}

export interface SecretCapability {
  profile(): {
    readonly providerId: string;
    readonly durability: "development" | "production";
    readonly external: boolean;
  };
  productionReadiness(context: CallContext): Promise<{
    readonly id: "secret-provider.production";
    readonly passed: boolean;
    readonly evidence?: string;
  }>;
  resolve(context: CallContext, ref: SecretRef): Promise<ResolvedSecret>;
}

export const SecretCapabilityToken = defineCapability<SecretCapability>({
  id: "secret",
  version: "1.0.0",
});
