import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat as fileStat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ArtifactStoreCapabilityToken,
  type ArtifactRef,
  type ArtifactStat,
  type ArtifactStoreCapability,
  type ArtifactWrite,
} from "@prismengine/contracts-artifact";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import { definePlugin } from "@prismengine/kernel";

export interface LocalArtifactStoreOptions {
  readonly root: string;
}

export function localArtifactStorePlugin(options: LocalArtifactStoreOptions) {
  return definePlugin({
    id: "artifact.store.local",
    version: "0.1.16",
    provides: [ArtifactStoreCapabilityToken],
    register(context) {
      context.provide(ArtifactStoreCapabilityToken, new LocalArtifactStore(options.root));
    },
  });
}

export class LocalArtifactStore implements ArtifactStoreCapability {
  constructor(private readonly root: string) {}

  async putImmutable(_context: CallContext, input: ArtifactWrite): Promise<ArtifactRef> {
    const files = canonicalFiles(input);
    const hash = artifactHash(input.contentType, files);
    const ref: ArtifactRef = {
      hash,
      size: files.reduce((total, file) => total + file.content.byteLength, 0),
      contentType: input.contentType,
      fileCount: files.length,
    };
    const target = this.directory(hash);
    try {
      await fileStat(join(target, "manifest.json"));
      if (!(await this.verify(_context, ref))) throw corrupt(hash);
      return ref;
    } catch (error) {
      if (error instanceof PrismError) throw error;
    }
    const staging = `${target}.staging-${randomUUID()}`;
    await mkdir(staging, { recursive: true });
    try {
      for (const file of files) {
        const path = join(staging, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      await writeFile(join(staging, "manifest.json"), JSON.stringify({
        ...ref,
        files: files.map((file) => ({ path: file.path, size: file.content.byteLength })),
      }, null, 2));
      await mkdir(dirname(target), { recursive: true });
      try {
        await rename(staging, target);
      } catch {
        await rm(staging, { recursive: true, force: true });
        if (!(await this.verify(_context, ref))) throw corrupt(hash);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
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

  async stat(_context: CallContext, ref: ArtifactRef): Promise<ArtifactStat> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory(ref.hash), "manifest.json"), "utf8"),
      ) as ArtifactStat;
      if (
        value.hash !== ref.hash || value.size !== ref.size ||
        value.contentType !== ref.contentType || value.fileCount !== ref.fileCount
      ) {
        throw corrupt(ref.hash);
      }
      return value;
    } catch (error) {
      if (error instanceof PrismError) throw error;
      throw PrismError.of(
        "ARTIFACT_NOT_FOUND",
        `Artifact ${ref.hash} does not exist.`,
        { hash: ref.hash },
      );
    }
  }

  async read(context: CallContext, ref: ArtifactRef, path: string): Promise<Uint8Array> {
    await this.stat(context, ref);
    const safe = artifactPath(path);
    try {
      return await readFile(join(this.directory(ref.hash), ...safe.split("/")));
    } catch {
      throw PrismError.of(
        "ARTIFACT_FILE_NOT_FOUND",
        `Artifact ${ref.hash} has no file ${safe}.`,
        { hash: ref.hash, path: safe },
      );
    }
  }

  async verify(context: CallContext, ref: ArtifactRef): Promise<boolean> {
    try {
      const metadata = await this.stat(context, ref);
      const files = await Promise.all(metadata.files.map(async (file) => ({
        path: file.path,
        content: await this.read(context, ref, file.path),
      })));
      return artifactHash(ref.contentType, files) === ref.hash;
    } catch {
      return false;
    }
  }

  private directory(hash: string): string {
    return join(this.root, "sha256", hash.slice(0, 2), hash);
  }
}

function canonicalFiles(input: ArtifactWrite) {
  if (input.files.length === 0) {
    throw PrismError.of("ARTIFACT_EMPTY", "Artifact must contain at least one file.");
  }
  const seen = new Set<string>();
  return input.files.map((file) => ({
    path: artifactPath(file.path),
    content: file.content,
  })).sort((left, right) => left.path.localeCompare(right.path)).map((file) => {
    if (seen.has(file.path)) {
      throw PrismError.of(
        "ARTIFACT_PATH_DUPLICATE",
        `Artifact contains duplicate file ${file.path}.`,
        { path: file.path },
      );
    }
    seen.add(file.path);
    return file;
  });
}

function artifactPath(path: string): string {
  const value = path.normalize("NFC");
  if (
    value === "" || value.startsWith("/") || value.includes("\\") ||
    value.includes("\u0000") || value.split("/").includes("..") || value === "manifest.json"
  ) {
    throw PrismError.of(
      "ARTIFACT_PATH_INVALID",
      `Artifact path ${path} is invalid.`,
      { path },
    );
  }
  return value;
}

function artifactHash(
  contentType: string,
  files: readonly { readonly path: string; readonly content: Uint8Array }[],
): string {
  const hash = createHash("sha256");
  hash.update(contentType);
  hash.update("\u0000");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function corrupt(hash: string): PrismError {
  return PrismError.of(
    "ARTIFACT_HASH_MISMATCH",
    `Artifact ${hash} failed SHA-256 verification.`,
    { hash },
  );
}
