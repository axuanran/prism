import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

export interface LocalSecretPluginOptions {
  readonly providerId?: string;
  /** Logical secret key -> environment variable name. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Logical secret key -> explicitly approved absolute file path. */
  readonly files?: Readonly<Record<string, string>>;
  readonly maxFileBytes?: number;
  readonly maxValueBytes?: number;
}

class LocalSecretCapability implements SecretCapability {
  constructor(
    private readonly providerId: string,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly files: Readonly<Record<string, string>>,
    private readonly maxFileBytes: number,
    private readonly maxValueBytes: number,
  ) {}

  profile() {
    return Object.freeze({
      providerId: this.providerId,
      durability: "development" as const,
      external: false,
    });
  }
  async productionReadiness(_context: CallContext) {
    return {
      id: "secret-provider.production" as const,
      passed: false,
      evidence: JSON.stringify(this.profile()),
    };
  }

  async resolve(context: CallContext, ref: SecretRef): Promise<ResolvedSecret> {
    validateSecretRef(ref);
    if (context.signal?.aborted === true) {
      throw PrismError.of(
        "SECRET_RESOLUTION_CANCELLED",
        "Secret resolution was cancelled.",
      );
    }
    if (ref.provider !== this.providerId) {
      throw PrismError.of(
        "SECRET_PROVIDER_MISMATCH",
        "Secret reference targets a different provider.",
        { requestedProvider: ref.provider, providerId: this.providerId },
      );
    }
    if (ref.field !== undefined) {
      throw PrismError.of(
        "SECRET_FIELD_UNSUPPORTED",
        "Local scalar secrets do not support a field selector.",
        { provider: this.providerId, key: ref.key },
      );
    }
    const variable = this.environment[ref.key];
    if (variable !== undefined) {
      const value = process.env[variable];
      if (value === undefined) {
        throw PrismError.of(
          "SECRET_UNAVAILABLE",
          "Configured environment secret is unavailable.",
          { provider: this.providerId, key: ref.key },
        );
      }
      if (Buffer.byteLength(value, "utf8") > this.maxValueBytes) {
        throw PrismError.of(
          "SECRET_VALUE_INVALID",
          "Configured environment secret exceeds the size limit.",
        );
      }
      return Object.freeze({ value, ...(ref.version ? { version: ref.version } : {}) });
    }
    const path = this.files[ref.key];
    if (path !== undefined) {
      const value = await readLocalSecretFile(path, this.maxFileBytes);
      return Object.freeze({ value, ...(ref.version ? { version: ref.version } : {}) });
    }
    throw PrismError.of(
      "SECRET_REF_UNKNOWN",
      "Secret reference is not present in the provider allowlist.",
      { provider: this.providerId, key: ref.key },
    );
  }
}

export const LOCAL_SECRET_DEFAULT_MAX_BYTES = 65_536;
export const LOCAL_SECRET_ENVIRONMENT_NAME_MAX_LENGTH = 256;
export const LOCAL_SECRET_FILE_PATH_MAX_LENGTH = 1_024;
const LOCAL_SECRET_CONTROL = /[\u0000-\u001f\u007f]/u;
const LOCAL_SECRET_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

async function readLocalSecretFile(path: string, maximum: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > maximum
    ) {
      throw new Error("invalid local secret file");
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
      throw new Error("local secret file changed");
    }
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer.subarray(0, bytesRead))
      .replace(/\r?\n$/u, "");
  } catch {
    throw PrismError.of(
      "SECRET_FILE_INVALID",
      "Configured secret file is invalid or exceeds the size limit.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function localSecretPlugin(options: LocalSecretPluginOptions = {}) {
  const providerId = options.providerId ?? "local";
  validateSecretProviderId(providerId);
  for (const key of Object.keys(options.environment ?? {})) {
    validateSecretRef({ provider: providerId, key });
  }
  for (const variable of Object.values(options.environment ?? {})) {
    if (
      variable.length > LOCAL_SECRET_ENVIRONMENT_NAME_MAX_LENGTH ||
      !LOCAL_SECRET_ENVIRONMENT_NAME.test(variable)
    ) {
      throw PrismError.of(
        "SECRET_CONFIGURATION_INVALID",
        "Local Secret environment allowlist is invalid.",
      );
    }
  }
  for (const key of Object.keys(options.files ?? {})) {
    validateSecretRef({ provider: providerId, key });
  }
  for (const path of Object.values(options.files ?? {})) {
    if (
      path.length > LOCAL_SECRET_FILE_PATH_MAX_LENGTH ||
      !isAbsolute(path) ||
      LOCAL_SECRET_CONTROL.test(path)
    ) {
      throw PrismError.of(
        "SECRET_CONFIGURATION_INVALID",
        "Local Secret file allowlist is invalid.",
      );
    }
  }
  const environment = Object.freeze({ ...(options.environment ?? {}) });
  const files = Object.freeze({ ...(options.files ?? {}) });
  const maxFileBytes = options.maxFileBytes ?? LOCAL_SECRET_DEFAULT_MAX_BYTES;
  const maxValueBytes = options.maxValueBytes ?? LOCAL_SECRET_DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    !Number.isSafeInteger(maxValueBytes) ||
    maxValueBytes < 1
  ) {
    throw PrismError.of(
      "SECRET_CONFIGURATION_INVALID",
      "Local Secret byte limits must be positive safe integers.",
    );
  }
  return definePlugin({
    id: "secret.local",
    version: "0.1.20",
    engineRange: "^0.1.20",
    provides: [SecretCapabilityToken],
    register(context) {
      context.provide(
        SecretCapabilityToken,
        new LocalSecretCapability(
          providerId,
          environment,
          files,
          maxFileBytes,
          maxValueBytes,
        ),
      );
    },
  });
}
