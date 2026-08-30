import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat as fileStat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ArtifactStoreCapabilityToken,
  artifactObjectPrefix,
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

export interface LocalArtifactStoreOptions {
  readonly root: string;
}

export function localArtifactStorePlugin(options: LocalArtifactStoreOptions) {
  return definePlugin({
    id: "artifact.store.local",
    version: "0.1.20",
    engineRange: "^0.1.20",
    provides: [ArtifactStoreCapabilityToken],
    register(context) {
      context.provide(ArtifactStoreCapabilityToken, new LocalArtifactStore(options.root));
    },
  });
}

export class LocalArtifactStore implements ArtifactStoreCapability {
  constructor(private readonly root: string) {}
  profile() {
    return Object.freeze({
      providerId: "artifact.store.local",
      durability: "development" as const,
      immutable: true,
      external: false,
    });
  }
  async productionReadiness(_context: CallContext) {
    return {
      id: "artifact-store.production" as const,
      passed: false,
      evidence: JSON.stringify(this.profile()),
    };
  }

  async putImmutable(_context: CallContext, input: ArtifactWrite): Promise<ArtifactRef> {
    const files = canonicalArtifactFiles(input);
    const ref = artifactRef(input.contentType, files);
    const target = this.directory(ref.hash);
    try {
      await fileStat(join(target, "manifest.json"));
      if (!(await this.verify(_context, ref))) throw corrupt(ref.hash);
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
      await writeFile(
        join(staging, "manifest.json"),
        serializeArtifactManifest(artifactStat(ref, files)),
      );
      await mkdir(dirname(target), { recursive: true });
      let published = false;
      try {
        await rename(staging, target);
        published = true;
      } catch {
        await rm(staging, { recursive: true, force: true });
        if (!(await this.verify(_context, ref))) throw corrupt(ref.hash);
      }
      if (published && !(await this.verify(_context, ref))) {
        await rm(target, { recursive: true, force: true });
        throw corrupt(ref.hash);
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
      const value: unknown = JSON.parse(
        await readFile(join(this.directory(ref.hash), "manifest.json"), "utf8"),
      );
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
      content = await readFile(join(this.directory(ref.hash), ...safe.split("/")));
    } catch {
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
          content: await this.read(context, ref, file.path),
        })),
      );
      return hashArtifact(ref.contentType, files) === ref.hash;
    } catch {
      return false;
    }
  }

  private directory(hash: string): string {
    return join(this.root, ...artifactObjectPrefix(hash).split("/"));
  }
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
