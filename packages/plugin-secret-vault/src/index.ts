import { open, stat } from "node:fs/promises";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import {
  SecretCapabilityToken,
  validateSecretProviderId,
  validateSecretRef,
  type ResolvedSecret,
  type SecretCapability,
  type SecretRef,
} from "@prismengine/contracts-secret";
import { definePlugin } from "@prismengine/kernel";

export type VaultAuthentication =
  | {
      readonly kind: "token";
      readonly resolveToken: (context: CallContext) => string | Promise<string>;
    }
  | {
      readonly kind: "kubernetes";
      readonly role: string;
      readonly jwtPath?: string;
      readonly mount?: string;
    };

export interface VaultSecretPluginOptions {
  readonly address: string;
  readonly mount?: string;
  readonly namespace?: string;
  readonly providerId?: string;
  readonly authentication: VaultAuthentication;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface VaultReadinessEvidence {
  readonly id: "secret-provider.production";
  readonly passed: boolean;
  readonly evidence?: string;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}
export const VAULT_TOKEN_MAX_BYTES = 16 * 1_024;
export const VAULT_KUBERNETES_JWT_MAX_BYTES = 64 * 1_024;
export const VAULT_ROLE_MAX_LENGTH = 128;
export const VAULT_AUTH_MOUNT_MAX_LENGTH = 64;
export const VAULT_NAMESPACE_MAX_LENGTH = 256;
export const VAULT_JWT_PATH_MAX_LENGTH = 1_024;
const VAULT_CONTROL = /[\u0000-\u001f\u007f]/u;

export function vaultSecretPlugin(options: VaultSecretPluginOptions) {
  return definePlugin({
    id: "secret.vault",
    version: "0.1.20",
    engineRange: "^0.1.20",
    provides: [SecretCapabilityToken],
    register(context) {
      context.provide(SecretCapabilityToken, new VaultSecretCapability(options));
    },
  });
}

export class VaultSecretCapability implements SecretCapability {
  private readonly address: string;
  private readonly mount: string;
  private readonly providerId: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private cachedToken: CachedToken | undefined;
  private loginInFlight: Promise<CachedToken> | undefined;

  constructor(private readonly options: VaultSecretPluginOptions) {
    const address = new URL(options.address);
    if (address.protocol !== "https:" && options.allowInsecureHttp !== true) {
      throw PrismError.of(
        "VAULT_TLS_REQUIRED",
        "Vault production provider requires an HTTPS address.",
      );
    }
    this.address = address.toString().replace(/\/$/u, "");
    this.mount = segment(options.mount ?? "secret", "mount", VAULT_AUTH_MOUNT_MAX_LENGTH);
    this.providerId = options.providerId ?? "vault";
    validateSecretProviderId(this.providerId);
    if (
      options.namespace !== undefined &&
      !boundedConfiguration(options.namespace, VAULT_NAMESPACE_MAX_LENGTH)
    ) {
      throw invalidVaultConfiguration();
    }
    if (options.authentication.kind === "kubernetes") {
      if (!boundedConfiguration(options.authentication.role, VAULT_ROLE_MAX_LENGTH)) {
        throw invalidVaultConfiguration();
      }
      segment(
        options.authentication.mount ?? "kubernetes",
        "auth mount",
        VAULT_AUTH_MOUNT_MAX_LENGTH,
      );
      if (
        options.authentication.jwtPath !== undefined &&
        !boundedConfiguration(options.authentication.jwtPath, VAULT_JWT_PATH_MAX_LENGTH)
      ) {
        throw invalidVaultConfiguration();
      }
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positiveMilliseconds(options.requestTimeoutMs ?? 10_000);
    this.maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes ?? 1_048_576,
      "maxResponseBytes",
    );
  }

  profile() {
    return Object.freeze({
      providerId: "secret.vault",
      durability: "production" as const,
      external: true,
    });
  }

  async resolve(context: CallContext, ref: SecretRef): Promise<ResolvedSecret> {
    validateSecretRef(ref);
    if (ref.provider !== this.providerId) {
      throw PrismError.of(
        "SECRET_PROVIDER_MISMATCH",
        "Secret reference targets a different provider.",
        { requestedProvider: ref.provider, providerId: this.providerId },
      );
    }
    const path = secretPath(ref.key);
    if (ref.version !== undefined && !/^[1-9]\d*$/u.test(ref.version)) {
      throw PrismError.of(
        "SECRET_VERSION_INVALID",
        "Vault KV v2 version must be a positive integer.",
        { provider: this.providerId, key: ref.key },
      );
    }
    let token = await this.token(context);
    const query =
      ref.version === undefined ? "" : `?version=${encodeURIComponent(ref.version)}`;
    const url = `${this.address}/v1/${encodeURIComponent(this.mount)}/data/${path}${query}`;
    let response = await this.request(context, url, {
      method: "GET",
      headers: this.headers(token),
    });
    if (
      this.options.authentication.kind === "kubernetes" &&
      (response.status === 401 || response.status === 403)
    ) {
      this.invalidateToken(token);
      token = await this.token(context);
      response = await this.request(context, url, {
        method: "GET",
        headers: this.headers(token),
      });
    }
    if (response.status === 404) {
      throw PrismError.of("SECRET_REF_UNKNOWN", "Vault secret reference was not found.", {
        provider: this.providerId,
        key: ref.key,
      });
    }
    if (!response.ok) {
      throw PrismError.of("SECRET_UNAVAILABLE", "Vault secret could not be resolved.", {
        provider: this.providerId,
        key: ref.key,
        status: response.status,
      });
    }
    const value = await this.json(response);
    const parsed = vaultSecret(value);
    const field = ref.field ?? "value";
    const secret = parsed.data[field];
    if (typeof secret !== "string") {
      throw PrismError.of(
        "SECRET_FIELD_UNAVAILABLE",
        "Vault secret field is unavailable or is not a string.",
        { provider: this.providerId, key: ref.key, field },
      );
    }
    return Object.freeze({ value: secret, version: String(parsed.version) });
  }

  async productionReadiness(context: CallContext): Promise<VaultReadinessEvidence> {
    try {
      const health = await this.request(context, `${this.address}/v1/sys/health`, {
        method: "GET",
      });
      const healthValue = await this.json(health);
      if (!vaultHealth(healthValue) || !healthValue.initialized || healthValue.sealed) {
        return {
          id: "secret-provider.production",
          passed: false,
          evidence: JSON.stringify({ provider: "secret.vault", initialized: false }),
        };
      }
      const token = await this.token(context);
      const lookup = await this.request(
        context,
        `${this.address}/v1/auth/token/lookup-self`,
        {
          method: "GET",
          headers: this.headers(token),
        },
      );
      return {
        id: "secret-provider.production",
        passed: lookup.ok,
        evidence: JSON.stringify({
          provider: "secret.vault",
          initialized: true,
          sealed: false,
          tokenLookup: lookup.status,
          tls: this.address.startsWith("https://"),
        }),
      };
    } catch (error) {
      return {
        id: "secret-provider.production",
        passed: false,
        evidence: JSON.stringify({
          provider: "secret.vault",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      };
    }
  }

  private async token(context: CallContext): Promise<string> {
    if (this.options.authentication.kind === "token") {
      const token = await this.options.authentication.resolveToken(context);
      return validVaultToken(token);
    }
    if (
      this.cachedToken !== undefined &&
      this.cachedToken.expiresAt > Date.now() + 30_000
    ) {
      return this.cachedToken.value;
    }
    const pending = this.loginInFlight ?? this.authenticateKubernetes(context);
    this.loginInFlight = pending;
    try {
      const token = await pending;
      this.cachedToken = token;
      return token.value;
    } finally {
      if (this.loginInFlight === pending) this.loginInFlight = undefined;
    }
  }

  private async authenticateKubernetes(context: CallContext): Promise<CachedToken> {
    const authentication = this.options.authentication;
    if (authentication.kind !== "kubernetes") {
      throw PrismError.of(
        "VAULT_AUTHENTICATION_FAILED",
        "Vault Kubernetes authentication is unavailable.",
      );
    }
    const jwt = await readKubernetesJwt(
      authentication.jwtPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );
    const mount = segment(
      authentication.mount ?? "kubernetes",
      "auth mount",
      VAULT_AUTH_MOUNT_MAX_LENGTH,
    );
    const response = await this.request(
      context,
      `${this.address}/v1/auth/${encodeURIComponent(mount)}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: authentication.role, jwt }),
      },
      "VAULT_AUTHENTICATION_FAILED",
    );
    if (!response.ok) {
      throw PrismError.of(
        "VAULT_AUTHENTICATION_FAILED",
        "Vault Kubernetes authentication failed.",
        { status: response.status },
      );
    }
    const value = await this.json(response);
    const auth = vaultAuth(value);
    return {
      value: validVaultToken(auth.token),
      expiresAt: Date.now() + Math.max(1, auth.leaseDuration) * 1_000,
    };
  }

  private invalidateToken(token: string): void {
    if (this.cachedToken?.value === token) this.cachedToken = undefined;
  }

  private headers(token: string): Record<string, string> {
    return {
      "x-vault-token": token,
      ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {}),
    };
  }

  private async json(response: Response): Promise<unknown> {
    const declaredValue = response.headers.get("content-length");
    let declared: number | undefined;
    if (declaredValue !== null) {
      if (!/^\d+$/u.test(declaredValue)) throw invalidVaultResponse();
      declared = Number(declaredValue);
      if (!Number.isSafeInteger(declared) || declared > this.maxResponseBytes) {
        throw invalidVaultResponse();
      }
    }
    const body = response.body;
    if (body === null) throw invalidVaultResponse();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw invalidVaultResponse();
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw invalidVaultResponse();
    } finally {
      reader.releaseLock();
    }
    if (declared !== undefined && declared !== total) throw invalidVaultResponse();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw invalidVaultResponse();
    }
  }

  private async request(
    context: CallContext,
    url: string,
    init: RequestInit,
    failureCode:
      "SECRET_UNAVAILABLE" | "VAULT_AUTHENTICATION_FAILED" = "SECRET_UNAVAILABLE",
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
    try {
      return await this.fetcher(url, { ...init, signal });
    } catch {
      context.signal?.throwIfAborted();
      throw PrismError.of(
        failureCode,
        failureCode === "VAULT_AUTHENTICATION_FAILED"
          ? "Vault Kubernetes authentication failed."
          : "Vault secret provider is unavailable.",
      );
    }
  }
}

async function readKubernetesJwt(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 1 ||
      before.size > VAULT_KUBERNETES_JWT_MAX_BYTES
    ) {
      throw new Error("invalid service-account token file");
    }
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const after = await handle.stat();
    const current = await stat(path);
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      !after.isFile() ||
      !current.isFile() ||
      current.size !== before.size ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    ) {
      throw new Error("service-account token file changed");
    }
    return validAuthenticationText(
      buffer.subarray(0, bytesRead).toString("utf8").trim(),
      VAULT_KUBERNETES_JWT_MAX_BYTES,
    );
  } catch {
    throw PrismError.of(
      "VAULT_AUTHENTICATION_FAILED",
      "Vault Kubernetes service-account token is unavailable.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validVaultToken(value: unknown): string {
  if (typeof value !== "string") {
    throw PrismError.of("VAULT_AUTHENTICATION_FAILED", "Vault token is unavailable.");
  }
  try {
    return validAuthenticationText(value, VAULT_TOKEN_MAX_BYTES);
  } catch {
    throw PrismError.of("VAULT_AUTHENTICATION_FAILED", "Vault token is unavailable.");
  }
}

function validAuthenticationText(value: string, maximumBytes: number): string {
  if (
    value.length < 1 ||
    VAULT_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error("invalid authentication text");
  }
  return value;
}

function boundedConfiguration(value: string, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !VAULT_CONTROL.test(value)
  );
}

function invalidVaultConfiguration(): PrismError {
  return PrismError.of(
    "VAULT_CONFIGURATION_INVALID",
    "Vault authentication configuration is invalid.",
  );
}

function segment(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !boundedConfiguration(value, maximum) ||
    value.includes("/") ||
    value.includes("..")
  ) {
    throw PrismError.of("VAULT_CONFIGURATION_INVALID", `Vault ${label} is invalid.`);
  }
  return value;
}

function secretPath(value: string): string {
  const parts = value.normalize("NFC").split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\u0000"))
  ) {
    throw PrismError.of("SECRET_REF_INVALID", "Vault secret key is invalid.");
  }
  return parts.map(encodeURIComponent).join("/");
}

function vaultSecret(value: unknown): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly version: number;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    typeof value.data !== "object" ||
    value.data === null ||
    !("data" in value.data) ||
    typeof value.data.data !== "object" ||
    value.data.data === null ||
    Array.isArray(value.data.data) ||
    !("metadata" in value.data) ||
    typeof value.data.metadata !== "object" ||
    value.data.metadata === null ||
    !("version" in value.data.metadata) ||
    typeof value.data.metadata.version !== "number"
  ) {
    throw PrismError.of("VAULT_RESPONSE_INVALID", "Vault KV v2 response is malformed.");
  }
  return {
    data: Object.fromEntries(Object.entries(value.data.data)),
    version: value.data.metadata.version,
  };
}

function vaultAuth(value: unknown): {
  readonly token: string;
  readonly leaseDuration: number;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("auth" in value) ||
    typeof value.auth !== "object" ||
    value.auth === null ||
    !("client_token" in value.auth) ||
    typeof value.auth.client_token !== "string" ||
    !("lease_duration" in value.auth) ||
    typeof value.auth.lease_duration !== "number"
  ) {
    throw PrismError.of("VAULT_RESPONSE_INVALID", "Vault auth response is malformed.");
  }
  return { token: value.auth.client_token, leaseDuration: value.auth.lease_duration };
}

function vaultHealth(
  value: unknown,
): value is { readonly initialized: boolean; readonly sealed: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "initialized" in value &&
    typeof value.initialized === "boolean" &&
    "sealed" in value &&
    typeof value.sealed === "boolean"
  );
}

function invalidVaultResponse(): PrismError {
  return PrismError.of("VAULT_RESPONSE_INVALID", "Vault response is malformed.");
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw PrismError.of(
      "VAULT_CONFIGURATION_INVALID",
      `Vault ${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function positiveMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw PrismError.of(
      "VAULT_CONFIGURATION_INVALID",
      "Vault requestTimeoutMs must be a positive finite number.",
    );
  }
  return value;
}
