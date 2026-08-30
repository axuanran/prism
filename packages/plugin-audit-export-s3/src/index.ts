import { createHash } from "node:crypto";
import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import {
  AuditExportCapabilityToken,
  StorageCapabilityToken,
  type AuditExportCapability,
  type AuditExportResult,
  type AuditRecord,
  type StorageCapability,
} from "@prismengine/contracts-storage";
import { definePlugin } from "@prismengine/kernel";

export interface AuditWormClient {
  putImmutable(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly checksumSha256: string;
    readonly retainUntil: Date;
    readonly signal?: AbortSignal;
  }): Promise<"created" | "exists">;
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
    readonly maxBytes: number;
  }): Promise<Uint8Array>;
  bucketVersioning(input: {
    readonly bucket: string;
    readonly signal?: AbortSignal;
  }): Promise<string | undefined>;
  objectLockEnabled(input: {
    readonly bucket: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
}

export interface S3AuditExportOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly retentionDays: number;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly client?: AuditWormClient;
  readonly aws?: S3ClientConfig;
}

export function s3AuditExportPlugin(options: S3AuditExportOptions) {
  return definePlugin({
    id: "storage.audit-export.s3",
    version: "0.1.20",
    engineRange: "^0.1.20",
    requires: { storage: StorageCapabilityToken },
    provides: [AuditExportCapabilityToken],
    register(context) {
      context.provide(
        AuditExportCapabilityToken,
        new S3AuditExportCapability(context.dependencies.storage, options),
      );
    },
  });
}

export class S3AuditExportCapability implements AuditExportCapability {
  private readonly client: AuditWormClient;
  private readonly prefix: string;

  constructor(
    private readonly storage: StorageCapability,
    private readonly options: S3AuditExportOptions,
  ) {
    if (!options.bucket.trim()) {
      throw PrismError.of(
        "AUDIT_EXPORT_BUCKET_INVALID",
        "Audit export bucket is required.",
      );
    }
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw PrismError.of(
        "AUDIT_EXPORT_RETENTION_INVALID",
        "Audit export retentionDays must be a positive integer.",
      );
    }
    this.prefix = auditPrefix(options.prefix ?? "audit");
    this.client =
      options.client ??
      new AwsAuditWormClient(
        new S3Client({
          region: options.region,
          endpoint: options.endpoint,
          forcePathStyle: options.forcePathStyle,
          ...options.aws,
        }),
      );
  }

  async exportRange(
    context: CallContext,
    afterSequence = 0,
    limit = 1_000,
  ): Promise<AuditExportResult> {
    this.validateRange(afterSequence, limit);
    await this.assertSource(context);
    const records = await this.records(context, afterSequence, limit);
    let exported = 0;
    let verified = 0;
    const retainUntil = new Date(Date.now() + this.options.retentionDays * 86_400_000);
    for (const record of records) {
      const body = serialize(record);
      const result = await this.client.putImmutable({
        bucket: this.options.bucket,
        key: this.key(record),
        body,
        checksumSha256: checksum(body),
        retainUntil,
        signal: context.signal,
      });
      if (result === "created") exported += 1;
      await this.assertRemote(context, record, body);
      verified += 1;
    }
    return {
      exported,
      verified,
      lastSequence: records.at(-1)?.sequence ?? afterSequence,
    };
  }

  async verifyRange(
    context: CallContext,
    afterSequence = 0,
    limit = 1_000,
  ): Promise<AuditExportResult> {
    this.validateRange(afterSequence, limit);
    await this.assertSource(context);
    const records = await this.records(context, afterSequence, limit);
    for (const record of records) {
      await this.assertRemote(context, record, serialize(record));
    }
    return {
      exported: 0,
      verified: records.length,
      lastSequence: records.at(-1)?.sequence ?? afterSequence,
    };
  }

  async productionReadiness(context: CallContext) {
    try {
      const [versioning, objectLock] = await Promise.all([
        this.client.bucketVersioning({
          bucket: this.options.bucket,
          signal: context.signal,
        }),
        this.client.objectLockEnabled({
          bucket: this.options.bucket,
          signal: context.signal,
        }),
      ]);
      const passed = versioning === "Enabled" && objectLock;
      return {
        id: "audit-worm-export" as const,
        passed,
        evidence: JSON.stringify({
          provider: "storage.audit-export.s3",
          bucketVersioning: versioning ?? "Disabled",
          objectLock,
          retentionDays: this.options.retentionDays,
        }),
      };
    } catch (error) {
      return {
        id: "audit-worm-export" as const,
        passed: false,
        evidence: JSON.stringify({
          provider: "storage.audit-export.s3",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      };
    }
  }

  private async assertSource(context: CallContext): Promise<void> {
    const verification = await this.storage.audit.verify(context);
    if (verification.valid) return;
    throw PrismError.of(
      "AUDIT_EXPORT_SOURCE_INVALID",
      "Durable audit journal failed integrity verification.",
      {
        checked: verification.checked,
        ...(verification.brokenAtSequence === undefined
          ? {}
          : { brokenAtSequence: verification.brokenAtSequence }),
      },
    );
  }

  private records(
    context: CallContext,
    afterSequence: number,
    limit: number,
  ): Promise<readonly AuditRecord[]> {
    return this.storage.audit.list(context, { afterSequence, limit });
  }

  private validateRange(afterSequence: number, limit: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw invalidRange("afterSequence");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw invalidRange("limit");
    }
  }

  private key(record: AuditRecord): string {
    return `${this.prefix}/${String(record.sequence).padStart(20, "0")}-${record.entryHash}.json`;
  }

  private async assertRemote(
    context: CallContext,
    record: AuditRecord,
    expected: Uint8Array,
  ): Promise<void> {
    const actual = await this.client.getObject({
      bucket: this.options.bucket,
      key: this.key(record),
      signal: context.signal,
      maxBytes: expected.byteLength,
    });
    if (!Buffer.from(actual).equals(Buffer.from(expected))) {
      throw PrismError.of(
        "AUDIT_EXPORT_MISMATCH",
        "Exported audit record does not match the durable journal.",
        { sequence: record.sequence, entryHash: record.entryHash },
      );
    }
  }
}

class AwsAuditWormClient implements AuditWormClient {
  constructor(private readonly client: S3Client) {}

  async putImmutable(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly checksumSha256: string;
    readonly retainUntil: Date;
    readonly signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: "application/json",
          ChecksumSHA256: input.checksumSha256,
          IfNoneMatch: "*",
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: input.retainUntil,
        }),
        { abortSignal: input.signal },
      );
      return "created";
    } catch (error) {
      if (httpStatus(error) === 412) return "exists";
      throw error;
    }
  }

  async getObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
    readonly maxBytes: number;
  }): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
      { abortSignal: input.signal },
    );
    if (response.Body === undefined) throw auditObjectSizeMismatch(input.maxBytes);
    return readBoundedAuditBody(response.Body, {
      maxBytes: input.maxBytes,
      ...(response.ContentLength === undefined
        ? {}
        : { declaredBytes: response.ContentLength }),
    });
  }

  async bucketVersioning(input: {
    readonly bucket: string;
    readonly signal?: AbortSignal;
  }): Promise<string | undefined> {
    const response = await this.client.send(
      new GetBucketVersioningCommand({
        Bucket: input.bucket,
      }),
      { abortSignal: input.signal },
    );
    return response.Status;
  }

  async objectLockEnabled(input: {
    readonly bucket: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    const response = await this.client.send(
      new GetObjectLockConfigurationCommand({
        Bucket: input.bucket,
      }),
      { abortSignal: input.signal },
    );
    return response.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
  }
}

export async function readBoundedAuditBody(
  body: unknown,
  options: {
    readonly maxBytes: number;
    readonly declaredBytes?: number;
  },
): Promise<Uint8Array> {
  const maxBytes = auditByteCount(options.maxBytes);
  const declaredBytes =
    options.declaredBytes === undefined ? undefined : auditByteCount(options.declaredBytes);
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throw auditObjectSizeMismatch(maxBytes, undefined, declaredBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (chunk: Uint8Array): boolean => {
    total += chunk.byteLength;
    if (total > maxBytes) return false;
    chunks.push(chunk);
    return true;
  };
  const transformed =
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
      ? body.transformToWebStream()
      : body;

  if (transformed instanceof Uint8Array) {
    if (!append(transformed)) {
      throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
    }
  } else if (isWebAuditBody(transformed)) {
    const reader = transformed.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!append(result.value)) {
          await reader.cancel().catch(() => undefined);
          throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
        }
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The sanitized bounded-read result remains authoritative.
      }
    }
  } else if (isAsyncAuditBody(transformed)) {
    try {
      for await (const chunk of transformed) {
        if (!(chunk instanceof Uint8Array)) {
          throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
        }
        if (!append(chunk)) {
          destroyAuditBody(transformed);
          throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
        }
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
    }
  } else {
    throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
  }

  if (declaredBytes !== undefined && declaredBytes !== total) {
    throw auditObjectSizeMismatch(maxBytes, total, declaredBytes);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWebAuditBody(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function isAsyncAuditBody(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function destroyAuditBody(value: object): void {
  if ("destroy" in value && typeof value.destroy === "function") {
    try {
      value.destroy();
    } catch {
      // The sanitized bounded-read result remains authoritative.
    }
  }
}

function auditByteCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw auditObjectSizeMismatch(0);
  return value;
}

function auditObjectSizeMismatch(
  maxBytes: number,
  actualBytes?: number,
  declaredBytes?: number,
): PrismError {
  return PrismError.of(
    "AUDIT_EXPORT_OBJECT_SIZE_MISMATCH",
    "S3 audit object exceeded or did not match its bounded size.",
    {
      maxBytes,
      ...(actualBytes === undefined ? {} : { actualBytes }),
      ...(declaredBytes === undefined ? {} : { declaredBytes }),
    },
  );
}

function invalidRange(field: string): PrismError {
  return PrismError.of("AUDIT_EXPORT_RANGE_INVALID", "Audit export range is invalid.", {
    field,
  });
}

function serialize(record: AuditRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64");
}

function auditPrefix(value: string): string {
  const prefix = value.normalize("NFC").replace(/^\/+|\/+$/gu, "");
  if (
    !prefix ||
    prefix.includes("\\") ||
    prefix.includes("\u0000") ||
    prefix.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw PrismError.of("AUDIT_EXPORT_PREFIX_INVALID", "Audit export prefix is invalid.");
  }
  return prefix;
}

function httpStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }
  return undefined;
}
