import { createHash } from "node:crypto";
import {
  PrismError,
  isPortableRelativePath,
  type CallContext,
} from "@prismengine/contracts-data";
import { defineCapability } from "@prismengine/kernel";

export interface ArtifactFileWrite {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface ArtifactWrite {
  readonly contentType: string;
  readonly files: readonly ArtifactFileWrite[];
}

export interface ArtifactRef {
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
  readonly fileCount: number;
}

export interface ArtifactStat extends ArtifactRef {
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
  }[];
}
export interface CanonicalArtifactFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export function normalizeArtifactPath(path: string): string {
  const value = path.normalize("NFC");
  if (!isPortableRelativePath(value) || value === "manifest.json") {
    throw PrismError.of("ARTIFACT_PATH_INVALID", `Artifact path ${path} is invalid.`, {
      path,
    });
  }
  return value;
}

export function canonicalArtifactFiles(
  input: ArtifactWrite,
): readonly CanonicalArtifactFile[] {
  if (input.contentType.trim() === "") {
    throw PrismError.of(
      "ARTIFACT_CONTENT_TYPE_INVALID",
      "Artifact content type is required.",
    );
  }
  if (input.files.length === 0) {
    throw PrismError.of("ARTIFACT_EMPTY", "Artifact must contain at least one file.");
  }
  const seen = new Set<string>();
  const portable = new Map<string, string>();
  return input.files
    .map((file) => ({
      path: normalizeArtifactPath(file.path),
      content: file.content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      if (seen.has(file.path)) {
        throw PrismError.of(
          "ARTIFACT_PATH_DUPLICATE",
          `Artifact contains duplicate file ${file.path}.`,
          { path: file.path },
        );
      }
      seen.add(file.path);
      const folded = file.path.toLowerCase();
      const collision = portable.get(folded);
      if (collision !== undefined) {
        throw PrismError.of(
          "ARTIFACT_PATH_COLLISION",
          "Artifact paths collide on a case-insensitive provider.",
          { path: file.path, conflictingPath: collision },
        );
      }
      portable.set(folded, file.path);
      return file;
    });
}

const ARTIFACT_HASH_DOMAIN = "prism.artifact.sha256.v2\u0000";

export function hashArtifact(
  contentType: string,
  files: readonly CanonicalArtifactFile[],
): string {
  const hash = createHash("sha256");
  const length = Buffer.allocUnsafe(8);
  const updateLength = (value: number): void => {
    length.writeBigUInt64BE(BigInt(value));
    hash.update(length);
  };
  const updateString = (value: string): void => {
    updateLength(Buffer.byteLength(value, "utf8"));
    hash.update(value, "utf8");
  };
  const updateBytes = (value: Uint8Array): void => {
    updateLength(value.byteLength);
    hash.update(value);
  };

  hash.update(ARTIFACT_HASH_DOMAIN, "utf8");
  updateString(contentType);
  updateLength(files.length);
  for (const file of files) {
    updateString(file.path);
    updateBytes(file.content);
  }
  return hash.digest("hex");
}

export function artifactRef(
  contentType: string,
  files: readonly CanonicalArtifactFile[],
): ArtifactRef {
  return Object.freeze({
    hash: hashArtifact(contentType, files),
    size: files.reduce((total, file) => total + file.content.byteLength, 0),
    contentType,
    fileCount: files.length,
  });
}

export function artifactStat(
  ref: ArtifactRef,
  files: readonly CanonicalArtifactFile[],
): ArtifactStat {
  return Object.freeze({
    ...ref,
    files: files.map((file) =>
      Object.freeze({
        path: file.path,
        size: file.content.byteLength,
      }),
    ),
  });
}

export function serializeArtifactManifest(stat: ArtifactStat): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(stat, null, 2)}\n`);
}

export function parseArtifactManifest(
  value: unknown,
  expected?: ArtifactRef,
): ArtifactStat {
  if (
    typeof value !== "object" ||
    value === null ||
    !("hash" in value) ||
    typeof value.hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.hash) ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !("contentType" in value) ||
    typeof value.contentType !== "string" ||
    value.contentType === "" ||
    !("fileCount" in value) ||
    typeof value.fileCount !== "number" ||
    !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 1 ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw PrismError.of("ARTIFACT_MANIFEST_INVALID", "Artifact manifest is malformed.");
  }
  const files = Object.freeze(
    value.files.map((file) => {
      if (
        typeof file !== "object" ||
        file === null ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !("size" in file) ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      ) {
        throw PrismError.of(
          "ARTIFACT_MANIFEST_INVALID",
          "Artifact file manifest is malformed.",
        );
      }
      return Object.freeze({ path: normalizeArtifactPath(file.path), size: file.size });
    }),
  );
  const stat: ArtifactStat = Object.freeze({
    hash: value.hash,
    size: value.size,
    contentType: value.contentType,
    fileCount: value.fileCount,
    files,
  });
  if (
    stat.fileCount !== stat.files.length ||
    stat.files.some(
      (file, index) =>
        index > 0 && stat.files[index - 1]!.path.localeCompare(file.path) >= 0,
    ) ||
    stat.size !== stat.files.reduce((total, file) => total + file.size, 0) ||
    (expected !== undefined &&
      (stat.hash !== expected.hash ||
        stat.size !== expected.size ||
        stat.contentType !== expected.contentType ||
        stat.fileCount !== expected.fileCount))
  ) {
    throw PrismError.of(
      "ARTIFACT_HASH_MISMATCH",
      `Artifact ${expected?.hash ?? stat.hash} failed manifest verification.`,
      { hash: expected?.hash ?? stat.hash },
    );
  }
  return stat;
}

export function artifactObjectPrefix(hash: string, prefix = ""): string {
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    throw PrismError.of(
      "ARTIFACT_HASH_INVALID",
      "Artifact hash must be lowercase SHA-256.",
    );
  }
  const root = prefix.normalize("NFC").replace(/^\/+|\/+$/gu, "");
  if (
    root.includes("\\") ||
    root.includes("\u0000") ||
    root.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw PrismError.of("ARTIFACT_PREFIX_INVALID", "Artifact object prefix is invalid.");
  }
  return `${root ? `${root}/` : ""}sha256/${hash.slice(0, 2)}/${hash}`;
}
export function artifactManifestObjectKey(hash: string, prefix = ""): string {
  return `${artifactObjectPrefix(hash, prefix)}/manifest.json`;
}

export function artifactObjectKey(hash: string, path: string, prefix = ""): string {
  return `${artifactObjectPrefix(hash, prefix)}/${normalizeArtifactPath(path)}`;
}
export interface ArtifactStoreProfile {
  readonly providerId: string;
  readonly durability: "development" | "production";
  readonly immutable: boolean;
  readonly external: boolean;
}

export interface ArtifactStoreCapability {
  profile(): ArtifactStoreProfile;
  putImmutable(context: CallContext, input: ArtifactWrite): Promise<ArtifactRef>;
  productionReadiness(context: CallContext): Promise<{
    readonly id: "artifact-store.production";
    readonly passed: boolean;
    readonly evidence?: string;
  }>;
  exists(context: CallContext, ref: ArtifactRef): Promise<boolean>;
  stat(context: CallContext, ref: ArtifactRef): Promise<ArtifactStat>;
  /**
   * Reads one immutable manifest member. Providers must reject normalized
   * paths absent from `stat(ref).files` before backing-store access and reject
   * bytes whose length differs from the manifest. Use `verify` for full
   * content-hash integrity.
   */
  read(context: CallContext, ref: ArtifactRef, path: string): Promise<Uint8Array>;
  verify(context: CallContext, ref: ArtifactRef): Promise<boolean>;
}

export const ArtifactStoreCapabilityToken = defineCapability<ArtifactStoreCapability>({
  id: "artifact.store",
  version: "1.0.0",
});
