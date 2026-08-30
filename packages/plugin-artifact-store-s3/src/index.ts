import { createHash, timingSafeEqual } from "node:crypto";
import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  ArtifactStoreCapabilityToken,
  artifactManifestObjectKey,
  artifactObjectKey,
  artifactRef,
  artifactStat,
  canonicalArtifactFiles,
  hashArtifact,
  normalizeArtifactPath,
  parseArtifactManifest,
  serializeArtifactManifest,
  type ArtifactRef,
  type ArtifactStat,
  type ArtifactStoreCapability,
  type ArtifactWrite,
} from "@prismengine/contracts-artifact";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import { definePlugin } from "@prismengine/kernel";

export interface S3ArtifactClient {
  headObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
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

export interface S3ArtifactStoreOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly retentionDays: number;
  readonly maxManifestBytes?: number;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly client?: S3ArtifactClient;
  readonly aws?: S3ClientConfig;
}

export interface ProductionReadinessEvidence {
  readonly id: "artifact-store.production";
  readonly passed: boolean;
  readonly evidence?: string;
}

export function s3ArtifactStorePlugin(options: S3ArtifactStoreOptions) {
  return definePlugin({
    id: "artifact.store.s3",
    version: "0.1.20",
    engineRange: "^0.1.20",
    provides: [ArtifactStoreCapabilityToken],
    register(context) {
      context.provide(ArtifactStoreCapabilityToken, new S3ArtifactStore(options));
    },
  });
}

export class S3ArtifactStore implements ArtifactStoreCapability {
  private readonly client: S3ArtifactClient;
  private readonly prefix: string;
  private readonly maxManifestBytes: number;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    if (!options.bucket.trim()) {
      throw PrismError.of("ARTIFACT_S3_BUCKET_INVALID", "S3 Artifact bucket is required.");
    }
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw PrismError.of(
        "ARTIFACT_S3_RETENTION_INVALID",
        "S3 Artifact retentionDays must be a positive integer.",
      );
    }
    this.maxManifestBytes = positiveSafeInteger(
      options.maxManifestBytes ?? 1_048_576,
      "maxManifestBytes",
    );
    this.prefix = options.prefix?.replace(/^\/+|\/+$/gu, "") ?? "";
    this.client =
      options.client ??
      new AwsS3ArtifactClient(
        new S3Client({
          region: options.region,
          endpoint: options.endpoint,
          forcePathStyle: options.forcePathStyle,
          ...options.aws,
        }),
      );
  }

  profile() {
    return Object.freeze({
      providerId: "artifact.store.s3",
      durability: "production" as const,
      immutable: true,
      external: true,
    });
  }

  async putImmutable(context: CallContext, input: ArtifactWrite): Promise<ArtifactRef> {
    const files = canonicalArtifactFiles(input);
    const ref = artifactRef(input.contentType, files);
    const manifestKey = artifactManifestObjectKey(ref.hash, this.prefix);
    if (
      await this.client.headObject({
        bucket: this.options.bucket,
        key: manifestKey,
        signal: context.signal,
      })
    ) {
      if (!(await this.verify(context, ref))) throw corrupt(ref.hash);
      return ref;
    }
    const retainUntil = new Date(Date.now() + this.options.retentionDays * 86_400_000);
    for (const file of files) {
      const key = artifactObjectKey(ref.hash, file.path, this.prefix);
      const result = await this.client.putObject({
        bucket: this.options.bucket,
        key,
        body: file.content,
        contentType: "application/octet-stream",
        checksumSha256: checksum(file.content),
        retainUntil,
        signal: context.signal,
      });
      if (result === "exists") {
        const existing = await this.client.getObject({
          bucket: this.options.bucket,
          key,
          maxBytes: file.content.byteLength,
          signal: context.signal,
        });
        if (!sameBytes(existing, file.content)) {
          throw PrismError.of(
            "ARTIFACT_IMMUTABLE_CONFLICT",
            "Existing immutable Artifact file does not match canonical content.",
            { hash: ref.hash, path: file.path },
          );
        }
      }
    }
    const manifest = serializeArtifactManifest(artifactStat(ref, files));
    if (manifest.byteLength > this.maxManifestBytes) {
      throw objectSizeMismatch(this.maxManifestBytes, manifest.byteLength);
    }
    await this.client.putObject({
      bucket: this.options.bucket,
      key: manifestKey,
      body: manifest,
      contentType: "application/json",
      checksumSha256: checksum(manifest),
      retainUntil,
      signal: context.signal,
    });
    if (!(await this.verify(context, ref))) throw corrupt(ref.hash);
    return ref;
  }

  async exists(context: CallContext, ref: ArtifactRef): Promise<boolean> {
    try {
      await this.stat(context, ref);
      return true;
    } catch {
      return false;
    }
  }

  async stat(context: CallContext, ref: ArtifactRef): Promise<ArtifactStat> {
    try {
      const bytes = await this.client.getObject({
        bucket: this.options.bucket,
        key: artifactManifestObjectKey(ref.hash, this.prefix),
        signal: context.signal,
        maxBytes: this.maxManifestBytes,
      });
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return parseArtifactManifest(value, ref);
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw PrismError.of("ARTIFACT_NOT_FOUND", `Artifact ${ref.hash} does not exist.`, {
        hash: ref.hash,
      });
    }
  }

  async read(context: CallContext, ref: ArtifactRef, path: string): Promise<Uint8Array> {
    const safe = normalizeArtifactPath(path);
    const metadata = await this.stat(context, ref);
    const declared = metadata.files.find((file) => file.path === safe);
    if (declared === undefined) throw fileNotFound(ref.hash, safe);
    let content: Uint8Array;
    try {
      content = await this.client.getObject({
        bucket: this.options.bucket,
        key: artifactObjectKey(ref.hash, safe, this.prefix),
        signal: context.signal,
        maxBytes: declared.size,
      });
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw fileNotFound(ref.hash, safe);
    }
    if (content.byteLength !== declared.size) {
      throw PrismError.of(
        "ARTIFACT_FILE_SIZE_MISMATCH",
        `Artifact ${ref.hash} file ${safe} does not match its manifest size.`,
        {
          hash: ref.hash,
          path: safe,
          expectedSize: declared.size,
          actualSize: content.byteLength,
        },
      );
    }
    return content;
  }

  async verify(context: CallContext, ref: ArtifactRef): Promise<boolean> {
    try {
      const metadata = await this.stat(context, ref);
      const files = await Promise.all(
        metadata.files.map(async (file) => ({
          path: file.path,
          content: await this.client.getObject({
            bucket: this.options.bucket,
            key: artifactObjectKey(ref.hash, file.path, this.prefix),
            signal: context.signal,
            maxBytes: file.size,
          }),
        })),
      );
      return hashArtifact(ref.contentType, files) === ref.hash;
    } catch {
      return false;
    }
  }

  async productionReadiness(context: CallContext): Promise<ProductionReadinessEvidence> {
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
        id: "artifact-store.production",
        passed,
        evidence: JSON.stringify({
          provider: "artifact.store.s3",
          bucketVersioning: versioning ?? "Disabled",
          objectLock,
          retentionDays: this.options.retentionDays,
        }),
      };
    } catch (error) {
      return {
        id: "artifact-store.production",
        passed: false,
        evidence: JSON.stringify({
          provider: "artifact.store.s3",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      };
    }
  }
}

class AwsS3ArtifactClient implements S3ArtifactClient {
  constructor(private readonly client: S3Client) {}

  async headObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
        {
          abortSignal: input.signal,
        },
      );
      return true;
    } catch (error) {
      if (httpStatus(error) === 404) return false;
      throw error;
    }
  }

  async putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
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
          ContentType: input.contentType,
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
    if (response.Body === undefined) throw objectSizeMismatch(input.maxBytes);
    return readBoundedS3Body(response.Body, {
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

export async function readBoundedS3Body(
  body: unknown,
  options: {
    readonly maxBytes: number;
    readonly declaredBytes?: number;
  },
): Promise<Uint8Array> {
  const maxBytes = nonNegativeSafeInteger(options.maxBytes);
  const declaredBytes =
    options.declaredBytes === undefined
      ? undefined
      : nonNegativeSafeInteger(options.declaredBytes);
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throw objectSizeMismatch(maxBytes, undefined, declaredBytes);
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
    if (!append(transformed)) throw objectSizeMismatch(maxBytes, total, declaredBytes);
  } else if (isWebReadable(transformed)) {
    const reader = transformed.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!append(result.value)) {
          await reader.cancel().catch(() => undefined);
          throw objectSizeMismatch(maxBytes, total, declaredBytes);
        }
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw objectSizeMismatch(maxBytes, total, declaredBytes);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The sanitized size/read failure remains authoritative.
      }
    }
  } else if (isAsyncBytes(transformed)) {
    try {
      for await (const chunk of transformed) {
        if (!(chunk instanceof Uint8Array)) {
          throw objectSizeMismatch(maxBytes, total, declaredBytes);
        }
        if (!append(chunk)) {
          destroyStream(transformed);
          throw objectSizeMismatch(maxBytes, total, declaredBytes);
        }
      }
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw objectSizeMismatch(maxBytes, total, declaredBytes);
    }
  } else {
    throw objectSizeMismatch(maxBytes, total, declaredBytes);
  }

  if (declaredBytes !== undefined && declaredBytes !== total) {
    throw objectSizeMismatch(maxBytes, total, declaredBytes);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWebReadable(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function isAsyncBytes(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function destroyStream(value: object): void {
  if ("destroy" in value && typeof value.destroy === "function") {
    try {
      value.destroy();
    } catch {
      // The sanitized size failure remains authoritative.
    }
  }
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw PrismError.of(
      "ARTIFACT_S3_CONFIGURATION_INVALID",
      `S3 Artifact ${field} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw objectSizeMismatch(0);
  return value;
}

function objectSizeMismatch(
  maxBytes: number,
  actualBytes?: number,
  declaredBytes?: number,
): PrismError {
  return PrismError.of(
    "ARTIFACT_OBJECT_SIZE_MISMATCH",
    "S3 Artifact object exceeded or did not match its bounded size.",
    {
      maxBytes,
      ...(actualBytes === undefined ? {} : { actualBytes }),
      ...(declaredBytes === undefined ? {} : { declaredBytes }),
    },
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64");
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

function corrupt(hash: string): PrismError {
  return PrismError.of(
    "ARTIFACT_HASH_MISMATCH",
    `Artifact ${hash} failed SHA-256 verification.`,
    { hash },
  );
}

function fileNotFound(hash: string, path: string): PrismError {
  return PrismError.of("ARTIFACT_FILE_NOT_FOUND", `Artifact ${hash} has no file ${path}.`, {
    hash,
    path,
  });
}
