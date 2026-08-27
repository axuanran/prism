import type { CallContext } from "@prismengine/contracts-data";
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

export interface ArtifactStoreCapability {
  putImmutable(context: CallContext, input: ArtifactWrite): Promise<ArtifactRef>;
  exists(context: CallContext, ref: ArtifactRef): Promise<boolean>;
  stat(context: CallContext, ref: ArtifactRef): Promise<ArtifactStat>;
  read(context: CallContext, ref: ArtifactRef, path: string): Promise<Uint8Array>;
  verify(context: CallContext, ref: ArtifactRef): Promise<boolean>;
}

export const ArtifactStoreCapabilityToken = defineCapability<ArtifactStoreCapability>({
  id: "artifact.store",
  version: "1.0.0",
});
